import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { hash } from './locationKeys.mjs';
import { userKey } from './sessionRegistry.mjs';

const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const fail = () => { throw new Error('Invalid or conflicting lifecycle hold.'); };

/** Internal permanent hold only: no trusted ingress, release or deletion worker. */
export function createLifecycleHoldStore({ client, tableName, now = Date.now, expectedStartedAt }) {
  if (!client?.send || !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName ?? ''))
    throw new Error('Lifecycle hold storage must be configured.');
  if (expectedStartedAt !== undefined && (!Number.isSafeInteger(expectedStartedAt) || expectedStartedAt < 0)) fail();
  function context(subject, eventId) {
    if (!id(subject) || !id(eventId)) fail();
    return { key: userKey(subject), binding: hash(JSON.stringify([subject, eventId, tableName])) };
  }
  async function read(subject, eventId) {
    const { key, binding } = context(subject, eventId);
    const row = (await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))).Item;
    if (row === undefined) return undefined;
    if (!exact(row, ['pk', 'subject', 'state', 'lifecycleHold']) || row.pk !== key.pk
      || row.subject !== subject || row.state !== 'blocked'
      || !exact(row.lifecycleHold, ['version', 'binding', 'startedAt'])
      || row.lifecycleHold.version !== 1 || row.lifecycleHold.binding !== binding
      || !Number.isSafeInteger(row.lifecycleHold.startedAt) || row.lifecycleHold.startedAt < 0
      || expectedStartedAt !== undefined && row.lifecycleHold.startedAt !== expectedStartedAt) fail();
    return structuredClone(row);
  }
  return {
    read,
    async begin(subject, eventId) {
      if (expectedStartedAt !== undefined) fail(); // A pinned worker can only read an existing hold.
      const { key, binding } = context(subject, eventId), at = now();
      if (!Number.isSafeInteger(at) || at < 0) fail();
      // Replacement deliberately removes TTL, expiry and pilot approval together.
      // A concurrent admission writer must also condition on hold absence.
      const row = { ...key, subject, state: 'blocked', lifecycleHold: { version: 1, binding, startedAt: at } };
      try {
        await client.send(new PutCommand({ TableName: tableName, Item: row,
          ConditionExpression: 'attribute_not_exists(lifecycleHold) AND (attribute_not_exists(pk) OR subject = :subject)',
          ExpressionAttributeValues: { ':subject': subject } }));
      } catch (error) {
        if (error?.name !== 'ConditionalCheckFailedException') throw error;
        const existing = await read(subject, eventId);
        if (!existing) fail();
        return existing;
      }
      // A lost response is not success: the caller must reread or retry the event.
      return structuredClone(row);
    },
  };
}
