import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { userKey } from './sessionRegistry.mjs';
import { locationKey } from './locationKeys.mjs';
import { UnauthorizedError } from './authorizer.mjs';
import { RoomError } from './rooms.mjs';
import { createLifecycleHoldStore } from './lifecycleHoldStore.mjs';

/** Temporary-block operator primitive; not durable lifecycle authorization. */
export function createBlockedAccountRoomStore(options) {
  const purge = createRoomPurge(options, false);
  return { purgeRoom: (subject, roomId) => purge(subject, roomId) };
}

/** Internal exact-event purge only. No rider handler, worker or hold release. */
export function createLifecycleRoomStore(options) {
  const purge = createRoomPurge(options, true);
  return { purgeRoom: (subject, eventId, roomId) => purge(subject, roomId, eventId) };
}

function createRoomPurge({ client, tableName, sessionTableName, locationTableName, now = Date.now, holdStartedAt }, lifecycle) {
  const names = [tableName, sessionTableName, locationTableName];
  if (!client?.send || new Set(names).size !== 3 || names.some((name) => !/^[A-Za-z0-9_.-]{3,255}$/.test(name ?? '')))
    throw new Error('Separate lifecycle storage must be configured.');
  const holds = lifecycle ? createLifecycleHoldStore({ client, tableName: sessionTableName, expectedStartedAt: holdStartedAt }) : null;
  return async function purgeRoom(subject, roomId, eventId) {
    if (typeof subject !== 'string' || !subject || subject.length > 256 || typeof roomId !== 'string' || !/^[a-f0-9]{64}$/.test(roomId))
      throw new Error('Invalid lifecycle context.');
    // Pin this invocation to its first validated hold, including across retries.
    let originalHold;
    const key = { pk: `ROOM#${roomId}` };
    for (let attempt = 0; attempt < 6; attempt++) {
      if (holds) {
        const held = await holds.read(subject, eventId);
        if (!held || (originalHold && held.lifecycleHold.startedAt !== originalHold.startedAt)) throw new UnauthorizedError();
        originalHold ??= held.lifecycleHold;
      }
      const row = (await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))).Item;
      const room = row?.room;
      if (row && (!room || room.id !== roomId || !Number.isSafeInteger(row.revision) || row.revision < 1
        || row.revision !== room.revision || row.revision >= Number.MAX_SAFE_INTEGER
        || !Array.isArray(room.members) || room.members.length > 10
        || !['lobby', 'riding', 'ended'].includes(room.state)
        || !Number.isSafeInteger(room.expiresAt) || room.expiresAt < 0
        || (room.endedAt !== undefined && (!Number.isSafeInteger(room.endedAt) || room.endedAt < 0))
        || room.members.some((m) => !m || typeof m.userId !== 'string' || !m.userId)
        || new Set(room.members.map((m) => m.userId)).size !== room.members.length
        || !Number.isSafeInteger(row.purgeAt) || !Number.isSafeInteger(row.ttl)
        || (room.members.length && !room.members.some((m) => m.userId === room.ownerId))))
        throw new Error('Invalid lifecycle room metadata.');
      const removed = !!room?.members.some((m) => m.userId === subject);
      const condition = row ? { ConditionExpression: '#revision = :revision',
        ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': row.revision } }
        : { ConditionExpression: 'attribute_not_exists(pk)' };
      let metadata = { ConditionCheck: { TableName: tableName, Key: key, ...condition } };
      if (removed || room?.ownerId === subject) {
        const next = structuredClone(row), at = now();
        if (!Number.isSafeInteger(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 86_400_000) throw new Error('Lifecycle clock unavailable.');
        next.room.members = next.room.members.filter((m) => m.userId !== subject);
        next.room.invite = null;
        if (!next.room.members.length) {
          next.room.state = 'ended';
          // Remove the final account identifier even from an ended room.
          next.room.ownerId = null;
          next.room.endedAt = Math.min(next.room.endedAt ?? at, at);
          const deadline = Math.min(next.room.endedAt, next.room.expiresAt) + 86_400_000;
          next.purgeAt = Math.min(next.purgeAt, deadline - 60_000);
          next.ttl = Math.min(next.ttl, Math.ceil(deadline / 1000));
        } else if (next.room.ownerId === subject) next.room.ownerId = next.room.members[0].userId;
        next.revision++; next.room.revision = next.revision;
        metadata = { Put: { TableName: tableName, Item: next, ...condition } };
      }
      try {
        await client.send(new TransactWriteCommand({ TransactItems: [
          { ConditionCheck: { TableName: sessionTableName, Key: userKey(subject),
            ConditionExpression: '#state = :blocked AND subject = :subject' + (lifecycle
              ? ' AND lifecycleHold = :hold AND attribute_not_exists(#ttl) AND attribute_not_exists(expiresAt) AND attribute_not_exists(pilotExpiresAt)' : ''),
            ExpressionAttributeNames: { '#state': 'state', ...(lifecycle ? { '#ttl': 'ttl' } : {}) },
            ExpressionAttributeValues: { ':blocked': 'blocked', ':subject': subject, ...(lifecycle ? { ':hold': originalHold } : {}) } } },
          metadata,
          // Also erase an orphan point when membership/metadata is already gone.
          { Delete: { TableName: locationTableName, Key: locationKey(roomId, subject) } },
        ] }));
        return { membershipRemoved: removed };
      } catch (error) {
        if (error?.name !== 'TransactionCanceledException') throw error;
        const reasons = error.CancellationReasons;
        if (reasons?.[0]?.Code === 'ConditionalCheckFailed') throw new UnauthorizedError();
        // Retry only identified revision races/transaction conflicts. Capacity,
        // malformed expressions and unknown failures must not become success.
        if (!reasons?.some((r, index) => r.Code === 'TransactionConflict' || (index === 1 && r.Code === 'ConditionalCheckFailed'))
          || reasons.some((r, index) => !['None', 'TransactionConflict'].includes(r.Code)
            && !(index === 1 && r.Code === 'ConditionalCheckFailed'))) throw error;
      }
    }
    throw new RoomError('ROOM_BUSY', 409);
  };
}
