import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDynamoSessionRegistry, userKey, logoutKey, familyKey, DEFAULT_SESSION_LIFETIME_MS } from '../src/sessionRegistry.mjs';
import { createSessionApi } from '../src/sessionApi.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';
import { store } from './support/fakeDynamo.mjs';
const at = 1_000_000, secret = 'a'.repeat(64), other = 'b'.repeat(64);
const session = { subject: 'synthetic-user', familyId: 'synthetic-family', expiresAt: at + 60_000, authenticatedAt: at };
function fixture() { const db = store(); db.items.set(userKey(session.subject).pk, { ...userKey(session.subject), subject: session.subject, state: 'active', pilotExpiresAt: at + 100_000 }); return { db, registry: createDynamoSessionRegistry({ client: db.client, tableName: 'synthetic-sessions', now: () => at }) }; }
test('registration hashes and atomically binds one revocation capability to one family', async () => {
  const { db, registry } = fixture();
  await registry.registerWithLogout(session, secret); const before = structuredClone([...db.items]);
  await registry.registerWithLogout(session, secret); assert.deepEqual([...db.items], before);
  assert.equal(JSON.stringify([...db.items]).includes(secret), false);
  assert.equal(db.items.get(familyKey(session.familyId).pk).logoutKey, logoutKey(secret).pk);
  await assert.rejects(registry.registerWithLogout(session, other), UnauthorizedError);
  await assert.rejects(registry.registerWithLogout({ ...session, familyId: 'different-family' }, secret), UnauthorizedError);
  assert.equal(await registry.active(session), true);
});
test('capability revokes only its own family without a live access token and cannot resurrect it', async () => {
  const { registry } = fixture();
  const second = { ...session, familyId: 'other-family' };
  await registry.registerWithLogout(session, secret); await registry.registerWithLogout(second, other);
  await registry.revokeWithLogout(secret); await registry.revokeWithLogout(secret);
  assert.equal(await registry.active(session), false); assert.equal(await registry.active(second), true);
  await assert.rejects(registry.registerWithLogout(session, secret), UnauthorizedError);
});
test('revocation before registration tombstones the capability without retaining it raw', async () => {
  const { registry, db } = fixture();
  await registry.revokeWithLogout(secret);
  assert.equal(db.items.get(logoutKey(secret).pk).state, 'revoked');
  assert.equal(db.items.get(logoutKey(secret).pk).expiresAt, at + DEFAULT_SESSION_LIFETIME_MS + 1000);
  await assert.rejects(registry.registerWithLogout(session, secret), UnauthorizedError);
  assert.equal(db.items.has(familyKey(session.familyId).pk), false);
});
test('logout endpoint grants no identity/read scope and rejects query/extra/malformed secrets', async () => {
  const { registry } = fixture(); let verified = 0;
  await registry.registerWithLogout(session, secret);
  const api = createSessionApi({ consumeAccountBudget: async () => {}, consumeLogoutBudget: async () => {}, registry, verifyToken: async () => { verified++; throw new UnauthorizedError(); }, probeProvider: async () => {} });
  const event = (input, extras = {}) => ({ rawPath: '/v1/session/logout', requestContext: { http: { method: 'POST' } }, body: JSON.stringify(input), ...extras });
  const response = await api(event({ logoutSecret: secret }));
  assert.equal(response.statusCode, 200); assert.deepEqual(JSON.parse(response.body), { revoked: true }); assert.equal(verified, 0);
  assert.equal(response.headers['Cache-Control'], 'no-store'); assert.equal(response.body.includes(secret), false);
  for (const input of [{ logoutSecret: 'short' }, { logoutSecret: secret, userId: 'victim' }, { logoutSecret: secret, familyId: 'victim' }, []]) assert.equal((await api(event(input))).statusCode, 400);
  assert.equal((await api(event({ logoutSecret: secret }, { rawQueryString: 'logoutSecret=hidden' }))).statusCode, 400);
  assert.equal((await api({ rawPath: '/v1/session/logout', requestContext: { http: { method: 'GET' } } })).statusCode, 404);
  assert.equal(await registry.active(session), false);
});
