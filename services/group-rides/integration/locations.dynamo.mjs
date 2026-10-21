// Explicit localhost-only integration suite. Never creates cloud resources.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, BatchWriteCommand, DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoSessionRegistry, familyKey, userKey } from '../src/sessionRegistry.mjs';
import { createDynamoRoomStore } from '../src/roomStore.mjs';
import { createRoomService } from '../src/rooms.mjs';
import { createDynamoLocationStore, LOCATION_RETENTION_MS } from '../src/locationStore.mjs';
import { createLocationService } from '../src/locations.mjs';
import { locationKey } from '../src/locationKeys.mjs';
const endpoint = process.env.GROUP_DYNAMO_LOCAL_ENDPOINT;
if (!endpoint || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw new Error('Set GROUP_DYNAMO_LOCAL_ENDPOINT to a localhost-only DynamoDB Local endpoint.');
const raw = new DynamoDBClient({ endpoint, region: 'eu-west-2', credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1 });
const client = DynamoDBDocumentClient.from(raw);
const suffix = randomUUID(), sessions = `sessions-${suffix}`, metadata = `rooms-${suffix}`, locations = `locations-${suffix}`;
let clock = 1_000_000;
const registry = createDynamoSessionRegistry({ client, tableName: sessions, now: () => clock });
const roomStore = createDynamoRoomStore({ client, registry, now: () => clock, tableName: metadata, sessionTableName: sessions, locationTableName: locations });
const rooms = createRoomService({ store: roomStore, sessionActive: registry.active, now: () => clock });
const pointStore = createDynamoLocationStore({ client, registry, tableName: locations, roomTableName: metadata, sessionTableName: sessions });
const service = createLocationService({ rooms, store: pointStore, now: () => clock });
const command = () => ({ id: randomUUID(), createdAt: clock });
const profile = { displayName: 'Synthetic rider', motorcycleType: 'adventure' };
const point = (epoch, sequence = 1, capturedAt = clock) => ({ latitude: 0, longitude: 0, accuracyM: 5, headingDeg: null, speedMps: null, capturedAt, sessionEpoch: epoch, sequence });
async function approve(subject, pilotExpiresAt = clock + 100_000_000) {
  await client.send(new PutCommand({ TableName: sessions, Item: { ...userKey(subject), subject, state: 'active', pilotExpiresAt } }));
}
async function actor() {
  const value = { userId: randomUUID(), sessionId: randomUUID(), expiresAt: clock + 100_000_000 };
  await approve(value.userId);
  await registry.register({ subject: value.userId, familyId: value.sessionId, expiresAt: value.expiresAt, authenticatedAt: clock });
  return value;
}
async function fixture() {
  const owner = await actor();
  const room = await rooms.create(owner, command(), { ...profile, title: 'Synthetic ride' });
  await rooms.start(owner, room.id, command());
  const lease = (await rooms.sharing(owner, room.id, command(), true)).result;
  return { owner, id: room.id, epoch: lease.deviceEpoch };
}
const publish = (actor, id, fix, target = service) => target.publish(actor, id, { version: 1, fix });
before(async () => {
  for (const TableName of [sessions, metadata, locations]) await raw.send(new CreateTableCommand({ TableName, BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, ...(TableName === locations ? [{ AttributeName: 'sk', KeyType: 'RANGE' }] : [])],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, ...(TableName === locations ? [
      { AttributeName: 'sk', AttributeType: 'S' }, { AttributeName: 'cleanupBucket', AttributeType: 'S' }, { AttributeName: 'expiresAt', AttributeType: 'N' },
    ] : [])], ...(TableName === locations ? { GlobalSecondaryIndexes: [{ IndexName: 'ExpiryIndex', KeySchema: [
      { AttributeName: 'cleanupBucket', KeyType: 'HASH' }, { AttributeName: 'expiresAt', KeyType: 'RANGE' },
    ], Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['pointVersion'] } }] } : {}),
  }));
});
after(async () => { for (const TableName of [sessions, metadata, locations]) await raw.send(new DeleteTableCommand({ TableName })); raw.destroy(); });
test('real transactions retain one point, acknowledge identical retries without changing receipt/expiry, reject reordered points', async () => {
  const { owner, id, epoch } = await fixture(), fix = point(epoch);
  const ack = await publish(owner, id, fix), first = await pointStore.read(id, owner.userId);
  clock += 1000;
  assert.deepEqual(await publish(owner, id, { ...fix }), ack);
  assert.deepEqual(await pointStore.read(id, owner.userId), first);
  await assert.rejects(publish(owner, id, { ...fix, longitude: 1 }), { code: 'FIX_OUT_OF_ORDER' });
  await assert.rejects(publish(owner, id, point(epoch, 0)), { code: 'FIX_OUT_OF_ORDER' });
  await assert.rejects(publish(owner, id, point(epoch, 2, fix.capturedAt)), { code: 'FIX_OUT_OF_ORDER' });
  await publish(owner, id, point(epoch, 2));
  const result = await client.send(new QueryCommand({ TableName: locations, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `ROOM#${id}` } }));
  assert.equal(result.Items.length, 1); assert.equal(result.Items[0].fix.sequence, 2);
});
test('stop after publication deletes it; old consent fails, replacement epoch starts fresh', async () => {
  const { owner, id, epoch } = await fixture();
  await publish(owner, id, point(epoch));
  await rooms.sharing(owner, id, command(), false);
  assert.equal(await pointStore.read(id, owner.userId), null);
  await assert.rejects(publish(owner, id, point(epoch)), { code: 'SHARING_NOT_ACTIVE' });
  const fresh = (await rooms.sharing(owner, id, command(), true)).result.deviceEpoch;
  await publish(owner, id, point(fresh));
  assert.equal((await pointStore.read(id, owner.userId)).fix.sessionEpoch, fresh);
});
test('in-flight publication loses atomically against stop and end', async () => {
  for (const operation of ['stop', 'end']) {
    const { owner, id, epoch } = await fixture();
    let intercepted = false;
    const gated = createLocationService({ rooms, now: () => clock, store: {
      read: pointStore.read, commit: async (input) => {
        if (!intercepted) { intercepted = true; await (operation === 'stop' ? rooms.sharing(owner, id, command(), false) : rooms.end(owner, id, command())); }
        return pointStore.commit(input);
      },
    } });
    await assert.rejects(publish(owner, id, point(epoch), gated));
    assert.equal(await pointStore.read(id, owner.userId), null);
  }
});
test('removal/leave erase points and an in-flight removed rider cannot publish', async () => {
  for (const operation of ['remove', 'leave']) {
    const { owner, id } = await fixture(), rider = await actor(), invite = await rooms.invite(owner, id);
    await rooms.join(rider, id, invite.token, profile);
    const epoch = (await rooms.sharing(rider, id, command(), true)).result.deviceEpoch;
    await publish(rider, id, point(epoch)); clock++;
    let intercepted = false;
    const gated = createLocationService({ rooms, now: () => clock, store: { read: pointStore.read, commit: async (input) => {
      if (!intercepted) { intercepted = true; await (operation === 'remove' ? rooms.remove(owner, id, command(), rider.userId) : rooms.leave(rider, id, command())); }
      return pointStore.commit(input);
    } } });
    await assert.rejects(publish(rider, id, point(epoch, 2), gated), { code: 'ROOM_UNAVAILABLE' });
    assert.equal(await pointStore.read(id, rider.userId), null);
  }
});
test('session revocation and account block close the check/write race', async () => {
  for (const operation of ['revoke', 'block']) {
    const { owner, id, epoch } = await fixture(); let intercepted = false;
    const gated = createLocationService({ rooms, now: () => clock, store: { read: pointStore.read, commit: async (input) => {
      if (!intercepted) { intercepted = true; await (operation === 'revoke' ? registry.revoke({ subject: owner.userId, familyId: owner.sessionId }) : registry.blockUser(owner.userId)); }
      return pointStore.commit(input);
    } } });
    await assert.rejects(publish(owner, id, point(epoch), gated));
    assert.equal(await pointStore.read(id, owner.userId), null);
    assert.equal((await client.send(new GetCommand({ TableName: sessions, Key: familyKey(owner.sessionId) }))).Item.subject, owner.userId);
  }
});
test('concurrent updates cannot regress latest sequence', async () => {
  const { owner, id, epoch } = await fixture();
  const results = await Promise.allSettled([publish(owner, id, point(epoch, 1, clock - 1)), publish(owner, id, point(epoch, 2))]);
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  assert.equal((await pointStore.read(id, owner.userId)).fix.sequence, 2);
});
test('expiry-index cleanup physically deletes overdue points and projects no coordinates', async () => {
  const { owner, id, epoch } = await fixture();
  await publish(owner, id, point(epoch));
  clock += LOCATION_RETENTION_MS + 1;
  const index = await client.send(new QueryCommand({ TableName: locations, IndexName: 'ExpiryIndex', KeyConditionExpression: 'cleanupBucket = :bucket AND expiresAt <= :now', ExpressionAttributeValues: { ':bucket': 'ACTIVE', ':now': clock } }));
  assert.ok(index.Items.length > 0); assert.equal(index.Items.some((item) => 'fix' in item || 'familyHash' in item), false);
  assert.ok((await pointStore.cleanup(clock)).deleted > 0);
  assert.equal(await pointStore.read(id, owner.userId), null);
  assert.deepEqual(locationKey(id, owner.userId), { pk: `ROOM#${id}`, sk: locationKey(id, owner.userId).sk });
});
test('atomic snapshots require current viewer membership/session and source consent/session; markers retain capture time', async () => {
  const { owner, id, epoch } = await fixture(), rider = await actor(), outsider = await actor();
  const invite = await rooms.invite(owner, id);
  await rooms.join(rider, id, invite.token, { ...profile, motorcycleType: 'cruiser' });
  const riderEpoch = (await rooms.sharing(rider, id, command(), true)).result.deviceEpoch;
  await publish(owner, id, point(epoch)); await publish(rider, id, point(riderEpoch));
  const snap = await service.read(owner, id);
  assert.equal(snap.members.length, 2); assert.equal(snap.members[1].motorcycleType, 'cruiser');
  assert.equal(snap.members[1].fix.capturedAt, clock); assert.equal(snap.members[1].fix.receivedAt, clock);
  assert.equal(JSON.stringify(snap).includes('deviceFamily'), false); assert.equal(JSON.stringify(snap).includes('familyHash'), false);
  await assert.rejects(service.read(outsider, id), { code: 'ROOM_UNAVAILABLE' });
  await registry.revoke({ subject: rider.userId, familyId: rider.sessionId });
  assert.equal((await service.read(owner, id)).members[1].fix, null);
  await assert.rejects(service.read(rider, id));
  clock += 300_000;
  assert.equal((await service.read(owner, id)).members[0].fix, null);
});
test('membership change between key discovery and transaction cannot leak points to a removed viewer', async () => {
  const { owner, id, epoch } = await fixture(), viewer = await actor(), invite = await rooms.invite(owner, id);
  await rooms.join(viewer, id, invite.token, profile); await publish(owner, id, point(epoch));
  let intercepted = false;
  const racingClient = { send: async (command) => {
    if (command.constructor.name === 'TransactGetCommand' && !intercepted) {
      intercepted = true; await rooms.remove(owner, id, commandForRace(), viewer.userId);
    }
    return client.send(command);
  } };
  const commandForRace = () => command();
  const racing = createDynamoLocationStore({ client: racingClient, registry, tableName: locations, roomTableName: metadata, sessionTableName: sessions });
  await assert.rejects(racing.snapshot(viewer, id, () => clock), { code: 'ROOM_UNAVAILABLE' });
});
test('stale cleanup index entry cannot erase a point refreshed after the query', async () => {
  const { owner, id, epoch } = await fixture();
  await publish(owner, id, point(epoch));
  const old = await pointStore.read(id, owner.userId);
  clock += LOCATION_RETENTION_MS + 1;
  let intercepted = false;
  const racingClient = { send: async (cmd) => {
    if (cmd.constructor.name === 'QueryCommand' && !intercepted) {
      intercepted = true; await publish(owner, id, point(epoch, 2));
      return { Items: [{ pk: old.pk, sk: old.sk, pointVersion: old.pointVersion, expiresAt: old.expiresAt }] };
    }
    return client.send(cmd);
  } };
  const racing = createDynamoLocationStore({ client: racingClient, registry, tableName: locations, roomTableName: metadata, sessionTableName: sessions });
  assert.deepEqual(await racing.cleanup(clock), { deleted: 0, examined: 1, more: false, oldestOverdueMs: 1 });
  assert.equal((await pointStore.read(id, owner.userId)).fix.sequence, 2);
});
test('a source revoked between discovery and transaction is hidden from the recipient snapshot', async () => {
  const { owner, id, epoch } = await fixture(), viewer = await actor(), invite = await rooms.invite(owner, id);
  await rooms.join(viewer, id, invite.token, profile); await publish(owner, id, point(epoch));
  let intercepted = false;
  const racingClient = { send: async (cmd) => {
    if (cmd.constructor.name === 'TransactGetCommand' && !intercepted) {
      intercepted = true; await registry.revoke({ subject: owner.userId, familyId: owner.sessionId });
    }
    return client.send(cmd);
  } };
  const racing = createDynamoLocationStore({ client: racingClient, registry, tableName: locations, roomTableName: metadata, sessionTableName: sessions });
  assert.equal((await racing.snapshot(viewer, id, () => clock)).members[0].fix, null);
});
test('idle cleanup cannot reset sequence in an old epoch; explicit new consent can restart', async () => {
  const { owner, id, epoch } = await fixture();
  await publish(owner, id, point(epoch, 8));
  clock += LOCATION_RETENTION_MS + 1; await pointStore.cleanup(clock);
  assert.equal(await pointStore.read(id, owner.userId), null);
  await assert.rejects(publish(owner, id, point(epoch, 1)), { code: 'SHARING_LEASE_EXPIRED' });
  const fresh = (await rooms.sharing(owner, id, command(), true)).result.deviceEpoch;
  assert.notEqual(fresh, epoch); await publish(owner, id, point(fresh, 1));
  assert.equal((await pointStore.read(id, owner.userId)).fix.sequence, 1);
});

