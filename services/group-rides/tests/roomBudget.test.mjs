import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoomBudget, RoomRateLimitedError } from '../src/roomBudget.mjs';
import { createRoomApi } from '../src/roomApi.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';
function fixture(options = {}) {
  let at = 60_000; const rows = new Map(), calls = [];
  const client = { async send(command) {
    const writes = command.input.TransactItems.map((entry) => entry.Update); calls.push(writes);
    assert.equal(command.constructor.name, 'TransactWriteCommand'); assert.equal(writes.length, 2);
    for (const write of writes) {
      assert.equal(write.UpdateExpression, 'SET #ttl = :ttl ADD #count :one');
      assert.equal(write.ConditionExpression, 'attribute_not_exists(#count) OR #count < :limit');
      if ((rows.get(write.Key.pk)?.count ?? 0) >= write.ExpressionAttributeValues[':limit'])
        throw Object.assign(new Error('private details'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
    }
    for (const write of writes) rows.set(write.Key.pk, { count: (rows.get(write.Key.pk)?.count ?? 0) + 1, ttl: write.ExpressionAttributeValues[':ttl'] });
  } };
  const config = { client, tableName: 'synthetic-room-budget', now: () => at, limits: { create: { global: 5, account: 2 }, redeem: { global: 5, account: 2 }, fix: { global: 5, account: 2 }, snapshot: { global: 5, account: 2 }, invite: { global: 5, account: 2 }, control: { global: 5, account: 2 } }, ...options };
  return { consume: createRoomBudget(config), second: createRoomBudget(config), rows, calls, setTime: (value) => { at = value; } };
}
test('multiple instances share account/global caps; denied accounts allocate no rows or global permits', async () => {
  const h = fixture();
  const same = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? h.consume : h.second)('create', 'synthetic-subject')));
  assert.equal(same.filter((r) => r.status === 'fulfilled').length, 2);
  assert.equal(h.rows.size, 2); assert.equal(h.rows.get('ROOM_RATE#create#1#GLOBAL').count, 2);
  const varied = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => h.consume('create', `synthetic-${i}`)));
  assert.equal(varied.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal(h.rows.size, 5); assert.equal(h.rows.get('ROOM_RATE#create#1#GLOBAL').count, 5);
  await h.consume('redeem', 'synthetic-subject'); // creation exhaustion does not spend redemption permits
  assert.equal(h.rows.get('ROOM_RATE#redeem#1#GLOBAL').count, 1);
  await h.consume('fix', 'synthetic-subject');
  assert.equal(h.rows.get('ROOM_RATE#fix#1#GLOBAL').count, 1);
  assert.equal(JSON.stringify(h.calls).includes('synthetic-subject'), false);
});
test('new windows do not rely on physical TTL deletion; no old permit is used after delay', async () => {
  const h = fixture(); await h.consume('create', 'synthetic'); await h.consume('create', 'synthetic'); h.setTime(119_001);
  await assert.rejects(h.consume('create', 'synthetic'), (e) => e instanceof RoomRateLimitedError && e.retryAfter === 1);
  h.setTime(120_000); await h.consume('create', 'synthetic');
  assert.equal(h.rows.size, 4); assert.equal(h.rows.get('ROOM_RATE#create#1#GLOBAL').ttl, 180);
  for (const completion of [120_000, 59_999, NaN]) {
    let at = 60_000;
    const consume = createRoomBudget({ client: { send: async () => { at = completion; } }, tableName: 'synthetic-budget', now: () => at });
    await assert.rejects(consume('redeem', 'synthetic'));
  }
});
test('invalid configuration/context and ambiguous storage failures deny without fallback', async () => {
  assert.throws(() => createRoomBudget({})); assert.throws(() => fixture({ limits: { create: { global: 5, account: 6 } } }));
  const h = fixture();
  for (const [operation, subject] of [[undefined, 'synthetic'], ['__proto__', 'synthetic'], ['GET', 'synthetic'], ['redeem', ''], ['create', undefined], ['create', 'x'.repeat(257)]])
    await assert.rejects(h.consume(operation, subject));
  assert.equal(h.calls.length, 0);
  for (const at of [NaN, -1, Number.MAX_SAFE_INTEGER]) { h.setTime(at); await assert.rejects(h.consume('redeem', 'synthetic')); }
  assert.equal(h.calls.length, 0);
  for (const name of ['TimeoutError', 'TransactionCanceledException']) {
    const failed = fixture({ client: { send: async () => { throw Object.assign(new Error('private'), { name }); } } });
    await assert.rejects(failed.consume('redeem', 'synthetic'), (e) => !(e instanceof RoomRateLimitedError));
  }
});
const id = 'a'.repeat(64);
const event = (method, path, input = {}) => ({ rawPath: path, headers: { authorization: 'Bearer synthetic' },
  requestContext: { http: { method } }, body: JSON.stringify(input) });
