import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccountBudget, AccountRateLimitedError } from '../src/accountBudget.mjs';
import { createSessionApi } from '../src/sessionApi.mjs';
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
  const config = { client, tableName: 'synthetic-account-budget', now: () => at, globalLimit: 5, accountLimit: 2, statusGlobalLimit: 5, statusAccountLimit: 2, ...options };
  return { consume: createAccountBudget(config), second: createAccountBudget(config), rows, calls, setTime: (value) => { at = value; } };
}
test('multiple instances share account/global caps; denied accounts allocate no rows or global permits', async () => {
  const h = fixture();
  const same = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? h.consume : h.second)('bootstrap', 'synthetic-subject')));
  assert.equal(same.filter((r) => r.status === 'fulfilled').length, 2);
  assert.equal(h.rows.size, 2); assert.equal(h.rows.get('ACCOUNT_RATE#bootstrap#1#GLOBAL').count, 2);
  const varied = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => h.consume('bootstrap', `synthetic-${i}`)));
  assert.equal(varied.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal(h.rows.size, 5); assert.equal(h.rows.get('ACCOUNT_RATE#bootstrap#1#GLOBAL').count, 5);
  await h.consume('logout', 'synthetic-subject'); // bootstrap/global exhaustion does not spend logout permits
  assert.equal(h.rows.get('ACCOUNT_RATE#logout#1#GLOBAL').count, 1);
  assert.equal(JSON.stringify(h.calls).includes('synthetic-subject'), false);
});
test('new windows do not rely on physical TTL deletion; no old permit is used after delay', async () => {
  const h = fixture(); await h.consume('bootstrap', 'synthetic'); await h.consume('bootstrap', 'synthetic'); h.setTime(119_001);
  await assert.rejects(h.consume('bootstrap', 'synthetic'), (e) => e instanceof AccountRateLimitedError && e.retryAfter === 1);
  h.setTime(120_000); await h.consume('bootstrap', 'synthetic');
  assert.equal(h.rows.size, 4); assert.equal(h.rows.get('ACCOUNT_RATE#bootstrap#1#GLOBAL').ttl, 180);
  for (const completion of [120_000, 59_999, NaN]) {
    let at = 60_000;
    const consume = createAccountBudget({ client: { send: async () => { at = completion; } }, tableName: 'synthetic-budget', now: () => at });
    await assert.rejects(consume('logout', 'synthetic'));
  }
});
test('invalid configuration/context and ambiguous storage failures deny without fallback', async () => {
  assert.throws(() => createAccountBudget({})); assert.throws(() => fixture({ accountLimit: 6 }));
  const h = fixture();
  for (const [operation, subject] of [['GET', 'synthetic'], ['logout', ''], ['bootstrap', undefined], ['bootstrap', 'x'.repeat(257)]])
    await assert.rejects(h.consume(operation, subject));
  assert.equal(h.calls.length, 0);
  for (const at of [NaN, -1, Number.MAX_SAFE_INTEGER]) { h.setTime(at); await assert.rejects(h.consume('logout', 'synthetic')); }
  assert.equal(h.calls.length, 0);
  for (const name of ['TimeoutError', 'TransactionCanceledException']) {
    const failed = fixture({ client: { send: async () => { throw Object.assign(new Error('private'), { name }); } } });
    await assert.rejects(failed.consume('logout', 'synthetic'), (e) => !(e instanceof AccountRateLimitedError));
  }
});
const secret = 'a'.repeat(64);
const event = (method, extra = {}) => ({ rawPath: '/v1/session', headers: { authorization: 'Bearer synthetic' }, requestContext: { http: { method } }, ...(method === 'POST' ? { body: JSON.stringify({ logoutSecret: secret }) } : {}), ...extra });
function api(overrides = {}) {
  const calls = [];
  const handler = createSessionApi({
    now: () => 60_000,
    consumeAccountBudget: async (...args) => calls.push(['budget', ...args]),
    consumeLogoutBudget: async () => calls.push(['capabilityBudget']),
    verifyToken: async () => { calls.push(['verify']); return { userId: 'verified-subject', sessionId: 'verified-family', expiresAt: 120_000, authenticatedAt: 60_000 }; },
    probeProvider: async () => calls.push(['provider']),
    registry: { admitted: async () => { calls.push(['admitted']); return true; }, registerWithLogout: async () => calls.push(['register']),
      active: async () => { calls.push(['active']); return true; }, revoke: async () => calls.push(['revoke']), revokeWithLogout: async () => calls.push(['capabilityRevoke']) },
    ...overrides,
  });
  return { handler, calls };
}
test('mandatory account budget derives only verified subject and precedes admission/provider/write effects', async () => {
  assert.throws(() => api({ consumeAccountBudget: undefined }));
  const post = api(); assert.equal((await post.handler(event('POST'))).statusCode, 200);
  assert.deepEqual(post.calls, [['verify'], ['budget', 'bootstrap', 'verified-subject'], ['admitted'], ['provider'], ['register']]);
  const del = api(); assert.equal((await del.handler(event('DELETE'))).statusCode, 200);
  assert.deepEqual(del.calls, [['verify'], ['budget', 'logout', 'verified-subject'], ['revoke']]);
  const denied = api({ verifyToken: async () => { throw new UnauthorizedError(); } });
  assert.equal((await denied.handler(event('POST'))).statusCode, 401); assert.deepEqual(denied.calls, []);
  const bodyId = api(); assert.equal((await bodyId.handler(event('POST', { body: JSON.stringify({ logoutSecret: secret, userId: 'body-subject' }) }))).statusCode, 400);
  assert.deepEqual(bodyId.calls, []);
});
test('429/outage denies signed effects and status reads with sanitised response; capability logout stays independent', async () => {
  for (const method of ['POST', 'DELETE', 'GET']) for (const error of [new AccountRateLimitedError(19), new Error('sensitive SDK text')]) {
    const h = api({ consumeAccountBudget: async () => { throw error; } });
    const response = await h.handler(event(method));
    assert.equal(response.statusCode, error instanceof AccountRateLimitedError ? 429 : 503);
    assert.equal(response.headers['Retry-After'], error instanceof AccountRateLimitedError ? '19' : undefined);
    assert.equal(response.headers['Cache-Control'], 'no-store'); assert.equal(response.body.includes('sensitive'), false);
    assert.deepEqual(h.calls, [['verify']]);
  }
  const h = api({ consumeAccountBudget: async () => { throw new Error('must not run'); } });
  assert.equal((await h.handler(event('POST', { rawPath: '/v1/session/logout' }))).statusCode, 200);
  assert.deepEqual(h.calls, [['capabilityBudget'], ['capabilityRevoke']]);
});

