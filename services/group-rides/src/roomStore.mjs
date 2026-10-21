import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { locationKey, conditionalConflict } from './locationKeys.mjs';
/** Dedicated metadata-only table. Never use the retained account-session table. */
export function createDynamoRoomStore({ client, tableName, sessionTableName, locationTableName, registry, now = Date.now }) {
  if (typeof registry?.transactionChecks !== 'function' || !client?.send || !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName ?? '')
    || !/^[A-Za-z0-9_.-]{3,255}$/.test(sessionTableName ?? '') || tableName === sessionTableName) throw new Error('Room storage must be configured.');
  if (locationTableName !== undefined && (!/^[A-Za-z0-9_.-]{3,255}$/.test(locationTableName) || [tableName, sessionTableName].includes(locationTableName))) throw new Error('Location storage must be separate.');
  const key = (id) => ({ pk: `ROOM#${id}` });
  async function put(room, revision, actor) {
    // Enforce metadata-only storage even if future callers accidentally add data.
    function inspect(value) {
      if (!value || typeof value !== 'object') return;
      for (const [name, child] of Object.entries(value)) {
        if (['latitude', 'longitude', 'fix', 'coords', 'accessToken', 'refreshToken', 'token'].includes(name)) throw new Error('Sensitive data does not belong in room metadata.');
        inspect(child);
      }
    }
    inspect(room);
    const retentionDeadline = Math.min(room.endedAt ?? room.expiresAt, room.expiresAt) + 24 * 60 * 60_000;
    if (!Number.isSafeInteger(retentionDeadline)) throw new Error('Invalid room retention deadline.');
    const input = { TableName: tableName, Item: { ...key(room.id), room, revision: room.revision,
      cleanupBucket: 'ROOMS', purgeAt: retentionDeadline - 60_000, ttl: Math.ceil(retentionDeadline / 1000) },
      ConditionExpression: revision === null ? 'attribute_not_exists(pk)' : '#revision = :revision',
      ...(revision === null ? {} : { ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': revision } }) };
    if (!actor?.userId || !actor.sessionId || !Number.isFinite(actor.expiresAt)) throw new Error('A verified room actor is required.');
    try {
      let removals = [];
      if (revision !== null && locationTableName) {
        const previous = (await client.send(new GetCommand({ TableName: tableName, Key: key(room.id), ConsistentRead: true }))).Item?.room;
        if (!previous || previous.revision !== revision) return false;
        // Serialize erasure with publication: either the old write commits first
        // and is deleted here, or the new revision blocks it.
        const removed = previous.members.filter((old) => {
          const next = room.members.find((m) => m.userId === old.userId);
          return room.state === 'ended' || !next || !next.sharing
            || next.deviceEpoch !== old.deviceEpoch || next.deviceFamily !== old.deviceFamily;
        });
        removals = removed.map((m) => ({ Delete: { TableName: locationTableName, Key: locationKey(room.id, m.userId) } }));
      }
      const checks = registry.transactionChecks({ subject: actor.userId, familyId: actor.sessionId, expiresAt: actor.expiresAt }, now());
      await client.send(new TransactWriteCommand({ TransactItems: [{ Put: input }, ...checks, ...removals] }));
      return true;
    }
    catch (error) { if (conditionalConflict(error)) return false; throw error; }
  }
  return {
    async read(id) { return (await client.send(new GetCommand({ TableName: tableName, Key: key(id), ConsistentRead: true }))).Item?.room ?? null; },
    create: (room, actor) => put(room, null, actor), replace: (room, revision, actor) => put(room, revision, actor),
  };
}
