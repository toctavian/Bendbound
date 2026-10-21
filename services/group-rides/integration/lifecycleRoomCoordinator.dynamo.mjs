// Real localhost transactions exercising the production coordinator; no cloud operations.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createLifecycleHoldStore } from '../src/lifecycleHoldStore.mjs';
import { userKey } from '../src/sessionRegistry.mjs';
import { hash, locationKey } from '../src/locationKeys.mjs';

const endpoint = process.env.GROUP_DYNAMO_LOCAL_ENDPOINT;
if (!endpoint || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw new Error('Localhost-only DynamoDB endpoint required.');
const raw = new DynamoDBClient({ endpoint, region: 'eu-west-2', credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1 });
const client = DynamoDBDocumentClient.from(raw);
after(() => raw.destroy());
const read = async (TableName, Key) => (await client.send(new GetCommand({ TableName, Key, ConsistentRead: true }))).Item;
const put = (TableName, Item) => client.send(new PutCommand({ TableName, Item }));

async function fixture(work) {
  const suffix = randomUUID(), config = { tableName: `recovery-progress-${suffix}`,
    sessionTableName: `recovery-sessions-${suffix}`, roomTableName: `recovery-rooms-${suffix}`,
    locationTableName: `recovery-points-${suffix}` }, created = [];
  try {
    for (const TableName of Object.values(config)) {
      const points = TableName === config.locationTableName;
      await raw.send(new CreateTableCommand({ TableName, BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, ...(points ? [{ AttributeName: 'sk', KeyType: 'RANGE' }] : [])],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, ...(points ? [{ AttributeName: 'sk', AttributeType: 'S' }] : [])] }));
      created.push(TableName);
    }
    const subject = randomUUID(), event = randomUUID(), peer = randomUUID(), clock = { at: 1_000_000 };
    const holdStore = createLifecycleHoldStore({ client, tableName: config.sessionTableName, now: () => clock.at });
    const held = await holdStore.begin(subject, event);
    const room = (id) => read(config.roomTableName, { pk: `ROOM#${id}` });
    const point = (id, rider = subject) => read(config.locationTableName, locationKey(id, rider));
    async function seed({ member = true, orphan = false } = {}) {
      const id = hash(randomUUID());
      if (!orphan) await put(config.roomTableName, { pk: `ROOM#${id}`, revision: 1,
        room: { id, revision: 1, ownerId: member ? subject : peer, state: 'riding', expiresAt: clock.at + 100_000,
          invite: { synthetic: true }, members: (member ? [subject, peer] : [peer]).map((userId) => ({ userId, displayName: 'Synthetic rider' })) },
        purgeAt: clock.at + 86_400_000, ttl: Math.ceil((clock.at + 86_400_000 + 60_000) / 1000) });
      if (member || orphan) await put(config.locationTableName, { ...locationKey(id, subject), synthetic: true });
      return id;
    }
    await work({ config, subject, event, peer, clock, held, room, point, seed });
  } finally {
    const results = await Promise.allSettled(created.map((TableName) => raw.send(new DeleteTableCommand({ TableName }))));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Synthetic recovery table cleanup failed.');
  }
}

