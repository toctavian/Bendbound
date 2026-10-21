// Synthetic localhost-only integration preparation; never creates cloud resources.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createLifecycleHoldStore } from '../src/lifecycleHoldStore.mjs';
import { createDynamoSessionRegistry, userKey, familyKey, logoutKey } from '../src/sessionRegistry.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';

const endpoint = process.env.GROUP_DYNAMO_LOCAL_ENDPOINT;
if (!endpoint || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw new Error('Localhost-only DynamoDB endpoint required.');
const raw = new DynamoDBClient({ endpoint, region: 'eu-west-2', credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1 });
const client = DynamoDBDocumentClient.from(raw), tableName = `lifecycle-hold-${randomUUID()}`;
const at = 1_000_000;
let created = false;
const holdStore = (storage = client, time = at) => createLifecycleHoldStore({ client: storage, tableName, now: () => time });
const registry = (storage = client) => createDynamoSessionRegistry({ client: storage, tableName, now: () => at });
const read = async (Key) => (await client.send(new GetCommand({ TableName: tableName, Key, ConsistentRead: true }))).Item;
const write = (Item) => client.send(new PutCommand({ TableName: tableName, Item }));
const admittedRow = (subject) => ({ ...userKey(subject), subject, state: 'active', pilotExpiresAt: at + 100_000 });
const session = (subject) => ({ subject, familyId: randomUUID(), expiresAt: at + 100_000, authenticatedAt: at });
// Intercept timing only: mutations and expression evaluation reach real DynamoDB.
function intercept(kind, work, afterSend = false) {
  let calls = 0;
  return { get calls() { return calls; }, async send(command) {
    if (command.constructor.name !== kind) return client.send(command);
    const call = ++calls;
    if (!afterSend) await work(call);
    const result = await client.send(command);
    if (afterSend) await work(call);
    return result;
  } };
}
before(async () => {
  await raw.send(new CreateTableCommand({ TableName: tableName, BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }] }));
  created = true;
});
after(async () => {
  try { if (created) await raw.send(new DeleteTableCommand({ TableName: tableName })); }
  finally { raw.destroy(); }
});

test('real hold replaces absent, legacy, admitted and temporary-blocked rows without expiry or approval', async () => {
  for (const state of ['absent', 'legacy', 'admitted', 'blocked']) {
    const subject = randomUUID(), event = randomUUID();
    if (state === 'legacy') await write({ ...userKey(subject), subject });
    if (state === 'admitted') await write(admittedRow(subject));
    if (state === 'blocked') await registry().blockUser(subject);
    const row = await holdStore().begin(subject, event);
    assert.deepEqual(await read(userKey(subject)), row);
    assert.deepEqual(Object.keys(row).sort(), ['lifecycleHold', 'pk', 'state', 'subject']);
    assert.equal(row.state, 'blocked'); assert.equal(row.lifecycleHold.startedAt, at);
    assert.equal(row.lifecycleHold.version, 1);
    assert.deepEqual(await holdStore().read(subject, event), row);
    // A fresh adapter with a later clock must keep the original acquisition time.
    assert.deepEqual(await holdStore(client, at + 1000).begin(subject, event), row);
    assert.deepEqual(await read(userKey(subject)), row);
  }
});

test('real foreign event and identity collision never overwrite the stored row', async () => {
  const subject = randomUUID(), event = randomUUID(), original = await holdStore().begin(subject, event);
  await assert.rejects(holdStore().begin(subject, randomUUID()), /conflicting/);
  await assert.rejects(holdStore().read(subject, randomUUID()), /conflicting/);
  assert.deepEqual(await read(userKey(subject)), original);
  const other = randomUUID(), collision = { ...userKey(other), subject: randomUUID(), state: 'active' };
  await write(collision);
  await assert.rejects(holdStore().begin(other, event), /conflicting/);
  assert.deepEqual(await read(userKey(other)), collision);
});

test('real malformed hold markers and expiring same-event holds fail closed without repair', async () => {
  const subject = randomUUID(), event = randomUUID(), row = await holdStore().begin(subject, event);
  const variants = [
    { ...row, ttl: 0 }, { ...row, expiresAt: 0 }, { ...row, pilotExpiresAt: 0 },
    { ...row, extra: true }, { ...row, state: 'active' },
    ...[null, false, {}, { ...row.lifecycleHold, version: 2 },
      { ...row.lifecycleHold, startedAt: -1 }, { ...row.lifecycleHold, startedAt: 1.5 },
      { ...row.lifecycleHold, extra: true }].map((lifecycleHold) => ({ ...row, lifecycleHold })),
  ];
  for (const corrupt of variants) {
    await write(corrupt);
    await assert.rejects(holdStore().read(subject, event), /conflicting/);
    await assert.rejects(holdStore().begin(subject, event), /conflicting/);
    assert.deepEqual(await read(userKey(subject)), corrupt);
  }
});