test('over 1000 overdue points produce backlog, then drain on the next bounded run', async () => {
  const requests = Array.from({ length: 1050 }, (_, index) => ({ PutRequest: { Item: {
    pk: `ROOM#synthetic-cleanup-${Math.floor(index / 10)}`, sk: `RIDER#synthetic-${index}`,
    pointVersion: randomUUID(), cleanupBucket: 'ACTIVE', expiresAt: clock - 1000,
    fix: { latitude: 0, longitude: 0, capturedAt: clock - 900_000 },
  } } }));
  for (let offset = 0; offset < requests.length; offset += 25) {
    const outcome = await client.send(new BatchWriteCommand({ RequestItems: { [locations]: requests.slice(offset, offset + 25) } }));
    assert.equal((outcome.UnprocessedItems?.[locations] ?? []).length, 0);
  }
  const first = await pointStore.cleanup(clock);
  assert.equal(first.deleted, 1000); assert.equal(first.more, true); assert.equal(first.oldestOverdueMs, 1000);
  const second = await pointStore.cleanup(clock);
  assert.equal(second.deleted, 50); assert.equal(second.more, false);
  assert.deepEqual(await pointStore.cleanup(clock), { deleted: 0, examined: 0, more: false, oldestOverdueMs: 0 });
});
test('real logout capability transactions work after access expiry and preserve other sessions', async () => {
  const secret = 'a'.repeat(64), otherSecret = 'b'.repeat(64);
  const one = { subject: randomUUID(), familyId: randomUUID(), expiresAt: clock + 1000, authenticatedAt: clock };
  const two = { ...one, familyId: randomUUID() };
  await approve(one.subject);
  await registry.registerWithLogout(one, secret); await registry.registerWithLogout(two, otherSecret);
  await registry.registerWithLogout(one, secret); // idempotent, including Update expression
  clock += 2000;
  await registry.revokeWithLogout(secret); await registry.revokeWithLogout(secret);
  assert.equal(await registry.active({ ...one, expiresAt: clock + 1000 }), false);
  assert.equal(await registry.active({ ...two, expiresAt: clock + 1000 }), true);
  await assert.rejects(registry.registerWithLogout({ ...one, expiresAt: clock + 1000 }, secret));
  await assert.rejects(registry.registerWithLogout({ ...two, expiresAt: clock + 1000 }, secret));
});
test('real logout-before-register race cannot activate the delayed family', async () => {
  const secret = 'c'.repeat(64);
  const session = { subject: randomUUID(), familyId: randomUUID(), expiresAt: clock + 60_000, authenticatedAt: clock };
  await approve(session.subject);
  let intercepted = false;
  const proxy = { send: async (cmd) => {
    if (cmd.constructor.name === 'TransactWriteCommand' && !intercepted) {
      intercepted = true; await registry.revokeWithLogout(secret);
    }
    return client.send(cmd);
  } };
  const racing = createDynamoSessionRegistry({ client: proxy, tableName: sessions, now: () => clock });
  await assert.rejects(racing.registerWithLogout(session, secret));
  assert.equal(await registry.active(session), false);
  assert.equal((await client.send(new GetCommand({ TableName: sessions, Key: familyKey(session.familyId) }))).Item, undefined);
});
test('two concurrent logout retries are idempotent against the actual DynamoDB service', async () => {
  const secret = 'd'.repeat(64), session = { subject: randomUUID(), familyId: randomUUID(), expiresAt: clock + 60_000, authenticatedAt: clock };
  await approve(session.subject);
  await registry.registerWithLogout(session, secret);
  await Promise.all([registry.revokeWithLogout(secret), registry.revokeWithLogout(secret)]);
  assert.equal(await registry.active(session), false);
});

