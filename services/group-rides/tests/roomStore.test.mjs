import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDynamoRoomStore } from '../src/roomStore.mjs';
const actor = { userId: 'synthetic-user', sessionId: 'synthetic-family', expiresAt: 2_000_000 };
const registry = { transactionChecks: (principal) => { assert.equal(principal.subject, actor.userId); return []; } };
function client() {
  let item; const calls = [];
  return { calls, async send(command) {
    const p = command.constructor.name === 'TransactWriteCommand' ? command.input.TransactItems[0].Put : command.input; calls.push(p);
    if (command.constructor.name === 'GetCommand') { assert.equal(p.ConsistentRead, true); return { Item: structuredClone(item) }; }
    if (command.constructor.name === 'TransactWriteCommand') {
      const conflict = p.ConditionExpression === 'attribute_not_exists(pk)' ? item !== undefined : item?.revision !== p.ExpressionAttributeValues[':revision'];
      if (conflict) throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
      item = structuredClone(p.Item); return {};
    }
    throw new Error('Unexpected command');
  } };
}
test('dedicated room adapter conditions create/update and rejects lost updates', async () => {
  const db = client(), store = createDynamoRoomStore({ registry, client: db, tableName: 'synthetic-room-metadata', sessionTableName: 'synthetic-sessions' });
  const room = { id: 'synthetic-room', revision: 1, expiresAt: 1_000_000, members: [] };
  assert.equal(await store.create(room, actor), true); assert.equal(await store.create(room, actor), false);
  const one = await store.read(room.id), two = await store.read(room.id);
  assert.equal(await store.replace({ ...one, revision: 2, title: 'First' }, 1, actor), true);
  assert.equal(await store.replace({ ...two, revision: 2, title: 'Lost update' }, 1, actor), false);
  assert.equal((await store.read(room.id)).title, 'First');
  const put = db.calls.find((c) => c.Item); assert.equal(put.Item.ttl, Math.ceil((room.expiresAt + 86_400_000) / 1000));
});
test('storage failures propagate instead of being mistaken for a harmless revision conflict', async () => {
  const store = createDynamoRoomStore({ registry, client: { send: async () => { throw new Error('unavailable'); } }, tableName: 'synthetic-room-metadata', sessionTableName: 'synthetic-sessions' });
  await assert.rejects(store.create({ id: 'synthetic', revision: 1, expiresAt: 1_000_000 }, actor));
});

test('session-table reuse and coordinates/raw credentials cannot enter room metadata', async () => {
  const db = client();
  assert.throws(() => createDynamoRoomStore({ registry, client: db, tableName: 'synthetic-sessions', sessionTableName: 'synthetic-sessions' }));
  const store = createDynamoRoomStore({ registry, client: db, tableName: 'synthetic-room-metadata', sessionTableName: 'synthetic-sessions' });
  for (const extra of [{ fix: { latitude: 0 } }, { token: 'synthetic-capability' }, { members: [{ coords: { longitude: 0 } }] }]) {
    await assert.rejects(store.create({ id: 'synthetic', revision: 1, expiresAt: 1_000_000, ...extra }, actor), /Sensitive data/);
  }
  assert.equal(db.calls.length, 0);
});

test('ending early uses end time for metadata TTL rather than the original ride deadline', async () => {
  const db = client(), store = createDynamoRoomStore({ registry, client: db, tableName: 'synthetic-room-metadata', sessionTableName: 'synthetic-sessions' });
  await store.create({ id: 'synthetic', revision: 1, expiresAt: 10_000_000, endedAt: 1_000_000, state: 'ended' }, actor);
  assert.equal(db.calls[0].Item.ttl, Math.ceil((1_000_000 + 86_400_000) / 1000));
});
test('metadata writes require both a live registry adapter and the verified actor', async () => {
  const db = client();
  assert.throws(() => createDynamoRoomStore({ client: db, tableName: 'synthetic-rooms', sessionTableName: 'synthetic-sessions' }));
  const store = createDynamoRoomStore({ registry, client: db, tableName: 'synthetic-rooms', sessionTableName: 'synthetic-sessions' });
  await assert.rejects(store.create({ id: 'synthetic', revision: 1, expiresAt: 1_000_000 }), /verified room actor/);
  assert.equal(db.calls.length, 0);
});
test('room writes schedule early explicit cleanup without extending expired-room retention', async () => {
  const db = client(), store = createDynamoRoomStore({ registry, client: db, tableName: 'synthetic-room-metadata', sessionTableName: 'synthetic-sessions' });
  await store.create({ id: 'synthetic', revision: 1, expiresAt: 1_000_000, endedAt: 2_000_000, state: 'ended' }, actor);
  const item = db.calls[0].Item;
  assert.equal(item.cleanupBucket, 'ROOMS');
  assert.equal(item.purgeAt, 1_000_000 + 86_400_000 - 60_000);
  assert.equal(item.ttl, (1_000_000 + 86_400_000) / 1000);
});
