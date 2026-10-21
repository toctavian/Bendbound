import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionApi } from '../src/sessionApi.mjs';
import { createRoomApi } from '../src/roomApi.mjs';

const sentinel = 'SYNTHETIC_PRIVATE_ERROR_SENTINEL';
const fail = async () => { throw Object.assign(new Error(sentinel), { cause: new Error(sentinel), request: { authorization: sentinel } }); };
const okay = async () => true;
const principal = { userId: 'synthetic-user', sessionId: 'synthetic-session', expiresAt: 2000, authenticatedAt: 500 };
const event = (method, rawPath, body) => ({ rawPath, requestContext: { http: { method, sourceIp: 'synthetic-source' } },
  headers: { authorization: `Bearer ${sentinel}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
function unavailable(response, code) {
  assert.equal(response.statusCode, 503);
  assert.equal(response.body, JSON.stringify({ error: code }));
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.headers['Retry-After'], undefined);
  assert.equal(JSON.stringify(response).includes(sentinel), false);
}

for (const stage of ['verifyToken', 'consumeAccountBudget', 'admitted', 'probeProvider', 'registerWithLogout', 'active', 'revoke', 'consumeLogoutBudget', 'revokeWithLogout']) {
  test(`session ${stage} unexpected errors expose only the unavailable response`, async () => {
    const registry = { admitted: okay, registerWithLogout: okay, active: okay, revoke: okay, revokeWithLogout: okay };
    const options = { registry, verifyToken: async () => principal, consumeAccountBudget: okay, probeProvider: okay, consumeLogoutBudget: okay, now: () => 1000 };
    if (Object.hasOwn(registry, stage)) registry[stage] = fail; else options[stage] = fail;
    const capability = ['consumeLogoutBudget', 'revokeWithLogout'].includes(stage);
    const method = stage === 'active' ? 'GET' : stage === 'revoke' ? 'DELETE' : 'POST';
    const request = event(method, capability ? '/v1/session/logout' : '/v1/session', method === 'POST' ? { logoutSecret: 'a'.repeat(64) } : undefined);
    unavailable(await createSessionApi(options)(request), 'ACCOUNT_SERVICE_UNAVAILABLE');
  });
}

for (const stage of ['authorize', 'consumeRoomBudget', 'read', 'publish']) {
  test(`room ${stage} unexpected errors expose only the unavailable response`, async () => {
    const locations = { read: okay, publish: okay };
    const options = { rooms: {}, locations, authorize: async () => principal, consumeRoomBudget: okay };
    if (Object.hasOwn(locations, stage)) locations[stage] = fail; else options[stage] = fail;
    const publish = stage === 'publish';
    const request = event(publish ? 'PUT' : 'GET', `/v1/rooms/${'a'.repeat(64)}${publish ? '/fix' : ''}`, publish ? { version: 1, fix: { synthetic: sentinel } } : undefined);
    unavailable(await createRoomApi(options)(request), 'GROUP_SERVICE_UNAVAILABLE');
  });
}
