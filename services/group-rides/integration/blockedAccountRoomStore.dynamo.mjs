// Explicit localhost-only integration suite. Never creates cloud resources.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { createBlockedAccountRoomStore, createLifecycleRoomStore } from '../src/blockedAccountRoomStore.mjs';
import { createDynamoSessionRegistry, userKey } from '../src/sessionRegistry.mjs';
import { createDynamoRoomStore } from '../src/roomStore.mjs';
import { createRoomService } from '../src/rooms.mjs';
import { createDynamoLocationStore } from '../src/locationStore.mjs';
import { createLocationService } from '../src/locations.mjs';
import { locationKey } from '../src/locationKeys.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';
import { createLifecycleHoldStore } from '../src/lifecycleHoldStore.mjs';

const endpoint = process.env.GROUP_DYNAMO_LOCAL_ENDPOINT;
if (!endpoint || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw new Error('Localhost-only DynamoDB endpoint required.');
const raw = new DynamoDBClient({ endpoint, region: 'eu-west-2', credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1 });
const client = DynamoDBDocumentClient.from(raw);
const suffix = randomUUID(), sessions = `purge-sessions-${suffix}`, metadata = `purge-rooms-${suffix}`, locations = `purge-locations-${suffix}`;
const created = [], at = 1_000_000;
const registry = createDynamoSessionRegistry({ client, tableName: sessions, now: () => at });
const roomStore = createDynamoRoomStore({ client, registry, now: () => at, tableName: metadata, sessionTableName: sessions, locationTableName: locations });
const rooms = createRoomService({ store: roomStore, sessionActive: registry.active, now: () => at });
const pointStore = createDynamoLocationStore({ client, registry, tableName: locations, roomTableName: metadata, sessionTableName: sessions });
const publication = createLocationService({ rooms, store: pointStore, now: () => at });
const purgeStore = (storage = client) => createBlockedAccountRoomStore({ client: storage, tableName: metadata, sessionTableName: sessions, locationTableName: locations, now: () => at });
const read = async (TableName, Key) => (await client.send(new GetCommand({ TableName, Key, ConsistentRead: true }))).Item;
const readRoom = (id) => read(metadata, { pk: `ROOM#${id}` });
const command = () => ({ id: randomUUID(), createdAt: at });
const profile = { displayName: 'Synthetic rider', motorcycleType: 'adventure' };
const fix = (epoch) => ({ version: 1, fix: { latitude: 0, longitude: 0, accuracyM: 5, headingDeg: null, speedMps: null, capturedAt: at, sessionEpoch: epoch, sequence: 1 } });
async function admit(subject) {
  await client.send(new PutCommand({ TableName: sessions, Item: { ...userKey(subject), subject, state: 'active', pilotExpiresAt: at + 100_000_000 } }));
}
async function actor() {
  const value = { userId: randomUUID(), sessionId: randomUUID(), expiresAt: at + 100_000_000 };
  await admit(value.userId);
  await registry.register({ subject: value.userId, familyId: value.sessionId, expiresAt: value.expiresAt, authenticatedAt: at });
  return value;
}
async function fixture({ peer = true, publish = true } = {}) {
  const owner = await actor(), room = await rooms.create(owner, command(), { ...profile, title: 'Synthetic ride' });
  const invite = await rooms.invite(owner, room.id);
  let rider;
  if (peer) { rider = await actor(); await rooms.join(rider, room.id, invite.token, profile); }
  await rooms.start(owner, room.id, command());
  const epoch = (await rooms.sharing(owner, room.id, command(), true)).result.deviceEpoch;
  if (publish) await publication.publish(owner, room.id, fix(epoch));
  return { owner, rider, id: room.id, epoch };
}
// Pause immediately before a real transaction reaches DynamoDB, after the helper
// read. The hook changes real rows; it does not simulate expression evaluation.
function intercept(work) {
  let calls = 0;
  return { get calls() { return calls; }, async send(cmd) {
    if (cmd.constructor.name === 'TransactWriteCommand') await work(++calls);
    return client.send(cmd);
  } };
}
before(async () => {
  for (const TableName of [sessions, metadata, locations]) {
    const composite = TableName === locations;
    await raw.send(new CreateTableCommand({ TableName, BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, ...(composite ? [{ AttributeName: 'sk', KeyType: 'RANGE' }] : [])],
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, ...(composite ? [{ AttributeName: 'sk', AttributeType: 'S' }] : [])],
    }));
    created.push(TableName);
  }
});
after(async () => {
  // Attempt all cleanup even when setup/assertions fail; surface cleanup failures.
  try {
    const outcomes = await Promise.allSettled(created.map((TableName) => raw.send(new DeleteTableCommand({ TableName }))));
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  } finally { raw.destroy(); }
});

