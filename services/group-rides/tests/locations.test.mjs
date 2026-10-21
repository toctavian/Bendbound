import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocationService, validFix, FIX_LIMITS } from '../src/locations.mjs';
import { createRoomApi } from '../src/roomApi.mjs';
import { createDynamoLocationStore } from '../src/locationStore.mjs';
const at = 1_000_000, epoch = 'synthetic-device-epoch';
const fix = { latitude: 0, longitude: 0, accuracyM: 5, headingDeg: null, speedMps: null, capturedAt: at, sessionEpoch: epoch, sequence: 1 };
test('server validates exact fix shape and capture age without clamping', () => {
  assert.equal(validFix(fix, at), true);
  for (const patch of [{ latitude: 91 }, { longitude: -181 }, { accuracyM: 101 }, { capturedAt: at - 15_001 },
    { capturedAt: at + 1001 }, { sequence: -1 }, { sequence: 1.2 }, { speedMps: 151 }, { headingDeg: 360 },
    { sessionEpoch: 'short' }, { userId: 'injected' }, { receivedAt: at }]) assert.equal(validFix({ ...fix, ...patch }, at), false);
  assert.equal(validFix(null, at), false);
  assert.equal(validFix({ ...fix, speedMps: 150, headingDeg: 359, capturedAt: at - 15_000 }, at), true);
});
test('server fix policy matches client limits', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../../src/types/groupRide.ts', import.meta.url), 'utf8');
  for (const [name, value] of Object.entries(FIX_LIMITS)) {
    const literal = source.match(new RegExp(`${name}: ([\\d_]+)`))?.[1];
    assert.equal(Number(literal?.replaceAll('_', '')), value);
  }
});
test('permission/storage latency rechecks capture age; no stale write is committed', async () => {
  let clock = at, writes = 0;
  const service = createLocationService({ now: () => clock, rooms: { publicationLease: async () => ({}) },
    store: { read: async () => { clock += 16_000; return null; }, commit: async () => { writes++; } } });
  await assert.rejects(service.publish({}, 'synthetic', { version: 1, fix }), { code: 'INVALID_FIX' });
  assert.equal(writes, 0);
});
test('fix route rejects body identity and hides internal service failures', async () => {
  let calls = 0;
  const api = createRoomApi({ consumeRoomBudget: async () => {}, authorize: async () => ({ userId: 'verified' }), rooms: {}, locations: { publish: async () => { calls++; throw new Error('sensitive failure'); } } });
  const event = { rawPath: `/v1/rooms/${'a'.repeat(64)}/fix`, requestContext: { http: { method: 'PUT' } } };
  assert.equal((await api({ ...event, body: JSON.stringify({ version: 1, fix, userId: 'injected' }) })).statusCode, 400);
  assert.equal(calls, 0);
  const response = await api({ ...event, body: JSON.stringify({ version: 1, fix }) });
  assert.equal(response.statusCode, 503); assert.equal(response.body.includes('sensitive'), false);
  assert.equal(response.headers['Cache-Control'], 'no-store');
});
test('cleanup paginates and skips refreshed versions from an eventually consistent index', async () => {
  let queries = 0, deletes = 0;
  const client = { send: async (command) => {
    if (command.constructor.name === 'QueryCommand') {
      queries++; assert.equal(command.input.IndexName, 'ExpiryIndex');
      return { Items: [{ pk: 'ROOM#synthetic', sk: `RIDER#${queries}`, pointVersion: 'old' }], ...(queries === 1 ? { LastEvaluatedKey: { pk: 'cursor' } } : {}) };
    }
    deletes++; assert.equal(command.input.ConditionExpression, '#version = :version AND expiresAt <= :now');
    if (deletes === 1) throw Object.assign(new Error('new version'), { name: 'ConditionalCheckFailedException' });
    return {};
  } };
  const store = createDynamoLocationStore({ client, tableName: 'locations', roomTableName: 'rooms', sessionTableName: 'sessions', registry: { allowsUser: () => true, transactionChecks: () => [] } });
  assert.deepEqual(await store.cleanup(at), { deleted: 1, examined: 2, more: false, oldestOverdueMs: 0 });
});
test('location store forbids retained table reuse and propagates outages', async () => {
  assert.throws(() => createDynamoLocationStore({ client: { send() {} }, tableName: 'sessions', roomTableName: 'rooms', sessionTableName: 'sessions', registry: { allowsUser: () => true, transactionChecks() {} } }));
  const store = createDynamoLocationStore({ client: { send: async () => { throw new Error('outage'); } }, tableName: 'locations', roomTableName: 'rooms', sessionTableName: 'sessions', registry: { allowsUser: () => true, transactionChecks: () => [] } });
  await assert.rejects(store.cleanup(at), /outage/);
});