test('real competing events acquire exactly one subject-wide hold', async () => {
  const subject = randomUUID(), events = [randomUUID(), randomUUID()];
  const outcomes = await Promise.allSettled(events.map((event) => holdStore().begin(subject, event)));
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  const winner = outcomes.findIndex((r) => r.status === 'fulfilled'), loser = 1 - winner;
  assert.equal(outcomes[loser].status, 'rejected');
  assert.match(outcomes[loser].reason.message, /conflicting/);
  assert.deepEqual(await holdStore().read(subject, events[winner]), outcomes[winner].value);
  assert.deepEqual(await read(userKey(subject)), outcomes[winner].value);
  await assert.rejects(holdStore().read(subject, events[loser]), /conflicting/);
});

test('real concurrent duplicate events converge and restart preserves ownership', async () => {
  const subject = randomUUID(), event = randomUUID();
  const rows = await Promise.all([holdStore().begin(subject, event), holdStore(client, at + 1).begin(subject, event)]);
  assert.deepEqual(rows[0], rows[1]);
  assert.deepEqual(await holdStore(client, at + 1000).begin(subject, event), rows[0]);
  rows[0].lifecycleHold.startedAt = 0;
  assert.deepEqual(await read(userKey(subject)), rows[1]);
});

test('real hold revokes existing session access and denies new session/logout registration', async () => {
  const subject = randomUUID(), event = randomUUID(), old = session(subject), store = registry();
  await write(admittedRow(subject)); await store.register(old);
  assert.equal(await store.active(old), true);
  const row = await holdStore().begin(subject, event);
  assert.equal(await store.active(old), false); assert.equal(await store.admitted(subject), false);
  const fresh = session(subject), secret = randomBytes(32).toString('hex');
  await assert.rejects(store.register(fresh), UnauthorizedError);
  await assert.rejects(store.registerWithLogout(fresh, secret), UnauthorizedError);
  assert.equal(await read(familyKey(fresh.familyId)), undefined);
  assert.equal(await read(logoutKey(secret)), undefined);
  assert.deepEqual(await read(userKey(subject)), row);
  // Marker presence denies even an otherwise approved row with a malformed hold.
  for (const lifecycleHold of [null, false, {}]) {
    await write({ ...admittedRow(subject), lifecycleHold });
    assert.equal(await store.active(old), false); assert.equal(await store.admitted(subject), false);
    await assert.rejects(store.register(fresh), UnauthorizedError);
    await assert.rejects(store.registerWithLogout(fresh, secret), UnauthorizedError);
    assert.equal(await read(familyKey(fresh.familyId)), undefined);
    assert.equal(await read(logoutKey(secret)), undefined);
  }
});

test('real hold acquired after admission preflight atomically cancels both registration forms', async () => {
  for (const withLogout of [false, true]) {
    const subject = randomUUID(), event = randomUUID(), fresh = session(subject), secret = randomBytes(32).toString('hex');
    await write(admittedRow(subject));
    assert.equal(await registry().admitted(subject), true);
    let held;
    const racing = intercept('TransactWriteCommand', async () => { held = await holdStore().begin(subject, event); });
    const operation = withLogout ? registry(racing).registerWithLogout(fresh, secret) : registry(racing).register(fresh);
    await assert.rejects(operation, UnauthorizedError);
    assert.equal(racing.calls, 1);
    assert.deepEqual(await read(userKey(subject)), held);
    assert.equal(await read(familyKey(fresh.familyId)), undefined);
    assert.equal(await read(logoutKey(secret)), undefined);
  }
});

test('real delayed temporary block cannot overwrite a hold or restore TTL', async () => {
  const subject = randomUUID(), event = randomUUID();
  await registry().blockUser(subject);
  assert.ok((await read(userKey(subject))).ttl);
  const row = await holdStore().begin(subject, event);
  await assert.rejects(registry().blockUser(subject), { name: 'ConditionalCheckFailedException' });
  assert.deepEqual(await read(userKey(subject)), row);
  const other = randomUUID(), otherEvent = randomUUID();
  let held;
  const racing = intercept('PutCommand', async () => { held = await holdStore().begin(other, otherEvent); });
  await assert.rejects(registry(racing).blockUser(other), { name: 'ConditionalCheckFailedException' });
  assert.equal(racing.calls, 1);
  assert.deepEqual(await read(userKey(other)), held);
});

test('real committed hold with lost response requires explicit retry and retains original start', async () => {
  const subject = randomUUID(), event = randomUUID(), failure = new Error('Synthetic response lost');
  const ambiguous = intercept('PutCommand', async () => { throw failure; }, true);
  await assert.rejects(holdStore(ambiguous).begin(subject, event), (error) => error === failure);
  assert.equal(ambiguous.calls, 1);
  const row = await holdStore().read(subject, event);
  assert.ok(row); assert.equal(row.lifecycleHold.startedAt, at);
  assert.deepEqual(await holdStore(client, at + 1000).begin(subject, event), row);
  assert.deepEqual(await read(userKey(subject)), row);
});
