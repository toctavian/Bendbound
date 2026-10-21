import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID, createDecipheriv } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { createNativeAppleStore, nativeProviderKey, nativeUserKey } from '../src/nativeAppleStore.mjs';
import { createAppleGrantJournal } from '../src/appleGrantJournal.mjs';
import { createJournalledAppleExchange } from '../src/journalledAppleExchange.mjs';
import { userKey } from '../src/sessionRegistry.mjs';
import { createAppleTokenEncryption } from '../src/nativeAppleVault.mjs';
import { createNativeAppleApi } from '../src/nativeAppleApi.mjs';
import { AppleAuthenticationError } from '../src/nativeApple.mjs';
const endpoint = process.env.GROUP_DYNAMO_LOCAL_ENDPOINT;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint ?? '')) throw new Error('Local DynamoDB required.');
const raw = new DynamoDBClient({ endpoint, region: 'eu-west-2', credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1 });
const client = DynamoDBDocumentClient.from(raw), tableName = `native-auth-${randomUUID()}`, grantTable = `native-grants-${randomUUID()}`, bundleId = 'com.example.synthetic';
let at = Date.now();
const make = () => createNativeAppleStore({ client, tableName, bundleId, now: () => at });
before(async () => { await raw.send(new CreateTableCommand({ TableName: tableName, BillingMode: 'PAY_PER_REQUEST',
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }] }));
  await raw.send(new CreateTableCommand({ TableName: grantTable, BillingMode: 'PAY_PER_REQUEST', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }], AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }] })); });
