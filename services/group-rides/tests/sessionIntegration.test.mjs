import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createAccountTokenVerifier, createAccountAuthorizer, UnauthorizedError } from '../src/authorizer.mjs';
import { createDynamoSessionRegistry, userKey } from '../src/sessionRegistry.mjs';
import { createSessionApi } from '../src/sessionApi.mjs';
import { store } from './support/fakeDynamo.mjs';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pool = 'eu-west-2_Integration', clientId = 'synthetic-client';
const jwtVerifier = CognitoJwtVerifier.create({ userPoolId: pool, clientId, tokenUse: 'access' });
jwtVerifier.cacheJwks({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'synthetic', use: 'sig', alg: 'RS256' }] });
function signed(family, subject = 'synthetic-user') {
  const seconds = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'RS256', kid: 'synthetic' })}.${encode({ iss: `https://cognito-idp.eu-west-2.amazonaws.com/${pool}`, client_id: clientId, token_use: 'access', sub: subject, origin_jti: family, scope: 'bendbound/groups aws.cognito.signin.user.admin', auth_time: seconds, iat: seconds, exp: seconds + 120 })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), keys.privateKey).toString('base64url')}`;
}
test('signed login -> private access -> logout -> replay denial, while a new login family works', async () => {
  const database = store(); database.items.set(userKey('synthetic-user').pk, { ...userKey('synthetic-user'), subject: 'synthetic-user', state: 'active', pilotExpiresAt: Date.now() + 120_000 });
  const registry = createDynamoSessionRegistry({ client: database.client, tableName: 'synthetic-sessions' });
  const config = { userPoolId: pool, clientId, verifier: jwtVerifier };
  const api = createSessionApi({ consumeAccountBudget: async () => {}, consumeLogoutBudget: async () => {}, verifyToken: createAccountTokenVerifier(config), registry, probeProvider: async () => {} });
  const authorize = createAccountAuthorizer({ ...config, sessionActive: registry.active });
  const access = `Bearer ${signed('original-family')}`;
  const event = (method, token = access) => ({ rawPath: '/v1/session', requestContext: { http: { method } }, headers: { authorization: token }, ...(method === 'POST' ? { body: JSON.stringify({ logoutSecret: (token === access ? 'a' : 'b').repeat(64) }) } : {}) });
  await assert.rejects(authorize(access), UnauthorizedError);
  assert.equal((await api(event('POST'))).statusCode, 200); assert.equal((await authorize(access)).userId, 'synthetic-user');
  assert.equal((await api(event('DELETE'))).statusCode, 200);
  await assert.rejects(authorize(access), UnauthorizedError);
  // Even a provider probe that still succeeds cannot undo our logout tombstone.
  assert.equal((await api(event('POST'))).statusCode, 401);
  const newAccess = `Bearer ${signed('new-family')}`;
  assert.equal((await api(event('POST', newAccess))).statusCode, 200); assert.equal((await authorize(newAccess)).userId, 'synthetic-user');
  await registry.blockUser('synthetic-user');
  await assert.rejects(authorize(newAccess), UnauthorizedError); assert.equal((await api(event('POST', newAccess))).statusCode, 401);
});

test('signed private-room requests enforce current membership and session revocation after join', async () => {
  const { createRoomService } = await import('../src/rooms.mjs');
  const { createRoomApi } = await import('../src/roomApi.mjs');
  const { randomUUID } = await import('node:crypto');
  const database = store();
  for (const subject of ['owner', 'rider']) database.items.set(userKey(subject).pk, { ...userKey(subject), subject, state: 'active', pilotExpiresAt: Date.now() + 120_000 });
  const registry = createDynamoSessionRegistry({ client: database.client, tableName: 'synthetic-sessions' });
  const config = { userPoolId: pool, clientId, verifier: jwtVerifier };
  const verifyToken = createAccountTokenVerifier(config);
  const accounts = createSessionApi({ consumeAccountBudget: async () => {}, consumeLogoutBudget: async () => {}, verifyToken, registry, probeProvider: async () => {} });
  const records = new Map();
  const roomStore = { read: async (id) => structuredClone(records.get(id) ?? null),
    create: async (room) => { if (records.has(room.id)) return false; records.set(room.id, structuredClone(room)); return true; },
    replace: async (room, revision) => { if (records.get(room.id)?.revision !== revision) return false; records.set(room.id, structuredClone(room)); return true; } };
  const rooms = createRoomService({ store: roomStore, sessionActive: registry.active });
  const api = createRoomApi({ consumeRoomBudget: async () => {}, rooms, authorize: createAccountAuthorizer({ ...config, sessionActive: registry.active }) });
  const owner = `Bearer ${signed('owner-family', 'owner')}`, rider = `Bearer ${signed('rider-family', 'rider')}`;
  const event = (method, path, token, body) => ({ rawPath: path, requestContext: { http: { method } }, headers: { authorization: token }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const command = () => ({ id: randomUUID(), createdAt: Date.now() });
  await accounts(event('POST', '/v1/session', owner, { logoutSecret: 'c'.repeat(64) })); await accounts(event('POST', '/v1/session', rider, { logoutSecret: 'd'.repeat(64) }));
  const created = await api(event('POST', '/v1/rooms', owner, { command: command(), title: 'Synthetic ride', displayName: 'Owner', motorcycleType: 'sports' }));
  assert.equal(created.statusCode, 201); const id = JSON.parse(created.body).room.id;
  const invite = JSON.parse((await api(event('POST', `/v1/rooms/${id}/invites`, owner))).body).token;
  assert.equal((await api(event('GET', `/v1/rooms/${id}`, rider))).statusCode, 404);
  assert.equal((await api(event('POST', `/v1/rooms/${id}/members`, rider, { inviteToken: invite, displayName: 'Rider', motorcycleType: 'cruiser' }))).statusCode, 200);
  const joined = JSON.parse((await api(event('GET', `/v1/rooms/${id}`, rider))).body).room;
  assert.equal(joined.members.find((m) => m.userId === 'rider').motorcycleType, 'cruiser');
  await api(event('DELETE', `/v1/rooms/${id}/members/rider`, owner, { command: command() }));
  assert.equal((await api(event('GET', `/v1/rooms/${id}`, rider))).statusCode, 404);
  assert.equal((await api(event('POST', `/v1/rooms/${id}/members`, rider, { inviteToken: invite, displayName: 'Rider', motorcycleType: 'cruiser' }))).statusCode, 404);
  await accounts(event('DELETE', '/v1/session', owner));
  assert.equal((await api(event('GET', `/v1/rooms/${id}`, owner))).statusCode, 401);
});
