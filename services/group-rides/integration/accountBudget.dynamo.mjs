// Synthetic localhost-only checks; no AWS resource operations.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createAccountBudget, AccountRateLimitedError } from '../src/accountBudget.mjs';
const endpoint = process.env.GROUP_DYNAMO_LOCAL_ENDPOINT;
if (!endpoint || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw new Error('Localhost-only DynamoDB endpoint required.');
const raw = new DynamoDBClient({ endpoint, region: 'eu-west-2', credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1 });
const client = DynamoDBDocumentClient.from(raw), tableName = `account-budget-${randomUUID()}`;
let at = 60_000;
const config = { client, tableName, now: () => at, globalLimit: 3, accountLimit: 2 };
const consume = createAccountBudget(config), other = createAccountBudget(config);
const read = async (key) => (await client.send(new GetCommand({ TableName: tableName, Key: { pk: key }, ConsistentRead: true }))).Item;
before(async () => {
  await raw.send(new CreateTableCommand({ TableName: tableName, BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }] }));
});
after(async () => { try { await raw.send(new DeleteTableCommand({ TableName: tableName })); } finally { raw.destroy(); } });
test('real atomic counters bound concurrent accounts, deny new allocation and reset independently of TTL', async () => {
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => (i % 2 ? consume : other)('bootstrap', 'synthetic-one')));
  // Transaction conflicts may conservatively deny, but never admit above the cap.
  assert.ok(results.filter((r) => r.status === 'fulfilled').length <= 2);
  for (let i = 0; i < 2; i++) { try { await consume('bootstrap', 'synthetic-one'); } catch (e) { assert.ok(e instanceof AccountRateLimitedError); } }
  assert.equal((await read('ACCOUNT_RATE#bootstrap#1#GLOBAL')).count, 2);
  await assert.rejects(consume('bootstrap', 'synthetic-one'), AccountRateLimitedError);
  assert.equal((await read('ACCOUNT_RATE#bootstrap#1#GLOBAL')).count, 2); // rejected transaction did not spend global permit
  await other('bootstrap', 'synthetic-two');
  await assert.rejects(consume('bootstrap', 'synthetic-three'), AccountRateLimitedError);
  assert.equal((await read('ACCOUNT_RATE#bootstrap#1#GLOBAL')).count, 3);
  const deniedAccount = createHash('sha256').update(JSON.stringify([1, 'bootstrap', 'synthetic-three'])).digest('hex');
  assert.equal(await read(`ACCOUNT_RATE#bootstrap#1#${deniedAccount}`), undefined);
  assert.equal((await read('ACCOUNT_RATE#bootstrap#1#GLOBAL')).ttl, 180);
  await consume('logout', 'synthetic-one');
  assert.equal((await read('ACCOUNT_RATE#logout#1#GLOBAL')).count, 1);
  at = 120_000; await consume('bootstrap', 'synthetic-one');
  assert.equal((await read('ACCOUNT_RATE#bootstrap#2#GLOBAL')).count, 1);
  assert.equal((await read('ACCOUNT_RATE#bootstrap#1#GLOBAL')).count, 3); // old TTL row still present
});

test('real status transactions cap shared instances, roll back denial and isolate logout capacity', async () => {
  let statusAt = 180_000;
  const config = { client, tableName, now: () => statusAt, statusGlobalLimit: 3, statusAccountLimit: 2 };
  const first = createAccountBudget(config), second = createAccountBudget(config);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second)('status', 'synthetic-status')));
  assert.ok(results.filter((r) => r.status === 'fulfilled').length <= 2);
  for (let i = 0; i < 2; i++) { try { await first('status', 'synthetic-status'); } catch (e) { assert.ok(e instanceof AccountRateLimitedError); } }
  assert.equal((await read('ACCOUNT_RATE#status#3#GLOBAL')).count, 2);
  await assert.rejects(second('status', 'synthetic-status'), AccountRateLimitedError);
  assert.equal((await read('ACCOUNT_RATE#status#3#GLOBAL')).count, 2);
  await second('status', 'synthetic-status-two');
  await assert.rejects(first('status', 'synthetic-status-denied'), AccountRateLimitedError);
  const hash = createHash('sha256').update(JSON.stringify([3, 'status', 'synthetic-status-denied'])).digest('hex');
  assert.equal(await read(`ACCOUNT_RATE#status#3#${hash}`), undefined);
  await first('bootstrap', 'synthetic-status'); await first('logout', 'synthetic-status');
  assert.equal((await read('ACCOUNT_RATE#bootstrap#3#GLOBAL')).count, 1);
  assert.equal((await read('ACCOUNT_RATE#logout#3#GLOBAL')).count, 1);
  statusAt = 240_000; await first('status', 'synthetic-status');
  assert.equal((await read('ACCOUNT_RATE#status#4#GLOBAL')).count, 1);
  assert.equal((await read('ACCOUNT_RATE#status#3#GLOBAL')).count, 3);
});