test('real three-table purge transfers owner, clears profile/grant/invite/point and retries without mutation', async () => {
  const { owner, rider, id } = await fixture(), before = await readRoom(id);
  await registry.blockUser(owner.userId);
  assert.deepEqual(await purgeStore().purgeRoom(owner.userId, id), { membershipRemoved: true });
  const after = await readRoom(id);
  assert.equal(after.revision, before.revision + 1); assert.equal(after.room.revision, after.revision);
  assert.equal(after.room.ownerId, rider.userId); assert.equal(after.room.invite, null);
  assert.deepEqual(after.room.members, before.room.members.filter((m) => m.userId !== owner.userId));
  assert.equal(after.purgeAt, before.purgeAt); assert.equal(after.ttl, before.ttl);
  assert.equal(await pointStore.read(id, owner.userId), null);
  assert.deepEqual(await purgeStore().purgeRoom(owner.userId, id), { membershipRemoved: false });
  assert.deepEqual(await readRoom(id), after);
});

test('real last-member purge ends the room and shortens retention', async () => {
  const { owner, id } = await fixture({ peer: false });
  await registry.blockUser(owner.userId); await purgeStore().purgeRoom(owner.userId, id);
  const after = await readRoom(id);
  assert.equal(after.room.ownerId, null); assert.deepEqual(after.room.members, []);
  assert.equal(after.room.state, 'ended'); assert.equal(after.room.endedAt, at);
  assert.equal(after.purgeAt, at + 86_400_000 - 60_000); assert.equal(after.ttl, Math.ceil((at + 86_400_000) / 1000));
  assert.equal(await pointStore.read(id, owner.userId), null);
});

test('real absent/active/mismatched USER conditions deny atomically', async () => {
  for (const state of ['missing', 'active', 'mismatched']) {
    const { owner, id } = await fixture(), before = await readRoom(id), point = await pointStore.read(id, owner.userId);
    if (state === 'missing') await client.send(new DeleteCommand({ TableName: sessions, Key: userKey(owner.userId) }));
    if (state === 'mismatched') await client.send(new PutCommand({ TableName: sessions, Item: { ...userKey(owner.userId), subject: randomUUID(), state: 'blocked' } }));
    await assert.rejects(purgeStore().purgeRoom(owner.userId, id), UnauthorizedError);
    assert.deepEqual(await readRoom(id), before); assert.deepEqual(await pointStore.read(id, owner.userId), point);
  }
});

test('readmission between metadata read and transaction cancels all erasure', async () => {
  const { owner, id } = await fixture(), before = await readRoom(id), point = await pointStore.read(id, owner.userId);
  await registry.blockUser(owner.userId);
  const racing = intercept(async () => admit(owner.userId));
  await assert.rejects(purgeStore(racing).purgeRoom(owner.userId, id), UnauthorizedError);
  assert.equal(racing.calls, 1); assert.deepEqual(await readRoom(id), before);
  assert.deepEqual(await pointStore.read(id, owner.userId), point);
});

test('real revision conflict retries and preserves a concurrent member edit', async () => {
  const { owner, rider, id } = await fixture(); await registry.blockUser(owner.userId);
  const before = await readRoom(id);
  const racing = intercept(async (call) => {
    if (call === 1) await rooms.sharing(rider, id, command(), true);
  });
  await purgeStore(racing).purgeRoom(owner.userId, id);
  const after = await readRoom(id);
  assert.equal(racing.calls, 2); assert.equal(after.revision, before.revision + 2);
  assert.equal(after.room.ownerId, rider.userId); assert.equal(after.room.members[0].sharing, true);
  assert.ok(after.room.members[0].deviceEpoch); assert.equal(await pointStore.read(id, owner.userId), null);
});

test('absent room and absent membership erase orphan points without creating or rewriting metadata', async () => {
  for (const absentRoom of [true, false]) {
    const { owner, id } = await fixture(); await registry.blockUser(owner.userId);
    await purgeStore().purgeRoom(owner.userId, id);
    if (absentRoom) await client.send(new DeleteCommand({ TableName: metadata, Key: { pk: `ROOM#${id}` } }));
    const before = await readRoom(id);
    await client.send(new PutCommand({ TableName: locations, Item: { ...locationKey(id, owner.userId), synthetic: true } }));
    assert.deepEqual(await purgeStore().purgeRoom(owner.userId, id), { membershipRemoved: false });
    assert.deepEqual(await readRoom(id), before); assert.equal(await pointStore.read(id, owner.userId), null);
  }
});

