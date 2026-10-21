import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDynamoRoomCleanupStore } from '../src/roomCleanupStore.mjs';
import { createCleanupHandler } from '../src/cleanupWorker.mjs';
const storeFor = (send) => createDynamoRoomCleanupStore({ client: { send }, tableName: 'synthetic-rooms' });
const due = (index) => ({ pk: `ROOM#synthetic-${index}`, revision: 2, purgeAt: 10 });
test('room cleanup paginates with bounded work and conditional stale-index protection', async () => {
  const calls = []; let page = 0;
  const store = storeFor(async (cmd) => {
    calls.push(cmd.input);
    if (cmd.constructor.name === 'QueryCommand') return ++page === 1
      ? { Items: [due(1)], LastEvaluatedKey: { pk: 'ROOM#synthetic-1' } } : { Items: [due(2)] };
    if (cmd.input.Key.pk.endsWith('2')) throw Object.assign(new Error('stale'), { name: 'ConditionalCheckFailedException' });
    return {};
  });
  assert.deepEqual(await store.cleanup(100), { deleted: 1, examined: 2, more: false, oldestOverdueMs: 90 });
  assert.equal(calls[0].Limit, 100); assert.equal(calls[0].IndexName, 'ExpiryIndex');
  assert.deepEqual(calls[2].ExclusiveStartKey, { pk: 'ROOM#synthetic-1' });
  assert.equal(calls[1].ConditionExpression, '#version = :version AND purgeAt = :purgeAt AND purgeAt <= :now');
  assert.deepEqual(calls[1].ExpressionAttributeValues, { ':version': 2, ':purgeAt': 10, ':now': 100 });
});
test('room cleaner reports page limit and runtime budget backlog', async () => {
  const store = storeFor(async () => ({ Items: [], LastEvaluatedKey: { pk: 'synthetic' } }));
  assert.equal((await store.cleanup(100, { maxPages: 1 })).more, true);
  const idle = storeFor(async () => { throw new Error('must not query'); });
  assert.deepEqual(await idle.cleanup(100, { shouldContinue: () => false }), { deleted: 0, examined: 0, more: true, oldestOverdueMs: 0 });
  for (const maxPages of [0, 101, 1.5]) await assert.rejects(store.cleanup(100, { maxPages }));
});
test('room cleaner waits for parallel deletes before reporting failure; concurrency is capped', async () => {
  let active = 0, peak = 0, settled = 0;
  const store = storeFor(async (cmd) => {
    if (cmd.constructor.name === 'QueryCommand') return { Items: Array.from({ length: 20 }, (_, i) => due(i)) };
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5)); active--; settled++;
    if (cmd.input.Key.pk.endsWith('-0')) throw new Error('NEVER_LOG_PRIVATE_DATA');
    return {};
  });
  const logs = [], handler = createCleanupHandler({ store, entity: 'Rooms', functionName: 'synthetic-room-cleanup', emit: (line) => logs.push(line) });
  await assert.rejects(handler({ private: 'NEVER_LOG_EVENT' }), { message: 'GROUP_ROOM_CLEANUP_FAILED' });
  assert.equal(active, 0); assert.equal(peak, 8); assert.equal(settled, 8);
  assert.equal(JSON.parse(logs[0]).CleanupFailed, 1); assert.equal(logs.join('').includes('NEVER_LOG'), false);
});
test('room monitoring emits room counts without retaining payloads or event data', async () => {
  const logs = [], handler = createCleanupHandler({ entity: 'Rooms', functionName: 'synthetic-room-cleanup', emit: (line) => logs.push(line),
    store: { cleanup: async () => ({ deleted: 2, examined: 3, more: false, oldestOverdueMs: 7, room: { private: 'NEVER_LOG' } }) } });
  await handler({ private: 'NEVER_LOG' });
  const metrics = JSON.parse(logs[0]); assert.equal(metrics.RoomsDeleted, 2); assert.equal(metrics.RoomsExamined, 3);
  assert.equal(metrics.PointsDeleted, undefined); assert.equal(logs.join('').includes('NEVER_LOG'), false);
  assert.throws(() => createCleanupHandler({ entity: 'arbitrary', functionName: 'synthetic', store: { cleanup() {} } }));
});
