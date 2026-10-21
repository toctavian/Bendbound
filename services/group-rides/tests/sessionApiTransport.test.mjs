import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionApi } from '../src/sessionApi.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';
import { AccountRateLimitedError } from '../src/accountBudget.mjs';
import { LogoutRateLimitedError } from '../src/logoutBudget.mjs';

// Synthetic transport fixtures; these do not establish provider or storage behavior.
const sentinel = 'SYNTHETIC_PRIVATE_SESSION_TRANSPORT';
const secret = 'a'.repeat(64);
const at = 1_000_000;
const principal = { userId: 'synthetic-user', sessionId: 'synthetic-family', expiresAt: at + 60_000, authenticatedAt: at };
const session = { subject: principal.userId, familyId: principal.sessionId, expiresAt: principal.expiresAt, authenticatedAt: at };
const auth = `Bearer ${sentinel}`;
const routes = [
  { name: 'bootstrap', method: 'POST', secret: true },
  { name: 'status', method: 'GET' },
  { name: 'revoke', method: 'DELETE' },
  { name: 'secret logout', method: 'POST', path: '/v1/session/logout', secret: true },
];
const request = (route, extras = {}) => ({ rawPath: route.path ?? '/v1/session', headers: { authorization: auth },
  requestContext: { http: { method: route.method, sourceIp: '192.0.2.1' } },
  ...(route.secret ? { body: JSON.stringify({ logoutSecret: secret }) } : {}), ...extras });
function fixture(failAt, error = new UnauthorizedError()) {
  const calls = [];
  const effect = (name, value) => async (...args) => {
    calls.push([name, ...args]);
    if (name === failAt) throw error;
    return value;
  };
  const handler = createSessionApi({
    verifyToken: effect('verify', principal), probeProvider: effect('probe'),
    consumeAccountBudget: effect('accountBudget'), consumeLogoutBudget: effect('logoutBudget'),
    registry: { admitted: effect('admitted', true), active: effect('active', true),
      registerWithLogout: effect('register'), revoke: effect('revoke'), revokeWithLogout: effect('secretRevoke') },
    now: () => at,
  });
  return { handler, calls };
}
function responseEquals(response, statusCode = 400, body = { error: 'INVALID_REQUEST' }, extraHeaders = {}) {
  assert.deepEqual(response, { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...extraHeaders }, body: JSON.stringify(body) });
  assert.equal(JSON.stringify(response).includes(sentinel), false);
  assert.equal(JSON.stringify(response).includes(secret), false);
}
const encode = (raw) => Buffer.from(raw).toString('base64');
const malformed = [
  ['missing', undefined], ['null event body', null], ['empty', ''], ['truncated JSON', '{'],
  ['trailing JSON', `{}${sentinel}`], ['JSON null', 'null'], ['array', '[]'],
  ['string', JSON.stringify(sentinel)], ['number', '1'], ['boolean', 'false'],
  ['object event body', { private: sentinel }], ['buffer event body', Buffer.from('{}')],
  ['oversized envelope', ' '.repeat(1025)],
];

