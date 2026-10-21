// Synthetic localhost-only checks; no AWS resource operations.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createLogoutBudget, LogoutRateLimitedError } from '../src/logoutBudget.mjs';
const endpoint = process.env.GROUP_DYNAMO_LOCAL_ENDPOINT;
if (!endpoint || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw new Error('Localhost-only DynamoDB endpoint required.');
const raw = new DynamoDBClient({ endpoint, region: 'eu-west-2', credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1 });
const client = DynamoDBDocumentClient.from(raw), tableName = `logout-budget-${randomUUID()}`;
let at = 60_000;
const config = { client, tableName, now: () => at, globalLimit: 3, sourceLimit: 2 };
const consume = createLogoutBudget(config), other = createLogoutBudget(config);
const read = async (key) => (await client.send(new GetCommand({ TableName: tableName, Key: { pk: key }, ConsistentRead: true }))).Item;
before(async () => {
  await raw.send(new CreateTableCommand({ TableName: tableName, BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }] }));
});
after(async () => { try { await raw.send(new DeleteTableCommand({ TableName: tableName })); } finally { raw.destroy(); } });
test('real atomic counters bound concurrent sources, deny new allocation and reset independently of TTL', async () => {
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => (i % 2 ? consume : other)('192.0.2.1')));
  // Transaction conflicts may conservatively deny, but never admit above the cap.
  assert.ok(results.filter((r) => r.status === 'fulfilled').length <= 2);
  for (let i = 0; i < 2; i++) { try { await consume('192.0.2.1'); } catch (e) { assert.ok(e instanceof LogoutRateLimitedError); } }
  assert.equal((await read('LOGOUT_RATE#1#GLOBAL')).count, 2);
  await assert.rejects(consume('192.0.2.1'), LogoutRateLimitedError);
  assert.equal((await read('LOGOUT_RATE#1#GLOBAL')).count, 2); // rejected transaction did not spend global permit
  await other('192.0.2.2');
  await assert.rejects(consume('192.0.2.3'), LogoutRateLimitedError);
  assert.equal((await read('LOGOUT_RATE#1#GLOBAL')).count, 3);
  const deniedSource = createHash('sha256').update('1\0' + '192.0.2.3').digest('hex');
  assert.equal(await read(`LOGOUT_RATE#1#${deniedSource}`), undefined);
  assert.equal((await read('LOGOUT_RATE#1#GLOBAL')).ttl, 180);
  at = 120_000; await consume('192.0.2.1');
  assert.equal((await read('LOGOUT_RATE#2#GLOBAL')).count, 1);
  assert.equal((await read('LOGOUT_RATE#1#GLOBAL')).count, 3); // old TTL row still present
});
