import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDynamoSessionRegistry, userKey, familyKey } from '../src/sessionRegistry.mjs';
import { createSessionApi } from '../src/sessionApi.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';
import { store } from './support/fakeDynamo.mjs';
const originalTime = 1_000_000, secret = 'a'.repeat(64);
const session = { subject: 'synthetic-user', familyId: 'synthetic-family', expiresAt: originalTime + 120_000, authenticatedAt: originalTime };
function fixture() {
  const db = store(); let time = originalTime;
  const registry = createDynamoSessionRegistry({ client: db.client, tableName: 'synthetic-sessions', now: () => time });
  const grant = (extras = {}) => db.items.set(userKey(session.subject).pk, { ...userKey(session.subject), subject: session.subject, state: 'active', pilotExpiresAt: time + 60_000, ...extras });
  return { db, registry, grant, advance: (ms) => { time += ms; } };
}
test('missing approval is denied by default without any family/capability writes', async () => {
  const { registry, db } = fixture();
  assert.equal(await registry.admitted(session.subject), false);
  await assert.rejects(registry.register(session), UnauthorizedError);
  await assert.rejects(registry.registerWithLogout(session, secret), UnauthorizedError);
  assert.equal(db.items.size, 0); assert.equal(await registry.active(session), false);
});
test('pilot approval requires matching subject, active status and a finite future deadline', async () => {
  const h = fixture();
  for (const patch of [{ subject: 'another-user' }, { state: 'blocked' }, { pilotExpiresAt: originalTime },
    { pilotExpiresAt: originalTime - 1 }, { pilotExpiresAt: '9999999999' }, { pilotExpiresAt: Infinity }, { pilotExpiresAt: undefined }]) {
    h.grant(patch); assert.equal(await h.registry.admitted(session.subject), false);
    await assert.rejects(h.registry.registerWithLogout(session, secret), UnauthorizedError);
  }
  h.grant(); assert.equal(await h.registry.admitted(session.subject), true);
  await h.registry.registerWithLogout(session, secret); assert.equal(await h.registry.active(session), true);
  h.advance(60_000); assert.equal(await h.registry.active(session), false);
  assert.equal(h.db.items.has(familyKey(session.familyId).pk), true); // logical denial precedes TTL
});
test('removing and reapproving pilot access cannot resurrect an explicitly revoked family', async () => {
  const h = fixture(); h.grant(); await h.registry.registerWithLogout(session, secret);
  h.db.items.delete(userKey(session.subject).pk); assert.equal(await h.registry.active(session), false);
  await h.registry.revokeWithLogout(secret); h.grant();
  assert.equal(await h.registry.active(session), false);
  await assert.rejects(h.registry.registerWithLogout(session, secret), UnauthorizedError);
});
test('non-pilots cannot trigger provider registration probes; logout still works after withdrawal', async () => {
  const h = fixture(); let probes = 0;
  const api = createSessionApi({ consumeAccountBudget: async () => {}, consumeLogoutBudget: async () => {}, registry: h.registry, verifyToken: async () => ({ userId: session.subject, sessionId: session.familyId, expiresAt: session.expiresAt, authenticatedAt: session.authenticatedAt }),
    probeProvider: async () => { probes++; }, now: () => originalTime });
  const event = (method, path = '/v1/session') => ({ rawPath: path, headers: { authorization: 'Bearer synthetic' }, requestContext: { http: { method } }, ...(method === 'POST' ? { body: JSON.stringify({ logoutSecret: secret }) } : {}) });
  assert.equal((await api(event('POST'))).statusCode, 401); assert.equal(probes, 0);
  h.grant(); assert.equal((await api(event('POST'))).statusCode, 200); assert.equal(probes, 1);
  h.db.items.delete(userKey(session.subject).pk);
  assert.equal((await api(event('GET'))).statusCode, 401);
  assert.equal((await api(event('DELETE'))).statusCode, 200);
  assert.equal((await api(event('POST', '/v1/session/logout'))).statusCode, 200);
});
test('withdrawal during the provider probe cannot create a new session or capability', async () => {
  const h = fixture(); h.grant();
  const api = createSessionApi({ consumeAccountBudget: async () => {}, consumeLogoutBudget: async () => {}, registry: h.registry, verifyToken: async () => ({ userId: session.subject, sessionId: session.familyId, expiresAt: session.expiresAt, authenticatedAt: session.authenticatedAt }),
    probeProvider: async () => { h.db.items.delete(userKey(session.subject).pk); } });
  const response = await api({ rawPath: '/v1/session', headers: { authorization: 'Bearer synthetic' }, requestContext: { http: { method: 'POST' } }, body: JSON.stringify({ logoutSecret: secret }) });
  assert.equal(response.statusCode, 401); assert.equal(h.db.items.size, 0);
});