after(async () => { try { await raw.send(new DeleteTableCommand({ TableName: tableName })); await raw.send(new DeleteTableCommand({ TableName: grantTable })); } finally { raw.destroy(); } });
test('challenge survives a new instance and only one of 20 concurrent consumers succeeds', async () => {
  const challenge = await make().begin();
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => make().consumeChallenge(challenge.challengeId)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.deepEqual(results.find((r) => r.status === 'fulfilled').value, { nonce: challenge.nonce });
  for (const r of results.filter((r) => r.status === 'rejected')) assert.ok(r.reason instanceof AppleAuthenticationError);
  await assert.rejects(make().consumeChallenge(challenge.challengeId), AppleAuthenticationError);
});
test('logical expiry denies an undeleted TTL row and proof binds username, subject and Cognito nonce', async () => {
  const challenge = await make().begin(); at += 300_000;
  await assert.rejects(make().consumeChallenge(challenge.challengeId), AppleAuthenticationError);
  const config = { username: 'synthetic-user', subject: 'synthetic-sub', challengeNonce: 'a'.repeat(64) };
  const proof = await make().createProof(config);
  for (const patch of [{ username: 'victim' }, { subject: 'victim' }, { challengeNonce: 'b'.repeat(64) }]) await assert.rejects(make().consumeProof({ ...config, ...patch, proof }), AppleAuthenticationError);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => make().consumeProof({ ...config, proof })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const late = await make().createProof(config); at += 30_000;
  await assert.rejects(make().consumeProof({ ...config, proof: late }), AppleAuthenticationError);
});
test('operator mapping requires matching active forward/reverse rows; no implicit email linking', async () => {
  const store = make(), providerSubject = 'synthetic-apple', providerKey = nativeProviderKey(bundleId, providerSubject);
  const mapping = { state: 'active', subject: 'synthetic-sub', username: 'synthetic-user', providerKey };
  await assert.rejects(store.findIdentity(providerSubject), AppleAuthenticationError);
  await client.send(new PutCommand({ TableName: tableName, Item: { pk: providerKey, ...mapping } }));
  await assert.rejects(store.findIdentity(providerSubject), AppleAuthenticationError);
  await client.send(new PutCommand({ TableName: tableName, Item: { pk: nativeUserKey(mapping.username), ...mapping } }));
  assert.deepEqual(await store.findIdentity(providerSubject), { subject: mapping.subject, username: mapping.username, providerKey });
  assert.deepEqual(await store.findUsername(mapping.username), await store.findIdentity(providerSubject));
  await client.send(new PutCommand({ TableName: tableName, Item: { pk: nativeUserKey(mapping.username), ...mapping, state: 'blocked' } }));
  await assert.rejects(store.findIdentity(providerSubject), AppleAuthenticationError);
});
test('HTTP exchange persists encrypted provider grant before issuance; concurrent replay cannot issue twice', async () => {
  const store = make(), events = [], key = Buffer.alloc(32, 42);
  const encrypt = createAppleTokenEncryption({ keyId: 'synthetic-kms-key', kms: { send: async () => ({ Plaintext: Buffer.from(key), CiphertextBlob: Buffer.from('synthetic-wrapped') }) } });
  const mapping = { username: 'synthetic-user', subject: 'synthetic-sub', providerKey: nativeProviderKey(bundleId, 'synthetic-apple') };
  const challenge = await store.begin();
  await client.send(new PutCommand({ TableName: tableName, Item: { ...userKey(mapping.subject), subject: mapping.subject, state: 'active', pilotExpiresAt: at + 3600_000 } }));
  const journal = createAppleGrantJournal({ client, tableName: grantTable, sessionTableName: tableName, now: () => at });
  const provider = { prepare: async () => ({ revoke: async () => {}, exchange: async ({ capture }) => {
    events.push('apple'); await capture('synthetic-provider-refresh'); return { provider: 'apple', subject: 'synthetic-apple' };
  } }) };
  const exchange = createJournalledAppleExchange({ provider, encryption: encrypt, journal: { ...journal,
    async capture(...args) { await journal.capture(...args); events.push('vault'); } } });
  const dependencies = { apiId: 'synthetic-api', store: { ...store, findIdentity: async () => mapping },
    consumeBudget: async () => {}, verifyIdentity: async (_token, nonce) => { assert.equal(nonce, challenge.nonce); return { subject: 'synthetic-apple' }; },
    exchangeCode: exchange, admitted: async () => true,
    issueSession: async () => { events.push('issue'); return { accessToken: 'synthetic-cognito', refreshToken: 'synthetic-cognito-refresh', expiresIn: 300 }; } };
  const event = { rawPath: '/v1/auth/apple/exchange', requestContext: { apiId: 'synthetic-api', http: { method: 'POST', sourceIp: '127.0.0.1' } },
    body: JSON.stringify({ challengeId: challenge.challengeId, identityToken: 'synthetic-apple-id', authorizationCode: 'synthetic-code' }) };
  const results = await Promise.all(Array.from({ length: 10 }, () => createNativeAppleApi(dependencies)(event)));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
  assert.equal(results.filter((r) => r.statusCode === 401).length, 9);
  assert.deepEqual(events, ['apple', 'vault', 'issue']);
  assert.ok(results.every((r) => r.headers['Cache-Control'] === 'no-store' && !r.body.includes('synthetic-provider-refresh')));
  const rows = (await client.send(new ScanCommand({ TableName: grantTable, ConsistentRead: true }))).Items;
  const vault = rows.filter((row) => row.pk.startsWith('APPLE#'));
  assert.equal(vault.length, 1); assert.equal(JSON.stringify(vault).includes('synthetic-provider-refresh'), false); assert.equal('ttl' in vault[0], false);
  const envelope = vault[0].envelope, decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(JSON.stringify(envelope.context))); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  assert.equal(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString(), 'synthetic-provider-refresh');
  const second = await store.begin();
  const failed = createNativeAppleApi({ ...dependencies, verifyIdentity: async () => ({ subject: 'synthetic-apple' }),
    issueSession: async () => { throw new Error('sensitive downstream failure'); } });
  const response = await failed({ ...event, body: JSON.stringify({ ...JSON.parse(event.body), challengeId: second.challengeId }) });
  assert.equal(response.statusCode, 503); assert.equal(response.body.includes('sensitive'), false);
  const retained = (await client.send(new ScanCommand({ TableName: grantTable }))).Items.filter((r) => r.pk.startsWith('APPLE#'));
  assert.equal(retained.length, 2); // previous device/login provider grant never overwritten
});
test('verified enrollment is deduplicated across concurrent instances; references never create mappings or pilot grants', async () => {
  const { NativeEnrollmentRequired, enrollmentKey, enrollmentIdentityKey } = await import('../src/nativeAppleStore.mjs');
  const subject = 'synthetic-enrollment-candidate', providerKey = nativeProviderKey(bundleId, subject);
  await assert.rejects(make().findIdentity(subject), NativeEnrollmentRequired);
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => make().requestEnrollment(subject)));
  const successes = results.filter((r) => r.status === 'fulfilled');
  assert.ok(successes.length >= 1);
  const reference = successes[0].value.requestId;
  assert.ok(successes.every((r) => r.value.requestId === reference));
  const read = async (pk) => (await client.send(new GetCommand({ TableName: tableName, Key: { pk }, ConsistentRead: true }))).Item;
  const request = await read(enrollmentKey(reference));
  assert.equal(request.state, 'pending'); assert.equal(request.providerKey, providerKey); assert.equal(request.version, 1);
  assert.equal(JSON.stringify(request).includes(subject), false); assert.equal(await read(providerKey), undefined);
  await assert.rejects(make().findIdentity(subject), NativeEnrollmentRequired);
  await client.send(new PutCommand({ TableName: tableName, Item: { pk: providerKey, providerKey, state: 'blocked' } }));
  await assert.rejects(make().findIdentity(subject), AppleAuthenticationError);
  await assert.rejects(make().requestEnrollment(subject), AppleAuthenticationError);
  // A pending request cannot re-open a blocked mapping.
  assert.equal((await read(enrollmentIdentityKey(providerKey))).requestId, reference);
});