import { createLifecycleRoomCoordinator } from '../src/lifecycleRoomCoordinator.mjs';
function context(f) { return { subject: f.subject, eventId: f.event, holdStartedAt: f.held.lifecycleHold.startedAt }; }
function worker(f, storage = client, options = {}) {
  return createLifecycleRoomCoordinator({ ...f.config, progressTableName: f.config.tableName, client: storage, now: () => f.clock.at, maxSteps: 3, ...options });
}
const progress = (f) => read(f.config.tableName, { pk: `LIFECYCLE#${hash(JSON.stringify([f.subject, f.event]))}` });
function intercept(hook) { return { send: (command) => hook(command, () => client.send(command)) }; }
async function drain(f) {
  for (let i = 0; i < 100; i++) {
    const r = await worker(f)(context(f));
    assert.equal('deleted' in r, false); assert.equal('complete' in r, false);
    if (r.status === 'traversal_ended') return r;
    assert.equal(r.status, 'pending'); f.clock.at += r.retryAfterMs;
  }
  throw new Error('Synthetic worker did not finish bounded traversal');
}
test('bounded coordinator resumes pages, erases own membership/orphans, preserves peers and hold', async () => fixture(async (f) => {
  const member = await f.seed(), orphan = await f.seed({ orphan: true }), unrelated = await f.seed({ member: false });
  const untouched = await f.room(unrelated);
  await put(f.config.locationTableName, { ...locationKey(member, f.peer), synthetic: 'peer' });
  const peerPoint = await f.point(member, f.peer);
  assert.equal((await worker(f, client, { maxSteps: 1 })(context(f))).status, 'pending');
  const row = await progress(f); assert.equal(row.lease, null); assert.ok(row.pendingPage);
  await drain(f);
  assert.equal(await f.point(member), undefined); assert.equal(await f.point(orphan), undefined);
  assert.deepEqual(await f.point(member, f.peer), peerPoint); assert.deepEqual(await f.room(unrelated), untouched);
  const room = await f.room(member);
  assert.equal(room.room.ownerId, f.peer); assert.equal(room.room.invite, null);
  assert.deepEqual(room.room.members.map((m) => m.userId), [f.peer]);
  assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), f.held);
  assert.equal((await progress(f)).traversalEnded, true);
  assert.deepEqual(await worker(f)(context(f)), { status: 'traversal_ended', roomsProcessed: 0 });
}));
test('lost stage commit response stops purge until durable reread and expired-lease takeover', async () => fixture(async (f) => {
  const id = await f.seed(), before = await f.room(id); let lost = false;
  const storage = intercept(async (command, send) => {
    const result = await send();
    if (!lost && command.input.TransactItems?.some((v) => v.Put?.TableName === f.config.tableName && v.Put.Item.pendingPage)) {
      lost = true; throw new Error('Synthetic stage response lost');
    }
    return result;
  });
  await assert.rejects(worker(f, storage)(context(f)), /response lost/);
  const staged = await progress(f); assert.ok(staged.pendingPage.roomIds.includes(id));
  assert.deepEqual(await f.room(id), before); assert.ok(await f.point(id));
  assert.equal((await worker(f)(context(f))).status, 'pending'); assert.deepEqual(await progress(f), staged);
  f.clock.at = staged.lease.until; await drain(f);
  assert.equal(await f.point(id), undefined); assert.equal((await f.room(id)).revision, 2);
}));
test('lost purge response retains item; replay does not repeat membership mutation', async () => fixture(async (f) => {
  const id = await f.seed(); let lost = false;
  const storage = intercept(async (command, send) => {
    const result = await send();
    if (!lost && command.input.TransactItems?.some((v) => v.Delete?.TableName === f.config.locationTableName)) {
      lost = true; throw new Error('Synthetic purge response lost');
    }
    return result;
  });
  await assert.rejects(worker(f, storage, { maxSteps: 10 })(context(f)), /response lost/);
  const row = await progress(f), purged = await f.room(id);
  assert.ok(row.pendingPage.roomIds.includes(id)); assert.equal(await f.point(id), undefined);
  f.clock.at = row.lease.until; await drain(f); assert.deepEqual(await f.room(id), purged);
}));
test('replacement hold between scan and stage fences original invocation and cross-incarnation retries', async () => fixture(async (f) => {
  const id = await f.seed(), before = await f.room(id); let replaced = false;
  const storage = intercept(async (command, send) => {
    const result = await send();
    if (!replaced && command.constructor.name === 'ScanCommand') {
      replaced = true;
      await put(f.config.sessionTableName, { ...f.held, lifecycleHold: { ...f.held.lifecycleHold, startedAt: f.clock.at + 1 } });
    }
    return result;
  });
  await assert.rejects(worker(f, storage)(context(f)));
  const row = await progress(f); assert.equal(row.pendingPage, null);
  await assert.rejects(worker(f)(context(f)));
  await assert.rejects(worker(f)({ ...context(f), holdStartedAt: f.clock.at + 1 }));
  assert.deepEqual(await progress(f), row); assert.deepEqual(await f.room(id), before); assert.ok(await f.point(id));
}));
test('concurrent workers preserve retained work and reject caller-supplied cursors', async () => fixture(async (f) => {
  const id = await f.seed(); await assert.rejects(worker(f)({ ...context(f), cursor: null }));
  const outcomes = await Promise.allSettled([worker(f)(context(f)), worker(f)(context(f))]);
  assert.ok(outcomes.some((v) => v.status === 'fulfilled'));
  const row = await progress(f); if (row.lease) f.clock.at = row.lease.until;
  await drain(f); assert.equal(await f.point(id), undefined); assert.equal((await f.room(id)).revision, 2);
}));
