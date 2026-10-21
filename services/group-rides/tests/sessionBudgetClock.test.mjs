import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccountBudget, AccountRateLimitedError } from '../src/accountBudget.mjs';
import { createLogoutBudget, LogoutRateLimitedError } from '../src/logoutBudget.mjs';
import { createSessionApi } from '../src/sessionApi.mjs';

const variants = [
  { name: 'logout', create: createLogoutBudget, args: ['192.0.2.1'], Limited: LogoutRateLimitedError },
  { name: 'account', create: createAccountBudget, args: ['logout', 'synthetic-subject'], Limited: AccountRateLimitedError },
];
const denied = () => Object.assign(new Error('private storage detail'), {
  name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
});
function fixture(variant, completion, failure) {
  let samples = 0, sends = 0;
  const commands = [];
  const consume = variant.create({ tableName: 'synthetic-budget',
    now: () => ++samples === 1 ? 60_000 : completion,
    client: { async send(command) { sends++; commands.push(command.input); if (failure) throw failure; } },
  });
  return { consume, run: () => consume(...variant.args), commands, samples: () => samples, sends: () => sends };
}

for (const variant of variants) {
  test(`${variant.name}: invalid completion clocks fail closed after success and conditional denial`, async (t) => {
    for (const completion of [NaN, Infinity, -Infinity, '60001', null, undefined, 60_000.5, 59_999]) {
      for (const outcome of ['success', 'conditional']) await t.test(`${String(completion)} ${outcome}`, async () => {
        const h = fixture(variant, completion, outcome === 'conditional' ? denied() : undefined);
        await assert.rejects(h.run(), (error) => !(error instanceof variant.Limited));
        assert.equal(h.sends(), 1); // no refund, retry or fallback after a committed/denied send
        assert.equal(h.samples(), 2);
      });
    }
  });
  test(`${variant.name}: successful permit uses exactly one post-send sample within its original window`, async () => {
    for (const completion of [60_000, 60_001, 119_999]) {
      const h = fixture(variant, completion);
      await h.run(); assert.equal(h.samples(), 2); assert.equal(h.sends(), 1);
    }
    for (const completion of [120_000, 120_001]) {
      const h = fixture(variant, completion); await assert.rejects(h.run());
      assert.equal(h.samples(), 2); assert.equal(h.sends(), 1);
    }
  });
  test(`${variant.name}: valid conditional rejections retain bounded integer retry delays`, async () => {
    for (const [completion, retryAfter] of [[60_000, 60], [60_001, 60], [119_001, 1], [120_000, 1], [180_000, 1]]) {
      const h = fixture(variant, completion, denied());
      await assert.rejects(h.run(), (error) => error instanceof variant.Limited && error.retryAfter === retryAfter);
      assert.equal(h.samples(), 2); assert.equal(h.sends(), 1);
    }
  });
  test(`${variant.name}: unrelated and ambiguous storage errors propagate without sampling or compensation`, async () => {
    for (const failure of [new Error('private storage detail'), Object.assign(new Error('private storage detail'), { name: 'TransactionCanceledException' })]) {
      const h = fixture(variant, NaN, failure);
      await assert.rejects(h.run(), (error) => error === failure);
      assert.equal(h.samples(), 1); assert.equal(h.sends(), 1);
    }
  });
  test(`${variant.name}: real budget invalid clocks return sanitized no-store 503 before revocation`, async () => {
    for (const failure of [undefined, denied()]) {
      const h = fixture(variant, NaN, failure);
      let effects = 0;
      const handler = createSessionApi({
        verifyToken: async () => ({ userId: 'synthetic-subject' }), probeProvider: async () => {},
        consumeAccountBudget: variant.name === 'account' ? h.consume : async () => {},
        consumeLogoutBudget: variant.name === 'logout' ? h.consume : async () => {},
        registry: { admitted: async () => true, active: async () => true, registerWithLogout: async () => {},
          revoke: async () => { effects++; }, revokeWithLogout: async () => { effects++; } },
      });
      const logout = variant.name === 'logout';
      const response = await handler({ rawPath: logout ? '/v1/session/logout' : '/v1/session',
        requestContext: { http: { method: logout ? 'POST' : 'DELETE', sourceIp: '192.0.2.1' } },
        headers: { authorization: 'Bearer synthetic' }, ...(logout ? { body: JSON.stringify({ logoutSecret: 'a'.repeat(64) }) } : {}),
      });
      assert.equal(response.statusCode, 503); assert.equal(effects, 0);
      assert.equal(response.body, JSON.stringify({ error: 'ACCOUNT_SERVICE_UNAVAILABLE' }));
      assert.equal(response.headers['Retry-After'], undefined);
      assert.equal(response.headers['Cache-Control'], 'no-store'); assert.equal(h.sends(), 1);
    }
  });
}
