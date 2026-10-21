import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionApi } from '../src/sessionApi.mjs';
import { createProviderProbe } from '../src/providerProbe.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';
const principal = { userId: 'synthetic-user', sessionId: 'synthetic-family', expiresAt: 2_000_000, authenticatedAt: 1_000_000 };
const secret = 'a'.repeat(64);
const event = (method, extras = {}) => ({ ...(method === 'POST' ? { body: JSON.stringify({ logoutSecret: secret }) } : {}), rawPath: '/v1/session', headers: { authorization: 'Bearer synthetic-token' }, requestContext: { http: { method } }, ...extras });
function api(overrides = {}) { return createSessionApi({ consumeAccountBudget: async () => {}, consumeLogoutBudget: async () => {}, verifyToken: async () => principal, probeProvider: async () => {}, registry: { admitted: async () => true, registerWithLogout: async () => {}, active: async () => true, revokeWithLogout: async () => {}, revoke: async () => {} }, now: () => 1_000_000, ...overrides }); }
test('bootstrap verifies provider before registration and passes only verified identity', async () => {
  const calls = [];
  const h = api({ probeProvider: async (token, subject) => calls.push(['probe', token, subject]), registry: { admitted: async () => true,
    registerWithLogout: async (value) => calls.push(['register', value]), active: async () => false, revokeWithLogout: async () => {}, revoke: async () => {},
  } });
  const response = await h(event('POST')); assert.equal(response.statusCode, 200);
  assert.equal(calls[0][0], 'probe'); assert.equal(calls[1][1].subject, principal.userId); assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.body.includes('synthetic-token'), false);
});
test('revoked provider tokens cannot bootstrap despite a valid offline signature', async () => {
  let registered = false;
  const h = api({ probeProvider: async () => { throw new UnauthorizedError(); }, registry: { admitted: async () => true, registerWithLogout: async () => { registered = true; }, active: async () => true, revokeWithLogout: async () => {}, revoke: async () => {} } });
  assert.equal((await h(event('POST'))).statusCode, 401); assert.equal(registered, false);
});
test('status rejects inactive sessions and logout may revoke an unknown family', async () => {
  let revoked;
  const h = api({ registry: { admitted: async () => true, registerWithLogout: async () => {}, active: async () => false, revokeWithLogout: async () => {}, revoke: async (value) => { revoked = value; } } });
  assert.equal((await h(event('GET'))).statusCode, 401); assert.equal((await h(event('DELETE'))).statusCode, 200); assert.equal(revoked.familyId, principal.sessionId);
});
test('body identities and query tokens are rejected; service errors are sanitised', async () => {
  assert.equal((await api()(event('POST', { body: '{"userId":"victim"}' }))).statusCode, 400);
  assert.equal((await api()(event('GET', { rawQueryString: 'token=synthetic' }))).statusCode, 400);
  const response = await api({ verifyToken: async () => { throw new Error('sensitive SDK details'); } })(event('GET'));
  assert.equal(response.statusCode, 503); assert.equal(response.body.includes('sensitive'), false);
});
test('GetUser must return the verified subject; provider revocation and outages deny admission', async () => {
  const okay = createProviderProbe({ send: async (command, options) => { assert.equal(command.input.AccessToken, 'synthetic'); assert.ok(options.abortSignal); return { UserAttributes: [{ Name: 'sub', Value: principal.userId }] }; } });
  await okay('synthetic', principal.userId);
  await assert.rejects(okay('synthetic', 'another-user'), UnauthorizedError);
  for (const name of ['NotAuthorizedException', 'UserNotFoundException', 'TooManyRequestsException']) {
    const probe = createProviderProbe({ send: async () => { throw Object.assign(new Error('private SDK text'), { name }); } });
    await assert.rejects(probe('synthetic', principal.userId), (error) => !error.message.includes('private SDK text'));
  }
});
