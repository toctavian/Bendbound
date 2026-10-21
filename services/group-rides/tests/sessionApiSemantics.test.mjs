import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionApi } from '../src/sessionApi.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';

const at = 1_000_000;
const sentinel = 'SYNTHETIC_PRIVATE_SEMANTIC_SENTINEL';
const secret = 'a'.repeat(64);
const principal = { userId: 'synthetic-user', sessionId: 'synthetic-family', expiresAt: at + 1000, authenticatedAt: at };
const orders = {
  POST: ['verify', 'budget', 'admitted', 'probe', 'register', 'clock'],
  GET: ['verify', 'budget', 'active', 'clock'],
  DELETE: ['verify', 'budget', 'revoke'],
  logout: ['logoutBudget', 'revokeWithLogout'],
};
function event(method) {
  return { rawPath: method === 'logout' ? '/v1/session/logout' : '/v1/session',
    requestContext: { http: { method: method === 'logout' ? 'POST' : method, sourceIp: 'synthetic-source' } },
    headers: { authorization: `Bearer ${sentinel}` },
    ...(['POST', 'logout'].includes(method) ? { body: JSON.stringify({ logoutSecret: secret }) } : {}) };
}
function fixture({ hooks = {}, value = principal, clock = () => at } = {}) {
  const calls = [];
  const effect = (name, result) => async (...args) => {
    calls.push(name);
    if (hooks[name]) await hooks[name](...args);
    return result;
  };
  const api = createSessionApi({
    verifyToken: effect('verify', value), consumeAccountBudget: effect('budget'),
    probeProvider: effect('probe'), consumeLogoutBudget: effect('logoutBudget'),
    registry: { admitted: effect('admitted', hooks.deniedAdmission ? false : true),
      active: effect('active', hooks.inactive ? false : true),
      registerWithLogout: effect('register'), revoke: effect('revoke'), revokeWithLogout: effect('revokeWithLogout') },
    now: () => { calls.push('clock'); return clock(); },
  });
  return { api, calls };
}
function responseEquals(response, statusCode, body) {
  assert.deepEqual(response, { statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    body: JSON.stringify(body) });
  assert.equal(JSON.stringify(response).includes(sentinel), false);
  assert.equal(JSON.stringify(response).includes(secret), false);
}
const unauthorized = (response) => responseEquals(response, 401, { error: 'UNAUTHORIZED' });

test('pilot denial stops bootstrap before provider, registration and response clock', async () => {
  const h = fixture({ hooks: { deniedAdmission: true } });
  unauthorized(await h.api(event('POST')));
  assert.deepEqual(h.calls, ['verify', 'budget', 'admitted']);
});

test('inactive status stops before response clock and cannot bootstrap a family', async () => {
  const h = fixture({ hooks: { inactive: true } });
  unauthorized(await h.api(event('GET')));
  assert.deepEqual(h.calls, ['verify', 'budget', 'active']);
});

for (const method of ['POST', 'GET', 'DELETE', 'logout']) {
  for (const stage of orders[method].filter((name) => name !== 'clock')) {
    test(`${method}: unauthorized ${stage} stops all subsequent effects`, async () => {
      const h = fixture({ hooks: { [stage]: async () => {
        throw Object.assign(new UnauthorizedError(), { message: sentinel, cause: new Error(sentinel) });
      } } });
      unauthorized(await h.api(event(method)));
      assert.deepEqual(h.calls, orders[method].slice(0, orders[method].indexOf(stage) + 1));
    });
  }
}

for (const method of ['POST', 'GET']) {
  for (const stage of orders[method].filter((name) => name !== 'clock')) {
    for (const elapsed of [999, 1000, 1001]) {
      test(`${method}: response deadline after awaited ${stage}, elapsed ${elapsed}`, async () => {
        let time = at;
        const h = fixture({ clock: () => time, hooks: { [stage]: async () => {
          // Move time only after an asynchronous boundary in the selected effect.
          await Promise.resolve();
          time += elapsed;
        } } });
        const response = await h.api(event(method));
        if (elapsed < 1000) responseEquals(response, 200, { userId: principal.userId, expiresAt: principal.expiresAt, serverTime: time });
        else unauthorized(response);
        // The API's final token deadline check happens after registration/status.
        // These stubs prove ordering, not registry mutation or admission validity.
        assert.deepEqual(h.calls, orders[method]);
      });
    }
  }

  for (const invalid of [NaN, Infinity, -Infinity, undefined, null, '1000000']) {
    test(`${method}: invalid response clock ${String(invalid)} denies success`, async () => {
      const h = fixture({ clock: () => invalid });
      unauthorized(await h.api(event(method)));
      assert.deepEqual(h.calls, orders[method]);
    });
  }
  test(`${method}: throwing response clock returns sanitized service failure`, async () => {
    const h = fixture({ clock: () => { throw new Error(sentinel); } });
    responseEquals(await h.api(event(method)), 503, { error: 'ACCOUNT_SERVICE_UNAVAILABLE' });
    assert.deepEqual(h.calls, orders[method]);
  });
  for (const expiresAt of [NaN, Infinity, -Infinity, undefined, null, '1001000']) {
    test(`${method}: nonfinite/nonnumeric verified expiry ${String(expiresAt)} cannot return success`, async () => {
      // Deliberately defective verifier stub exercises API defence in depth only.
      const h = fixture({ value: { ...principal, expiresAt } });
      unauthorized(await h.api(event(method)));
      assert.deepEqual(h.calls, orders[method]);
    });
  }
}

for (const method of ['DELETE', 'logout']) {
  test(`${method}: revocation does not consult status clock or active/admission checks`, async () => {
    const h = fixture({ value: { ...principal, expiresAt: at }, hooks: { deniedAdmission: true, inactive: true },
      clock: () => { throw new Error(sentinel); } });
    const request = event(method);
    if (method === 'logout') delete request.headers;
    // DELETE still invokes the verifier; the stub does not prove expired tokens
    // pass real verification. Secret logout has no access-token dependency.
    responseEquals(await h.api(request), 200, { revoked: true });
    assert.deepEqual(h.calls, orders[method]);
  });
}