for (const route of routes) {
  test(`${route.name}: query capabilities and unknown parameters reject before all effects`, async () => {
    for (const rawQueryString of [`logoutSecret=${sentinel}`, `authorization=${sentinel}`, '%6cogoutSecret=synthetic', 'unknown=']) {
      const h = fixture();
      responseEquals(await h.handler(request(route, { rawQueryString, body: '{' })));
      assert.deepEqual(h.calls, []);
    }
  });
  test(`${route.name}: invalid bodies reject before verification, budgets and services`, async (t) => {
    for (const [name, body] of malformed) {
      // Status/revoke deliberately accept absent, null and empty event bodies.
      if (!route.secret && (body == null || body === '')) continue;
      await t.test(name, async () => {
        const h = fixture();
        responseEquals(await h.handler(request(route, { body })));
        assert.deepEqual(h.calls, []);
      });
    }
  });
  test(`${route.name}: body identities and capabilities cannot override signed identity`, async () => {
    for (const key of ['userId', 'familyId', 'sessionId', 'authorization', 'unknown', '__proto__', 'constructor']) {
      const raw = JSON.stringify({ ...(route.secret ? { logoutSecret: secret } : {}), [key]: sentinel });
      for (const isBase64Encoded of [false, true]) {
        const h = fixture();
        responseEquals(await h.handler(request(route, { body: isBase64Encoded ? encode(raw) : raw, isBase64Encoded })));
        assert.deepEqual(h.calls, []);
      }
    }
  });
  test(`${route.name}: encoded malformed bodies reject before all effects`, async () => {
    for (const body of [encode('{'), encode('null'), encode('[]'), '!!!!', encode(' '.repeat(769))]) {
      const h = fixture();
      responseEquals(await h.handler(request(route, { body, isBase64Encoded: true })));
      assert.deepEqual(h.calls, []);
    }
  });
  if (route.secret) {
    test(`${route.name}: exactly one valid lowercase hexadecimal secret is required`, async () => {
      for (const input of [{}, { logoutSecret: null }, { logoutSecret: 1 }, { logoutSecret: [] },
        ...['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ` ${secret}`, `${secret}\n`]
          .map((logoutSecret) => ({ logoutSecret }))]) {
        for (const isBase64Encoded of [false, true]) {
          const h = fixture();
          const raw = JSON.stringify(input);
          responseEquals(await h.handler(request(route, { body: isBase64Encoded ? encode(raw) : raw, isBase64Encoded })));
          assert.deepEqual(h.calls, []);
        }
      }
    });
    test(`${route.name}: valid raw/base64 input preserves ordering and exact arguments at envelope limit`, async () => {
      for (const isBase64Encoded of [false, true]) {
        // The existing cap measures the envelope string, not decoded bytes.
        const raw = JSON.stringify({ logoutSecret: secret }).padEnd(isBase64Encoded ? 768 : 1024, ' ');
        const body = isBase64Encoded ? encode(raw) : raw;
        assert.equal(body.length, 1024);
        const h = fixture();
        const response = await h.handler(request(route, { body, isBase64Encoded, rawQueryString: '' }));
        if (route.path) {
          responseEquals(response, 200, { revoked: true });
          assert.deepEqual(h.calls, [['logoutBudget', '192.0.2.1'], ['secretRevoke', secret]]);
        } else {
          responseEquals(response, 200, { userId: principal.userId, expiresAt: principal.expiresAt, serverTime: at });
          assert.deepEqual(h.calls, [['verify', auth], ['accountBudget', 'bootstrap', principal.userId],
            ['admitted', principal.userId], ['probe', sentinel, principal.userId], ['register', session, secret]]);
        }
        const rejected = fixture();
        responseEquals(await rejected.handler(request(route, { body: `${body} `, isBase64Encoded })));
        assert.deepEqual(rejected.calls, []);
      }
    });
  } else {
    test(`${route.name}: only absent/null/empty bodies reach signed-session operations`, async () => {
      for (const body of [undefined, null, '']) {
        const h = fixture();
        const response = await h.handler(request(route, { body }));
        responseEquals(response, 200, route.method === 'GET'
          ? { userId: principal.userId, expiresAt: principal.expiresAt, serverTime: at } : { revoked: true });
        assert.deepEqual(h.calls, [['verify', auth], ['accountBudget', route.name === 'status' ? 'status' : 'logout', principal.userId],
          [route.name === 'status' ? 'active' : 'revoke', session]]);
      }
      for (const body of ['{}', JSON.stringify({ logoutSecret: secret }), encode('{}')]) {
        const h = fixture();
        responseEquals(await h.handler(request(route, { body })));
        assert.deepEqual(h.calls, []);
      }
    });
  }
}

test('unknown routes/methods reject before parsing, verification or budget consumption', async () => {
  for (const [rawPath, method] of [['/v1/session/logout', 'GET'], ['/v1/session/logout', 'DELETE'],
    ['/v1/session', 'PUT'], ['/v1/session/unknown', 'POST']]) {
    const h = fixture();
    responseEquals(await h.handler(request(routes[0], { rawPath, requestContext: { http: { method } }, body: '{', rawQueryString: `secret=${sentinel}` })),
      404, { error: 'NOT_FOUND' });
    assert.deepEqual(h.calls, []);
  }
});

test('secret logout remains independent of token verification and account/provider state', async () => {
  const h = fixture('verify');
  responseEquals(await h.handler(request(routes[3], { headers: {} })), 200, { revoked: true });
  assert.deepEqual(h.calls, [['logoutBudget', '192.0.2.1'], ['secretRevoke', secret]]);
});

test('valid signed requests deny unverified identity before budget or registry access', async () => {
  for (const route of routes.slice(0, 3)) {
    const h = fixture('verify');
    responseEquals(await h.handler(request(route)), 401, { error: 'UNAUTHORIZED' });
    assert.deepEqual(h.calls, [['verify', auth]]);
  }
});

test('valid requests retain separate rate limits without provider or registry effects', async () => {
  for (const route of routes) {
    const logout = Boolean(route.path);
    const h = fixture(logout ? 'logoutBudget' : 'accountBudget',
      logout ? new LogoutRateLimitedError(12) : new AccountRateLimitedError(12));
    responseEquals(await h.handler(request(route)), 429,
      { error: logout ? 'LOGOUT_RATE_LIMITED' : 'ACCOUNT_RATE_LIMITED' }, { 'Retry-After': '12' });
    assert.deepEqual(h.calls, logout ? [['logoutBudget', '192.0.2.1']]
      : [['verify', auth], ['accountBudget', route.name === 'revoke' ? 'logout' : route.name, principal.userId]]);
  }
});