test('status verifies identity and envelope before budget, then checks live session', async () => {
  const h = api();
  assert.equal((await h.handler(event('GET'))).statusCode, 200);
  assert.deepEqual(h.calls, [['verify'], ['budget', 'status', 'verified-subject'], ['active']]);
  for (const extra of [{ body: '{"userId":"body-subject"}' }, { rawQueryString: 'userId=body-subject' }]) {
    const bad = api(); assert.equal((await bad.handler(event('GET', extra))).statusCode, 400); assert.deepEqual(bad.calls, []);
  }
  const bad = api({ verifyToken: async () => { throw new UnauthorizedError(); } });
  assert.equal((await bad.handler(event('GET'))).statusCode, 401); assert.deepEqual(bad.calls, []);
});
test('status shared caps bound allocation and rollback independently of bootstrap/logout pools', async () => {
  const h = fixture();
  const same = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? h.consume : h.second)('status', 'synthetic-status')));
  assert.equal(same.filter((r) => r.status === 'fulfilled').length, 2);
  assert.equal(h.rows.get('ACCOUNT_RATE#status#1#GLOBAL').count, 2); assert.equal(h.rows.size, 2);
  const varied = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => h.consume('status', `synthetic-${i}`)));
  assert.equal(varied.filter((r) => r.status === 'fulfilled').length, 3); assert.equal(h.rows.size, 5);
  assert.equal(h.rows.get('ACCOUNT_RATE#status#1#GLOBAL').count, 5);
  const handler = api({ consumeAccountBudget: h.consume });
  assert.equal((await handler.handler(event('GET'))).statusCode, 429);
  assert.equal((await handler.handler(event('POST'))).statusCode, 200);
  assert.equal((await handler.handler(event('DELETE'))).statusCode, 200);
  assert.equal((await handler.handler(event('POST', { rawPath: '/v1/session/logout' }))).statusCode, 200);
  h.setTime(120_000); await h.consume('status', 'synthetic-status');
  assert.equal(h.rows.get('ACCOUNT_RATE#status#2#GLOBAL').count, 1);
  assert.equal(h.rows.get('ACCOUNT_RATE#status#1#GLOBAL').ttl, 180);
});
test('status-only outage preserves both logout recovery paths and bootstrap', async () => {
  const h = api({ consumeAccountBudget: async (operation) => { if (operation === 'status') throw new Error('private storage error'); } });
  assert.equal((await h.handler(event('GET'))).statusCode, 503);
  assert.equal((await h.handler(event('DELETE'))).statusCode, 200);
  assert.equal((await h.handler(event('POST', { rawPath: '/v1/session/logout' }))).statusCode, 200);
  assert.equal((await h.handler(event('POST'))).statusCode, 200);
});
test('status defaults and configuration are independently bounded', async () => {
  for (const options of [{ statusGlobalLimit: 0 }, { statusGlobalLimit: 1001 }, { statusAccountLimit: 0 }, { statusAccountLimit: 601 }, { statusAccountLimit: NaN }])
    assert.throws(() => fixture(options));
  const writes = [];
  const consume = createAccountBudget({ client: { send: async (command) => writes.push(command.input.TransactItems) }, tableName: 'synthetic-budget', now: () => 60_000 });
  await consume('status', 'synthetic'); await consume('logout', 'synthetic'); await consume('bootstrap', 'synthetic');
  assert.deepEqual(writes.map((items) => items.map((item) => item.Update.ExpressionAttributeValues[':limit'])), [[600, 60], [60, 6], [60, 6]]);
});
