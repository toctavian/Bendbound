import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogoutBudget, LogoutRateLimitedError } from '../src/logoutBudget.mjs';
import { createSessionApi } from '../src/sessionApi.mjs';
function fixture(options = {}) {
  let at = 60_000; const rows = new Map(), calls = [];
  const client = { async send(command) {
    const writes = command.input.TransactItems.map((entry) => entry.Update); calls.push(writes);
    assert.equal(command.constructor.name, 'TransactWriteCommand'); assert.equal(writes.length, 2);
    for (const write of writes) {
      assert.equal(write.UpdateExpression, 'SET #ttl = :ttl ADD #count :one');
      assert.equal(write.ConditionExpression, 'attribute_not_exists(#count) OR #count < :limit');
      if ((rows.get(write.Key.pk)?.count ?? 0) >= write.ExpressionAttributeValues[':limit'])
        throw Object.assign(new Error('private conditional details'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
    }
    for (const write of writes) rows.set(write.Key.pk, { count: (rows.get(write.Key.pk)?.count ?? 0) + 1, ttl: write.ExpressionAttributeValues[':ttl'] });
  } };
  const config = { client, tableName: 'synthetic-budget', now: () => at, globalLimit: 5, sourceLimit: 2, ...options };
  return { consume: createLogoutBudget(config), second: createLogoutBudget(config), rows, calls, setTime: (value) => { at = value; } };
}
test('concurrent Lambda instances share source/global caps and denied sources cannot allocate rows', async () => {
  const h = fixture();
  const same = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? h.consume : h.second)('192.0.2.1')));
  assert.equal(same.filter((r) => r.status === 'fulfilled').length, 2);
  assert.equal(h.rows.size, 2); assert.equal([...h.rows.values()][0].count, 2);
  const varied = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => h.consume(`192.0.2.${i + 2}`)));
  assert.equal(varied.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal(h.rows.size, 5); // global + four admitted sources, never twenty new denied sources
  assert.equal([...h.rows.values()][0].count, 5);
});
test('logical windows reset without relying on TTL; boundary bursts and retry delays are bounded', async () => {
  const h = fixture(); await h.consume('2001:db8::1'); await h.consume('2001:db8::1'); h.setTime(119_001);
  await assert.rejects(h.consume('2001:db8::1'), (e) => e instanceof LogoutRateLimitedError && e.retryAfter === 1);
  h.setTime(120_000); await h.consume('2001:db8::1');
  assert.equal(h.rows.size, 4); assert.equal([...h.rows.values()][0].ttl, 180);
  const stored = JSON.stringify(h.calls);
  assert.equal(stored.includes('2001:db8::1'), false); assert.equal(stored.includes('logoutSecret'), false);
});
test('invalid configuration, absent source, outages and stale permits fail closed', async () => {
  assert.throws(() => createLogoutBudget({})); assert.throws(() => fixture({ sourceLimit: 6 }));
  const h = fixture(); for (const source of [undefined, '', 'spoofed', '192.0.2.1, 192.0.2.2']) await assert.rejects(h.consume(source));
  assert.equal(h.calls.length, 0);
  for (const name of ['TimeoutError', 'TransactionCanceledException']) {
    const failed = fixture({ client: { send: async () => { throw Object.assign(new Error('private details'), { name }); } } });
    await assert.rejects(failed.consume('192.0.2.1'), (e) => !(e instanceof LogoutRateLimitedError));
  }
  let time = 60_000;
  const stale = createLogoutBudget({ client: { send: async () => { time = 120_000; } }, tableName: 'synthetic-budget', now: () => time });
  await assert.rejects(stale('192.0.2.1'));
});
const secret = 'a'.repeat(64);
function api(consumeLogoutBudget) {
  let revocations = 0;
  const registry = { admitted: async () => true, active: async () => true, registerWithLogout: async () => {}, revoke: async () => {}, revokeWithLogout: async () => { revocations++; } };
  return { handler: createSessionApi({ consumeAccountBudget: async () => {}, consumeLogoutBudget, registry, verifyToken: async () => { throw new Error('JWT must not be required for capability logout'); }, probeProvider: async () => {} }), count: () => revocations };
}
const request = { rawPath: '/v1/session/logout', requestContext: { http: { method: 'POST', sourceIp: '192.0.2.1' } }, headers: { 'x-forwarded-for': '192.0.2.2' }, body: JSON.stringify({ logoutSecret: secret }) };
test('API requires budget and uses gateway source only, denying before revocation and sanitising errors', async () => {
  assert.throws(() => createSessionApi({})); assert.throws(() => api(undefined));
  const sources = [], accepted = api(async (source) => sources.push(source));
  assert.equal((await accepted.handler(request)).statusCode, 200); assert.deepEqual(sources, ['192.0.2.1']); assert.equal(accepted.count(), 1);
  for (const error of [new LogoutRateLimitedError(17), new Error('sensitive details')]) {
    const h = api(async () => { throw error; }), response = await h.handler(request);
    assert.equal(response.statusCode, error instanceof LogoutRateLimitedError ? 429 : 503);
    assert.equal(h.count(), 0); assert.equal(response.body.includes('sensitive'), false);
    assert.equal(response.headers['Retry-After'], error instanceof LogoutRateLimitedError ? '17' : undefined);
    assert.equal(response.headers['Cache-Control'], 'no-store');
  }
  const h = api(fixture().consume);
  assert.equal((await h.handler({ ...request, requestContext: { http: { method: 'POST' } } })).statusCode, 503); assert.equal(h.count(), 0);
  assert.equal((await h.handler({ ...request, body: '{"logoutSecret":"bad"}' })).statusCode, 400);
});
