import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCleanupHandler } from '../src/cleanupWorker.mjs';
import { createDynamoLocationStore } from '../src/locationStore.mjs';
test('cleanup metrics allow only aggregates and one bounded function dimension', async () => {
  const lines = []; let budget;
  const handler = createCleanupHandler({ functionName: 'synthetic-cleanup', now: () => 1000, emit: (line) => lines.push(line),
    store: { cleanup: async (at, options) => { assert.equal(at, 1000); budget = options.shouldContinue(); return { deleted: 4, examined: 5, more: true, oldestOverdueMs: 30, token: 'NEVER_LOG_THIS', fix: { latitude: 0 } }; } } });
  const result = await handler({ token: 'NEVER_LOG_EVENT' }, { getRemainingTimeInMillis: () => 10_000 });
  assert.equal(budget, true); assert.deepEqual(result, { deleted: 4, examined: 5, more: true, oldestOverdueMs: 30 });
  const metric = JSON.parse(lines[0]); assert.equal(metric.CleanupSucceeded, 1); assert.equal(metric.CleanupBacklog, 1);
  assert.deepEqual(metric._aws.CloudWatchMetrics[0].Dimensions, [['FunctionName']]);
  assert.equal(metric._aws.CloudWatchMetrics[0].Namespace, 'Bendbound/GroupRides');
  assert.equal(lines.join('').includes('NEVER_LOG'), false); assert.equal(lines.join('').includes('latitude'), false);
});
test('hard failures emit failure metric and a generic exception without cause/payload', async () => {
  const lines = [];
  const handler = createCleanupHandler({ functionName: 'synthetic-cleanup', now: () => 1000, emit: (line) => lines.push(line),
    store: { cleanup: async () => { throw new Error('NEVER_LOG_THIS_TOKEN_OR_LOCATION'); } } });
  await assert.rejects(handler({ secret: 'NEVER_LOG_EVENT' }), (error) => error.message === 'GROUP_LOCATION_CLEANUP_FAILED' && !error.cause);
  assert.equal(JSON.parse(lines[0]).CleanupFailed, 1); assert.equal(JSON.parse(lines[0]).CleanupSucceeded, 0);
  assert.equal(lines.join('').includes('NEVER_LOG'), false);
});
test('time budget pauses before a query and reports backlog rather than claiming completion', async () => {
  let calls = 0;
  const store = createDynamoLocationStore({ client: { send: async () => { calls++; throw new Error('must not run'); } },
    registry: { allowsUser: () => true, transactionChecks() {} }, tableName: 'locations', roomTableName: 'rooms', sessionTableName: 'sessions' });
  const handler = createCleanupHandler({ functionName: 'synthetic-cleanup', now: () => 1000, emit() {}, store });
  assert.deepEqual(await handler({}, { getRemainingTimeInMillis: () => 4000 }), { deleted: 0, examined: 0, more: true, oldestOverdueMs: 0 });
  assert.equal(calls, 0);
});
test('mid-page budget stop is safe and oldest observed overdue age is preserved', async () => {
  let checks = 0, deletes = 0;
  const store = createDynamoLocationStore({ client: { send: async (command) => {
    if (command.constructor.name === 'QueryCommand') return { Items: [
      { pk: 'synthetic', sk: 'one', pointVersion: 'v1', expiresAt: 10 }, { pk: 'synthetic', sk: 'two', pointVersion: 'v2', expiresAt: 20 },
    ] };
    deletes++; return {};
  } }, registry: { allowsUser: () => true, transactionChecks() {} }, tableName: 'locations', roomTableName: 'rooms', sessionTableName: 'sessions' });
  assert.deepEqual(await store.cleanup(1000, { shouldContinue: () => ++checks <= 2 }), { deleted: 1, examined: 1, more: true, oldestOverdueMs: 990 });
  assert.equal(deletes, 1);
});
test('parallel cleanup awaits every launched deletion before surfacing a hard failure', async () => {
  let settled = 0;
  const store = createDynamoLocationStore({ client: { send: async (command) => {
    if (command.constructor.name === 'QueryCommand') return { Items: Array.from({ length: 8 }, (_, index) => ({ pk: 'synthetic', sk: String(index), pointVersion: 'v1', expiresAt: 10 })) };
    await new Promise((resolve) => setTimeout(resolve, command.input.Key.sk === '0' ? 1 : 10));
    settled++;
    if (command.input.Key.sk === '0') throw new Error('outage');
    return {};
  } }, registry: { allowsUser: () => true, transactionChecks() {} }, tableName: 'locations', roomTableName: 'rooms', sessionTableName: 'sessions' });
  await assert.rejects(store.cleanup(1000), /outage/);
  assert.equal(settled, 8);
});