const routes = [
  ['create', event('POST', '/v1/rooms', { command: { id: 'synthetic' }, title: 'Ride' }), 201],
  ['redeem', event('POST', `/v1/rooms/${id}/members`, { inviteToken: 'synthetic-capability' }), 200],
  ['fix', event('PUT', `/v1/rooms/${id}/fix`, { version: 1, fix: {} }), 200],
  ['snapshot', event('GET', `/v1/rooms/${id}`), 200],
  ['invite', event('POST', `/v1/rooms/${id}/invites`), 200],
  ['control', event('POST', `/v1/rooms/${id}/start`, { command: {} }), 200],
  ['control', event('PUT', `/v1/rooms/${id}/profile`, { command: {}, displayName: 'Rider' }), 200],
  ['control', event('PUT', `/v1/rooms/${id}/sharing`, { command: {}, enabled: true }), 200],
];
function api(overrides = {}) {
  const calls = [];
  const effect = (name) => async () => { calls.push([name]); return {}; };
  const handler = createRoomApi({ authorize: async () => { calls.push(['authorize']); return { userId: 'verified-subject', sessionId: 'verified-family' }; },
    consumeRoomBudget: async (...args) => calls.push(['budget', ...args]),
    rooms: { create: effect('create'), join: effect('redeem'), read: effect('snapshot'), invite: effect('invite'), start: effect('control'), updateProfile: effect('control'), sharing: effect('control'), remove: effect('remove'), leave: effect('leave'), end: effect('end') },
    locations: { publish: effect('fix'), read: effect('snapshot') }, ...overrides });
  return { handler, calls };
}
test('mandatory room budget derives only authorised account and precedes all protected effects', async () => {
  assert.throws(() => api({ consumeRoomBudget: undefined }));
  for (const [operation, request, status] of routes) {
    const h = api(); assert.equal((await h.handler(request)).statusCode, status);
    assert.deepEqual(h.calls, [['authorize'], ['budget', operation, 'verified-subject'], [operation]]);
    const denied = api({ authorize: async () => { throw new UnauthorizedError(); } });
    assert.equal((await denied.handler(request)).statusCode, 401); assert.deepEqual(denied.calls, []);
    const bad = api();
    assert.equal((await bad.handler({ ...request, body: JSON.stringify({ userId: 'body-subject' }) })).statusCode, 400);
    assert.deepEqual(bad.calls, [['authorize']]);
    for (const body of ['{', 'x'.repeat(12_001)]) {
      const malformed = api(); assert.equal((await malformed.handler({ ...request, body })).statusCode, 400);
      assert.deepEqual(malformed.calls, [['authorize']]);
    }
  }
});
test('limits and storage failures deny every protected effect with sanitised no-store responses', async () => {
  for (const [, request] of routes) for (const error of [new RoomRateLimitedError(19), new Error('sensitive SDK text')]) {
    const h = api({ consumeRoomBudget: async () => { throw error; } });
    const response = await h.handler(request);
    assert.equal(response.statusCode, error instanceof RoomRateLimitedError ? 429 : 503);
    assert.deepEqual(JSON.parse(response.body), { error: error instanceof RoomRateLimitedError ? 'ROOM_RATE_LIMITED' : 'GROUP_SERVICE_UNAVAILABLE' });
    assert.equal(response.headers['Retry-After'], error instanceof RoomRateLimitedError ? '19' : undefined);
    assert.equal(response.headers['Cache-Control'], 'no-store'); assert.deepEqual(h.calls, [['authorize']]);
  }
});
test('exhaustion and counter-store outages leave stop-sharing, removal, leave and end available', async () => {
  for (const error of [new RoomRateLimitedError(30), new Error('synthetic storage outage')]) {
    const h = api({ consumeRoomBudget: async () => { throw error; } });
    for (const request of [event('PUT', `/v1/rooms/${id}/sharing`, { enabled: false, command: {} }),
      event('DELETE', `/v1/rooms/${id}/members/me`, { command: {} }),
      event('DELETE', `/v1/rooms/${id}/members/synthetic-member`, { command: {} }), event('POST', `/v1/rooms/${id}/end`, { command: {} })])
      assert.equal((await h.handler(request)).statusCode, 200);
    assert.deepEqual(h.calls.filter(([name]) => name !== 'authorize'), [['control'], ['leave'], ['remove'], ['end']]);
    assert.equal((await h.handler(event('POST', `/v1/rooms/${id}/fix`))).statusCode, 404);
    assert.equal((await h.handler({ ...routes[0][1], rawQueryString: 'userId=body-subject' })).statusCode, 400);
  }
});
test('default operation capacities and immutable configuration are explicit', async () => {
  const calls = [];
  const consume = createRoomBudget({ client: { send: async (c) => calls.push(c.input) }, tableName: 'synthetic-budget', now: () => 60_000 });
  for (const operation of ['create', 'redeem', 'fix', 'snapshot', 'invite', 'control']) await consume(operation, 'synthetic');
  assert.deepEqual(calls.map((c) => c.TransactItems.map((t) => t.Update.ExpressionAttributeValues[':limit'])), [[60, 6], [120, 12], [600, 60], [600, 60], [60, 6], [120, 12]]);
  const limits = { create: { global: 5, account: 1 }, redeem: { global: 5, account: 1 }, fix: { global: 5, account: 1 }, snapshot: { global: 5, account: 1 }, invite: { global: 5, account: 1 }, control: { global: 5, account: 1 } };
  const h = fixture({ limits }); limits.create.account = 5;
  await h.consume('create', 'synthetic'); await assert.rejects(h.consume('create', 'synthetic'), RoomRateLimitedError);
});


