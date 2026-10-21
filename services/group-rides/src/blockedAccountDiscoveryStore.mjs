import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { userKey } from './sessionRegistry.mjs';
import { hash } from './locationKeys.mjs';
import { UnauthorizedError } from './authorizer.mjs';
import { createLifecycleHoldStore } from './lifecycleHoldStore.mjs';

const roomKey = (key) => typeof key === 'string' && /^ROOM#[a-f0-9]{64}$/.test(key);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** Internal reconciliation only. Candidates are not evidence of membership or deletion.
 * No caller/worker: persist work before advancing cursors; never expose these cursors.
 */
export function createBlockedAccountDiscoveryStore(config) {
  return createDiscoveryStore(config, false);
}

/** Exact event hold required. Cursors from temporary reconciliation are incompatible. */
export function createLifecycleDiscoveryStore(config) {
  return createDiscoveryStore(config, true);
}

function createDiscoveryStore({ client, tableName, sessionTableName, locationTableName, holdStartedAt }, lifecycle) {
  const tables = [tableName, sessionTableName, locationTableName];
  if (!client?.send || new Set(tables).size !== 3 || tables.some((name) => !/^[A-Za-z0-9_.-]{3,255}$/.test(name ?? '')))
    throw new Error('Separate lifecycle discovery storage must be configured.');
  const holds = createLifecycleHoldStore({ client, tableName: sessionTableName, expectedStartedAt: holdStartedAt });
  async function blocked(subject, eventId) {
    if (lifecycle) {
      const row = await holds.read(subject, eventId);
      if (!row) throw new UnauthorizedError();
      return row.lifecycleHold;
    }
    const row = (await client.send(new GetCommand({ TableName: sessionTableName, Key: userKey(subject), ConsistentRead: true }))).Item;
    if (row?.subject !== subject || row.state !== 'blocked') throw new UnauthorizedError();
  }
  async function readPage(subject, eventId, { cursor = null, limit = 100 } = {}) {
    if (typeof subject !== 'string' || !subject || subject.length > 256 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid lifecycle discovery context.');
    if (lifecycle && (typeof eventId !== 'string' || !eventId || eventId.length > 256))
      throw new Error('Invalid lifecycle discovery event.');
    // A binding catches accidental cross-job/table reuse; it is not a signed capability.
    const binding = hash(JSON.stringify(lifecycle ? [subject, eventId, ...tables, ...(holdStartedAt === undefined ? [] : [holdStartedAt])] : [subject, ...tables]));
    const rider = `RIDER#${hash(subject)}`;
    const validKey = (key, phase) => exactKeys(key, phase === 'rooms' ? ['pk'] : ['pk', 'sk'])
      && roomKey(key.pk) && (phase === 'rooms' || (typeof key.sk === 'string' && /^RIDER#[a-f0-9]{64}$/.test(key.sk)));
    if (cursor !== null && (!exactKeys(cursor, ['version', 'binding', 'phase', 'key']) || cursor.version !== 1
      || cursor.binding !== binding || !['rooms', 'points'].includes(cursor.phase)
      || (cursor.key !== null && !validKey(cursor.key, cursor.phase))
      || (cursor.phase === 'rooms' && cursor.key === null)))
      throw new Error('Invalid lifecycle discovery cursor.');
    const phase = cursor?.phase ?? 'rooms';
    // Copy before awaiting so a caller cannot change the continuation mid-request.
    const start = cursor?.key ? { ...cursor.key } : null;
    const before = await blocked(subject, eventId);
    const response = await client.send(new ScanCommand({ TableName: phase === 'rooms' ? tableName : locationTableName,
      ConsistentRead: true, Limit: limit, ProjectionExpression: phase === 'rooms' ? '#pk' : '#pk, #sk',
      ExpressionAttributeNames: phase === 'rooms' ? { '#pk': 'pk' } : { '#pk': 'pk', '#sk': 'sk' },
      // No state/TTL filter: expired rooms and orphan points still require erasure.
      ...(phase === 'points' ? { FilterExpression: '#sk = :rider', ExpressionAttributeValues: { ':rider': rider } } : {}),
      ...(start ? { ExclusiveStartKey: start } : {}),
    }));
    const items = response.Items ?? [];
    if (!Array.isArray(items) || items.length > limit || items.some((item) => !validKey(item, phase) || (phase === 'points' && item.sk !== rider)))
      throw new Error('Invalid lifecycle discovery page.');
    // Scan continuation is the last *evaluated* key, possibly for another rider.
    const rawLast = response.LastEvaluatedKey;
    const last = exactKeys(rawLast, []) ? undefined : rawLast;
    const validLast = validKey(last, phase);
    if (last !== undefined && (!validLast || (start && last.pk === start.pk && last.sk === start.sk)))
      throw new Error('Invalid lifecycle discovery continuation.');
    const after = await blocked(subject, eventId);
    if (lifecycle && before.startedAt !== after.startedAt) throw new UnauthorizedError();
    const next = last ? { version: 1, binding, phase, key: { ...last } }
      : phase === 'rooms' ? { version: 1, binding, phase: 'points', key: null } : null;
    return { roomIds: [...new Set(items.map((item) => item.pk.slice(5)))], next };
  }
  return { readPage: lifecycle ? readPage : (subject, options) => readPage(subject, undefined, options) };
}