test('metadata created after absent read forces rediscovery before orphan erasure', async () => {
  const subject = randomUUID(), id = randomBytes(32).toString('hex'); await registry.blockUser(subject);
  const initial = { pk: `ROOM#${id}`, revision: 1, purgeAt: at + 100_000, ttl: 100_000,
    room: { id, revision: 1, ownerId: subject, state: 'riding', expiresAt: at + 100_000,
      members: [{ userId: subject, displayName: 'Synthetic', sharing: false }], invite: null } };
  await client.send(new PutCommand({ TableName: locations, Item: { ...locationKey(id, subject), synthetic: true } }));
  const racing = intercept(async (call) => {
    if (call === 1) await client.send(new PutCommand({ TableName: metadata, Item: initial }));
  });
  assert.deepEqual(await purgeStore(racing).purgeRoom(subject, id), { membershipRemoved: true });
  assert.equal(racing.calls, 2); assert.equal((await readRoom(id)).room.ownerId, null);
  assert.equal(await pointStore.read(id, subject), null);
});

test('in-flight publication cannot recreate a point after block and purge', async () => {
  const { owner, id, epoch } = await fixture({ publish: false });
  let intercepted = false;
  const gated = createLocationService({ rooms, now: () => at, store: { read: pointStore.read, commit: async (input) => {
    assert.equal(intercepted, false); intercepted = true;
    await registry.blockUser(owner.userId); await purgeStore().purgeRoom(owner.userId, id);
    assert.equal(await pointStore.commit(input), false);
    return false;
  } } });
  await assert.rejects(gated.publish(owner, id, fix(epoch)), UnauthorizedError);
  assert.equal(intercepted, true); assert.equal(await pointStore.read(id, owner.userId), null);
  assert.equal((await readRoom(id)).room.members.some((m) => m.userId === owner.userId), false);
});

test('publication committed before block is erased by the following purge', async () => {
  const { owner, id, epoch } = await fixture({ publish: false });
  let intercepted = false;
  const gated = createLocationService({ rooms, now: () => at, store: { read: pointStore.read, commit: async (input) => {
    intercepted = true;
    assert.equal(await pointStore.commit(input), true);
    assert.ok(await pointStore.read(id, owner.userId));
    await registry.blockUser(owner.userId); await purgeStore().purgeRoom(owner.userId, id);
    return true;
  } } });
  await gated.publish(owner, id, fix(epoch));
  assert.equal(intercepted, true); assert.equal(await pointStore.read(id, owner.userId), null);
});

test('continuous real revision conflicts exhaust six attempts without erasing the point', async () => {
  const { owner, rider, id } = await fixture(); await registry.blockUser(owner.userId);
  const point = await pointStore.read(id, owner.userId);
  const racing = intercept(async () => rooms.sharing(rider, id, command(), true));
  await assert.rejects(purgeStore(racing).purgeRoom(owner.userId, id), { code: 'ROOM_BUSY' });
  assert.equal(racing.calls, 6);
  assert.deepEqual(await pointStore.read(id, owner.userId), point);
  assert.ok((await readRoom(id)).room.members.some((m) => m.userId === owner.userId));
});

// Lifecycle cases share the guarded three-table harness above. All hold/room
// mutations below reach the real local service; no expression evaluator is faked.
const lifecyclePurge = (storage = client) => createLifecycleRoomStore({ client: storage,
  tableName: metadata, sessionTableName: sessions, locationTableName: locations, now: () => at });
const holds = createLifecycleHoldStore({ client, tableName: sessions, now: () => at });
async function lifecycleFixture(options = {}) {
  const f = await fixture(options), subject = options.member ? f.rider.userId : f.owner.userId;
  if (options.member) {
    const epoch = (await rooms.sharing(f.rider, f.id, command(), true)).result.deviceEpoch;
    await publication.publish(f.rider, f.id, fix(epoch));
  }
  const event = randomUUID(), hold = await holds.begin(subject, event);
  return { ...f, subject, event, hold };
}
const writeHold = (row) => client.send(new PutCommand({ TableName: sessions, Item: row }));
async function bumpRoom(id) {
  const row = await readRoom(id);
  row.revision++; row.room.revision = row.revision;
  await client.send(new PutCommand({ TableName: metadata, Item: row }));
  return row;
}

