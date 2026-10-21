import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { userKey } from '../src/sessionRegistry.mjs';
import { createLifecycleHoldStore } from '../src/lifecycleHoldStore.mjs';
import { createAppleGrantJournal, appleGrantPartition } from '../src/appleGrantJournal.mjs';
import { createAppleTokenEncryption, createAppleTokenDecryption } from '../src/nativeAppleVault.mjs';
import { createJournalledAppleExchange } from '../src/journalledAppleExchange.mjs';
import { createAppleProviderCleanup } from '../src/appleProviderCleanup.mjs';
import { AppleExchangeRejectedError } from '../src/nativeApple.mjs';
const endpoint = process.env.GROUP_DYNAMO_LOCAL_ENDPOINT;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint ?? '')) throw new Error('Local DynamoDB required.');
const raw = new DynamoDBClient({ endpoint, region: 'eu-west-2', credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1 });
const client = DynamoDBDocumentClient.from(raw), sessions = `grant-sessions-${randomUUID()}`, grants = `grant-journal-${randomUUID()}`;
const at = Date.now(), config = { client, tableName: grants, sessionTableName: sessions, now: () => at };
const journal = createAppleGrantJournal(config), holds = createLifecycleHoldStore({ client, tableName: sessions, now: () => at });
const kms = { send: async (command) => command.constructor.name === 'GenerateDataKeyCommand'
  ? { Plaintext: Buffer.alloc(32, 42), CiphertextBlob: Buffer.from('synthetic-wrapped') }
  : { Plaintext: Buffer.alloc(32, 42) } };
