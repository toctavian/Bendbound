import { randomUUID } from 'node:crypto';
import { GetCommand, TransactGetCommand, TransactWriteCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { locationKey, conditionalConflict, hash, LOCATION_RETENTION_MS } from './locationKeys.mjs';
import { familyKey, userKey } from './sessionRegistry.mjs';
import { UnauthorizedError } from './authorizer.mjs';
import { RoomError } from './rooms.mjs';
import { validFix } from './locations.mjs';
const FIX_FUTURE_MS = 1000, HIDE_AFTER_MS = 5 * 60_000;
export { LOCATION_RETENTION_MS } from './locationKeys.mjs';
/** Latest points only. Expiry must be backed by a scheduled worker, not just TTL. */
export function createDynamoLocationStore({ client, tableName, roomTableName, sessionTableName, registry }) {
  const names = [tableName, roomTableName, sessionTableName];
  if (!client?.send || typeof registry?.transactionChecks !== 'function' || typeof registry?.allowsUser !== 'function' || new Set(names).size !== 3
    || names.some((name) => !/^[A-Za-z0-9_.-]{3,255}$/.test(name ?? ''))) throw new Error('Separate location storage and atomic session checks are required.');
  async function commit({ actor, lease, fix, previous, fingerprint, at, duplicate }) {
    const key = locationKey(lease.roomId, actor.userId);
    const condition = previous ? '#version = :version' : 'attribute_not_exists(pk)';
    const attributes = previous ? { ExpressionAttributeNames: { '#version': 'pointVersion' }, ExpressionAttributeValues: { ':version': previous.pointVersion } } : {};
    const expiry = Math.min(lease.expiresAt, at + LOCATION_RETENTION_MS);
    const point = duplicate ? { ConditionCheck: { TableName: tableName, Key: key, ConditionExpression: condition, ...attributes } }
      : { Put: { TableName: tableName, ConditionExpression: condition, ...attributes,
        Item: { ...key, pointVersion: randomUUID(), familyHash: hash(actor.sessionId),
          fix: { ...fix, receivedAt: at }, fingerprint, expiresAt: expiry, cleanupBucket: 'ACTIVE', ttl: Math.ceil(expiry / 1000) } } };
    try {
      await client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: roomTableName, Key: { pk: `ROOM#${lease.roomId}` },
          ConditionExpression: '#revision = :revision AND #room.#state = :riding AND #room.expiresAt > :now',
          ExpressionAttributeNames: { '#revision': 'revision', '#room': 'room', '#state': 'state' },
          ExpressionAttributeValues: { ':revision': lease.revision, ':riding': 'riding', ':now': at } } },
        ...registry.transactionChecks({ subject: actor.userId, familyId: actor.sessionId, expiresAt: actor.expiresAt }, at), point,
      ] }));
      return true;
    } catch (error) { if (conditionalConflict(error)) return false; throw error; }
  }
  return {
    async read(roomId, userId) { return (await client.send(new GetCommand({ TableName: tableName, Key: locationKey(roomId, userId), ConsistentRead: true }))).Item ?? null; },
    commit,
    async snapshot(actor, roomId, now = Date.now) {
      if (!actor?.userId || !actor.sessionId || !Number.isFinite(actor.expiresAt)) throw new UnauthorizedError();
      const roomKey = { pk: `ROOM#${roomId}` };
      for (let attempt = 0; attempt < 6; attempt++) {
        const discovery = (await client.send(new GetCommand({ TableName: roomTableName, Key: roomKey, ConsistentRead: true }))).Item?.room;
        if (!discovery || discovery.state === 'ended' || discovery.expiresAt <= now()
          || !discovery.members.some((m) => m.userId === actor.userId)) throw new RoomError('ROOM_UNAVAILABLE', 404);
        // Discover keys first, then atomically read room + every relevant grant +
        // point. Changed membership/revision forces rediscovery, not a mixed read.
        const gets = [], indices = new Map();
        const add = (table, key) => {
          const label = JSON.stringify([table, key]);
          if (!indices.has(label)) { indices.set(label, gets.length); gets.push({ Get: { TableName: table, Key: key } }); }
          return indices.get(label);
        };
        const roomIndex = add(roomTableName, roomKey);
        const sessionIndices = (user, family) => [add(sessionTableName, familyKey(family)), add(sessionTableName, userKey(user))];
        const viewer = sessionIndices(actor.userId, actor.sessionId);
        const members = discovery.members.map((m) => ({ userId: m.userId,
          point: add(tableName, locationKey(roomId, m.userId)),
          grants: m.sharing && m.deviceFamily ? sessionIndices(m.userId, m.deviceFamily) : null,
        }));
        const response = await client.send(new TransactGetCommand({ TransactItems: gets }));
        const item = (index) => response.Responses[index]?.Item;
        const room = item(roomIndex)?.room;
        const at = now();
        const active = (subject, indices) => {
          if (!indices) return false;
          const family = item(indices[0]), user = item(indices[1]);
          return family?.subject === subject && family.state === 'active' && family.expiresAt > at
            && registry.allowsUser(user, subject, at);
        };
        if (actor.expiresAt <= at || !active(actor.userId, viewer)) throw new UnauthorizedError();
        if (!room || room.state === 'ended' || room.expiresAt <= at || !room.members.some((m) => m.userId === actor.userId)) throw new RoomError('ROOM_UNAVAILABLE', 404);
        if (room.revision !== discovery.revision) continue;
        return { version: 1, id: room.id, revision: room.revision, title: room.title, state: room.state, expiresAt: room.expiresAt, routeSnapshotId: room.routeSnapshotId,
          members: room.members.map((m, index) => {
            const source = members[index], point = item(source.point), fix = point?.fix;
            const visible = room.state === 'riding' && m.sharing && active(m.userId, source.grants)
              && point?.familyHash === hash(m.deviceFamily) && fix?.sessionEpoch === m.deviceEpoch
              && point.expiresAt > at && validFix(fix && Object.fromEntries(Object.entries(fix).filter(([key]) => key !== 'receivedAt')), fix?.capturedAt)
              && Number.isFinite(fix.receivedAt) && fix.capturedAt <= at + FIX_FUTURE_MS && fix.receivedAt <= at + FIX_FUTURE_MS
              && Math.max(at - fix.capturedAt, at - fix.receivedAt) < HIDE_AFTER_MS;
            return { userId: m.userId, displayName: m.displayName, motorcycleType: m.motorcycleType,
              role: room.ownerId === m.userId ? 'owner' : 'member', sharing: m.sharing, fix: visible ? fix : null };
          }),
        };
      }
      throw new RoomError('ROOM_BUSY', 409);
    },
    async cleanup(at, { maxPages = 10, shouldContinue = () => true } = {}) {
      if (typeof shouldContinue !== 'function' || !Number.isFinite(at) || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('Invalid cleanup parameters.');
      let cursor, deleted = 0, examined = 0, oldestOverdueMs = 0;
      for (let page = 0; page < maxPages; page++) {
        if (!shouldContinue()) return { deleted, examined, more: true, oldestOverdueMs };
        // The index projects only keys/version, never coordinates. Its eventual
        // consistency cannot delete a refreshed point: the delete is conditional.
        const response = await client.send(new QueryCommand({ TableName: tableName, IndexName: 'ExpiryIndex',
          KeyConditionExpression: 'cleanupBucket = :bucket AND expiresAt <= :now',
          ExpressionAttributeValues: { ':bucket': 'ACTIVE', ':now': at }, Limit: 100,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
        const items = response.Items ?? [];
        // Bounded parallel erasure keeps a large pilot backlog within the worker
        // budget. Always inspect/await every outcome before returning or failing.
        for (let offset = 0; offset < items.length;) {
          const batch = [];
          while (offset < items.length && batch.length < 8 && shouldContinue()) batch.push(items[offset++]);
          if (!batch.length) return { deleted, examined, more: true, oldestOverdueMs };
          const outcomes = await Promise.allSettled(batch.map(async (item) => {
            examined++;
            if (Number.isFinite(item.expiresAt)) oldestOverdueMs = Math.max(oldestOverdueMs, at - item.expiresAt);
            await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: item.pk, sk: item.sk },
              ConditionExpression: '#version = :version AND expiresAt <= :now',
              ExpressionAttributeNames: { '#version': 'pointVersion' }, ExpressionAttributeValues: { ':version': item.pointVersion, ':now': at } }));
          }));
          let failure;
          for (const outcome of outcomes) {
            if (outcome.status === 'fulfilled') deleted++;
            else if (!conditionalConflict(outcome.reason)) failure ??= outcome.reason;
          }
          if (failure) throw failure;
        }
        cursor = response.LastEvaluatedKey;
        if (!cursor) break;
      }
      return { deleted, examined, more: !!cursor, oldestOverdueMs };
    },
  };
}