test('lifecycle real exact hold permits owner/member/last-member erasure and stable replay', async () => {
  for (const options of [{}, { member: true }, { peer: false }]) {
    const { owner, id, subject, event, hold } = await lifecycleFixture(options), before = await readRoom(id);
    assert.deepEqual(await holds.begin(subject, event), hold); // Duplicate ingress keeps the same hold.
    assert.deepEqual(await lifecyclePurge().purgeRoom(subject, event, id), { membershipRemoved: true });
    const after = await readRoom(id);
    assert.equal(after.revision, before.revision + 1); assert.equal(after.room.revision, after.revision);
    assert.deepEqual(after.room.members, before.room.members.filter((m) => m.userId !== subject));
    assert.equal(after.room.invite, null); assert.equal(await pointStore.read(id, subject), null);
    if (options.peer === false) {
      assert.equal(after.room.state, 'ended'); assert.equal(after.room.ownerId, null);
      assert.equal(after.room.endedAt, at); assert.equal(after.purgeAt, at + 86_400_000 - 60_000);
      assert.equal(after.ttl, Math.ceil((at + 86_400_000) / 1000));
    } else {
      assert.equal(after.room.ownerId, options.member ? owner.userId : after.room.members[0].userId);
      assert.equal(after.purgeAt, before.purgeAt); assert.equal(after.ttl, before.ttl);
    }
    assert.deepEqual(await lifecyclePurge().purgeRoom(subject, event, id), { membershipRemoved: false });
    assert.deepEqual(await readRoom(id), after); assert.deepEqual(await holds.read(subject, event), hold);
  }
});

test('lifecycle real hold gates orphan erasure with absent room or absent membership', async () => {
  for (const absentRoom of [true, false]) {
    const { id, subject, event } = await lifecycleFixture();
    await lifecyclePurge().purgeRoom(subject, event, id);
    if (absentRoom) await client.send(new DeleteCommand({ TableName: metadata, Key: { pk: `ROOM#${id}` } }));
    const before = await readRoom(id);
    await client.send(new PutCommand({ TableName: locations, Item: { ...locationKey(id, subject), synthetic: true } }));
    assert.deepEqual(await lifecyclePurge().purgeRoom(subject, event, id), { membershipRemoved: false });
    assert.deepEqual(await readRoom(id), before); assert.equal(await pointStore.read(id, subject), null);
  }
});

test('lifecycle strict initial denial never reads room or attempts erasure', async () => {
  const mutations = [
    () => undefined,
    (row) => ({ pk: row.pk, subject: row.subject, state: 'blocked' }), // Temporary block.
    (row) => ({ ...row, state: 'active' }),
    (row) => ({ ...row, subject: randomUUID() }),
    (row) => ({ ...row, lifecycleHold: { ...row.lifecycleHold, binding: 'foreign-event' } }),
    (row) => ({ ...row, lifecycleHold: { ...row.lifecycleHold, version: 2 } }),
    (row) => ({ ...row, lifecycleHold: { ...row.lifecycleHold, extra: true } }),
    (row) => ({ ...row, lifecycleHold: { ...row.lifecycleHold, startedAt: -1 } }),
    ...['ttl', 'expiresAt', 'pilotExpiresAt'].map((key) => (row) => ({ ...row, [key]: 0 })),
  ];
  for (const mutate of mutations) {
    const { id, subject, event, hold } = await lifecycleFixture(), before = await readRoom(id);
    const point = await pointStore.read(id, subject), changed = mutate(structuredClone(hold));
    if (changed) await writeHold(changed);
    else await client.send(new DeleteCommand({ TableName: sessions, Key: userKey(subject) }));
    const requests = [];
    const storage = { async send(cmd) {
      requests.push({ command: cmd.constructor.name, input: cmd.input });
      return client.send(cmd);
    } };
    await assert.rejects(lifecyclePurge(storage).purgeRoom(subject, event, id));
    // Assert outside rejects so an assertion failure inside the transport cannot
    // accidentally be accepted as the expected hold denial.
    assert.deepEqual(requests, [{ command: 'GetCommand', input: {
      TableName: sessions, Key: userKey(subject), ConsistentRead: true,
    } }]);
    assert.deepEqual(await readRoom(id), before);
    assert.deepEqual(await pointStore.read(id, subject), point);
  }
});

