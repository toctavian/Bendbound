// Local synthetic storage checks only; never connect to AWS.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoRoomStore } from '../src/roomStore.mjs';
import { createDynamoRoomCleanupStore } from '../src/roomCleanupStore.mjs';
const endpoint = process.env.GROUP_DYNAMO_LOCAL_ENDPOINT;
if (!endpoint || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw new Error('Localhost-only DynamoDB endpoint required.');
const raw = new DynamoDBClient({ endpoint, region: 'eu-west-2', credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1 });
const client = DynamoDBDocumentClient.from(raw), tableName = `room-cleanup-${randomUUID()}`;
const store = createDynamoRoomStore({ client, tableName, sessionTableName: 'synthetic-sessions', registry: { transactionChecks: () => [] } });
const cleanup = createDynamoRoomCleanupStore({ client, tableName });
const actor = { userId: 'synthetic', sessionId: 'synthetic', expiresAt: 1e12 };
const read = async (id) => (await client.send(new GetCommand({ TableName: tableName, Key: { pk: `ROOM#${id}` }, ConsistentRead: true }))).Item;
before(async () => {
  await raw.send(new CreateTableCommand({ TableName: tableName, BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }], AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'cleanupBucket', AttributeType: 'S' }, { AttributeName: 'purgeAt', AttributeType: 'N' },
    ], GlobalSecondaryIndexes: [{ IndexName: 'ExpiryIndex', KeySchema: [
      { AttributeName: 'cleanupBucket', KeyType: 'HASH' }, { AttributeName: 'purgeAt', KeyType: 'RANGE' },
    ], Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['revision'] } }],
  }));
});
after(async () => { await raw.send(new DeleteTableCommand({ TableName: tableName })); raw.destroy(); });
test('real room cleanup honours natural/early end boundaries and index contains no room payload', async () => {
  for (const endedAt of [undefined, 500_000]) {
    const id = randomUUID(), room = { id, revision: 1, expiresAt: 1_000_000, members: [], ...(endedAt === undefined ? {} : { endedAt, state: 'ended' }) };
    await store.create(room, actor); const row = await read(id);
    assert.equal(row.purgeAt, (endedAt ?? room.expiresAt) + 86_400_000 - 60_000);
    await cleanup.cleanup(row.purgeAt - 1); assert.ok(await read(id));
    const index = await client.send(new QueryCommand({ TableName: tableName, IndexName: 'ExpiryIndex', KeyConditionExpression: 'cleanupBucket = :bucket AND purgeAt <= :now', ExpressionAttributeValues: { ':bucket': 'ROOMS', ':now': row.purgeAt } }));
    assert.ok(index.Items.length); assert.equal(index.Items.some((item) => 'room' in item || 'members' in item), false);
    await cleanup.cleanup(row.purgeAt); assert.equal(await read(id), undefined);
  }
});
test('stale metadata index cannot erase concurrent revision/deadline updates', async () => {
  const id = randomUUID(), room = { id, revision: 1, expiresAt: 1_000_000, members: [] };
  await store.create(room, actor); const old = await read(id);
  let intercepted = false;
  const racing = createDynamoRoomCleanupStore({ tableName, client: { send: async (cmd) => {
    if (cmd.constructor.name === 'QueryCommand' && !intercepted) {
      intercepted = true;
      await store.replace({ ...room, revision: 2, expiresAt: 2_000_000 }, 1, actor);
      return { Items: [{ pk: old.pk, revision: old.revision, purgeAt: old.purgeAt }] };
    }
    return client.send(cmd);
  } } });
  assert.deepEqual(await racing.cleanup(old.purgeAt), { deleted: 0, examined: 1, more: false, oldestOverdueMs: 0 });
  assert.equal((await read(id)).revision, 2);
  await cleanup.cleanup((await read(id)).purgeAt);
});
test('1050 expired metadata rows drain across bounded invocations', async () => {
  const requests = Array.from({ length: 1050 }, (_, i) => ({ PutRequest: { Item: { pk: `ROOM#synthetic-${i}`, revision: 1, cleanupBucket: 'ROOMS', purgeAt: 1000 } } }));
  for (let i = 0; i < requests.length; i += 25) {
    const result = await client.send(new BatchWriteCommand({ RequestItems: { [tableName]: requests.slice(i, i + 25) } }));
    assert.equal((result.UnprocessedItems?.[tableName] ?? []).length, 0);
  }
  assert.deepEqual(await cleanup.cleanup(1000), { deleted: 1000, examined: 1000, more: true, oldestOverdueMs: 0 });
  assert.deepEqual(await cleanup.cleanup(1000), { deleted: 50, examined: 50, more: false, oldestOverdueMs: 0 });
});