test('expired revocation capability acknowledges safely even if TTL already removed its family row', async () => {
  const secret = 'e'.repeat(64), session = { subject: randomUUID(), familyId: randomUUID(), expiresAt: clock + 60_000, authenticatedAt: clock };
  await approve(session.subject);
  await registry.registerWithLogout(session, secret);
  clock += 30 * 24 * 60 * 60_000 + 1;
  await client.send(new DeleteCommand({ TableName: sessions, Key: familyKey(session.familyId) }));
  await registry.revokeWithLogout(secret); await registry.revokeWithLogout(secret);
  await assert.rejects(registry.registerWithLogout({ ...session, expiresAt: clock + 60_000 }, secret));
});
test('pilot withdrawal racing a location write rejects it and snapshots hide the source', async () => {
  const { owner, id, epoch } = await fixture(), viewer = await actor(), invite = await rooms.invite(owner, id);
  await rooms.join(viewer, id, invite.token, profile); await publish(owner, id, point(epoch)); clock++;
  let intercepted = false;
  const gated = createLocationService({ rooms, now: () => clock, store: { read: pointStore.read, commit: async (input) => {
    if (!intercepted) { intercepted = true; await approve(owner.userId, 0); }
    return pointStore.commit(input);
  } } });
  await assert.rejects(publish(owner, id, point(epoch, 2), gated));
  assert.equal((await pointStore.read(id, owner.userId)).fix.sequence, 1);
  assert.equal((await service.read(viewer, id)).members.find((m) => m.userId === owner.userId).fix, null);
  await assert.rejects(service.read(owner, id));
  // Withdrawal does not prevent the independent session-revocation workflow.
  await registry.revoke({ subject: owner.userId, familyId: owner.sessionId });
});
test('pilot removal between snapshot discovery and atomic read denies the viewer', async () => {
  const { owner, id, epoch } = await fixture(); await publish(owner, id, point(epoch));
  let intercepted = false;
  const proxy = { send: async (cmd) => {
    if (cmd.constructor.name === 'TransactGetCommand' && !intercepted) { intercepted = true; await client.send(new DeleteCommand({ TableName: sessions, Key: userKey(owner.userId) })); }
    return client.send(cmd);
  } };
  const racing = createDynamoLocationStore({ client: proxy, registry, tableName: locations, roomTableName: metadata, sessionTableName: sessions });
  await assert.rejects(racing.snapshot(owner, id, () => clock));
});
test('pilot removal after registration preflight cannot commit a family or capability', async () => {
  const session = { subject: randomUUID(), familyId: randomUUID(), expiresAt: clock + 60_000, authenticatedAt: clock };
  const { randomBytes } = await import('node:crypto'); const secret = randomBytes(32).toString('hex');
  await approve(session.subject); let intercepted = false;
  const proxy = { send: async (cmd) => {
    if (cmd.constructor.name === 'TransactWriteCommand' && !intercepted) { intercepted = true; await client.send(new DeleteCommand({ TableName: sessions, Key: userKey(session.subject) })); }
    return client.send(cmd);
  } };
  const racing = createDynamoSessionRegistry({ client: proxy, tableName: sessions, now: () => clock });
  await assert.rejects(racing.registerWithLogout(session, secret));
  assert.equal((await client.send(new GetCommand({ TableName: sessions, Key: familyKey(session.familyId) }))).Item, undefined);
});
test('pilot withdrawal rejects in-flight room creation and mutation atomically', async () => {
  const { hash } = await import('../src/locationKeys.mjs');
  for (const operation of ['create', 'profile']) {
    const owner = await actor(), existing = operation === 'profile' ? await rooms.create(owner, command(), { ...profile, title: 'Synthetic ride' }) : null;
    let intercepted = false;
    const proxy = { send: async (cmd) => {
      if (cmd.constructor.name === 'TransactWriteCommand' && !intercepted) { intercepted = true; await approve(owner.userId, 0); }
      return client.send(cmd);
    } };
    const racingStore = createDynamoRoomStore({ client: proxy, registry, now: () => clock, tableName: metadata, sessionTableName: sessions, locationTableName: locations });
    const racing = createRoomService({ store: racingStore, sessionActive: registry.active, now: () => clock });
    const action = command();
    if (operation === 'create') {
      await assert.rejects(racing.create(owner, action, { ...profile, title: 'Must not persist' }));
      assert.equal(await roomStore.read(hash(`${owner.userId}\0${action.id}`)), null);
    } else {
      await assert.rejects(racing.updateProfile(owner, existing.id, action, { ...profile, displayName: 'Must not persist' }));
      assert.equal((await roomStore.read(existing.id)).members[0].displayName, profile.displayName);
    }
  }
});
