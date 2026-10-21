import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogoutBudget, LogoutRateLimitedError } from '../src/logoutBudget.mjs';
import { createSessionApi } from '../src/sessionApi.mjs';

const WINDOW_MS = 60_000;
const latest = Number.MAX_SAFE_INTEGER - 2 * WINDOW_MS;
function fixture(at, failure) {
  const commands = []; let samples = 0;
  const consume = createLogoutBudget({ tableName: 'synthetic-budget', now: () => { samples++; return at; },
    client: { async send(command) { commands.push(command.input); if (failure) throw failure; } },
  });
  return { consume, commands, samples: () => samples };
}

test('logout rejects clocks outside arithmetic headroom before SDK send', async (t) => {
  for (const at of [latest + 1, Number.MAX_SAFE_INTEGER - WINDOW_MS, Number.MAX_SAFE_INTEGER]) {
    await t.test(`unsupported clock ${at}`, async () => {
      const h = fixture(at);
      await assert.rejects(h.consume('192.0.2.1'), /Logout clock unavailable/);
      assert.equal(h.samples(), 1); assert.equal(h.commands.length, 0);
    });
  }
});

test('logout preserves safe window and TTL arithmetic at supported boundaries', async () => {
  for (const at of [0, 59_999, 60_000, latest - 1, latest]) {
    const h = fixture(at); await h.consume('192.0.2.1');
    assert.equal(h.samples(), 2); assert.equal(h.commands.length, 1);
    const window = Math.floor(at / WINDOW_MS), end = (window + 1) * WINDOW_MS;
    assert.ok(Number.isSafeInteger(end + WINDOW_MS));
    const writes = h.commands[0].TransactItems.map(({ Update }) => Update);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].Key.pk, `LOGOUT_RATE#${window}#GLOBAL`);
    for (const write of writes) {
      assert.equal(write.ExpressionAttributeValues[':ttl'], Math.ceil((end + WINDOW_MS) / 1000));
      assert.equal(write.ConditionExpression, 'attribute_not_exists(#count) OR #count < :limit');
    }
  }
});

test('logout preserves bounded retry at the last supported initial clock', async () => {
  const failure = Object.assign(new Error('private storage detail'), { name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
  const h = fixture(latest, failure);
  const end = (Math.floor(latest / WINDOW_MS) + 1) * WINDOW_MS;
  await assert.rejects(h.consume('192.0.2.1'), (error) => error instanceof LogoutRateLimitedError
    && error.retryAfter === Math.ceil((end - latest) / 1000));
  assert.equal(h.commands.length, 1); assert.equal(h.samples(), 2);
});

test('unsupported logout clock produces sanitized 503 before storage or revocation', async () => {
  const h = fixture(Number.MAX_SAFE_INTEGER); let effects = 0;
  const handler = createSessionApi({ consumeLogoutBudget: h.consume, consumeAccountBudget: async () => {},
    verifyToken: async () => { throw new Error('capability logout needs no JWT'); }, probeProvider: async () => {},
    registry: { admitted: async () => true, active: async () => true, registerWithLogout: async () => {},
      revoke: async () => { effects++; }, revokeWithLogout: async () => { effects++; } },
  });
  const response = await handler({ rawPath: '/v1/session/logout',
    requestContext: { http: { method: 'POST', sourceIp: '192.0.2.1' } },
    body: JSON.stringify({ logoutSecret: 'a'.repeat(64) }),
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body, JSON.stringify({ error: 'ACCOUNT_SERVICE_UNAVAILABLE' }));
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.headers['Retry-After'], undefined);
  assert.equal(effects, 0); assert.equal(h.commands.length, 0); assert.equal(h.samples(), 1);
});