test('failed counter transactions never emit invalid retry headers when the clock fails', async () => {
  for (const completion of [NaN, 59_999, Infinity]) {
    let at = 60_000;
    const consume = createRoomBudget({ tableName: 'synthetic-budget', now: () => at, client: { send: async () => {
      at = completion;
      throw Object.assign(new Error('private'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
    } } });
    await assert.rejects(consume('fix', 'synthetic'), (e) => !(e instanceof RoomRateLimitedError));
  }
});

test('new operation pools share caps across instances without spending each other or allocating denied rows', async () => {
  const h = fixture();
  for (const operation of ['snapshot', 'invite', 'control']) {
    const same = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? h.consume : h.second)(operation, 'synthetic-one')));
    assert.equal(same.filter((r) => r.status === 'fulfilled').length, 2);
    assert.equal(h.rows.get(`ROOM_RATE#${operation}#1#GLOBAL`).count, 2);
    const varied = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => h.consume(operation, `synthetic-${i}`)));
    assert.equal(varied.filter((r) => r.status === 'fulfilled').length, 3);
    assert.equal([...h.rows.keys()].filter((key) => key.startsWith(`ROOM_RATE#${operation}#`)).length, 5);
    assert.equal(h.rows.get(`ROOM_RATE#${operation}#1#GLOBAL`).count, 5);
  }
  for (const operation of ['create', 'redeem', 'fix']) await h.consume(operation, 'synthetic-one');
  assert.equal(JSON.stringify(h.calls).includes('synthetic-one'), false);
});
test('only literal sharing false avoids control budget; malformed enable requests cannot bypass it', async () => {
  for (const enabled of [undefined, null, 0, '', 'false', [], {}]) {
    const h = api({ consumeRoomBudget: async () => { throw new RoomRateLimitedError(10); } });
    assert.equal((await h.handler(event('PUT', `/v1/rooms/${id}/sharing`, { enabled, command: {} }))).statusCode, 429);
    assert.deepEqual(h.calls, [['authorize']]);
  }
});
test('snapshot fallback without location service retains mandatory snapshot budget', async () => {
  const h = api({ locations: undefined });
  assert.equal((await h.handler(event('GET', `/v1/rooms/${id}`))).statusCode, 200);
  assert.deepEqual(h.calls, [['authorize'], ['budget', 'snapshot', 'verified-subject'], ['snapshot']]);
});