const encryption = createAppleTokenEncryption({ kms, keyId: 'synthetic-key' });
const decrypt = createAppleTokenDecryption({ kms, keyId: 'synthetic-key' });
const mapping = () => ({ subject: `synthetic-${randomUUID()}`, providerKey: 'NATIVEAPPLE#' + 'a'.repeat(64) });
async function approve(m) { await client.send(new PutCommand({ TableName: sessions, Item: { ...userKey(m.subject), subject: m.subject, state: 'active', pilotExpiresAt: at + 3600_000 } })); }
async function hold(m) { const row = await holds.begin(m.subject, 'synthetic-event'); return { subject: m.subject, eventId: 'synthetic-event', holdStartedAt: row.lifecycleHold.startedAt }; }
before(async () => {
  await raw.send(new CreateTableCommand({ TableName: sessions, BillingMode: 'PAY_PER_REQUEST', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }] }));
  await raw.send(new CreateTableCommand({ TableName: grants, BillingMode: 'PAY_PER_REQUEST', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }], AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }] }));
});
after(async () => { try { await raw.send(new DeleteTableCommand({ TableName: sessions })); await raw.send(new DeleteTableCommand({ TableName: grants })); } finally { raw.destroy(); } });
test('durable intent precedes provider call; a hold prevents new exchanges but a late token is retained and revoked', async () => {
  const m = mapping(); await approve(m); let cleanupInput, revoked = 0;
  const provider = { prepare: async () => ({ revoke: async () => {}, exchange: async ({ capture }) => {
    assert.equal((await journal.page(m.subject)).records[0].state, 'exchanging');
    cleanupInput = await hold(m);
    await assert.rejects(createAppleGrantJournal(config).begin(m));
    await capture('synthetic-provider-refresh');
    return { provider: 'apple', subject: 'synthetic-apple' };
  } }) };
  await createJournalledAppleExchange({ provider, encryption, journal })({}, m);
  const row = (await journal.page(m.subject)).records[0];
  assert.equal(row.state, 'validated'); assert.equal(JSON.stringify(row).includes('synthetic-provider-refresh'), false);
  const cleanup = createAppleProviderCleanup({ holds, journal, decrypt, revoke: async (token) => { assert.equal(token, 'synthetic-provider-refresh'); revoked++; } });
  assert.equal((await cleanup(cleanupInput)).providerTokensDrained, true); assert.equal(revoked, 1);
  await assert.rejects(journal.capture({ subject: m.subject, attemptId: row.sk }, row.envelope)); // no late resurrection
  assert.equal((await holds.read(m.subject, 'synthetic-event')).state, 'blocked');
});
test('unknown provider result is durable/manual pending; forged cursors cannot manufacture cleanup success', async () => {
  const m = mapping(); await approve(m);
  const provider = { prepare: async () => ({ revoke: async () => {}, exchange: async () => { throw new Error('response lost'); } }) };
  await assert.rejects(createJournalledAppleExchange({ provider, encryption, journal })({}, m));
  assert.equal((await journal.page(m.subject)).records[0].state, 'uncertain');
  const input = await hold(m);
  const cleanup = createAppleProviderCleanup({ holds, journal, decrypt, revoke: async () => { throw new Error('must not revoke without material'); } });
  const pending = await cleanup(input);
  assert.equal(pending.providerTokensDrained, false); assert.equal(pending.manualProviderActionMayBeRequired, true);
  const skipped = await cleanup({ ...input, cursor: { pk: appleGrantPartition(m.subject), sk: 'f'.repeat(64) } });
  assert.equal(skipped.providerTokensDrained, false);
  const row = (await journal.page(m.subject)).records[0];
  await assert.rejects(journal.removeUnderHold(row, (await holds.read(m.subject, input.eventId)).lifecycleHold));
});
test('definite rejection closes an intent; persistence failure compensates with confirmed revocation, never issues a session', async () => {
  const rejected = mapping(); await approve(rejected);
  const provider = { prepare: async () => ({ revoke: async () => {}, exchange: async () => { throw new AppleExchangeRejectedError(); } }) };
  await assert.rejects(createJournalledAppleExchange({ provider, encryption, journal })({}, rejected));
  assert.equal((await journal.page(rejected.subject)).records[0].state, 'closed');
  const m = mapping(); await approve(m); let revoked = false;
  const captureFails = { ...journal, capture: async () => { throw new Error('ambiguous database failure'); } };
  const compensated = { prepare: async () => ({ revoke: async (token) => { assert.equal(token, 'synthetic-refresh'); revoked = true; },
    exchange: async ({ capture }) => { await capture('synthetic-refresh'); return { subject: 'synthetic' }; } }) };
  await assert.rejects(createJournalledAppleExchange({ provider: compensated, encryption, journal: captureFails })({}, m));
  assert.equal(revoked, true); const row = (await journal.page(m.subject)).records[0];
  assert.equal(row.state, 'closed'); assert.equal('envelope' in row, false);
});
test('failed revocation retains material; wrong envelope context and a replacement hold cannot acknowledge cleanup', async () => {
  const m = mapping(); await approve(m); const attempt = await journal.begin(m);
  const envelope = await encryption(m.subject, 'synthetic-refresh'); await journal.capture(attempt, envelope);
  await assert.rejects(decrypt('another-subject', envelope));
  await assert.rejects(decrypt(m.subject, { ...envelope, tag: Buffer.alloc(16).toString('base64') }));
  const input = await hold(m);
  const failing = createAppleProviderCleanup({ holds, journal, decrypt, revoke: async () => { throw new Error('Apple outage'); } });
  assert.equal((await failing(input)).providerTokensDrained, false); assert.equal((await journal.page(m.subject)).records.length, 1);
  const replacing = createAppleProviderCleanup({ holds, journal, decrypt, revoke: async () => {
    const row = await holds.read(m.subject, input.eventId); row.lifecycleHold.startedAt++;
    await client.send(new PutCommand({ TableName: sessions, Item: row }));
  } });
  await assert.rejects(replacing(input), /hold changed/);
  assert.equal((await journal.page(m.subject)).records.length, 1);
  await assert.rejects(replacing(input), /hold is required/); // original receipt fenced across restarts
});