test('lifecycle real full-map and absent-expiry conditions cancel owner/last-member/orphan commits', async () => {
  const mutations = [
    (row) => ({ ...row, lifecycleHold: { ...row.lifecycleHold, startedAt: at + 1 } }),
    (row) => ({ ...row, lifecycleHold: { ...row.lifecycleHold, binding: 'foreign-event' } }),
    (row) => ({ ...row, lifecycleHold: { ...row.lifecycleHold, version: 2 } }),
    (row) => ({ ...row, lifecycleHold: { ...row.lifecycleHold, extra: true } }),
    ...['ttl', 'expiresAt', 'pilotExpiresAt'].map((key) => (row) => ({ ...row, [key]: 0 })),
    (row) => ({ ...row, state: 'active' }),
    (row) => ({ ...row, subject: randomUUID() }),
    () => undefined,
  ];
  for (const mode of ['owner', 'last-member', 'orphan']) {
    for (const mutate of mutations) {
      const { id, subject, event, hold } = await lifecycleFixture({ peer: mode !== 'last-member' });
      if (mode === 'orphan') await client.send(new DeleteCommand({ TableName: metadata, Key: { pk: `ROOM#${id}` } }));
      const before = await readRoom(id), point = await pointStore.read(id, subject);
      const racing = intercept(async () => {
        const changed = mutate(structuredClone(hold));
        if (changed) await writeHold(changed);
        else await client.send(new DeleteCommand({ TableName: sessions, Key: userKey(subject) }));
      });
      await assert.rejects(lifecyclePurge(racing).purgeRoom(subject, event, id), UnauthorizedError);
      assert.equal(racing.calls, 1); assert.deepEqual(await readRoom(id), before);
      assert.deepEqual(await pointStore.read(id, subject), point);
    }
  }
});

test('lifecycle real revision retry preserves original hold and concurrent room revision', async () => {
  const { id, subject, event } = await lifecycleFixture(), before = await readRoom(id);
  const racing = intercept(async (call) => { if (call === 1) await bumpRoom(id); });
  assert.deepEqual(await lifecyclePurge(racing).purgeRoom(subject, event, id), { membershipRemoved: true });
  assert.equal(racing.calls, 2); assert.equal((await readRoom(id)).revision, before.revision + 2);
  assert.equal(await pointStore.read(id, subject), null);
});

test('lifecycle changed ownership between real revision retries is never adopted', async () => {
  const { id, subject, event, hold } = await lifecycleFixture(), point = await pointStore.read(id, subject);
  let concurrent;
  const racing = { calls: 0, async send(cmd) {
    if (cmd.constructor.name !== 'TransactWriteCommand') return client.send(cmd);
    this.calls++; concurrent = await bumpRoom(id);
    try { return await client.send(cmd); }
    catch (error) {
      assert.equal(error.name, 'TransactionCanceledException');
      assert.equal(error.CancellationReasons[1].Code, 'ConditionalCheckFailed');
      // Change ownership only after the actual DB revision failure. The next
      // hold read sees a valid same-event hold with a different start time.
      await writeHold({ ...hold, lifecycleHold: { ...hold.lifecycleHold, startedAt: at + 1 } });
      throw error;
    }
  } };
  await assert.rejects(lifecyclePurge(racing).purgeRoom(subject, event, id), UnauthorizedError);
  assert.equal(racing.calls, 1); assert.deepEqual(await readRoom(id), concurrent);
  assert.deepEqual(await pointStore.read(id, subject), point);
});

test('lifecycle real continuous revision conflicts stop after six attempts without erasure', async () => {
  const { id, subject, event } = await lifecycleFixture(), before = await readRoom(id);
  const point = await pointStore.read(id, subject), racing = intercept(async () => bumpRoom(id));
  await assert.rejects(lifecyclePurge(racing).purgeRoom(subject, event, id), { code: 'ROOM_BUSY' });
  assert.equal(racing.calls, 6); const after = await readRoom(id);
  assert.equal(after.revision, before.revision + 6); assert.deepEqual(after.room.members, before.room.members);
  assert.deepEqual(await pointStore.read(id, subject), point);
});

test('lifecycle real committed but lost response propagates and replay confirms idempotent success', async () => {
  const { id, subject, event } = await lifecycleFixture(), lost = new Error('Synthetic lost response');
  let writes = 0;
  const storage = { async send(cmd) {
    const result = await client.send(cmd);
    if (cmd.constructor.name === 'TransactWriteCommand' && ++writes === 1) throw lost;
    return result;
  } };
  await assert.rejects(lifecyclePurge(storage).purgeRoom(subject, event, id), (error) => error === lost);
  const committed = await readRoom(id);
  assert.equal(committed.room.members.some((m) => m.userId === subject), false);
  assert.equal(await pointStore.read(id, subject), null); assert.equal(writes, 1);
  assert.deepEqual(await lifecyclePurge(storage).purgeRoom(subject, event, id), { membershipRemoved: false });
  assert.equal(writes, 2); assert.deepEqual(await readRoom(id), committed);
});
