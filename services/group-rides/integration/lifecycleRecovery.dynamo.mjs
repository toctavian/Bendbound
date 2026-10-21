// Synthetic test-only composition. No production worker or cloud resources.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { createLifecycleProgressStore } from '../src/lifecycleProgressStore.mjs';
import { createLifecycleDiscoveryStore } from '../src/blockedAccountDiscoveryStore.mjs';
import { createLifecycleRoomStore } from '../src/blockedAccountRoomStore.mjs';
import { createLifecycleHoldStore } from '../src/lifecycleHoldStore.mjs';
import { userKey } from '../src/sessionRegistry.mjs';
import { hash, locationKey } from '../src/locationKeys.mjs';

const endpoint = process.env.GROUP_DYNAMO_LOCAL_ENDPOINT;
if (!endpoint || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw new Error('Localhost-only DynamoDB endpoint required.');
const raw = new DynamoDBClient({ endpoint, region: 'eu-west-2', credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1 });
const client = DynamoDBDocumentClient.from(raw);
after(() => raw.destroy());
const token = () => randomBytes(32).toString('hex');
const receipt = (row, value = row.lease?.token ?? token()) => ({ revision: row.revision, token: value });
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
    const ledger = (storage = client) => createLifecycleProgressStore({ ...config, client: storage, now: () => clock.at });
    const roomConfig = { tableName: config.roomTableName, sessionTableName: config.sessionTableName, locationTableName: config.locationTableName };
    const discovery = () => createLifecycleDiscoveryStore({ ...roomConfig, client });
    const purge = (storage = client) => createLifecycleRoomStore({ ...roomConfig, client: storage, now: () => clock.at });
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
    const start = async () => {
      const row = await ledger().initialize(subject, event);
      return ledger().claim(subject, event, receipt(row));
    };
    const stage = async (row, limit = 1) => ledger().stagePage(subject, event, receipt(row),
      await discovery().readPage(subject, event, { cursor: row.cursor, limit }));
    await work({ config, subject, event, peer, clock, held, holdStore, ledger, discovery, purge, room, point, seed, start, stage });
  } finally {
    const results = await Promise.allSettled(created.map((TableName) => raw.send(new DeleteTableCommand({ TableName }))));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Synthetic recovery table cleanup failed.');
  }
}
// Hooks forward real commands; only timing and response delivery are controlled.
function intercept(hook) {
  let transactions = 0;
  return { get transactions() { return transactions; }, async send(command) {
    if (command.constructor.name === 'TransactWriteCommand') transactions++;
    return hook(command, () => client.send(command));
  } };
}
async function pending(f) {
  const id = await f.seed(), row = await f.stage(await f.start());
  assert.deepEqual(row.pendingPage.roomIds, [id]);
  return { id, row };
}
async function assertHeld(f) { assert.deepEqual(await f.holdStore.read(f.subject, f.event), f.held); }

// This is deliberately test-side sequencing, not an exported orchestration API.
test('real composition drains discovered pages only after purge and retains hold at terminal traversal', async () => {
  await fixture(async (f) => {
    const member = await f.seed(), otherMember = await f.seed(), unrelated = await f.seed({ member: false }), orphan = await f.seed({ orphan: true });
    await put(f.config.locationTableName, { ...locationKey(member, f.peer), synthetic: 'peer-preserved' });
    const untouched = await f.room(unrelated), peerPoint = await f.point(member, f.peer), seen = new Set();
    let row = await f.start(), pages = 0;
    while (!row.traversalEnded) {
      assert.ok(++pages <= 50, 'Bound synthetic traversal');
      const originalCursor = structuredClone(row.cursor);
      row = await f.stage(row);
      assert.deepEqual(row.cursor, originalCursor);
      if (row.pendingPage.roomIds.length) await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(row)), /conflicting/);
      while (row.pendingPage.roomIds.length) {
        const id = row.pendingPage.roomIds[0];
        await f.purge().purgeRoom(f.subject, f.event, id);
        assert.equal(await f.point(id), undefined);
        const metadata = await f.room(id);
        assert.ok(!metadata || metadata.room.members.every((m) => m.userId !== f.subject));
        seen.add(id);
        row = await f.ledger().acknowledge(f.subject, f.event, receipt(row), id);
        assert.deepEqual(row.cursor, originalCursor);
      }
      row = await f.ledger().advance(f.subject, f.event, receipt(row));
      assert.deepEqual(await f.ledger().read(f.subject, f.event), row);
    }
    assert.deepEqual(seen, new Set([member, otherMember, unrelated, orphan]));
    for (const id of [member, otherMember]) {
      const metadata = await f.room(id);
      assert.equal(metadata.room.ownerId, f.peer); assert.equal(metadata.room.invite, null);
      assert.equal(metadata.revision, 2);
    }
    assert.deepEqual(await f.room(unrelated), untouched); assert.equal(await f.room(orphan), undefined);
    assert.deepEqual(await f.point(member, f.peer), peerPoint);
    assert.equal(row.cursor, null); assert.equal(row.pendingPage, null);
    assert.equal(Object.hasOwn(row, 'complete'), false); assert.equal(Object.hasOwn(row, 'ttl'), false);
    await assertHeld(f);
  });
});

test('real crash after purge resumes retained page under a new lease and replays without further room mutation', async () => {
  await fixture(async (f) => {
    const { id, row } = await pending(f);
    await f.purge().purgeRoom(f.subject, f.event, id);
    const purged = await f.room(id);
    assert.equal(await f.point(id), undefined);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), row);
    f.clock.at = row.lease.until;
    const loaded = await f.ledger().read(f.subject, f.event);
    const takeover = await f.ledger().claim(f.subject, f.event, receipt(loaded, token()));
    assert.deepEqual(takeover.pendingPage, row.pendingPage); assert.deepEqual(takeover.cursor, row.cursor);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(row), id), /conflicting/);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, id), { membershipRemoved: false });
    assert.deepEqual(await f.room(id), purged);
    const ack = await f.ledger().acknowledge(f.subject, f.event, receipt(takeover), id);
    const advanced = await f.ledger().advance(f.subject, f.event, receipt(ack));
    assert.deepEqual(advanced.cursor, row.pendingPage.next); await assertHeld(f);
  });
});

for (const committed of [false, true]) test(`real ${committed ? 'committed lost-response' : 'precommit failed'} purge retains work until confirmed replay`, async () => {
  await fixture(async (f) => {
    const { id, row } = await pending(f), before = await f.room(id), beforePoint = await f.point(id);
    const outage = new Error('Synthetic purge response unavailable');
    const failing = intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      if (committed) await send();
      throw outage;
    });
    await assert.rejects(f.purge(failing).purgeRoom(f.subject, f.event, id), (error) => error === outage);
    assert.equal(failing.transactions, 1);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), row);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(row)), /conflicting/);
    if (!committed) { assert.deepEqual(await f.room(id), before); assert.deepEqual(await f.point(id), beforePoint); }
    else { assert.equal((await f.room(id)).revision, before.revision + 1); assert.equal(await f.point(id), undefined); }
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, id), { membershipRemoved: !committed });
    assert.equal((await f.room(id)).revision, before.revision + 1); assert.equal(await f.point(id), undefined);
    const ack = await f.ledger().acknowledge(f.subject, f.event, receipt(row), id);
    assert.deepEqual(ack.pendingPage.roomIds, []); assert.deepEqual(ack.cursor, row.cursor); await assertHeld(f);
  });
});

test('real lost acknowledgement and advance responses recover by reread without skipping retained work', async () => {
  await fixture(async (f) => {
    const { id, row } = await pending(f);
    await f.purge().purgeRoom(f.subject, f.event, id);
    const purged = await f.room(id), outage = new Error('Synthetic ledger committed response lost');
    const failing = intercept(async (command, send) => {
      const result = await send();
      if (command.constructor.name === 'TransactWriteCommand') throw outage;
      return result;
    });
    await assert.rejects(f.ledger(failing).acknowledge(f.subject, f.event, receipt(row), id), (error) => error === outage);
    const ack = await f.ledger().read(f.subject, f.event);
    assert.equal(ack.revision, row.revision + 1); assert.deepEqual(ack.pendingPage.roomIds, []); assert.deepEqual(ack.cursor, row.cursor);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(row), id), /conflicting/);
    await assert.rejects(f.ledger(failing).advance(f.subject, f.event, receipt(ack)), (error) => error === outage);
    const advanced = await f.ledger().read(f.subject, f.event);
    assert.equal(advanced.revision, ack.revision + 1); assert.equal(advanced.pendingPage, null);
    assert.deepEqual(advanced.cursor, row.pendingPage.next);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(ack)), /conflicting/);
    assert.equal(failing.transactions, 2); assert.deepEqual(await f.room(id), purged); await assertHeld(f);
  });
});

test('real hold removal after purge denies acknowledgement and preserves pending recovery state', async () => {
  await fixture(async (f) => {
    const { id, row } = await pending(f);
    await f.purge().purgeRoom(f.subject, f.event, id);
    const purged = await f.room(id);
    await client.send(new DeleteCommand({ TableName: f.config.sessionTableName, Key: userKey(f.subject) }));
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(row), id), /lifecycle hold|not authorised/);
    await assert.rejects(f.purge().purgeRoom(f.subject, f.event, id), /lifecycle hold|not authorised/);
    const key = { pk: row.pk };
    assert.deepEqual(await read(f.config.tableName, key), row);
    // Test-only restoration of the identical fixture hold; no production release/readmission API.
    await put(f.config.sessionTableName, f.held);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, id), { membershipRemoved: false });
    assert.deepEqual(await f.room(id), purged);
    const ack = await f.ledger().acknowledge(f.subject, f.event, receipt(await f.ledger().read(f.subject, f.event)), id);
    assert.deepEqual(ack.pendingPage.roomIds, []); await assertHeld(f);
  });
});

for (const committed of [false, true]) test(`real multi-candidate page retains suffix after ${committed ? 'lost committed' : 'failed'} second purge and takeover`, async () => {
  await fixture(async (f) => {
    const seeded = [await f.seed(), await f.seed(), await f.seed()];
    const staged = await f.stage(await f.start(), 100);
    const [first, second, third] = staged.pendingPage.roomIds;
    assert.deepEqual(new Set(staged.pendingPage.roomIds), new Set(seeded));
    assert.equal(staged.pendingPage.roomIds.length, 3);
    // Discovery owns ordering; no assumption about DynamoDB scan order.
    await f.purge().purgeRoom(f.subject, f.event, first);
    const firstPurged = await f.room(first);
    const partial = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), first);
    assert.deepEqual(partial.pendingPage, { roomIds: [second, third], next: staged.pendingPage.next });
    const secondBefore = await f.room(second), thirdBefore = await f.room(third);
    const secondPoint = await f.point(second), thirdPoint = await f.point(third);
    const outage = new Error('Synthetic second purge unavailable');
    const failing = intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      if (committed) await send();
      throw outage;
    });
    await assert.rejects(f.purge(failing).purgeRoom(f.subject, f.event, second), (error) => error === outage);
    assert.equal(failing.transactions, 1);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), partial);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(partial)), /conflicting/);
    assert.deepEqual(await f.room(third), thirdBefore); assert.deepEqual(await f.point(third), thirdPoint);
    if (committed) {
      assert.equal((await f.room(second)).revision, secondBefore.revision + 1);
      assert.equal(await f.point(second), undefined);
    } else {
      assert.deepEqual(await f.room(second), secondBefore); assert.deepEqual(await f.point(second), secondPoint);
    }
    // Simulate restart with a fresh adapter, then a different worker's expired-lease claim.
    f.clock.at = partial.lease.until;
    const loaded = await f.ledger().read(f.subject, f.event);
    let resumed = await f.ledger().claim(f.subject, f.event, receipt(loaded, token()));
    assert.deepEqual(resumed.pendingPage, partial.pendingPage); assert.deepEqual(resumed.cursor, staged.cursor);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(partial), second), /conflicting/);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(resumed), first), /conflicting/);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(resumed), third), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), resumed);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, second), { membershipRemoved: !committed });
    assert.equal((await f.room(second)).revision, secondBefore.revision + 1);
    resumed = await f.ledger().acknowledge(f.subject, f.event, receipt(resumed), second);
    assert.deepEqual(resumed.pendingPage.roomIds, [third]);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(resumed)), /conflicting/);
    await f.purge().purgeRoom(f.subject, f.event, third);
    resumed = await f.ledger().acknowledge(f.subject, f.event, receipt(resumed), third);
    assert.deepEqual(resumed.pendingPage.roomIds, []); assert.deepEqual(resumed.cursor, staged.cursor);
    const advanced = await f.ledger().advance(f.subject, f.event, receipt(resumed));
    assert.deepEqual(advanced.cursor, staged.pendingPage.next); assert.equal(advanced.pendingPage, null);
    assert.deepEqual(await f.room(first), firstPurged);
    for (const id of seeded) assert.equal(await f.point(id), undefined);
    await assertHeld(f);
  });
});

test('real lost stage response requires durable reread before purge and rejects restaging retained candidates', async () => {
  await fixture(async (f) => {
    const seeded = [await f.seed(), await f.seed(), await f.seed()];
    const before = await Promise.all(seeded.map((id) => f.room(id)));
    const pointsBefore = await Promise.all(seeded.map((id) => f.point(id)));
    const claimed = await f.start();
    const page = await f.discovery().readPage(f.subject, f.event, { cursor: claimed.cursor, limit: 100 });
    assert.deepEqual(new Set(page.roomIds), new Set(seeded));
    const outage = new Error('Synthetic staging committed response lost');
    const failing = intercept(async (command, send) => {
      const result = await send();
      if (command.constructor.name === 'TransactWriteCommand') throw outage;
      return result;
    });
    await assert.rejects(f.ledger(failing).stagePage(f.subject, f.event, receipt(claimed), page), (error) => error === outage);
    assert.equal(failing.transactions, 1);
    // No purge follows the ambiguous result; first recover the durable page.
    assert.deepEqual(await Promise.all(seeded.map((id) => f.room(id))), before);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id))), pointsBefore);
    let recovered = await f.ledger().read(f.subject, f.event);
    assert.equal(recovered.revision, claimed.revision + 1);
    assert.deepEqual(recovered.pendingPage, page); assert.deepEqual(recovered.cursor, claimed.cursor);
    await assert.rejects(f.ledger().stagePage(f.subject, f.event, receipt(claimed), page), /conflicting/);
    await assert.rejects(f.ledger().stagePage(f.subject, f.event, receipt(recovered), page), /conflicting/);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), recovered);
    const ordered = [...recovered.pendingPage.roomIds], erased = [];
    while (recovered.pendingPage.roomIds.length) {
      const id = recovered.pendingPage.roomIds[0];
      await f.purge().purgeRoom(f.subject, f.event, id);
      erased.push(id);
      recovered = await f.ledger().acknowledge(f.subject, f.event, receipt(recovered), id);
      assert.deepEqual(recovered.pendingPage.roomIds, ordered.slice(erased.length));
      assert.deepEqual(recovered.cursor, claimed.cursor);
    }
    assert.deepEqual(erased, ordered);
    const advanced = await f.ledger().advance(f.subject, f.event, receipt(recovered));
    assert.deepEqual(advanced.cursor, page.next); assert.equal(advanced.pendingPage, null);
    for (const id of seeded) {
      assert.equal(await f.point(id), undefined); assert.equal((await f.room(id)).revision, 2);
    }
    await assertHeld(f);
  });
});

for (const replacement of ['event', 'startedAt']) test(`real partial-page recovery survives in-flight ${replacement} hold replacement without skipping retained work`, async () => {
  await fixture(async (f) => {
    const seeded = [await f.seed(), await f.seed(), await f.seed()];
    for (const id of seeded) await put(f.config.locationTableName, { ...locationKey(id, f.peer), synthetic: 'peer-preserved' });
    const staged = await f.stage(await f.start(), 100);
    assert.deepEqual(new Set(staged.pendingPage.roomIds), new Set(seeded));
    assert.equal(staged.pendingPage.roomIds.length, 3);
    // Use discovery order, including for the acknowledged prefix.
    const [first, second, third] = staged.pendingPage.roomIds;
    await f.purge().purgeRoom(f.subject, f.event, first);
    const partial = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), first);
    assert.deepEqual(partial.pendingPage, { roomIds: [second, third], next: staged.pendingPage.next });
    const replaced = structuredClone(f.held);
    if (replacement === 'event') replaced.lifecycleHold.binding = hash(JSON.stringify([f.subject, randomUUID(), f.config.sessionTableName]));
    else replaced.lifecycleHold.startedAt++;
    const snapshot = async () => ({
      progress: await read(f.config.tableName, { pk: partial.pk }),
      rooms: await Promise.all(seeded.map((id) => f.room(id))),
      points: await Promise.all(seeded.map((id) => f.point(id))),
      peers: await Promise.all(seeded.map((id) => f.point(id, f.peer))),
    });
    // The replacement happens after the adapter validates the original hold,
    // immediately before DynamoDB evaluates the real transaction condition.
    const replacing = () => intercept(async (command, send) => {
      if (command.constructor.name === 'TransactWriteCommand') await put(f.config.sessionTableName, replaced);
      return send();
    });
    const beforePurge = await snapshot(), purgeRace = replacing();
    await assert.rejects(f.purge(purgeRace).purgeRoom(f.subject, f.event, second), /not authorised/);
    assert.equal(purgeRace.transactions, 1);
    assert.deepEqual(await snapshot(), beforePurge);
    assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replaced);
    if (replacement === 'event') {
      // An already-replaced foreign event must also deny new invocations.
      await assert.rejects(f.ledger().read(f.subject, f.event), /lifecycle hold/);
      await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(partial), second), /lifecycle hold/);
      await assert.rejects(f.purge().purgeRoom(f.subject, f.event, third), /lifecycle hold/);
      assert.deepEqual(await snapshot(), beforePurge);
    }
    // Only this isolated fixture restores its identical original hold. There is
    // no production replacement/release API or durable cross-call incarnation pin.
    await put(f.config.sessionTableName, f.held);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, second), { membershipRemoved: true });
    const beforeAck = await snapshot(), ackRace = replacing();
    assert.equal(await f.point(second), undefined);
    assert.equal((await f.room(second)).revision, beforePurge.rooms[seeded.indexOf(second)].revision + 1);
    await assert.rejects(f.ledger(ackRace).acknowledge(f.subject, f.event, receipt(partial), second), { name: 'TransactionCanceledException' });
    assert.equal(ackRace.transactions, 1);
    assert.deepEqual(await snapshot(), beforeAck);
    assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replaced);
    assert.deepEqual(beforeAck.progress, partial);
    await put(f.config.sessionTableName, f.held);
    f.clock.at = partial.lease.until;
    const loaded = await f.ledger().read(f.subject, f.event);
    let resumed = await f.ledger().claim(f.subject, f.event, receipt(loaded, token()));
    assert.deepEqual(resumed.pendingPage, partial.pendingPage);
    assert.deepEqual(resumed.cursor, staged.cursor);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(partial), second), /conflicting/);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(resumed), first), /conflicting/);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(resumed), third), /conflicting/);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(resumed)), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), resumed);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, second), { membershipRemoved: false });
    assert.deepEqual(await f.room(second), beforeAck.rooms[seeded.indexOf(second)]);
    resumed = await f.ledger().acknowledge(f.subject, f.event, receipt(resumed), second);
    assert.deepEqual(resumed.pendingPage.roomIds, [third]);
    assert.deepEqual(await f.room(third), beforePurge.rooms[seeded.indexOf(third)]);
    assert.deepEqual(await f.point(third), beforePurge.points[seeded.indexOf(third)]);
    await f.purge().purgeRoom(f.subject, f.event, third);
    resumed = await f.ledger().acknowledge(f.subject, f.event, receipt(resumed), third);
    assert.deepEqual(resumed.pendingPage.roomIds, []);
    assert.deepEqual(resumed.cursor, staged.cursor);
    const advanced = await f.ledger().advance(f.subject, f.event, receipt(resumed));
    assert.deepEqual(advanced.cursor, staged.pendingPage.next);
    assert.equal(advanced.pendingPage, null);
    assert.deepEqual(await f.room(first), beforePurge.rooms[seeded.indexOf(first)]);
    for (const id of seeded) {
      assert.equal(await f.point(id), undefined);
      assert.equal((await f.room(id)).revision, 2);
    }
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), beforePurge.peers);
    await assertHeld(f);
  });
});

// Rendezvous only the first transaction of each independent adapter. Retries
// forward immediately, so a losing purge can reread and confirm idempotent success.
async function competeFirstTransactions(operations, inspect) {
  let arrivals = 0, release, fail;
  const barrier = new Promise((resolve, reject) => { release = resolve; fail = reject; });
  const timer = setTimeout(() => fail(new Error('Synthetic transaction barrier timed out')), 5000);
  const stores = operations.map(() => {
    let first = true;
    return intercept(async (command, send) => {
      if (command.constructor.name === 'TransactWriteCommand' && first) {
        first = false;
        arrivals++;
        try { inspect(command); } catch (error) { fail(error); }
        if (arrivals === operations.length) release();
        await barrier;
      }
      return send();
    });
  });
  try {
    const results = await Promise.allSettled(operations.map((operation, index) => operation(stores[index])));
    assert.equal(arrivals, operations.length, 'All competitors must reach the real transaction');
    return { results, stores };
  } finally { clearTimeout(timer); }
}

test('real concurrent retained-candidate purges and acknowledgements recover one durable winner without skipping the suffix', async () => {
  await fixture(async (f) => {
    const seeded = [await f.seed(), await f.seed(), await f.seed()];
    for (const id of seeded) await put(f.config.locationTableName, { ...locationKey(id, f.peer), synthetic: 'peer-preserved' });
    const peers = await Promise.all(seeded.map((id) => f.point(id, f.peer)));
    const staged = await f.stage(await f.start(), 100);
    assert.deepEqual(new Set(staged.pendingPage.roomIds), new Set(seeded));
    assert.equal(staged.pendingPage.roomIds.length, 3);
    const [first, second, third] = staged.pendingPage.roomIds;
    await f.purge().purgeRoom(f.subject, f.event, first);
    const firstPurged = await f.room(first);
    const partial = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), first);
    const secondBefore = await f.room(second), thirdBefore = await f.room(third), thirdPoint = await f.point(third);
    assert.deepEqual(partial.pendingPage.roomIds, [second, third]);
    const purgeRace = await competeFirstTransactions([0, 1].map(() => (storage) =>
      f.purge(storage).purgeRoom(f.subject, f.event, second)), (command) => {
      const metadata = command.input.TransactItems[1].Put;
      assert.equal(metadata.Item.pk, `ROOM#${second}`);
      assert.equal(metadata.ExpressionAttributeValues[':revision'], secondBefore.revision);
    });
    for (const result of purgeRace.results) assert.equal(result.status, 'fulfilled', result.reason?.message);
    assert.deepEqual(purgeRace.results.map((result) => result.value.membershipRemoved).sort(), [false, true]);
    const attempts = purgeRace.stores.reduce((sum, storage) => sum + storage.transactions, 0);
    assert.ok(attempts >= 3 && attempts <= 12, 'Conflict must retry within the adapters six-attempt bounds');
    const secondPurged = await f.room(second);
    assert.equal(secondPurged.revision, secondBefore.revision + 1);
    assert.equal(secondPurged.room.revision, secondPurged.revision);
    assert.deepEqual(secondPurged.room.members, secondBefore.room.members.filter((member) => member.userId !== f.subject));
    assert.equal(secondPurged.room.ownerId, f.peer); assert.equal(secondPurged.room.invite, null);
    assert.equal(await f.point(second), undefined);
    // Neither successful purge advances the durable ledger automatically.
    assert.deepEqual(await f.ledger().read(f.subject, f.event), partial);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(partial)), /conflicting/);
    assert.deepEqual(await f.room(third), thirdBefore); assert.deepEqual(await f.point(third), thirdPoint);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);

    // Only after both purge results confirm success do competing callers ack.
    const ackRace = await competeFirstTransactions([0, 1].map(() => (storage) =>
      f.ledger(storage).acknowledge(f.subject, f.event, receipt(partial), second)), (command) => {
      const progress = command.input.TransactItems[1].Put;
      assert.equal(progress.ExpressionAttributeValues[':revision'], partial.revision);
      assert.deepEqual(progress.Item.pendingPage.roomIds, [third]);
    });
    const winners = ackRace.results.filter((result) => result.status === 'fulfilled');
    const losers = ackRace.results.filter((result) => result.status === 'rejected');
    assert.equal(winners.length, 1); assert.equal(losers.length, 1);
    assert.equal(losers[0].reason.name, 'TransactionCanceledException');
    assert.deepEqual(ackRace.stores.map((storage) => storage.transactions), [1, 1]);
    // Restart by rereading, rather than trusting either competitor's local state.
    let recovered = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(recovered, winners[0].value);
    assert.equal(recovered.revision, partial.revision + 1);
    assert.deepEqual(recovered.pendingPage, { roomIds: [third], next: staged.pendingPage.next });
    assert.deepEqual(recovered.cursor, staged.cursor);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(partial), second), /conflicting/);
    for (const id of [first, second]) await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(recovered), id), /conflicting/);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), recovered);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, second), { membershipRemoved: false });
    assert.deepEqual(await f.room(second), secondPurged);
    assert.deepEqual(await f.room(third), thirdBefore); assert.deepEqual(await f.point(third), thirdPoint);
    await f.purge().purgeRoom(f.subject, f.event, third);
    recovered = await f.ledger().acknowledge(f.subject, f.event, receipt(recovered), third);
    assert.deepEqual(recovered.pendingPage.roomIds, []); assert.deepEqual(recovered.cursor, staged.cursor);
    const advanced = await f.ledger().advance(f.subject, f.event, receipt(recovered));
    assert.deepEqual(advanced.cursor, staged.pendingPage.next); assert.equal(advanced.pendingPage, null);
    assert.deepEqual(await f.room(first), firstPurged);
    for (const id of seeded) {
      assert.equal(await f.point(id), undefined); assert.equal((await f.room(id)).revision, 2);
    }
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    await assertHeld(f);
  });
});

test('real concurrent orphan purges and acknowledgements preserve absent metadata and recover the exact points suffix', async () => {
  await fixture(async (f) => {
    const seeded = [await f.seed({ orphan: true }), await f.seed({ orphan: true }), await f.seed({ orphan: true })];
    for (const id of seeded) await put(f.config.locationTableName, { ...locationKey(id, f.peer), synthetic: 'peer-preserved' });
    const peers = await Promise.all(seeded.map((id) => f.point(id, f.peer)));
    // Enter the points phase through actual empty-room discovery and ledger advance.
    const rooms = await f.stage(await f.start(), 100);
    assert.deepEqual(rooms.pendingPage.roomIds, []);
    assert.equal(rooms.pendingPage.next.phase, 'points');
    assert.equal(rooms.pendingPage.next.key, null);
    const points = await f.ledger().advance(f.subject, f.event, receipt(rooms));
    const staged = await f.stage(points, 100);
    assert.deepEqual(new Set(staged.pendingPage.roomIds), new Set(seeded));
    assert.equal(staged.pendingPage.roomIds.length, 3);
    assert.equal(staged.pendingPage.next, null);
    const [first, second, third] = staged.pendingPage.roomIds;
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, first), { membershipRemoved: false });
    const partial = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), first);
    assert.deepEqual(partial.pendingPage, { roomIds: [second, third], next: null });
    const thirdPoint = await f.point(third);
    assert.ok(thirdPoint);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.room(id))), [undefined, undefined, undefined]);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(partial), third), /conflicting/);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(partial)), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), partial);

    const purgeRace = await competeFirstTransactions([0, 1].map(() => (storage) =>
      f.purge(storage).purgeRoom(f.subject, f.event, second)), (command) => {
      const metadata = command.input.TransactItems[1];
      assert.equal(Object.hasOwn(metadata, 'Put'), false);
      assert.equal(metadata.ConditionCheck.TableName, f.config.roomTableName);
      assert.deepEqual(metadata.ConditionCheck.Key, { pk: `ROOM#${second}` });
      assert.equal(metadata.ConditionCheck.ConditionExpression, 'attribute_not_exists(pk)');
      assert.deepEqual(command.input.TransactItems[2].Delete.Key, locationKey(second, f.subject));
    });
    for (const result of purgeRace.results) {
      assert.equal(result.status, 'fulfilled', result.reason?.message);
      assert.deepEqual(result.value, { membershipRemoved: false });
    }
    // No metadata revision exists: both may commit directly, or retry transaction conflicts.
    for (const storage of purgeRace.stores) assert.ok(storage.transactions >= 1 && storage.transactions <= 6);
    assert.equal(await f.point(first), undefined); assert.equal(await f.point(second), undefined);
    assert.deepEqual(await f.point(third), thirdPoint);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.room(id))), [undefined, undefined, undefined]);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    // Confirmed purge results alone cannot consume the retained candidate.
    assert.deepEqual(await f.ledger().read(f.subject, f.event), partial);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(partial)), /conflicting/);

    const ackRace = await competeFirstTransactions([0, 1].map(() => (storage) =>
      f.ledger(storage).acknowledge(f.subject, f.event, receipt(partial), second)), (command) => {
      const progress = command.input.TransactItems[1].Put;
      assert.equal(progress.ExpressionAttributeValues[':revision'], partial.revision);
      assert.deepEqual(progress.Item.pendingPage, { roomIds: [third], next: null });
    });
    const winners = ackRace.results.filter((result) => result.status === 'fulfilled');
    const losers = ackRace.results.filter((result) => result.status === 'rejected');
    assert.equal(winners.length, 1); assert.equal(losers.length, 1);
    assert.equal(losers[0].reason.name, 'TransactionCanceledException');
    assert.deepEqual(ackRace.stores.map((storage) => storage.transactions), [1, 1]);
    let recovered = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(recovered, winners[0].value);
    assert.equal(recovered.revision, partial.revision + 1);
    assert.deepEqual(recovered.pendingPage, { roomIds: [third], next: null });
    assert.deepEqual(recovered.cursor, staged.cursor);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(partial), second), /conflicting/);
    for (const id of [first, second]) await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(recovered), id), /conflicting/);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), recovered);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, second), { membershipRemoved: false });
    assert.deepEqual(await f.point(third), thirdPoint);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, third), { membershipRemoved: false });
    recovered = await f.ledger().acknowledge(f.subject, f.event, receipt(recovered), third);
    assert.deepEqual(recovered.pendingPage, { roomIds: [], next: null });
    assert.deepEqual(recovered.cursor, staged.cursor);
    const advanced = await f.ledger().advance(f.subject, f.event, receipt(recovered));
    assert.equal(advanced.pendingPage, null); assert.equal(advanced.cursor, null);
    assert.equal(advanced.traversalEnded, true);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), advanced);
    assert.equal(Object.hasOwn(advanced, 'complete'), false); assert.equal(Object.hasOwn(advanced, 'ttl'), false);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.room(id))), [undefined, undefined, undefined]);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id))), [undefined, undefined, undefined]);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    await assertHeld(f);
  });
});

test('real partial-page recovery retains work after six revision conflicts and resumes under a new lease', async () => {
  await fixture(async (f) => {
    const seeded = [await f.seed(), await f.seed(), await f.seed()];
    for (const id of seeded) await put(f.config.locationTableName, { ...locationKey(id, f.peer), synthetic: 'peer-preserved' });
    const peers = await Promise.all(seeded.map((id) => f.point(id, f.peer)));
    const staged = await f.stage(await f.start(), 100);
    assert.deepEqual(new Set(staged.pendingPage.roomIds), new Set(seeded));
    assert.equal(staged.pendingPage.roomIds.length, 3);
    const [first, second, third] = staged.pendingPage.roomIds;
    await f.purge().purgeRoom(f.subject, f.event, first);
    const firstPurged = await f.room(first);
    const partial = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), first);
    assert.deepEqual(partial.pendingPage, { roomIds: [second, third], next: staged.pendingPage.next });
    const secondBefore = await f.room(second), secondPoint = await f.point(second);
    const thirdBefore = await f.room(third), thirdPoint = await f.point(third);
    let conflicts = 0;
    const racing = intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      const metadata = command.input.TransactItems[1].Put;
      assert.equal(metadata.Item.pk, `ROOM#${second}`);
      const concurrent = await f.room(second);
      assert.equal(metadata.ExpressionAttributeValues[':revision'], concurrent.revision);
      // A real write invalidates every attempted purge revision before it reaches DB.
      concurrent.revision++; concurrent.room.revision = concurrent.revision;
      await put(f.config.roomTableName, concurrent);
      try {
        const result = await send();
        assert.fail('Stale-revision purge must be rejected by the database');
        return result;
      } catch (error) {
        assert.equal(error.name, 'TransactionCanceledException');
        assert.equal(error.CancellationReasons[1].Code, 'ConditionalCheckFailed');
        assert.ok(error.CancellationReasons.every((reason, index) => reason.Code === (index === 1 ? 'ConditionalCheckFailed' : 'None')));
        conflicts++;
        throw error;
      }
    });
    await assert.rejects(f.purge(racing).purgeRoom(f.subject, f.event, second), { code: 'ROOM_BUSY' });
    assert.equal(racing.transactions, 6); assert.equal(conflicts, 6);
    const contended = structuredClone(secondBefore);
    contended.revision += 6; contended.room.revision = contended.revision;
    assert.deepEqual(await f.room(second), contended);
    assert.deepEqual(await f.point(second), secondPoint);
    assert.deepEqual(await f.room(first), firstPurged); assert.equal(await f.point(first), undefined);
    assert.deepEqual(await f.room(third), thirdBefore); assert.deepEqual(await f.point(third), thirdPoint);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), partial);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(partial)), /conflicting/);
    await assertHeld(f);

    // A fresh worker must resume the durable suffix, never rediscover past it.
    f.clock.at = partial.lease.until;
    const loaded = await f.ledger().read(f.subject, f.event);
    let resumed = await f.ledger().claim(f.subject, f.event, receipt(loaded, token()));
    assert.notEqual(resumed.lease.token, partial.lease.token);
    assert.equal(resumed.revision, partial.revision + 1);
    assert.deepEqual(resumed.pendingPage, partial.pendingPage); assert.deepEqual(resumed.cursor, staged.cursor);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(partial), second), /conflicting/);
    for (const id of [first, third]) await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(resumed), id), /conflicting/);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(resumed)), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), resumed);
    assert.deepEqual(await f.room(second), contended); assert.deepEqual(await f.point(second), secondPoint);
    // Cease conflicts and confirm both the first success and an idempotent replay.
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, second), { membershipRemoved: true });
    const secondPurged = await f.room(second);
    assert.equal(secondPurged.revision, contended.revision + 1);
    assert.equal(secondPurged.room.revision, secondPurged.revision);
    assert.deepEqual(secondPurged.room.members, secondBefore.room.members.filter((member) => member.userId !== f.subject));
    assert.equal(secondPurged.room.ownerId, f.peer); assert.equal(secondPurged.room.invite, null);
    assert.equal(await f.point(second), undefined);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, second), { membershipRemoved: false });
    assert.deepEqual(await f.room(second), secondPurged);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), resumed);
    resumed = await f.ledger().acknowledge(f.subject, f.event, receipt(resumed), second);
    assert.deepEqual(resumed.pendingPage, { roomIds: [third], next: staged.pendingPage.next });
    assert.deepEqual(resumed.cursor, staged.cursor);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(resumed)), /conflicting/);
    assert.deepEqual(await f.room(third), thirdBefore); assert.deepEqual(await f.point(third), thirdPoint);
    await f.purge().purgeRoom(f.subject, f.event, third);
    resumed = await f.ledger().acknowledge(f.subject, f.event, receipt(resumed), third);
    assert.deepEqual(resumed.pendingPage, { roomIds: [], next: staged.pendingPage.next });
    assert.deepEqual(resumed.cursor, staged.cursor);
    const advanced = await f.ledger().advance(f.subject, f.event, receipt(resumed));
    assert.deepEqual(advanced.cursor, staged.pendingPage.next); assert.equal(advanced.pendingPage, null);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), advanced);
    assert.deepEqual(await f.room(first), firstPurged); assert.deepEqual(await f.room(second), secondPurged);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id))), [undefined, undefined, undefined]);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    assert.equal(Object.hasOwn(advanced, 'complete'), false); assert.equal(Object.hasOwn(advanced, 'ttl'), false);
    await assertHeld(f);
  });
});

test('real lost committed takeover response recovers the winning lease before draining the retained suffix', async () => {
  await fixture(async (f) => {
    const seeded = [await f.seed(), await f.seed(), await f.seed()];
    for (const id of seeded) await put(f.config.locationTableName, { ...locationKey(id, f.peer), synthetic: 'peer-preserved' });
    const peers = await Promise.all(seeded.map((id) => f.point(id, f.peer)));
    const staged = await f.stage(await f.start(), 100);
    assert.deepEqual(new Set(staged.pendingPage.roomIds), new Set(seeded));
    assert.equal(staged.pendingPage.roomIds.length, 3);
    const [first, second, third] = staged.pendingPage.roomIds;
    await f.purge().purgeRoom(f.subject, f.event, first);
    const firstPurged = await f.room(first);
    const partial = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), first);
    assert.deepEqual(partial.pendingPage, { roomIds: [second, third], next: staged.pendingPage.next });
    const before = await Promise.all(seeded.map((id) => f.room(id)));
    const pointsBefore = await Promise.all(seeded.map((id) => f.point(id)));
    f.clock.at = partial.lease.until;
    const loaded = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(loaded, partial);
    const takeoverReceipt = receipt(loaded, token());
    assert.notEqual(takeoverReceipt.token, partial.lease.token);
    const outage = new Error('Synthetic committed takeover response lost');
    let committed = false;
    const failing = intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      const replacement = command.input.TransactItems[1].Put;
      assert.equal(replacement.TableName, f.config.tableName);
      assert.equal(replacement.ExpressionAttributeValues[':revision'], partial.revision);
      assert.equal(replacement.Item.lease.token, takeoverReceipt.token);
      // Only response delivery fails: the real conditional claim must commit first.
      await send();
      committed = true;
      throw outage;
    });
    await assert.rejects(f.ledger(failing).claim(f.subject, f.event, takeoverReceipt), (error) => error === outage);
    assert.equal(committed, true); assert.equal(failing.transactions, 1);
    // Ambiguous ownership never triggers purge; a fresh adapter first reads the winner.
    assert.deepEqual(await Promise.all(seeded.map((id) => f.room(id))), before);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id))), pointsBefore);
    let recovered = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(recovered, { ...partial, revision: partial.revision + 1,
      lease: { token: takeoverReceipt.token, until: f.clock.at + 30_000 } });
    const winner = structuredClone(recovered);
    await assert.rejects(f.ledger().claim(f.subject, f.event, takeoverReceipt), /conflicting/);
    await assert.rejects(f.ledger().claim(f.subject, f.event, receipt(recovered, token())), /conflicting/);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(partial), second), /conflicting/);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(recovered, partial.lease.token), second), /conflicting/);
    for (const id of [first, third]) await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(recovered), id), /conflicting/);
    await assert.rejects(f.ledger().stagePage(f.subject, f.event, receipt(recovered), staged.pendingPage), /conflicting/);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), winner);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.room(id))), before);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id))), pointsBefore);
    await assertHeld(f);

    const suffix = [second, third], purged = [];
    for (const [index, id] of suffix.entries()) {
      assert.deepEqual(recovered.pendingPage.roomIds, suffix.slice(index));
      assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, id), { membershipRemoved: true });
      const metadata = await f.room(id);
      assert.equal(metadata.revision, 2); assert.equal(metadata.room.revision, 2);
      assert.equal(metadata.room.ownerId, f.peer); assert.equal(metadata.room.invite, null);
      assert.deepEqual(metadata.room.members, before[seeded.indexOf(id)].room.members.filter((member) => member.userId !== f.subject));
      assert.equal(await f.point(id), undefined);
      assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, id), { membershipRemoved: false });
      assert.deepEqual(await f.room(id), metadata);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), recovered);
      purged.push(metadata);
      recovered = await f.ledger().acknowledge(f.subject, f.event, receipt(recovered), id);
      assert.deepEqual(recovered.pendingPage, { roomIds: suffix.slice(index + 1), next: staged.pendingPage.next });
      assert.deepEqual(recovered.cursor, staged.cursor); assert.deepEqual(recovered.lease, winner.lease);
      assert.deepEqual(await f.room(first), firstPurged);
      assert.deepEqual(await Promise.all(seeded.map((roomId) => f.point(roomId, f.peer))), peers);
      if (index === 0) {
        await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(recovered)), /conflicting/);
        assert.deepEqual(await f.room(third), before[seeded.indexOf(third)]);
        assert.deepEqual(await f.point(third), pointsBefore[seeded.indexOf(third)]);
      }
    }
    const advanced = await f.ledger().advance(f.subject, f.event, receipt(recovered));
    assert.deepEqual(advanced.cursor, staged.pendingPage.next); assert.equal(advanced.pendingPage, null);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), advanced);
    assert.deepEqual(await Promise.all(suffix.map((id) => f.room(id))), purged);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id))), [undefined, undefined, undefined]);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    assert.equal(Object.hasOwn(advanced, 'complete'), false); assert.equal(Object.hasOwn(advanced, 'ttl'), false);
    await assertHeld(f);
  });
});

test('real purge completing at lease expiry retains the suffix until takeover and confirmed replay', async () => {
  await fixture(async (f) => {
    const seeded = [await f.seed(), await f.seed(), await f.seed()];
    for (const id of seeded) await put(f.config.locationTableName, { ...locationKey(id, f.peer), synthetic: 'peer-preserved' });
    const peers = await Promise.all(seeded.map((id) => f.point(id, f.peer)));
    const staged = await f.stage(await f.start(), 100);
    assert.deepEqual(new Set(staged.pendingPage.roomIds), new Set(seeded));
    assert.equal(staged.pendingPage.roomIds.length, 3);
    const [first, second, third] = staged.pendingPage.roomIds;
    await f.purge().purgeRoom(f.subject, f.event, first);
    const firstPurged = await f.room(first);
    const partial = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), first);
    assert.deepEqual(partial.pendingPage, { roomIds: [second, third], next: staged.pendingPage.next });
    const secondBefore = await f.room(second), thirdBefore = await f.room(third), thirdPoint = await f.point(third);
    assert.ok(f.clock.at < partial.lease.until);
    let completed = false;
    const delayed = intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      assert.equal(command.input.TransactItems[1].Put.Item.pk, `ROOM#${second}`);
      assert.deepEqual(command.input.TransactItems[2].Delete.Key, locationKey(second, f.subject));
      const response = await send();
      completed = true;
      // The purge has committed; expire the lease before its success reaches the caller.
      // This tests subsequent ledger admission, not commit-time lease fencing.
      f.clock.at = partial.lease.until;
      return response;
    });
    assert.deepEqual(await f.purge(delayed).purgeRoom(f.subject, f.event, second), { membershipRemoved: true });
    assert.equal(completed, true); assert.equal(delayed.transactions, 1);
    assert.equal(f.clock.at, partial.lease.until);
    const secondPurged = await f.room(second), expected = structuredClone(secondBefore);
    expected.revision++; expected.room.revision++;
    expected.room.members = expected.room.members.filter((member) => member.userId !== f.subject);
    expected.room.ownerId = f.peer; expected.room.invite = null;
    assert.deepEqual(secondPurged, expected); assert.equal(await f.point(second), undefined);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), partial);

    const expired = intercept((_command, send) => send());
    await assert.rejects(f.ledger(expired).acknowledge(f.subject, f.event, receipt(partial), second), /conflicting/);
    await assert.rejects(f.ledger(expired).stagePage(f.subject, f.event, receipt(partial), staged.pendingPage), /conflicting/);
    await assert.rejects(f.ledger(expired).advance(f.subject, f.event, receipt(partial)), /conflicting/);
    assert.equal(expired.transactions, 0, 'Already-expired receipts must fail before any ledger transaction');
    assert.deepEqual(await f.ledger().read(f.subject, f.event), partial);
    assert.deepEqual(await f.room(first), firstPurged); assert.equal(await f.point(first), undefined);
    assert.deepEqual(await f.room(third), thirdBefore); assert.deepEqual(await f.point(third), thirdPoint);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    await assertHeld(f);

    // Resume durable pending work with a fresh lease; never rediscover past the suffix.
    const loaded = await f.ledger().read(f.subject, f.event);
    let recovered = await f.ledger().claim(f.subject, f.event, receipt(loaded, token()));
    assert.notEqual(recovered.lease.token, partial.lease.token);
    assert.deepEqual(recovered, { ...partial, revision: partial.revision + 1,
      lease: { token: recovered.lease.token, until: f.clock.at + 30_000 } });
    const takeover = structuredClone(recovered);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(partial), second), /conflicting/);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(recovered, partial.lease.token), second), /conflicting/);
    await assert.rejects(f.ledger().claim(f.subject, f.event, receipt(recovered, token())), /conflicting/);
    for (const id of [first, third]) await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(recovered), id), /conflicting/);
    await assert.rejects(f.ledger().stagePage(f.subject, f.event, receipt(recovered), staged.pendingPage), /conflicting/);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), takeover);
    assert.deepEqual(await f.room(second), secondPurged);
    assert.deepEqual(await f.room(third), thirdBefore); assert.deepEqual(await f.point(third), thirdPoint);
    // A confirmed idempotent replay is required before consuming the retained second candidate.
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, second), { membershipRemoved: false });
    assert.deepEqual(await f.room(second), secondPurged); assert.equal(await f.point(second), undefined);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), takeover);
    recovered = await f.ledger().acknowledge(f.subject, f.event, receipt(recovered), second);
    assert.deepEqual(recovered.pendingPage, { roomIds: [third], next: staged.pendingPage.next });
    assert.deepEqual(recovered.cursor, staged.cursor); assert.deepEqual(recovered.lease, takeover.lease);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    assert.deepEqual(await f.room(third), thirdBefore); assert.deepEqual(await f.point(third), thirdPoint);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, third), { membershipRemoved: true });
    const thirdPurged = await f.room(third);
    assert.equal(thirdPurged.revision, thirdBefore.revision + 1);
    assert.equal(thirdPurged.room.revision, thirdPurged.revision);
    assert.deepEqual(thirdPurged.room.members, thirdBefore.room.members.filter((member) => member.userId !== f.subject));
    assert.equal(thirdPurged.room.ownerId, f.peer); assert.equal(thirdPurged.room.invite, null);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, third), { membershipRemoved: false });
    assert.deepEqual(await f.room(third), thirdPurged);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), recovered);
    recovered = await f.ledger().acknowledge(f.subject, f.event, receipt(recovered), third);
    assert.deepEqual(recovered.pendingPage, { roomIds: [], next: staged.pendingPage.next });
    assert.deepEqual(recovered.cursor, staged.cursor); assert.deepEqual(recovered.lease, takeover.lease);
    const advanced = await f.ledger().advance(f.subject, f.event, receipt(recovered));
    assert.deepEqual(advanced.cursor, staged.pendingPage.next); assert.equal(advanced.pendingPage, null);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), advanced);
    assert.deepEqual(await f.room(first), firstPurged); assert.deepEqual(await f.room(second), secondPurged);
    assert.deepEqual(await f.room(third), thirdPurged);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id))), [undefined, undefined, undefined]);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    assert.equal(Object.hasOwn(advanced, 'complete'), false); assert.equal(Object.hasOwn(advanced, 'ttl'), false);
    await assertHeld(f);
  });
});

test('real admitted acknowledgement loses its revision condition after a committed lease takeover', async () => {
  await fixture(async (f) => {
    const seeded = [await f.seed(), await f.seed(), await f.seed()];
    for (const id of seeded) await put(f.config.locationTableName, { ...locationKey(id, f.peer), synthetic: 'peer-preserved' });
    const peers = await Promise.all(seeded.map((id) => f.point(id, f.peer)));
    const staged = await f.stage(await f.start(), 100);
    assert.deepEqual(new Set(staged.pendingPage.roomIds), new Set(seeded));
    assert.equal(staged.pendingPage.roomIds.length, 3);
    const [first, second, third] = staged.pendingPage.roomIds;
    await f.purge().purgeRoom(f.subject, f.event, first);
    const firstPurged = await f.room(first);
    const partial = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), first);
    assert.deepEqual(partial.pendingPage, { roomIds: [second, third], next: staged.pendingPage.next });
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, second), { membershipRemoved: true });
    const roomsBefore = await Promise.all(seeded.map((id) => f.room(id)));
    const pointsBefore = await Promise.all(seeded.map((id) => f.point(id)));
    assert.equal(await f.point(second), undefined);
    let winner, forwarded = false;
    const delayed = intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      // The old adapter has completed its admission/hold reads at a valid lease.
      assert.ok(f.clock.at < partial.lease.until);
      const attempted = command.input.TransactItems[1].Put;
      assert.equal(attempted.TableName, f.config.tableName);
      assert.equal(attempted.ExpressionAttributeValues[':revision'], partial.revision);
      assert.deepEqual(attempted.Item, { ...partial, revision: partial.revision + 1,
        pendingPage: { roomIds: [third], next: staged.pendingPage.next } });
      assert.deepEqual(await f.ledger().read(f.subject, f.event), partial);
      f.clock.at = partial.lease.until;
      // Commit through a separate adapter before forwarding the old real command.
      const loaded = await f.ledger().read(f.subject, f.event);
      winner = await f.ledger().claim(f.subject, f.event, receipt(loaded, token()));
      assert.notEqual(winner.lease.token, partial.lease.token);
      assert.deepEqual(winner, { ...partial, revision: partial.revision + 1,
        lease: { token: winner.lease.token, until: f.clock.at + 30_000 } });
      assert.deepEqual(await f.ledger().read(f.subject, f.event), winner);
      forwarded = true;
      return send();
    });
    await assert.rejects(f.ledger(delayed).acknowledge(f.subject, f.event, receipt(partial), second), (error) => {
      assert.equal(error.name, 'TransactionCanceledException');
      assert.deepEqual(error.CancellationReasons.map((reason) => reason.Code), ['None', 'ConditionalCheckFailed']);
      return true;
    });
    assert.equal(delayed.transactions, 1); assert.equal(forwarded, true);
    // The winning revision has not consumed either suffix candidate.
    let recovered = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(recovered, winner);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.room(id))), roomsBefore);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id))), pointsBefore);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    await assertHeld(f);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(partial), second), /conflicting/);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(recovered, partial.lease.token), second), /conflicting/);
    await assert.rejects(f.ledger().claim(f.subject, f.event, receipt(recovered, token())), /conflicting/);
    for (const id of [first, third]) await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(recovered), id), /conflicting/);
    await assert.rejects(f.ledger().stagePage(f.subject, f.event, receipt(recovered), staged.pendingPage), /conflicting/);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), winner);

    // Confirm the already-purged candidate by replay before acknowledging it.
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, second), { membershipRemoved: false });
    assert.deepEqual(await f.room(second), roomsBefore[seeded.indexOf(second)]);
    assert.equal(await f.point(second), undefined);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), winner);
    recovered = await f.ledger().acknowledge(f.subject, f.event, receipt(recovered), second);
    assert.deepEqual(recovered.pendingPage, { roomIds: [third], next: staged.pendingPage.next });
    assert.deepEqual(recovered.cursor, staged.cursor); assert.deepEqual(recovered.lease, winner.lease);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    assert.deepEqual(await f.room(third), roomsBefore[seeded.indexOf(third)]);
    assert.deepEqual(await f.point(third), pointsBefore[seeded.indexOf(third)]);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, third), { membershipRemoved: true });
    const thirdPurged = await f.room(third), expected = structuredClone(roomsBefore[seeded.indexOf(third)]);
    expected.revision++; expected.room.revision++;
    expected.room.members = expected.room.members.filter((member) => member.userId !== f.subject);
    expected.room.ownerId = f.peer; expected.room.invite = null;
    assert.deepEqual(thirdPurged, expected); assert.equal(await f.point(third), undefined);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, third), { membershipRemoved: false });
    assert.deepEqual(await f.room(third), thirdPurged);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), recovered);
    recovered = await f.ledger().acknowledge(f.subject, f.event, receipt(recovered), third);
    assert.deepEqual(recovered.pendingPage, { roomIds: [], next: staged.pendingPage.next });
    assert.deepEqual(recovered.cursor, staged.cursor); assert.deepEqual(recovered.lease, winner.lease);
    const advanced = await f.ledger().advance(f.subject, f.event, receipt(recovered));
    assert.deepEqual(advanced.cursor, staged.pendingPage.next); assert.equal(advanced.pendingPage, null);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), advanced);
    assert.deepEqual(await f.room(first), firstPurged);
    assert.deepEqual(await f.room(second), roomsBefore[seeded.indexOf(second)]);
    assert.deepEqual(await f.room(third), thirdPurged);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id))), [undefined, undefined, undefined]);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    assert.equal(Object.hasOwn(advanced, 'complete'), false); assert.equal(Object.hasOwn(advanced, 'ttl'), false);
    await assertHeld(f);
  });
});

test('real admitted page advance loses its revision condition after a committed lease takeover', async () => {
  await fixture(async (f) => {
    const seeded = [await f.seed(), await f.seed(), await f.seed()];
    for (const id of seeded) await put(f.config.locationTableName, { ...locationKey(id, f.peer), synthetic: 'peer-preserved' });
    const peers = await Promise.all(seeded.map((id) => f.point(id, f.peer)));
    let drained = await f.stage(await f.start(), 1);
    assert.equal(drained.pendingPage.roomIds.length, 1);
    assert.equal(drained.pendingPage.next.phase, 'rooms');
    assert.ok(drained.pendingPage.next.key);
    const [first] = drained.pendingPage.roomIds;
    assert.ok(seeded.includes(first));
    const staged = structuredClone(drained);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, first), { membershipRemoved: true });
    const firstPurged = await f.room(first);
    assert.equal(await f.point(first), undefined);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, first), { membershipRemoved: false });
    assert.deepEqual(await f.room(first), firstPurged);
    drained = await f.ledger().acknowledge(f.subject, f.event, receipt(drained), first);
    assert.deepEqual(drained.pendingPage, { roomIds: [], next: staged.pendingPage.next });
    assert.deepEqual(drained.cursor, staged.cursor);
    const roomsBefore = await Promise.all(seeded.map((id) => f.room(id)));
    const pointsBefore = await Promise.all(seeded.map((id) => f.point(id)));
    let winner, forwarded = false;
    const delayed = intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      // Admission and hold reads completed while the old lease was still live.
      assert.ok(f.clock.at < drained.lease.until);
      const attempted = command.input.TransactItems[1].Put;
      assert.equal(attempted.TableName, f.config.tableName);
      assert.equal(attempted.ExpressionAttributeValues[':revision'], drained.revision);
      assert.deepEqual(attempted.Item, { ...drained, revision: drained.revision + 1,
        cursor: staged.pendingPage.next, pendingPage: null });
      assert.deepEqual(await f.ledger().read(f.subject, f.event), drained);
      f.clock.at = drained.lease.until;
      const loaded = await f.ledger().read(f.subject, f.event);
      winner = await f.ledger().claim(f.subject, f.event, receipt(loaded, token()));
      assert.notEqual(winner.lease.token, drained.lease.token);
      assert.deepEqual(winner, { ...drained, revision: drained.revision + 1,
        lease: { token: winner.lease.token, until: f.clock.at + 30_000 } });
      assert.deepEqual(await f.ledger().read(f.subject, f.event), winner);
      forwarded = true;
      return send();
    });
    await assert.rejects(f.ledger(delayed).advance(f.subject, f.event, receipt(drained)), (error) => {
      assert.equal(error.name, 'TransactionCanceledException');
      assert.deepEqual(error.CancellationReasons.map((reason) => reason.Code), ['None', 'ConditionalCheckFailed']);
      return true;
    });
    assert.equal(delayed.transactions, 1); assert.equal(forwarded, true);
    const recovered = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(recovered, winner);
    assert.deepEqual(recovered.pendingPage, { roomIds: [], next: staged.pendingPage.next });
    assert.deepEqual(recovered.cursor, staged.cursor);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(drained)), /conflicting/);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(recovered, drained.lease.token)), /conflicting/);
    await assert.rejects(f.ledger().stagePage(f.subject, f.event, receipt(recovered), staged.pendingPage), /conflicting/);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(recovered), first), /conflicting/);
    await assert.rejects(f.ledger().claim(f.subject, f.event, receipt(recovered, token())), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), winner);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.room(id))), roomsBefore);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id))), pointsBefore);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    await assertHeld(f);

    // The winner consumes the retained empty page exactly once, then uses its cursor.
    const advanced = await f.ledger().advance(f.subject, f.event, receipt(recovered));
    assert.deepEqual(advanced, { ...winner, revision: winner.revision + 1,
      cursor: staged.pendingPage.next, pendingPage: null });
    assert.deepEqual(await f.ledger().read(f.subject, f.event), advanced);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(drained)), /conflicting/);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(advanced)), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), advanced);
    let scans = 0;
    const continued = intercept((command, send) => {
      if (command.constructor.name === 'ScanCommand') {
        scans++;
        assert.equal(command.input.TableName, f.config.roomTableName);
        assert.equal(command.input.ConsistentRead, true); assert.equal(command.input.Limit, 1);
        assert.deepEqual(command.input.ExclusiveStartKey, advanced.cursor.key);
      }
      return send();
    });
    const discovery = createLifecycleDiscoveryStore({ client: continued, tableName: f.config.roomTableName,
      sessionTableName: f.config.sessionTableName, locationTableName: f.config.locationTableName });
    const nextPage = await discovery.readPage(f.subject, f.event, { cursor: advanced.cursor, limit: 1 });
    assert.equal(scans, 1); assert.equal(continued.transactions, 0);
    assert.equal(nextPage.roomIds.length, 1);
    assert.ok(seeded.includes(nextPage.roomIds[0])); assert.notEqual(nextPage.roomIds[0], first);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), advanced);
    const restaged = await f.ledger().stagePage(f.subject, f.event, receipt(advanced), nextPage);
    assert.deepEqual(restaged, { ...advanced, revision: advanced.revision + 1, pendingPage: nextPage });
    assert.deepEqual(await f.ledger().read(f.subject, f.event), restaged);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.room(id))), roomsBefore);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id))), pointsBefore);
    assert.deepEqual(await f.room(first), firstPurged);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    assert.equal(Object.hasOwn(restaged, 'complete'), false); assert.equal(Object.hasOwn(restaged, 'ttl'), false);
    await assertHeld(f);
  });
});

test('real admitted page stage loses its revision condition after a committed lease takeover', async () => {
  await fixture(async (f) => {
    const seeded = [await f.seed(), await f.seed(), await f.seed()];
    for (const id of seeded) await put(f.config.locationTableName, { ...locationKey(id, f.peer), synthetic: 'peer-preserved' });
    const peers = await Promise.all(seeded.map((id) => f.point(id, f.peer)));
    let prefix = await f.stage(await f.start(), 1);
    const [first] = prefix.pendingPage.roomIds;
    assert.ok(seeded.includes(first)); assert.equal(prefix.pendingPage.next.phase, 'rooms');
    assert.ok(prefix.pendingPage.next.key);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, first), { membershipRemoved: true });
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, first), { membershipRemoved: false });
    prefix = await f.ledger().acknowledge(f.subject, f.event, receipt(prefix), first);
    const unstaged = await f.ledger().advance(f.subject, f.event, receipt(prefix));
    assert.equal(unstaged.pendingPage, null); assert.equal(unstaged.cursor.phase, 'rooms');
    assert.ok(unstaged.cursor.key);
    const page = await f.discovery().readPage(f.subject, f.event, { cursor: unstaged.cursor, limit: 1 });
    assert.equal(page.roomIds.length, 1);
    const [candidate] = page.roomIds;
    assert.ok(seeded.includes(candidate)); assert.notEqual(candidate, first);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), unstaged);
    const roomsBefore = await Promise.all(seeded.map((id) => f.room(id)));
    const pointsBefore = await Promise.all(seeded.map((id) => f.point(id)));
    let winner, forwarded = false;
    const delayed = intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      // Stage admission and exact-hold reads finish before expiry; takeover wins the write.
      assert.ok(f.clock.at < unstaged.lease.until);
      const attempted = command.input.TransactItems[1].Put;
      assert.equal(attempted.TableName, f.config.tableName);
      assert.equal(attempted.ExpressionAttributeValues[':revision'], unstaged.revision);
      assert.deepEqual(attempted.Item, { ...unstaged, revision: unstaged.revision + 1, pendingPage: page });
      assert.deepEqual(await f.ledger().read(f.subject, f.event), unstaged);
      f.clock.at = unstaged.lease.until;
      const loaded = await f.ledger().read(f.subject, f.event);
      winner = await f.ledger().claim(f.subject, f.event, receipt(loaded, token()));
      assert.notEqual(winner.lease.token, unstaged.lease.token);
      assert.deepEqual(winner, { ...unstaged, revision: unstaged.revision + 1,
        lease: { token: winner.lease.token, until: f.clock.at + 30_000 } });
      assert.deepEqual(await f.ledger().read(f.subject, f.event), winner);
      forwarded = true;
      return send();
    });
    await assert.rejects(f.ledger(delayed).stagePage(f.subject, f.event, receipt(unstaged), page), (error) => {
      assert.equal(error.name, 'TransactionCanceledException');
      assert.deepEqual(error.CancellationReasons.map((reason) => reason.Code), ['None', 'ConditionalCheckFailed']);
      return true;
    });
    assert.equal(delayed.transactions, 1); assert.equal(forwarded, true);
    const recovered = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(recovered, winner); assert.equal(recovered.pendingPage, null);
    assert.deepEqual(recovered.cursor, unstaged.cursor);
    await assert.rejects(f.ledger().stagePage(f.subject, f.event, receipt(unstaged), page), /conflicting/);
    await assert.rejects(f.ledger().stagePage(f.subject, f.event, receipt(recovered, unstaged.lease.token), page), /conflicting/);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(recovered), candidate), /conflicting/);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    await assert.rejects(f.ledger().claim(f.subject, f.event, receipt(recovered, token())), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), winner);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.room(id))), roomsBefore);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id))), pointsBefore);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    await assertHeld(f);

    let scans = 0;
    const continued = intercept((command, send) => {
      if (command.constructor.name === 'ScanCommand') {
        scans++;
        assert.equal(command.input.TableName, f.config.roomTableName);
        assert.equal(command.input.ConsistentRead, true); assert.equal(command.input.Limit, 1);
        assert.deepEqual(command.input.ExclusiveStartKey, recovered.cursor.key);
      }
      return send();
    });
    const discovery = createLifecycleDiscoveryStore({ client: continued, tableName: f.config.roomTableName,
      sessionTableName: f.config.sessionTableName, locationTableName: f.config.locationTableName });
    const rediscovered = await discovery.readPage(f.subject, f.event, { cursor: recovered.cursor, limit: 1 });
    assert.equal(scans, 1); assert.equal(continued.transactions, 0); assert.deepEqual(rediscovered, page);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), winner);
    let staged = await f.ledger().stagePage(f.subject, f.event, receipt(recovered), rediscovered);
    assert.deepEqual(staged, { ...winner, revision: winner.revision + 1, pendingPage: rediscovered });
    assert.deepEqual(await f.ledger().read(f.subject, f.event), staged);
    await assert.rejects(f.ledger().stagePage(f.subject, f.event, receipt(recovered), page), /conflicting/);
    await assert.rejects(f.ledger().stagePage(f.subject, f.event, receipt(staged), page), /conflicting/);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(staged)), /conflicting/);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.room(id))), roomsBefore);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id))), pointsBefore);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, candidate), { membershipRemoved: true });
    const candidatePurged = await f.room(candidate);
    assert.equal(await f.point(candidate), undefined);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), staged);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, candidate), { membershipRemoved: false });
    assert.deepEqual(await f.room(candidate), candidatePurged);
    staged = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), candidate);
    assert.deepEqual(staged.pendingPage, { roomIds: [], next: page.next });
    assert.deepEqual(staged.cursor, winner.cursor);
    const advanced = await f.ledger().advance(f.subject, f.event, receipt(staged));
    assert.deepEqual(advanced, { ...staged, revision: staged.revision + 1, cursor: page.next, pendingPage: null });
    assert.deepEqual(await f.ledger().read(f.subject, f.event), advanced);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(staged)), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), advanced);
    for (const [index, id] of seeded.entries()) {
      assert.deepEqual(await f.point(id, f.peer), peers[index]);
      if (id === candidate) continue;
      assert.deepEqual(await f.room(id), roomsBefore[index]);
      assert.deepEqual(await f.point(id), pointsBefore[index]);
    }
    assert.equal(Object.hasOwn(advanced, 'complete'), false); assert.equal(Object.hasOwn(advanced, 'ttl'), false);
    await assertHeld(f);
  });
});

test('real concurrent stages on one live receipt persist exactly one page before ordered recovery', async () => {
  await fixture(async (f) => {
    const seeded = [await f.seed(), await f.seed(), await f.seed()];
    for (const id of seeded) await put(f.config.locationTableName, { ...locationKey(id, f.peer), synthetic: 'peer-preserved' });
    const peers = await Promise.all(seeded.map((id) => f.point(id, f.peer)));
    let prefix = await f.stage(await f.start(), 1);
    const [first] = prefix.pendingPage.roomIds;
    assert.ok(seeded.includes(first)); assert.ok(prefix.pendingPage.next.key);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, first), { membershipRemoved: true });
    prefix = await f.ledger().acknowledge(f.subject, f.event, receipt(prefix), first);
    const unstaged = await f.ledger().advance(f.subject, f.event, receipt(prefix));
    assert.equal(unstaged.pendingPage, null); assert.equal(unstaged.cursor.phase, 'rooms');
    assert.ok(unstaged.cursor.key);
    const page = await f.discovery().readPage(f.subject, f.event, { cursor: unstaged.cursor, limit: 1 });
    assert.equal(page.roomIds.length, 1);
    const [candidate] = page.roomIds;
    assert.ok(seeded.includes(candidate)); assert.notEqual(candidate, first);
    const roomsBefore = await Promise.all(seeded.map((id) => f.room(id)));
    const pointsBefore = await Promise.all(seeded.map((id) => f.point(id)));
    const expected = { ...unstaged, revision: unstaged.revision + 1, pendingPage: page };

    let ready, admitted = 0, forwarded = 0;
    const releases = [];
    const gates = [0, 1].map((index) => new Promise((resolve) => { releases[index] = resolve; }));
    const bothReady = new Promise((resolve) => { ready = resolve; });
    const adapters = [0, 1].map((index) => intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      assert.ok(f.clock.at < unstaged.lease.until);
      const attempted = command.input.TransactItems[1].Put;
      assert.equal(attempted.TableName, f.config.tableName);
      assert.equal(attempted.ExpressionAttributeValues[':revision'], unstaged.revision);
      assert.deepEqual(attempted.Item, expected);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), unstaged);
      if (++admitted === 2) ready();
      await gates[index];
      forwarded++;
      return send();
    }));
    // Both distinct adapters finish admission before either real transaction is sent.
    const attempts = adapters.map((storage) =>
      f.ledger(storage).stagePage(f.subject, f.event, receipt(unstaged), page));
    const outcomes = Promise.allSettled(attempts);
    let timer, results;
    try {
      await Promise.race([bothReady, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Concurrent stage admission timed out.')), 5000);
      })]);
      assert.equal(admitted, 2); assert.equal(forwarded, 0);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), unstaged);
      // Commit one admitted operation before forwarding its competitor, so the
      // loser exercises the revision condition rather than a transient DB lock.
      releases[0]();
      assert.deepEqual(await attempts[0], expected);
      assert.equal(forwarded, 1);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), expected);
      releases[1]();
      results = await outcomes;
    } finally {
      clearTimeout(timer); releases.forEach((release) => release());
      // Collect both real operations even if admission/assertions fail.
      await outcomes;
    }
    assert.deepEqual(adapters.map((storage) => storage.transactions), [1, 1]);
    assert.equal(forwarded, 2);
    const successful = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result) => result.status === 'rejected');
    assert.equal(successful.length, 1); assert.equal(failed.length, 1);
    assert.deepEqual(successful[0].value, expected);
    assert.equal(failed[0].reason.name, 'TransactionCanceledException');
    assert.deepEqual(failed[0].reason.CancellationReasons.map((reason) => reason.Code), ['None', 'ConditionalCheckFailed']);

    let recovered = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(recovered, expected); assert.deepEqual(recovered.cursor, unstaged.cursor);
    assert.deepEqual(recovered.lease, unstaged.lease);
    await assert.rejects(f.ledger().stagePage(f.subject, f.event, receipt(unstaged), page), /conflicting/);
    await assert.rejects(f.ledger().stagePage(f.subject, f.event, receipt(recovered), page), /conflicting/);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), recovered);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.room(id))), roomsBefore);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id))), pointsBefore);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    await assertHeld(f);

    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, candidate), { membershipRemoved: true });
    const purged = await f.room(candidate);
    assert.equal(await f.point(candidate), undefined);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), recovered);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, candidate), { membershipRemoved: false });
    assert.deepEqual(await f.room(candidate), purged);
    recovered = await f.ledger().acknowledge(f.subject, f.event, receipt(recovered), candidate);
    assert.deepEqual(recovered, { ...expected, revision: expected.revision + 1,
      pendingPage: { roomIds: [], next: page.next } });
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(recovered), candidate), /conflicting/);
    const advanced = await f.ledger().advance(f.subject, f.event, receipt(recovered));
    assert.deepEqual(advanced, { ...recovered, revision: recovered.revision + 1, cursor: page.next, pendingPage: null });
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), advanced);
    for (const [index, id] of seeded.entries()) {
      assert.deepEqual(await f.point(id, f.peer), peers[index]);
      if (id === candidate) continue;
      assert.deepEqual(await f.room(id), roomsBefore[index]);
      assert.deepEqual(await f.point(id), pointsBefore[index]);
    }
    assert.equal(Object.hasOwn(advanced, 'complete'), false); assert.equal(Object.hasOwn(advanced, 'ttl'), false);
    await assertHeld(f);
  });
});


test('real competing advances of one drained page persist one cursor and resume without skipping work', async () => {
  await fixture(async (f) => {
    const seeded = [await f.seed(), await f.seed(), await f.seed()];
    for (const id of seeded) await put(f.config.locationTableName, { ...locationKey(id, f.peer), synthetic: 'peer-preserved' });
    const peers = await Promise.all(seeded.map((id) => f.point(id, f.peer)));
    let prefix = await f.stage(await f.start(), 1);
    const [first] = prefix.pendingPage.roomIds;
    assert.ok(seeded.includes(first)); assert.ok(prefix.pendingPage.next.key);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, first), { membershipRemoved: true });
    const firstPurged = await f.room(first);
    assert.equal(await f.point(first), undefined);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, first), { membershipRemoved: false });
    assert.deepEqual(await f.room(first), firstPurged);
    prefix = await f.ledger().acknowledge(f.subject, f.event, receipt(prefix), first);
    const unstaged = await f.ledger().advance(f.subject, f.event, receipt(prefix));
    assert.equal(unstaged.pendingPage, null); assert.equal(unstaged.cursor.phase, 'rooms');
    assert.ok(unstaged.cursor.key);
    const staged = await f.stage(unstaged, 1);
    assert.deepEqual(staged.cursor, unstaged.cursor);
    assert.equal(staged.pendingPage.roomIds.length, 1);
    assert.equal(staged.pendingPage.next.phase, 'rooms'); assert.ok(staged.pendingPage.next.key);
    const [candidate] = staged.pendingPage.roomIds;
    assert.ok(seeded.includes(candidate)); assert.notEqual(candidate, first);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(staged)), /conflicting/);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, candidate), { membershipRemoved: true });
    const purged = await f.room(candidate);
    assert.equal(await f.point(candidate), undefined);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), staged);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, candidate), { membershipRemoved: false });
    assert.deepEqual(await f.room(candidate), purged);
    const drained = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), candidate);
    assert.deepEqual(drained.pendingPage, { roomIds: [], next: staged.pendingPage.next });
    assert.deepEqual(drained.cursor, unstaged.cursor);
    const roomsBefore = await Promise.all(seeded.map((id) => f.room(id)));
    const pointsBefore = await Promise.all(seeded.map((id) => f.point(id)));
    const expected = { ...drained, revision: drained.revision + 1,
      cursor: staged.pendingPage.next, pendingPage: null };

    let ready, admitted = 0, forwarded = 0;
    const releases = [];
    const gates = [0, 1].map((index) => new Promise((resolve) => { releases[index] = resolve; }));
    const bothReady = new Promise((resolve) => { ready = resolve; });
    const adapters = [0, 1].map((index) => intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      assert.ok(f.clock.at < drained.lease.until);
      const attempted = command.input.TransactItems[1].Put;
      assert.equal(attempted.TableName, f.config.tableName);
      assert.equal(attempted.ExpressionAttributeValues[':revision'], drained.revision);
      assert.deepEqual(attempted.Item, expected);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), drained);
      if (++admitted === 2) ready();
      await gates[index];
      forwarded++;
      return send();
    }));
    // Both distinct adapters finish admission before either real transaction is sent.
    const attempts = adapters.map((storage) =>
      f.ledger(storage).advance(f.subject, f.event, receipt(drained)));
    const outcomes = Promise.allSettled(attempts);
    let timer, results;
    try {
      await Promise.race([bothReady, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Concurrent advance admission timed out.')), 5000);
      })]);
      assert.equal(admitted, 2); assert.equal(forwarded, 0);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), drained);
      // Commit one admitted operation before forwarding its competitor, so the
      // loser exercises the revision condition rather than a transient DB lock.
      releases[0]();
      assert.deepEqual(await attempts[0], expected);
      assert.equal(forwarded, 1);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), expected);
      releases[1]();
      results = await outcomes;
    } finally {
      clearTimeout(timer); releases.forEach((release) => release());
      // Collect both real operations even if admission/assertions fail.
      await outcomes;
    }
    assert.deepEqual(adapters.map((storage) => storage.transactions), [1, 1]);
    assert.equal(forwarded, 2);
    const successful = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result) => result.status === 'rejected');
    assert.equal(successful.length, 1); assert.equal(failed.length, 1);
    assert.deepEqual(successful[0].value, expected);
    assert.equal(failed[0].reason.name, 'TransactionCanceledException');
    assert.deepEqual(failed[0].reason.CancellationReasons.map((reason) => reason.Code), ['None', 'ConditionalCheckFailed']);

    const recovered = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(recovered, expected); assert.deepEqual(recovered.lease, drained.lease);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(drained)), /conflicting/);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    await assert.rejects(f.ledger().acknowledge(f.subject, f.event, receipt(recovered), candidate), /conflicting/);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), expected);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.room(id))), roomsBefore);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id))), pointsBefore);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    await assertHeld(f);

    let scans = 0;
    const continued = intercept((command, send) => {
      if (command.constructor.name === 'ScanCommand') {
        scans++;
        assert.equal(command.input.TableName, f.config.roomTableName);
        assert.equal(command.input.ConsistentRead, true); assert.equal(command.input.Limit, 1);
        assert.deepEqual(command.input.ExclusiveStartKey, recovered.cursor.key);
      }
      return send();
    });
    const discovery = createLifecycleDiscoveryStore({ client: continued, tableName: f.config.roomTableName,
      sessionTableName: f.config.sessionTableName, locationTableName: f.config.locationTableName });
    const nextPage = await discovery.readPage(f.subject, f.event, { cursor: recovered.cursor, limit: 1 });
    assert.equal(scans, 1); assert.equal(continued.transactions, 0);
    assert.equal(nextPage.roomIds.length, 1);
    assert.ok(seeded.includes(nextPage.roomIds[0]));
    assert.notEqual(nextPage.roomIds[0], first); assert.notEqual(nextPage.roomIds[0], candidate);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), expected);
    const restaged = await f.ledger().stagePage(f.subject, f.event, receipt(recovered), nextPage);
    assert.deepEqual(restaged, { ...expected, revision: expected.revision + 1, pendingPage: nextPage });
    assert.deepEqual(await f.ledger().read(f.subject, f.event), restaged);
    assert.deepEqual(await f.room(first), firstPurged); assert.deepEqual(await f.room(candidate), purged);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.room(id))), roomsBefore);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id))), pointsBefore);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    assert.equal(Object.hasOwn(restaged, 'complete'), false); assert.equal(Object.hasOwn(restaged, 'ttl'), false);
    await assertHeld(f);
  });
});


test('real competing terminal advances retain one ended traversal and the exact lifecycle hold', async () => {
  await fixture(async (f) => {
    const orphan = await f.seed({ orphan: true }), unrelated = await f.seed({ member: false });
    await put(f.config.locationTableName, { ...locationKey(orphan, f.peer), synthetic: 'peer-preserved' });
    const untouched = await f.room(unrelated), peerPoint = await f.point(orphan, f.peer);
    let prefix = await f.stage(await f.start(), 100);
    assert.deepEqual(prefix.pendingPage.roomIds, [unrelated]);
    assert.equal(prefix.pendingPage.next.phase, 'points'); assert.equal(prefix.pendingPage.next.key, null);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, unrelated), { membershipRemoved: false });
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, unrelated), { membershipRemoved: false });
    assert.deepEqual(await f.room(unrelated), untouched);
    prefix = await f.ledger().acknowledge(f.subject, f.event, receipt(prefix), unrelated);
    const unstaged = await f.ledger().advance(f.subject, f.event, receipt(prefix));
    assert.equal(unstaged.cursor.phase, 'points'); assert.equal(unstaged.cursor.key, null);
    const staged = await f.stage(unstaged, 100);
    assert.deepEqual(staged.pendingPage, { roomIds: [orphan], next: null });
    assert.deepEqual(staged.cursor, unstaged.cursor);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(staged)), /conflicting/);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, orphan), { membershipRemoved: false });
    assert.equal(await f.point(orphan), undefined); assert.equal(await f.room(orphan), undefined);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), staged);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, orphan), { membershipRemoved: false });
    assert.equal(await f.point(orphan), undefined); assert.equal(await f.room(orphan), undefined);
    const drained = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), orphan);
    assert.deepEqual(drained.pendingPage, { roomIds: [], next: null });
    assert.deepEqual(drained.cursor, unstaged.cursor);
    const expected = { ...drained, revision: drained.revision + 1,
      cursor: null, pendingPage: null, traversalEnded: true };

    let ready, admitted = 0, forwarded = 0;
    const releases = [];
    const gates = [0, 1].map((index) => new Promise((resolve) => { releases[index] = resolve; }));
    const bothReady = new Promise((resolve) => { ready = resolve; });
    const adapters = [0, 1].map((index) => intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      assert.ok(f.clock.at < drained.lease.until);
      const attempted = command.input.TransactItems[1].Put;
      assert.equal(attempted.TableName, f.config.tableName);
      assert.equal(attempted.ExpressionAttributeValues[':revision'], drained.revision);
      assert.deepEqual(attempted.Item, expected);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), drained);
      if (++admitted === 2) ready();
      await gates[index];
      forwarded++;
      return send();
    }));
    // Both distinct adapters finish admission before either real transaction is sent.
    const attempts = adapters.map((storage) =>
      f.ledger(storage).advance(f.subject, f.event, receipt(drained)));
    const outcomes = Promise.allSettled(attempts);
    let timer, results;
    try {
      await Promise.race([bothReady, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Concurrent advance admission timed out.')), 5000);
      })]);
      assert.equal(admitted, 2); assert.equal(forwarded, 0);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), drained);
      // Commit one admitted operation before forwarding its competitor, so the
      // loser exercises the revision condition rather than a transient DB lock.
      releases[0]();
      assert.deepEqual(await attempts[0], expected);
      assert.equal(forwarded, 1);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), expected);
      releases[1]();
      results = await outcomes;
    } finally {
      clearTimeout(timer); releases.forEach((release) => release());
      // Collect both real operations even if admission/assertions fail.
      await outcomes;
    }
    assert.deepEqual(adapters.map((storage) => storage.transactions), [1, 1]);
    assert.equal(forwarded, 2);
    const successful = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result) => result.status === 'rejected');
    assert.equal(successful.length, 1); assert.equal(failed.length, 1);
    assert.deepEqual(successful[0].value, expected);
    assert.equal(failed[0].reason.name, 'TransactionCanceledException');
    assert.deepEqual(failed[0].reason.CancellationReasons.map((reason) => reason.Code), ['None', 'ConditionalCheckFailed']);

    const recovered = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(recovered, expected); assert.deepEqual(recovered.lease, drained.lease);
    assert.equal(recovered.traversalEnded, true);
    assert.equal(recovered.cursor, null); assert.equal(recovered.pendingPage, null);
    // Both stale and latest receipts must fail every mutation after traversal ends.
    const denied = intercept((_command, send) => send());
    for (const row of [drained, recovered]) {
      await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(row)), /conflicting/);
      await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(row), orphan), /conflicting/);
      await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, receipt(row), staged.pendingPage), /conflicting/);
      await assert.rejects(f.ledger(denied).claim(f.subject, f.event, receipt(row, token())), /conflicting/);
    }
    assert.equal(denied.transactions, 0);
    // Expiry cannot turn terminal traversal into a claimable job or release the hold.
    f.clock.at = recovered.lease.until;
    await assert.rejects(f.ledger(denied).claim(f.subject, f.event, receipt(recovered, token())), /conflicting/);
    assert.equal(denied.transactions, 0);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), expected);
    assert.deepEqual(await f.room(unrelated), untouched); assert.equal(await f.point(unrelated), undefined);
    assert.equal(await f.room(orphan), undefined); assert.equal(await f.point(orphan), undefined);
    assert.deepEqual(await f.point(orphan, f.peer), peerPoint);
    assert.equal(Object.hasOwn(recovered, 'complete'), false); assert.equal(Object.hasOwn(recovered, 'ttl'), false);
    await assertHeld(f);
  });
});

for (const committed of [false, true]) test(`real terminal advance recovers after ${committed ? 'committed lost response' : 'precommit failure'} without releasing the hold`, async () => {
  await fixture(async (f) => {
    const orphan = await f.seed({ orphan: true }), unrelated = await f.seed({ member: false });
    await put(f.config.locationTableName, { ...locationKey(orphan, f.peer), synthetic: 'peer-preserved' });
    const untouched = await f.room(unrelated), peerPoint = await f.point(orphan, f.peer);
    let prefix = await f.stage(await f.start(), 100);
    assert.deepEqual(prefix.pendingPage.roomIds, [unrelated]);
    assert.equal(prefix.pendingPage.next.phase, 'points'); assert.equal(prefix.pendingPage.next.key, null);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, unrelated), { membershipRemoved: false });
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, unrelated), { membershipRemoved: false });
    prefix = await f.ledger().acknowledge(f.subject, f.event, receipt(prefix), unrelated);
    const unstaged = await f.ledger().advance(f.subject, f.event, receipt(prefix));
    assert.equal(unstaged.cursor.phase, 'points'); assert.equal(unstaged.cursor.key, null);
    const staged = await f.stage(unstaged, 100);
    assert.deepEqual(staged.pendingPage, { roomIds: [orphan], next: null });
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(staged)), /conflicting/);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, orphan), { membershipRemoved: false });
    assert.equal(await f.point(orphan), undefined); assert.equal(await f.room(orphan), undefined);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), staged);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, orphan), { membershipRemoved: false });
    assert.equal(await f.point(orphan), undefined); assert.equal(await f.room(orphan), undefined);
    const drained = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), orphan);
    assert.deepEqual(drained.pendingPage, { roomIds: [], next: null });
    assert.deepEqual(drained.cursor, unstaged.cursor);
    const expected = { ...drained, revision: drained.revision + 1,
      cursor: null, pendingPage: null, traversalEnded: true };
    const outage = new Error('Synthetic terminal advance response unavailable');
    let forwarded = 0;
    const failing = intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      assert.ok(f.clock.at < drained.lease.until);
      const attempted = command.input.TransactItems[1].Put;
      assert.equal(attempted.TableName, f.config.tableName);
      assert.equal(attempted.ExpressionAttributeValues[':revision'], drained.revision);
      assert.deepEqual(attempted.Item, expected);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), drained);
      if (committed) { forwarded++; await send(); }
      throw outage;
    });
    await assert.rejects(f.ledger(failing).advance(f.subject, f.event, receipt(drained)), (error) => error === outage);
    assert.equal(failing.transactions, 1); assert.equal(forwarded, committed ? 1 : 0);
    // A new adapter must reread durable state before deciding whether to retry.
    const recovered = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(recovered, committed ? expected : drained);
    assert.deepEqual(recovered.lease, drained.lease);
    await assertHeld(f);
    const retry = intercept((_command, send) => send());
    if (!committed) {
      assert.equal(recovered.traversalEnded, false);
      assert.deepEqual(recovered.pendingPage, { roomIds: [], next: null });
      assert.deepEqual(await f.ledger(retry).advance(f.subject, f.event, receipt(recovered)), expected);
      assert.equal(retry.transactions, 1);
    } else {
      await assert.rejects(f.ledger(retry).advance(f.subject, f.event, receipt(drained)), /conflicting/);
      assert.equal(retry.transactions, 0);
    }
    assert.deepEqual(await f.ledger().read(f.subject, f.event), expected);
    // Neither an old receipt nor the terminal revision permits further writes,
    // even after expiry. Terminal traversal is not deletion completion.
    const denied = intercept((_command, send) => send());
    for (const at of [f.clock.at, expected.lease.until]) {
      f.clock.at = at;
      for (const row of [drained, expected]) {
        await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(row)), /conflicting/);
        await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(row), orphan), /conflicting/);
        await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, receipt(row), staged.pendingPage), /conflicting/);
        await assert.rejects(f.ledger(denied).claim(f.subject, f.event, receipt(row, token())), /conflicting/);
      }
    }
    assert.equal(denied.transactions, 0);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), expected);
    assert.deepEqual(await f.room(unrelated), untouched); assert.equal(await f.point(unrelated), undefined);
    assert.equal(await f.room(orphan), undefined); assert.equal(await f.point(orphan), undefined);
    assert.deepEqual(await f.point(orphan, f.peer), peerPoint);
    assert.equal(Object.hasOwn(expected, 'complete'), false); assert.equal(Object.hasOwn(expected, 'ttl'), false);
    await assertHeld(f);
  });
});

test('real terminal precommit failure retains the drained page through expiry and a fenced lease takeover', async () => {
  await fixture(async (f) => {
    const orphan = await f.seed({ orphan: true }), unrelated = await f.seed({ member: false });
    await put(f.config.locationTableName, { ...locationKey(orphan, f.peer), synthetic: 'peer-preserved' });
    const untouched = await f.room(unrelated), peerPoint = await f.point(orphan, f.peer);
    let prefix = await f.stage(await f.start(), 100);
    assert.deepEqual(prefix.pendingPage.roomIds, [unrelated]);
    assert.equal(prefix.pendingPage.next.phase, 'points'); assert.equal(prefix.pendingPage.next.key, null);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, unrelated), { membershipRemoved: false });
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, unrelated), { membershipRemoved: false });
    prefix = await f.ledger().acknowledge(f.subject, f.event, receipt(prefix), unrelated);
    const unstaged = await f.ledger().advance(f.subject, f.event, receipt(prefix));
    assert.equal(unstaged.cursor.phase, 'points'); assert.equal(unstaged.cursor.key, null);
    const staged = await f.stage(unstaged, 100);
    assert.deepEqual(staged.pendingPage, { roomIds: [orphan], next: null });
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(staged)), /conflicting/);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, orphan), { membershipRemoved: false });
    assert.equal(await f.point(orphan), undefined); assert.equal(await f.room(orphan), undefined);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), staged);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, orphan), { membershipRemoved: false });
    assert.equal(await f.point(orphan), undefined); assert.equal(await f.room(orphan), undefined);
    const drained = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), orphan);
    assert.deepEqual(drained.pendingPage, { roomIds: [], next: null });
    assert.deepEqual(drained.cursor, unstaged.cursor);
    const outage = new Error('Synthetic terminal advance unavailable before commit');
    const failing = intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      assert.ok(f.clock.at < drained.lease.until);
      const attempted = command.input.TransactItems[1].Put;
      assert.equal(attempted.TableName, f.config.tableName);
      assert.equal(attempted.ExpressionAttributeValues[':revision'], drained.revision);
      assert.deepEqual(attempted.Item, { ...drained, revision: drained.revision + 1,
        cursor: null, pendingPage: null, traversalEnded: true });
      // The real transaction is not forwarded; only this transport failure is injected.
      throw outage;
    });
    await assert.rejects(f.ledger(failing).advance(f.subject, f.event, receipt(drained)), (error) => error === outage);
    assert.equal(failing.transactions, 1);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), drained);
    await assertHeld(f);

    f.clock.at = drained.lease.until;
    // A fresh adapter must recover the exact retained page before claiming it.
    const loaded = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(loaded, drained); assert.equal(loaded.traversalEnded, false);
    const denied = intercept((_command, send) => send());
    await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(loaded)), /conflicting/);
    await assert.rejects(f.ledger(denied).claim(f.subject, f.event, receipt(loaded)), /conflicting/);
    assert.equal(denied.transactions, 0);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), drained);

    const takeoverReceipt = receipt(loaded, token());
    assert.notEqual(takeoverReceipt.token, drained.lease.token);
    const expectedClaim = { ...drained, revision: drained.revision + 1,
      lease: { token: takeoverReceipt.token, until: f.clock.at + 30_000 } };
    const claiming = intercept((command, send) => {
      if (command.constructor.name === 'TransactWriteCommand') {
        const attempted = command.input.TransactItems[1].Put;
        assert.equal(attempted.TableName, f.config.tableName);
        assert.equal(attempted.ExpressionAttributeValues[':revision'], drained.revision);
        assert.deepEqual(attempted.Item, expectedClaim);
      }
      return send();
    });
    assert.deepEqual(await f.ledger(claiming).claim(f.subject, f.event, takeoverReceipt), expectedClaim);
    assert.equal(claiming.transactions, 1);
    const claimed = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(claimed, expectedClaim);
    // Reject both the stale revision and an old token paired with the new revision.
    for (const old of [receipt(drained), receipt(claimed, drained.lease.token)]) {
      await assert.rejects(f.ledger(denied).advance(f.subject, f.event, old), /conflicting/);
      await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, old, orphan), /conflicting/);
      await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, old, staged.pendingPage), /conflicting/);
    }
    await assert.rejects(f.ledger(denied).claim(f.subject, f.event, takeoverReceipt), /conflicting/);
    await assert.rejects(f.ledger(denied).claim(f.subject, f.event, receipt(claimed, token())), /conflicting/);
    assert.equal(denied.transactions, 0);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), expectedClaim);
    assert.deepEqual(await f.room(unrelated), untouched);
    assert.deepEqual(await f.point(orphan, f.peer), peerPoint); await assertHeld(f);

    const expected = { ...claimed, revision: claimed.revision + 1,
      cursor: null, pendingPage: null, traversalEnded: true };
    const retry = intercept((command, send) => {
      if (command.constructor.name === 'TransactWriteCommand') {
        const attempted = command.input.TransactItems[1].Put;
        assert.equal(attempted.TableName, f.config.tableName);
        assert.equal(attempted.ExpressionAttributeValues[':revision'], claimed.revision);
        assert.deepEqual(attempted.Item, expected);
      }
      return send();
    });
    assert.deepEqual(await f.ledger(retry).advance(f.subject, f.event, receipt(claimed)), expected);
    assert.equal(retry.transactions, 1);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), expected);
    for (const at of [f.clock.at, expected.lease.until]) {
      f.clock.at = at;
      for (const row of [drained, claimed, expected]) {
        await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(row)), /conflicting/);
        await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(row), orphan), /conflicting/);
        await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, receipt(row), staged.pendingPage), /conflicting/);
        await assert.rejects(f.ledger(denied).claim(f.subject, f.event, receipt(row, token())), /conflicting/);
      }
    }
    assert.equal(denied.transactions, 0); assert.equal(retry.transactions, 1);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), expected);
    assert.deepEqual(await f.room(unrelated), untouched); assert.equal(await f.point(unrelated), undefined);
    assert.equal(await f.room(orphan), undefined); assert.equal(await f.point(orphan), undefined);
    assert.deepEqual(await f.point(orphan, f.peer), peerPoint);
    assert.equal(Object.hasOwn(expected, 'complete'), false); assert.equal(Object.hasOwn(expected, 'ttl'), false);
    await assertHeld(f);
  });
});

test('real terminal takeover claim loses its hold condition after in-flight foreign-event replacement', async () => {
  await fixture(async (f) => {
    const orphan = await f.seed({ orphan: true }), unrelated = await f.seed({ member: false });
    await put(f.config.locationTableName, { ...locationKey(orphan, f.peer), synthetic: 'peer-preserved' });
    const untouched = await f.room(unrelated), peerPoint = await f.point(orphan, f.peer);
    let prefix = await f.stage(await f.start(), 100);
    assert.deepEqual(prefix.pendingPage.roomIds, [unrelated]);
    assert.equal(prefix.pendingPage.next.phase, 'points'); assert.equal(prefix.pendingPage.next.key, null);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, unrelated), { membershipRemoved: false });
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, unrelated), { membershipRemoved: false });
    prefix = await f.ledger().acknowledge(f.subject, f.event, receipt(prefix), unrelated);
    const unstaged = await f.ledger().advance(f.subject, f.event, receipt(prefix));
    assert.equal(unstaged.cursor.phase, 'points'); assert.equal(unstaged.cursor.key, null);
    const staged = await f.stage(unstaged, 100);
    assert.deepEqual(staged.pendingPage, { roomIds: [orphan], next: null });
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(staged)), /conflicting/);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, orphan), { membershipRemoved: false });
    assert.equal(await f.point(orphan), undefined); assert.equal(await f.room(orphan), undefined);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), staged);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, orphan), { membershipRemoved: false });
    assert.equal(await f.point(orphan), undefined); assert.equal(await f.room(orphan), undefined);
    const drained = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), orphan);
    assert.deepEqual(drained.pendingPage, { roomIds: [], next: null });
    assert.deepEqual(drained.cursor, unstaged.cursor);
    f.clock.at = drained.lease.until;
    const loaded = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(loaded, drained); assert.equal(loaded.traversalEnded, false);
    const takeoverReceipt = receipt(loaded, token());
    assert.notEqual(takeoverReceipt.token, drained.lease.token);
    const expectedClaim = { ...drained, revision: drained.revision + 1,
      lease: { token: takeoverReceipt.token, until: f.clock.at + 30_000 } };
    const replacement = structuredClone(f.held);
    replacement.lifecycleHold.binding = hash(JSON.stringify([f.subject, randomUUID(), f.config.sessionTableName]));
    assert.notEqual(replacement.lifecycleHold.binding, f.held.lifecycleHold.binding);
    const snapshot = async () => ({
      progress: await read(f.config.tableName, { pk: drained.pk }),
      metadata: await f.room(unrelated), orphan: await f.room(orphan),
      point: await f.point(orphan), unrelatedPoint: await f.point(unrelated),
      peer: await f.point(orphan, f.peer),
    });
    const before = await snapshot();
    let forwarded = false;
    const replacing = intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      assert.equal(command.input.TransactItems.length, 2);
      const hold = command.input.TransactItems[0].ConditionCheck;
      assert.equal(hold.TableName, f.config.sessionTableName);
      assert.deepEqual(hold.Key, userKey(f.subject));
      assert.deepEqual(hold.ExpressionAttributeValues[':hold'], f.held.lifecycleHold);
      const attempted = command.input.TransactItems[1].Put;
      assert.equal(attempted.TableName, f.config.tableName);
      assert.equal(attempted.ExpressionAttributeValues[':revision'], drained.revision);
      assert.deepEqual(attempted.Item, expectedClaim);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), drained);
      // Admission has read the original hold. Only the isolated fixture replaces
      // it, directly before forwarding the real transaction; no deferred worker.
      await put(f.config.sessionTableName, replacement);
      assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);
      forwarded = true;
      return send();
    });
    await assert.rejects(f.ledger(replacing).claim(f.subject, f.event, takeoverReceipt), (error) => {
      assert.equal(error.name, 'TransactionCanceledException');
      assert.deepEqual(error.CancellationReasons.map((reason) => reason.Code), ['ConditionalCheckFailed', 'None']);
      return true;
    });
    assert.equal(replacing.transactions, 1); assert.equal(forwarded, true);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);
    const denied = intercept((_command, send) => send());
    await assert.rejects(f.ledger(denied).read(f.subject, f.event), /lifecycle hold/);
    await assert.rejects(f.ledger(denied).claim(f.subject, f.event, takeoverReceipt), /lifecycle hold/);
    assert.equal(denied.transactions, 0);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);

    // Test-only restoration of the identical original row. No production
    // hold replacement/release API or durable cross-call incarnation pin exists.
    await put(f.config.sessionTableName, f.held);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), drained);
    const claiming = intercept((_command, send) => send());
    assert.deepEqual(await f.ledger(claiming).claim(f.subject, f.event, takeoverReceipt), expectedClaim);
    assert.equal(claiming.transactions, 1);
    const claimed = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(claimed, expectedClaim);
    for (const old of [receipt(drained), receipt(claimed, drained.lease.token)]) {
      await assert.rejects(f.ledger(denied).advance(f.subject, f.event, old), /conflicting/);
      await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, old, orphan), /conflicting/);
      await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, old, staged.pendingPage), /conflicting/);
    }
    assert.equal(denied.transactions, 0);
    const expected = { ...claimed, revision: claimed.revision + 1,
      cursor: null, pendingPage: null, traversalEnded: true };
    const advancing = intercept((command, send) => {
      if (command.constructor.name === 'TransactWriteCommand') {
        const attempted = command.input.TransactItems[1].Put;
        assert.equal(attempted.ExpressionAttributeValues[':revision'], claimed.revision);
        assert.deepEqual(attempted.Item, expected);
      }
      return send();
    });
    assert.deepEqual(await f.ledger(advancing).advance(f.subject, f.event, receipt(claimed)), expected);
    assert.equal(advancing.transactions, 1);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), expected);
    for (const at of [f.clock.at, expected.lease.until]) {
      f.clock.at = at;
      for (const row of [drained, claimed, expected]) {
        await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(row)), /conflicting/);
        await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(row), orphan), /conflicting/);
        await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, receipt(row), staged.pendingPage), /conflicting/);
        await assert.rejects(f.ledger(denied).claim(f.subject, f.event, receipt(row, token())), /conflicting/);
      }
    }
    assert.equal(denied.transactions, 0); assert.equal(claiming.transactions, 1); assert.equal(advancing.transactions, 1);
    assert.deepEqual(await snapshot(), { ...before, progress: expected });
    assert.deepEqual(await f.room(unrelated), untouched); assert.deepEqual(await f.point(orphan, f.peer), peerPoint);
    assert.equal(Object.hasOwn(expected, 'complete'), false); assert.equal(Object.hasOwn(expected, 'ttl'), false);
    await assertHeld(f);
  });
});

test('real terminal advance loses its hold condition after in-flight foreign-event replacement', async () => {
  await fixture(async (f) => {
    const orphan = await f.seed({ orphan: true }), unrelated = await f.seed({ member: false });
    await put(f.config.locationTableName, { ...locationKey(orphan, f.peer), synthetic: 'peer-preserved' });
    const untouched = await f.room(unrelated), peerPoint = await f.point(orphan, f.peer);
    let prefix = await f.stage(await f.start(), 100);
    assert.deepEqual(prefix.pendingPage.roomIds, [unrelated]);
    assert.equal(prefix.pendingPage.next.phase, 'points'); assert.equal(prefix.pendingPage.next.key, null);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, unrelated), { membershipRemoved: false });
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, unrelated), { membershipRemoved: false });
    prefix = await f.ledger().acknowledge(f.subject, f.event, receipt(prefix), unrelated);
    const unstaged = await f.ledger().advance(f.subject, f.event, receipt(prefix));
    assert.equal(unstaged.cursor.phase, 'points'); assert.equal(unstaged.cursor.key, null);
    const staged = await f.stage(unstaged, 100);
    assert.deepEqual(staged.pendingPage, { roomIds: [orphan], next: null });
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(staged)), /conflicting/);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, orphan), { membershipRemoved: false });
    assert.equal(await f.point(orphan), undefined); assert.equal(await f.room(orphan), undefined);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), staged);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, orphan), { membershipRemoved: false });
    assert.equal(await f.point(orphan), undefined); assert.equal(await f.room(orphan), undefined);
    const drained = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), orphan);
    assert.deepEqual(drained.pendingPage, { roomIds: [], next: null });
    assert.deepEqual(drained.cursor, unstaged.cursor);
    assert.ok(f.clock.at < drained.lease.until);
    const loaded = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(loaded, drained); assert.equal(loaded.traversalEnded, false);
    const expected = { ...drained, revision: drained.revision + 1,
      cursor: null, pendingPage: null, traversalEnded: true };
    const replacement = structuredClone(f.held);
    replacement.lifecycleHold.binding = hash(JSON.stringify([f.subject, randomUUID(), f.config.sessionTableName]));
    assert.notEqual(replacement.lifecycleHold.binding, f.held.lifecycleHold.binding);
    const snapshot = async () => ({
      progress: await read(f.config.tableName, { pk: drained.pk }),
      metadata: await f.room(unrelated), orphan: await f.room(orphan),
      point: await f.point(orphan), unrelatedPoint: await f.point(unrelated),
      peer: await f.point(orphan, f.peer),
    });
    const before = await snapshot();
    let forwarded = false;
    const replacing = intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      assert.equal(command.input.TransactItems.length, 2);
      const hold = command.input.TransactItems[0].ConditionCheck;
      assert.equal(hold.TableName, f.config.sessionTableName);
      assert.deepEqual(hold.Key, userKey(f.subject));
      assert.deepEqual(hold.ExpressionAttributeValues[':hold'], f.held.lifecycleHold);
      const attempted = command.input.TransactItems[1].Put;
      assert.equal(attempted.TableName, f.config.tableName);
      assert.equal(attempted.ExpressionAttributeValues[':revision'], drained.revision);
      assert.deepEqual(attempted.Item, expected);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), drained);
      // Admission has read the original hold. Only the isolated fixture replaces
      // it, directly before forwarding the real transaction; no deferred worker.
      await put(f.config.sessionTableName, replacement);
      assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);
      forwarded = true;
      return send();
    });
    await assert.rejects(f.ledger(replacing).advance(f.subject, f.event, receipt(loaded)), (error) => {
      assert.equal(error.name, 'TransactionCanceledException');
      assert.deepEqual(error.CancellationReasons.map((reason) => reason.Code), ['ConditionalCheckFailed', 'None']);
      return true;
    });
    assert.equal(replacing.transactions, 1); assert.equal(forwarded, true);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);
    const denied = intercept((_command, send) => send());
    await assert.rejects(f.ledger(denied).read(f.subject, f.event), /lifecycle hold/);
    await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(drained)), /lifecycle hold/);
    assert.equal(denied.transactions, 0);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);

    // Test-only restoration of the identical original row. No production
    // hold replacement/release API or durable cross-call incarnation pin exists.
    await put(f.config.sessionTableName, f.held);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), drained);
    const recovered = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(recovered, drained);
    const advancing = intercept((command, send) => {
      if (command.constructor.name === 'TransactWriteCommand') {
        const attempted = command.input.TransactItems[1].Put;
        assert.equal(attempted.ExpressionAttributeValues[':revision'], recovered.revision);
        assert.deepEqual(attempted.Item, expected);
      }
      return send();
    });
    assert.deepEqual(await f.ledger(advancing).advance(f.subject, f.event, receipt(recovered)), expected);
    assert.equal(advancing.transactions, 1);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), expected);
    for (const at of [f.clock.at, expected.lease.until]) {
      f.clock.at = at;
      for (const row of [drained, expected]) {
        await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(row)), /conflicting/);
        await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(row), orphan), /conflicting/);
        await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, receipt(row), staged.pendingPage), /conflicting/);
        await assert.rejects(f.ledger(denied).claim(f.subject, f.event, receipt(row, token())), /conflicting/);
      }
    }
    assert.equal(denied.transactions, 0); assert.equal(advancing.transactions, 1);
    assert.deepEqual(await snapshot(), { ...before, progress: expected });
    assert.deepEqual(await f.room(unrelated), untouched); assert.deepEqual(await f.point(orphan, f.peer), peerPoint);
    assert.equal(Object.hasOwn(expected, 'complete'), false); assert.equal(Object.hasOwn(expected, 'ttl'), false);
    await assertHeld(f);
  });
});

test('real competing terminal lease takeovers preserve one drained page and fence the losing token', async () => {
  await fixture(async (f) => {
    const orphan = await f.seed({ orphan: true }), unrelated = await f.seed({ member: false });
    await put(f.config.locationTableName, { ...locationKey(orphan, f.peer), synthetic: 'peer-preserved' });
    const untouched = await f.room(unrelated), peerPoint = await f.point(orphan, f.peer);
    let prefix = await f.stage(await f.start(), 100);
    assert.deepEqual(prefix.pendingPage.roomIds, [unrelated]);
    assert.equal(prefix.pendingPage.next.phase, 'points'); assert.equal(prefix.pendingPage.next.key, null);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, unrelated), { membershipRemoved: false });
    prefix = await f.ledger().acknowledge(f.subject, f.event, receipt(prefix), unrelated);
    const unstaged = await f.ledger().advance(f.subject, f.event, receipt(prefix));
    const staged = await f.stage(unstaged, 100);
    assert.deepEqual(staged.pendingPage, { roomIds: [orphan], next: null });
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, orphan), { membershipRemoved: false });
    assert.equal(await f.point(orphan), undefined); assert.equal(await f.room(orphan), undefined);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), staged);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, orphan), { membershipRemoved: false });
    const drained = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), orphan);
    assert.deepEqual(drained.pendingPage, { roomIds: [], next: null });
    assert.deepEqual(drained.cursor, unstaged.cursor);
    f.clock.at = drained.lease.until;
    const loaded = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(loaded, drained); assert.equal(loaded.traversalEnded, false);
    const receipts = [receipt(loaded, token()), receipt(loaded, token())];
    assert.notEqual(receipts[0].token, receipts[1].token);
    for (const candidate of receipts) assert.notEqual(candidate.token, drained.lease.token);
    const expectedClaims = receipts.map((candidate) => ({ ...drained, revision: drained.revision + 1,
      lease: { token: candidate.token, until: f.clock.at + 30_000 } }));

    let ready, admitted = 0, forwarded = 0;
    const releases = [];
    const gates = [0, 1].map((index) => new Promise((resolve) => { releases[index] = resolve; }));
    const bothReady = new Promise((resolve) => { ready = resolve; });
    const adapters = [0, 1].map((index) => intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      assert.equal(f.clock.at, drained.lease.until);
      const [hold, progress] = command.input.TransactItems;
      assert.deepEqual(hold.ConditionCheck.ExpressionAttributeValues[':hold'], f.held.lifecycleHold);
      assert.equal(progress.Put.TableName, f.config.tableName);
      assert.equal(progress.Put.ExpressionAttributeValues[':revision'], drained.revision);
      assert.deepEqual(progress.Put.Item, expectedClaims[index]);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), drained);
      if (++admitted === 2) ready();
      await gates[index];
      forwarded++;
      return send();
    }));
    const attempts = adapters.map((storage, index) =>
      f.ledger(storage).claim(f.subject, f.event, receipts[index]));
    const outcomes = Promise.allSettled(attempts);
    let timer, results;
    try {
      await Promise.race([bothReady, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Concurrent takeover admission timed out.')), 5000);
      })]);
      assert.equal(admitted, 2); assert.equal(forwarded, 0);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), drained);
      // Both loaded the expired revision. Order real sends to exercise the
      // ledger condition rather than a transient DynamoDB transaction lock.
      releases[0]();
      assert.deepEqual(await attempts[0], expectedClaims[0]);
      assert.equal(forwarded, 1);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), expectedClaims[0]);
      releases[1]();
      results = await outcomes;
    } finally {
      clearTimeout(timer); releases.forEach((release) => release());
      await outcomes;
    }
    assert.deepEqual(adapters.map((storage) => storage.transactions), [1, 1]);
    assert.equal(forwarded, 2);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.name, 'TransactionCanceledException');
    assert.deepEqual(results[1].reason.CancellationReasons.map((reason) => reason.Code), ['None', 'ConditionalCheckFailed']);
    const recovered = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(recovered, expectedClaims[0]);
    assert.deepEqual(recovered.pendingPage, drained.pendingPage); assert.deepEqual(recovered.cursor, drained.cursor);
    assert.equal(recovered.traversalEnded, false);
    assert.deepEqual(await read(f.config.tableName, { pk: drained.pk }), recovered);
    assert.deepEqual(await f.room(unrelated), untouched);
    assert.deepEqual(await f.point(orphan, f.peer), peerPoint); await assertHeld(f);

    const denied = intercept((_command, send) => send());
    // Fence stale revisions and both old/losing tokens paired with the new revision.
    const stale = [receipt(drained), ...receipts,
      receipt(recovered, drained.lease.token), receipt(recovered, receipts[1].token)];
    for (const old of stale) {
      await assert.rejects(f.ledger(denied).advance(f.subject, f.event, old), /conflicting/);
      await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, old, orphan), /conflicting/);
      await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, old, staged.pendingPage), /conflicting/);
    }
    for (const candidate of [...receipts, receipt(recovered, receipts[1].token), receipt(recovered, token())])
      await assert.rejects(f.ledger(denied).claim(f.subject, f.event, candidate), /conflicting/);
    assert.equal(denied.transactions, 0);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), recovered);

    const expected = { ...recovered, revision: recovered.revision + 1,
      cursor: null, pendingPage: null, traversalEnded: true };
    const advancing = intercept((command, send) => {
      if (command.constructor.name === 'TransactWriteCommand') {
        const attempted = command.input.TransactItems[1].Put;
        assert.equal(attempted.TableName, f.config.tableName);
        assert.equal(attempted.ExpressionAttributeValues[':revision'], recovered.revision);
        assert.deepEqual(attempted.Item, expected);
      }
      return send();
    });
    assert.deepEqual(await f.ledger(advancing).advance(f.subject, f.event, receipt(recovered)), expected);
    assert.equal(advancing.transactions, 1);
    for (const at of [f.clock.at, expected.lease.until]) {
      f.clock.at = at;
      for (const row of [drained, ...expectedClaims, expected]) {
        await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(row)), /conflicting/);
        await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(row), orphan), /conflicting/);
        await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, receipt(row), staged.pendingPage), /conflicting/);
        await assert.rejects(f.ledger(denied).claim(f.subject, f.event, receipt(row, token())), /conflicting/);
      }
    }
    assert.equal(denied.transactions, 0); assert.equal(advancing.transactions, 1);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), expected);
    assert.deepEqual(await read(f.config.tableName, { pk: drained.pk }), expected);
    assert.deepEqual(await f.room(unrelated), untouched); assert.equal(await f.point(unrelated), undefined);
    assert.equal(await f.room(orphan), undefined); assert.equal(await f.point(orphan), undefined);
    assert.deepEqual(await f.point(orphan, f.peer), peerPoint);
    assert.equal(Object.hasOwn(expected, 'complete'), false); assert.equal(Object.hasOwn(expected, 'ttl'), false);
    await assertHeld(f);
  });
});

test('real competing partial-page lease takeovers retain the ordered suffix until confirmed recovery', async () => {
  await fixture(async (f) => {
    const seeded = [await f.seed(), await f.seed(), await f.seed()];
    for (const id of seeded)
      await put(f.config.locationTableName, { ...locationKey(id, f.peer), synthetic: 'peer-preserved' });
    const staged = await f.stage(await f.start(), 100);
    assert.deepEqual(new Set(staged.pendingPage.roomIds), new Set(seeded));
    assert.equal(staged.pendingPage.roomIds.length, 3);
    assert.equal(staged.pendingPage.next.phase, 'points'); assert.equal(staged.pendingPage.next.key, null);
    const [first, second, third] = staged.pendingPage.roomIds;
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, first), { membershipRemoved: true });
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, first), { membershipRemoved: false });
    const firstPurged = await f.room(first);
    const partial = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), first);
    assert.deepEqual(partial.pendingPage, { roomIds: [second, third], next: staged.pendingPage.next });
    assert.deepEqual(partial.cursor, staged.cursor);
    // Added after discovery: unrelated metadata is outside the retained page.
    const unrelated = await f.seed({ member: false }), untouched = await f.room(unrelated);
    const suffixRooms = await Promise.all([second, third].map((id) => f.room(id)));
    const suffixPoints = await Promise.all([second, third].map((id) => f.point(id)));
    const peers = await Promise.all(seeded.map((id) => f.point(id, f.peer)));
    f.clock.at = partial.lease.until;
    const loaded = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(loaded, partial);
    const receipts = [receipt(loaded, token()), receipt(loaded, token())];
    assert.notEqual(receipts[0].token, receipts[1].token);
    for (const candidate of receipts) assert.notEqual(candidate.token, partial.lease.token);
    const expectedClaims = receipts.map((candidate) => ({ ...partial, revision: partial.revision + 1,
      lease: { token: candidate.token, until: f.clock.at + 30_000 } }));

    let ready, admitted = 0, forwarded = 0;
    const releases = [];
    const gates = [0, 1].map((index) => new Promise((resolve) => { releases[index] = resolve; }));
    const bothReady = new Promise((resolve) => { ready = resolve; });
    const adapters = [0, 1].map((index) => intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      assert.equal(f.clock.at, partial.lease.until);
      const [hold, progress] = command.input.TransactItems;
      assert.deepEqual(hold.ConditionCheck.ExpressionAttributeValues[':hold'], f.held.lifecycleHold);
      assert.equal(progress.Put.TableName, f.config.tableName);
      assert.equal(progress.Put.ExpressionAttributeValues[':revision'], partial.revision);
      assert.deepEqual(progress.Put.Item, expectedClaims[index]);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), partial);
      if (++admitted === 2) ready();
      await gates[index];
      forwarded++;
      return send();
    }));
    const attempts = adapters.map((storage, index) => f.ledger(storage).claim(f.subject, f.event, receipts[index]));
    const outcomes = Promise.allSettled(attempts);
    let timer, results;
    try {
      await Promise.race([bothReady, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Concurrent partial-page takeover admission timed out.')), 5000);
      })]);
      assert.equal(admitted, 2); assert.equal(forwarded, 0);
      assert.deepEqual(await read(f.config.tableName, { pk: partial.pk }), partial);
      // Order real sends after both claims have loaded the same expired revision.
      releases[0]();
      assert.deepEqual(await attempts[0], expectedClaims[0]);
      assert.equal(forwarded, 1);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), expectedClaims[0]);
      releases[1]();
      results = await outcomes;
    } finally {
      clearTimeout(timer); releases.forEach((release) => release());
      await outcomes;
    }
    assert.deepEqual(adapters.map((storage) => storage.transactions), [1, 1]);
    assert.equal(forwarded, 2);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.name, 'TransactionCanceledException');
    assert.deepEqual(results[1].reason.CancellationReasons.map((reason) => reason.Code), ['None', 'ConditionalCheckFailed']);
    let recovered = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(recovered, expectedClaims[0]);
    assert.deepEqual(await read(f.config.tableName, { pk: partial.pk }), recovered);
    assert.deepEqual(recovered.pendingPage, partial.pendingPage); assert.deepEqual(recovered.cursor, partial.cursor);
    assert.deepEqual(await Promise.all([second, third].map((id) => f.room(id))), suffixRooms);
    assert.deepEqual(await Promise.all([second, third].map((id) => f.point(id))), suffixPoints);
    assert.deepEqual(await f.room(first), firstPurged); assert.equal(await f.point(first), undefined);
    assert.deepEqual(await f.room(unrelated), untouched); await assertHeld(f);

    const denied = intercept((_command, send) => send());
    const stale = [receipt(staged), receipt(partial), ...receipts,
      receipt(recovered, partial.lease.token), receipt(recovered, receipts[1].token)];
    for (const old of stale) {
      await assert.rejects(f.ledger(denied).advance(f.subject, f.event, old), /conflicting/);
      await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, old, second), /conflicting/);
      await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, old, staged.pendingPage), /conflicting/);
    }
    for (const candidate of [...receipts, receipt(recovered, receipts[1].token), receipt(recovered, token())])
      await assert.rejects(f.ledger(denied).claim(f.subject, f.event, candidate), /conflicting/);
    await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    for (const id of [first, third])
      await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(recovered), id), /conflicting/);
    assert.equal(denied.transactions, 0);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), recovered);

    const winningLease = structuredClone(recovered.lease);
    for (const [index, id] of [second, third].entries()) {
      assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, id), { membershipRemoved: true });
      const purged = await f.room(id);
      assert.equal(purged.revision, suffixRooms[index].revision + 1);
      assert.equal(await f.point(id), undefined);
      assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, id), { membershipRemoved: false });
      assert.deepEqual(await f.room(id), purged);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), recovered);
      const previous = recovered;
      recovered = await f.ledger().acknowledge(f.subject, f.event, receipt(previous), id);
      assert.equal(recovered.revision, previous.revision + 1);
      assert.deepEqual(recovered.pendingPage, { roomIds: index === 0 ? [third] : [], next: staged.pendingPage.next });
      assert.deepEqual(recovered.cursor, partial.cursor); assert.deepEqual(recovered.lease, winningLease);
      await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(previous), id), /conflicting/);
      if (index === 0)
        await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    }
    const expected = { ...recovered, revision: recovered.revision + 1,
      cursor: staged.pendingPage.next, pendingPage: null, traversalEnded: false };
    const advancing = intercept((command, send) => {
      if (command.constructor.name === 'TransactWriteCommand') {
        const attempted = command.input.TransactItems[1].Put;
        assert.equal(attempted.TableName, f.config.tableName);
        assert.equal(attempted.ExpressionAttributeValues[':revision'], recovered.revision);
        assert.deepEqual(attempted.Item, expected);
      }
      return send();
    });
    assert.deepEqual(await f.ledger(advancing).advance(f.subject, f.event, receipt(recovered)), expected);
    assert.equal(advancing.transactions, 1);
    await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(expected)), /conflicting/);
    assert.equal(denied.transactions, 0);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), expected);
    assert.deepEqual(await read(f.config.tableName, { pk: partial.pk }), expected);
    assert.deepEqual(await f.room(first), firstPurged);
    for (const id of seeded) assert.equal(await f.point(id), undefined);
    assert.deepEqual(await Promise.all(seeded.map((id) => f.point(id, f.peer))), peers);
    assert.deepEqual(await f.room(unrelated), untouched); assert.equal(await f.point(unrelated), undefined);
    assert.equal(Object.hasOwn(expected, 'complete'), false); assert.equal(Object.hasOwn(expected, 'ttl'), false);
    await assertHeld(f);
  });
});

test('real partial-page takeover loses its hold condition after in-flight foreign-event replacement', async () => {
  await fixture(async (f) => {
    const seeded = [await f.seed(), await f.seed(), await f.seed()];
    for (const id of seeded)
      await put(f.config.locationTableName, { ...locationKey(id, f.peer), synthetic: 'peer-preserved' });
    const staged = await f.stage(await f.start(), 100);
    assert.deepEqual(new Set(staged.pendingPage.roomIds), new Set(seeded));
    assert.equal(staged.pendingPage.roomIds.length, 3);
    assert.equal(staged.pendingPage.next.phase, 'points'); assert.equal(staged.pendingPage.next.key, null);
    const [first, second, third] = staged.pendingPage.roomIds;
    const ordered = [first, second, third];
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, first), { membershipRemoved: true });
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, first), { membershipRemoved: false });
    const partial = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), first);
    assert.deepEqual(partial.pendingPage, { roomIds: [second, third], next: staged.pendingPage.next });
    assert.deepEqual(partial.cursor, staged.cursor);
    // Seed unrelated metadata after discovery so it is outside the retained page.
    const unrelated = await f.seed({ member: false });
    const snapshot = async () => ({
      progress: await read(f.config.tableName, { pk: partial.pk }),
      rooms: await Promise.all(ordered.map((id) => f.room(id))),
      points: await Promise.all(ordered.map((id) => f.point(id))),
      peers: await Promise.all(ordered.map((id) => f.point(id, f.peer))),
      unrelated: await f.room(unrelated), unrelatedPoint: await f.point(unrelated),
    });
    const before = await snapshot();
    assert.equal(before.points[0], undefined);
    f.clock.at = partial.lease.until;
    const loaded = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(loaded, partial);
    const takeoverReceipt = receipt(loaded, token());
    assert.notEqual(takeoverReceipt.token, partial.lease.token);
    const expectedClaim = { ...partial, revision: partial.revision + 1,
      lease: { token: takeoverReceipt.token, until: f.clock.at + 30_000 } };
    const replacement = structuredClone(f.held);
    replacement.lifecycleHold.binding = hash(JSON.stringify([f.subject, randomUUID(), f.config.sessionTableName]));
    assert.notEqual(replacement.lifecycleHold.binding, f.held.lifecycleHold.binding);
    let forwarded = false;
    const replacing = intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      assert.equal(command.input.TransactItems.length, 2);
      const hold = command.input.TransactItems[0].ConditionCheck;
      assert.equal(hold.TableName, f.config.sessionTableName);
      assert.deepEqual(hold.Key, userKey(f.subject));
      assert.deepEqual(hold.ExpressionAttributeValues[':hold'], f.held.lifecycleHold);
      const attempted = command.input.TransactItems[1].Put;
      assert.equal(attempted.TableName, f.config.tableName);
      assert.equal(attempted.ExpressionAttributeValues[':revision'], partial.revision);
      assert.deepEqual(attempted.Item, expectedClaim);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), partial);
      // Only the isolated fixture replaces the hold after admission. The real
      // transaction must reject it; no synthetic database result or worker.
      await put(f.config.sessionTableName, replacement);
      assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);
      forwarded = true;
      return send();
    });
    await assert.rejects(f.ledger(replacing).claim(f.subject, f.event, takeoverReceipt), (error) => {
      assert.equal(error.name, 'TransactionCanceledException');
      assert.deepEqual(error.CancellationReasons.map((reason) => reason.Code), ['ConditionalCheckFailed', 'None']);
      return true;
    });
    assert.equal(replacing.transactions, 1); assert.equal(forwarded, true);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);
    const denied = intercept((_command, send) => send());
    await assert.rejects(f.ledger(denied).read(f.subject, f.event), /lifecycle hold/);
    await assert.rejects(f.ledger(denied).claim(f.subject, f.event, takeoverReceipt), /lifecycle hold/);
    for (const id of [second, third])
      await assert.rejects(f.purge(denied).purgeRoom(f.subject, f.event, id), /lifecycle hold|not authorised/);
    await assert.rejects(f.discovery().readPage(f.subject, f.event, { cursor: partial.cursor, limit: 100 }), /lifecycle hold|not authorised/);
    assert.equal(denied.transactions, 0);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);

    // Identical fixture-only restoration is not a production release/readmission
    // API or durable cross-call hold-incarnation fence.
    await put(f.config.sessionTableName, f.held);
    const reread = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(reread, partial);
    const freshReceipt = receipt(reread, token());
    assert.notEqual(freshReceipt.token, takeoverReceipt.token);
    assert.notEqual(freshReceipt.token, partial.lease.token);
    let recovered = await f.ledger().claim(f.subject, f.event, freshReceipt);
    assert.deepEqual(recovered, { ...partial, revision: partial.revision + 1,
      lease: { token: freshReceipt.token, until: f.clock.at + 30_000 } });
    assert.deepEqual(await snapshot(), { ...before, progress: recovered });
    for (const old of [receipt(staged), receipt(partial), takeoverReceipt,
      receipt(recovered, partial.lease.token), receipt(recovered, takeoverReceipt.token)]) {
      await assert.rejects(f.ledger(denied).advance(f.subject, f.event, old), /conflicting/);
      await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, old, second), /conflicting/);
      await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, old, staged.pendingPage), /conflicting/);
      await assert.rejects(f.ledger(denied).claim(f.subject, f.event, old), /conflicting/);
    }
    await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    for (const id of [first, third])
      await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(recovered), id), /conflicting/);
    assert.equal(denied.transactions, 0);
    assert.deepEqual(await snapshot(), { ...before, progress: recovered });

    const lease = structuredClone(recovered.lease);
    for (const [index, id] of [second, third].entries()) {
      assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, id), { membershipRemoved: true });
      const purged = await f.room(id);
      assert.equal(purged.revision, before.rooms[index + 1].revision + 1);
      assert.equal(await f.point(id), undefined);
      assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, id), { membershipRemoved: false });
      assert.deepEqual(await f.room(id), purged);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), recovered);
      const previous = recovered;
      recovered = await f.ledger().acknowledge(f.subject, f.event, receipt(previous), id);
      assert.equal(recovered.revision, previous.revision + 1);
      assert.deepEqual(recovered.pendingPage, { roomIds: index === 0 ? [third] : [], next: staged.pendingPage.next });
      assert.deepEqual(recovered.cursor, partial.cursor); assert.deepEqual(recovered.lease, lease);
      await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(previous), id), /conflicting/);
      if (index === 0)
        await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    }
    const expected = { ...recovered, revision: recovered.revision + 1,
      cursor: staged.pendingPage.next, pendingPage: null, traversalEnded: false };
    const advancing = intercept((command, send) => {
      if (command.constructor.name === 'TransactWriteCommand') {
        const attempted = command.input.TransactItems[1].Put;
        assert.equal(attempted.TableName, f.config.tableName);
        assert.equal(attempted.ExpressionAttributeValues[':revision'], recovered.revision);
        assert.deepEqual(attempted.Item, expected);
      }
      return send();
    });
    assert.deepEqual(await f.ledger(advancing).advance(f.subject, f.event, receipt(recovered)), expected);
    assert.equal(advancing.transactions, 1);
    await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(recovered)), /conflicting/);
    await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(expected)), /conflicting/);
    assert.equal(denied.transactions, 0);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), expected);
    assert.deepEqual(await read(f.config.tableName, { pk: partial.pk }), expected);
    const after = await snapshot();
    assert.deepEqual(after.rooms[0], before.rooms[0]);
    assert.deepEqual(after.points, [undefined, undefined, undefined]);
    assert.deepEqual(after.peers, before.peers);
    assert.deepEqual(after.unrelated, before.unrelated); assert.equal(after.unrelatedPoint, undefined);
    assert.equal(Object.hasOwn(expected, 'complete'), false); assert.equal(Object.hasOwn(expected, 'ttl'), false);
    await assertHeld(f);
  });
});

test('real nonterminal advance loses its hold condition without skipping the drained continuation', async () => {
  await fixture(async (f) => {
    const seeded = [await f.seed(), await f.seed(), await f.seed()];
    for (const id of seeded)
      await put(f.config.locationTableName, { ...locationKey(id, f.peer), synthetic: 'peer-preserved' });
    let prefix = await f.stage(await f.start(), 1);
    const [first] = prefix.pendingPage.roomIds;
    assert.ok(seeded.includes(first)); assert.ok(prefix.pendingPage.next.key);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, first), { membershipRemoved: true });
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, first), { membershipRemoved: false });
    prefix = await f.ledger().acknowledge(f.subject, f.event, receipt(prefix), first);
    const unstaged = await f.ledger().advance(f.subject, f.event, receipt(prefix));
    const staged = await f.stage(unstaged, 1);
    assert.equal(staged.pendingPage.roomIds.length, 1);
    assert.equal(staged.pendingPage.next.phase, 'rooms'); assert.ok(staged.pendingPage.next.key);
    const [candidate] = staged.pendingPage.roomIds;
    assert.ok(seeded.includes(candidate)); assert.notEqual(candidate, first);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(staged)), /conflicting/);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, candidate), { membershipRemoved: true });
    const purged = await f.room(candidate);
    assert.equal(await f.point(candidate), undefined);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, candidate), { membershipRemoved: false });
    assert.deepEqual(await f.room(candidate), purged);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), staged);
    const drained = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), candidate);
    assert.deepEqual(drained.pendingPage, { roomIds: [], next: staged.pendingPage.next });
    assert.deepEqual(drained.cursor, unstaged.cursor); assert.ok(drained.cursor.key);
    assert.ok(f.clock.at < drained.lease.until);
    const expected = { ...drained, revision: drained.revision + 1,
      cursor: staged.pendingPage.next, pendingPage: null };
    const snapshot = async () => ({
      progress: await read(f.config.tableName, { pk: drained.pk }),
      rooms: await Promise.all(seeded.map((id) => f.room(id))),
      points: await Promise.all(seeded.map((id) => f.point(id))),
      peers: await Promise.all(seeded.map((id) => f.point(id, f.peer))),
    });
    const before = await snapshot();
    const remaining = seeded.find((id) => id !== first && id !== candidate);
    assert.ok(before.points[seeded.indexOf(remaining)]);
    const replacement = structuredClone(f.held);
    replacement.lifecycleHold.binding = hash(JSON.stringify([f.subject, randomUUID(), f.config.sessionTableName]));
    assert.notEqual(replacement.lifecycleHold.binding, f.held.lifecycleHold.binding);
    let forwarded = false;
    const replacing = intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      assert.equal(command.input.TransactItems.length, 2);
      const hold = command.input.TransactItems[0].ConditionCheck;
      assert.equal(hold.TableName, f.config.sessionTableName);
      assert.deepEqual(hold.Key, userKey(f.subject));
      assert.deepEqual(hold.ExpressionAttributeValues[':hold'], f.held.lifecycleHold);
      const attempted = command.input.TransactItems[1].Put;
      assert.equal(attempted.TableName, f.config.tableName);
      assert.equal(attempted.ExpressionAttributeValues[':revision'], drained.revision);
      assert.deepEqual(attempted.Item, expected);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), drained);
      // Replace only the fixture hold after admission, then send the real write.
      await put(f.config.sessionTableName, replacement);
      assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);
      forwarded = true;
      return send();
    });
    await assert.rejects(f.ledger(replacing).advance(f.subject, f.event, receipt(drained)), (error) => {
      assert.equal(error.name, 'TransactionCanceledException');
      assert.deepEqual(error.CancellationReasons.map((reason) => reason.Code), ['ConditionalCheckFailed', 'None']);
      return true;
    });
    assert.equal(replacing.transactions, 1); assert.equal(forwarded, true);
    assert.deepEqual(await snapshot(), before);
    const denied = intercept((_command, send) => send());
    await assert.rejects(f.ledger(denied).read(f.subject, f.event), /lifecycle hold/);
    await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(drained)), /lifecycle hold/);
    await assert.rejects(f.discovery().readPage(f.subject, f.event, { cursor: drained.pendingPage.next, limit: 1 }), /lifecycle hold|not authorised/);
    await assert.rejects(f.purge(denied).purgeRoom(f.subject, f.event, remaining), /lifecycle hold|not authorised/);
    assert.equal(denied.transactions, 0);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);

    // Identical fixture restoration is not a production hold-release/readmission
    // API and does not establish durable cross-call hold-incarnation fencing.
    await put(f.config.sessionTableName, f.held);
    const recovered = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(recovered, drained);
    const advancing = intercept((command, send) => {
      if (command.constructor.name === 'TransactWriteCommand') {
        const attempted = command.input.TransactItems[1].Put;
        assert.equal(attempted.ExpressionAttributeValues[':revision'], recovered.revision);
        assert.deepEqual(attempted.Item, expected);
      }
      return send();
    });
    assert.deepEqual(await f.ledger(advancing).advance(f.subject, f.event, receipt(recovered)), expected);
    assert.equal(advancing.transactions, 1);
    for (const row of [drained, expected]) {
      await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(row)), /conflicting/);
      await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(row), candidate), /conflicting/);
    }
    assert.equal(denied.transactions, 0);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), expected);
    assert.deepEqual(await snapshot(), { ...before, progress: expected });
    assert.deepEqual(expected.lease, drained.lease); assert.equal(expected.traversalEnded, false);
    await assertHeld(f);

    let scans = 0;
    const continued = intercept((command, send) => {
      if (command.constructor.name === 'ScanCommand') {
        scans++;
        assert.equal(command.input.TableName, f.config.roomTableName);
        assert.equal(command.input.ConsistentRead, true); assert.equal(command.input.Limit, 1);
        assert.deepEqual(command.input.ExclusiveStartKey, expected.cursor.key);
      }
      return send();
    });
    const discovery = createLifecycleDiscoveryStore({ client: continued, tableName: f.config.roomTableName,
      sessionTableName: f.config.sessionTableName, locationTableName: f.config.locationTableName });
    const nextPage = await discovery.readPage(f.subject, f.event, { cursor: expected.cursor, limit: 1 });
    assert.equal(scans, 1); assert.equal(continued.transactions, 0);
    assert.deepEqual(nextPage.roomIds, [remaining]);
    assert.deepEqual(await snapshot(), { ...before, progress: expected });
    const restaged = await f.ledger().stagePage(f.subject, f.event, receipt(expected), nextPage);
    assert.deepEqual(restaged, { ...expected, revision: expected.revision + 1, pendingPage: nextPage });
    assert.deepEqual(await f.ledger().read(f.subject, f.event), restaged);
    assert.deepEqual(await snapshot(), { ...before, progress: restaged });
    assert.equal(Object.hasOwn(restaged, 'complete'), false); assert.equal(Object.hasOwn(restaged, 'ttl'), false);
    await assertHeld(f);
  });
});

for (const recovery of ['live', 'expired', 'lost-takeover-response', 'lost-stage-response', 'lost-purge-response', 'lost-ack-response', 'lost-recovered-advance-response', 'recovered-advance-hold-race', 'recovered-advance-hold-race-expired', 'lost-recovered-drained-claim-response', 'expired-lost-recovered-drained-claim-response', 'second-drained-reclaim-hold-race']) test(`real committed nonterminal advance survives response loss and a foreign hold (${recovery}) without replaying its page`, async () => {
  const loseAdvanceResponse = recovery === 'lost-recovered-advance-response';
  const replaceHoldOnReclaim = recovery === 'second-drained-reclaim-hold-race';
  const expireLostDrainedClaim = recovery === 'expired-lost-recovered-drained-claim-response' || replaceHoldOnReclaim;
  const loseDrainedClaimResponse = recovery === 'lost-recovered-drained-claim-response' || expireLostDrainedClaim;
  const expireBlockedAdvance = recovery === 'recovered-advance-hold-race-expired' || loseDrainedClaimResponse;
  const replaceHoldOnAdvance = recovery === 'recovered-advance-hold-race' || expireBlockedAdvance;
  const loseAckResponse = recovery === 'lost-ack-response' || loseAdvanceResponse || replaceHoldOnAdvance;
  const losePurgeResponse = recovery === 'lost-purge-response' || loseAckResponse;
  const expired = recovery !== 'live', loseStageResponse = recovery === 'lost-stage-response' || losePurgeResponse;
  const loseTakeoverResponse = recovery === 'lost-takeover-response' || loseStageResponse;
  await fixture(async (f) => {
    const seeded = [await f.seed(), await f.seed(), await f.seed()];
    for (const id of seeded)
      await put(f.config.locationTableName, { ...locationKey(id, f.peer), synthetic: 'peer-preserved' });
    let prefix = await f.stage(await f.start(), 1);
    const [first] = prefix.pendingPage.roomIds;
    assert.ok(seeded.includes(first)); assert.ok(prefix.pendingPage.next.key);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, first), { membershipRemoved: true });
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, first), { membershipRemoved: false });
    prefix = await f.ledger().acknowledge(f.subject, f.event, receipt(prefix), first);
    const unstaged = await f.ledger().advance(f.subject, f.event, receipt(prefix));
    const staged = await f.stage(unstaged, 1);
    assert.equal(staged.pendingPage.roomIds.length, 1);
    assert.equal(staged.pendingPage.next.phase, 'rooms'); assert.ok(staged.pendingPage.next.key);
    const [candidate] = staged.pendingPage.roomIds;
    assert.ok(seeded.includes(candidate)); assert.notEqual(candidate, first);
    await assert.rejects(f.ledger().advance(f.subject, f.event, receipt(staged)), /conflicting/);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, candidate), { membershipRemoved: true });
    const purged = await f.room(candidate);
    assert.equal(await f.point(candidate), undefined);
    assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, candidate), { membershipRemoved: false });
    assert.deepEqual(await f.room(candidate), purged);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), staged);
    const drained = await f.ledger().acknowledge(f.subject, f.event, receipt(staged), candidate);
    assert.deepEqual(drained.pendingPage, { roomIds: [], next: staged.pendingPage.next });
    assert.deepEqual(drained.cursor, unstaged.cursor); assert.ok(drained.cursor.key);
    assert.ok(f.clock.at < drained.lease.until);
    const expected = { ...drained, revision: drained.revision + 1,
      cursor: staged.pendingPage.next, pendingPage: null };
    const snapshot = async () => ({
      progress: await read(f.config.tableName, { pk: drained.pk }),
      rooms: await Promise.all(seeded.map((id) => f.room(id))),
      points: await Promise.all(seeded.map((id) => f.point(id))),
      peers: await Promise.all(seeded.map((id) => f.point(id, f.peer))),
    });
    const before = await snapshot();
    const remaining = seeded.find((id) => id !== first && id !== candidate);
    assert.ok(before.points[seeded.indexOf(remaining)]);
    const replacement = structuredClone(f.held);
    replacement.lifecycleHold.binding = hash(JSON.stringify([f.subject, randomUUID(), f.config.sessionTableName]));
    assert.notEqual(replacement.lifecycleHold.binding, f.held.lifecycleHold.binding);
    const outage = new Error('Synthetic committed continuation response lost');
    let committed = 0, blockedPage;
    const failing = intercept(async (command, send) => {
      if (command.constructor.name !== 'TransactWriteCommand') return send();
      assert.equal(command.input.TransactItems.length, 2);
      const hold = command.input.TransactItems[0].ConditionCheck;
      assert.equal(hold.TableName, f.config.sessionTableName);
      assert.deepEqual(hold.Key, userKey(f.subject));
      assert.deepEqual(hold.ExpressionAttributeValues[':hold'], f.held.lifecycleHold);
      const attempted = command.input.TransactItems[1].Put;
      assert.equal(attempted.TableName, f.config.tableName);
      assert.equal(attempted.ExpressionAttributeValues[':revision'], drained.revision);
      assert.deepEqual(attempted.Item, expected);
      assert.deepEqual(await snapshot(), before);
      // Commit the real conditional transaction before changing only the fixture
      // hold and dropping its response. No successful response reaches the caller.
      await send(); committed++;
      assert.deepEqual(await snapshot(), { ...before, progress: expected });
      blockedPage = await f.discovery().readPage(f.subject, f.event, { cursor: expected.cursor, limit: 1 });
      assert.deepEqual(blockedPage.roomIds, [remaining]);
      await put(f.config.sessionTableName, replacement);
      throw outage;
    });
    await assert.rejects(f.ledger(failing).advance(f.subject, f.event, receipt(drained)), (error) => error === outage);
    assert.equal(failing.transactions, 1); assert.equal(committed, 1);
    assert.deepEqual(await snapshot(), { ...before, progress: expected });
    assert.deepEqual(expected.lease, drained.lease);
    assert.equal(expected.traversalEnded, false); assert.equal(expected.pendingPage, null);
    assert.notDeepEqual(expected.cursor, drained.cursor);
    assert.deepEqual(expected.cursor, staged.pendingPage.next);
    assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);
    const denied = intercept((_command, send) => send());
    await assert.rejects(f.ledger(denied).read(f.subject, f.event), /lifecycle hold/);
    // The old receipt fails on revision before hold admission. It cannot repeat
    // the committed advance; this is conflict evidence, not a hold check.
    await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(drained)), /conflicting/);
    await assert.rejects(f.discovery().readPage(f.subject, f.event, { cursor: expected.cursor, limit: 1 }), /lifecycle hold|not authorised/);
    await assert.rejects(f.purge(denied).purgeRoom(f.subject, f.event, remaining), /lifecycle hold|not authorised/);
    // Even a real page discovered before replacement cannot be staged under the
    // foreign hold. The current receipt reaches hold admission before any write.
    await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, receipt(expected), blockedPage), /lifecycle hold/);
    assert.equal(denied.transactions, 0);
    assert.deepEqual(await snapshot(), { ...before, progress: expected });
    assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);

    if (expired) {
      // Expiry during the outage cannot permit takeover under a foreign hold.
      f.clock.at = expected.lease.until;
      await assert.rejects(f.ledger(denied).read(f.subject, f.event), /lifecycle hold/);
      await assert.rejects(f.ledger(denied).claim(f.subject, f.event, receipt(expected, token())), /lifecycle hold/);
      await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, receipt(expected), blockedPage), /conflicting/);
      assert.equal(denied.transactions, 0);
      assert.deepEqual(await snapshot(), { ...before, progress: expected });
      assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);
    }

    // Identical fixture restoration is not a production hold-release/readmission
    // API and does not establish durable cross-call hold-incarnation fencing.
    await put(f.config.sessionTableName, f.held);
    let recovered = await f.ledger().read(f.subject, f.event);
    assert.deepEqual(recovered, expected);
    for (const row of [drained, recovered]) {
      await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(row)), /conflicting/);
      await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(row), candidate), /conflicting/);
    }
    assert.equal(denied.transactions, 0);
    assert.deepEqual(await snapshot(), { ...before, progress: expected });
    await assertHeld(f);

    if (expired) {
      // A reread recovers the committed cursor, but does not renew its lease.
      await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, receipt(recovered), blockedPage), /conflicting/);
      await assert.rejects(f.ledger(denied).claim(f.subject, f.event, receipt(recovered)), /conflicting/);
      assert.equal(denied.transactions, 0);
      assert.deepEqual(await snapshot(), { ...before, progress: expected });
      const fresh = receipt(recovered, token());
      assert.notEqual(fresh.token, expected.lease.token);
      const claimed = { ...expected, revision: expected.revision + 1,
        lease: { token: fresh.token, until: f.clock.at + 30_000 } };
      const takeoverOutage = new Error('Synthetic committed continuation takeover response lost');
      let takeoverCommits = 0;
      const claiming = intercept(async (command, send) => {
        if (command.constructor.name === 'TransactWriteCommand') {
          assert.equal(command.input.TransactItems.length, 2);
          assert.deepEqual(command.input.TransactItems[0].ConditionCheck.ExpressionAttributeValues[':hold'], f.held.lifecycleHold);
          const attempted = command.input.TransactItems[1].Put;
          assert.equal(attempted.ExpressionAttributeValues[':revision'], expected.revision);
          assert.deepEqual(attempted.Item, claimed);
          if (loseTakeoverResponse) {
            assert.deepEqual(await snapshot(), { ...before, progress: expected });
            // Forward the actual conditional claim; lose only its response.
            await send(); takeoverCommits++;
            assert.deepEqual(await snapshot(), { ...before, progress: claimed });
            throw takeoverOutage;
          }
        }
        return send();
      });
      if (loseTakeoverResponse) {
        await assert.rejects(f.ledger(claiming).claim(f.subject, f.event, fresh), (error) => error === takeoverOutage);
        assert.equal(takeoverCommits, 1);
        assert.deepEqual(await snapshot(), { ...before, progress: claimed });
        // Ambiguous response delivery is resolved by a fresh authorised read,
        // before discovery or staging. It cannot trigger a second takeover.
        recovered = await f.ledger().read(f.subject, f.event);
        await assert.rejects(f.ledger(denied).claim(f.subject, f.event, receipt(recovered, token())), /conflicting/);
      } else recovered = await f.ledger(claiming).claim(f.subject, f.event, fresh);
      assert.equal(claiming.transactions, 1);
      assert.deepEqual(recovered, claimed);
      assert.deepEqual(await snapshot(), { ...before, progress: claimed });
      for (const old of [receipt(drained), receipt(expected), fresh, receipt(recovered, expected.lease.token)]) {
        await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, old, blockedPage), /conflicting/);
        await assert.rejects(f.ledger(denied).advance(f.subject, f.event, old), /conflicting/);
        await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, old, candidate), /conflicting/);
        await assert.rejects(f.ledger(denied).claim(f.subject, f.event, old), /conflicting/);
      }
      assert.equal(denied.transactions, 0);
      assert.deepEqual(await snapshot(), { ...before, progress: claimed });
      await assertHeld(f);
    }

    let scans = 0;
    const continued = intercept((command, send) => {
      if (command.constructor.name === 'ScanCommand') {
        scans++;
        assert.equal(command.input.TableName, f.config.roomTableName);
        assert.equal(command.input.ConsistentRead, true); assert.equal(command.input.Limit, 1);
        assert.deepEqual(command.input.ExclusiveStartKey, expected.cursor.key);
      }
      return send();
    });
    const discovery = createLifecycleDiscoveryStore({ client: continued, tableName: f.config.roomTableName,
      sessionTableName: f.config.sessionTableName, locationTableName: f.config.locationTableName });
    const nextPage = await discovery.readPage(f.subject, f.event, { cursor: expected.cursor, limit: 1 });
    assert.equal(scans, 1); assert.equal(continued.transactions, 0);
    assert.deepEqual(nextPage.roomIds, [remaining]);
    assert.deepEqual(nextPage, blockedPage);
    assert.deepEqual(await snapshot(), { ...before, progress: recovered });
    const stagedWinner = { ...recovered, revision: recovered.revision + 1, pendingPage: nextPage };
    const stageOutage = new Error('Synthetic committed continuation stage response lost');
    let stageCommits = 0;
    const staging = intercept(async (command, send) => {
      if (loseStageResponse && command.constructor.name === 'TransactWriteCommand') {
        assert.equal(command.input.TransactItems.length, 2);
        assert.deepEqual(command.input.TransactItems[0].ConditionCheck.ExpressionAttributeValues[':hold'], f.held.lifecycleHold);
        const attempted = command.input.TransactItems[1].Put;
        assert.equal(attempted.TableName, f.config.tableName);
        assert.equal(attempted.ExpressionAttributeValues[':revision'], recovered.revision);
        assert.deepEqual(attempted.Item, stagedWinner);
        assert.deepEqual(await snapshot(), { ...before, progress: recovered });
        // Only response delivery fails: the real conditional stage has committed.
        await send(); stageCommits++;
        assert.deepEqual(await snapshot(), { ...before, progress: stagedWinner });
        throw stageOutage;
      }
      return send();
    });
    let restaged;
    if (loseStageResponse) {
      await assert.rejects(f.ledger(staging).stagePage(f.subject, f.event, receipt(recovered), nextPage), (error) => error === stageOutage);
      assert.equal(stageCommits, 1);
      // No purge or retry follows ambiguity until a fresh authorised durable read.
      assert.deepEqual(await snapshot(), { ...before, progress: stagedWinner });
      restaged = await f.ledger().read(f.subject, f.event);
    } else restaged = await f.ledger(staging).stagePage(f.subject, f.event, receipt(recovered), nextPage);
    assert.equal(staging.transactions, 1);
    assert.deepEqual(restaged, stagedWinner);
    assert.deepEqual(await f.ledger().read(f.subject, f.event), restaged);
    assert.deepEqual(await snapshot(), { ...before, progress: restaged });
    if (loseTakeoverResponse) {
      await assert.rejects(f.ledger(staging).stagePage(f.subject, f.event, receipt(recovered), nextPage), /conflicting/);
      await assert.rejects(f.ledger(staging).stagePage(f.subject, f.event, receipt(restaged), nextPage), /conflicting/);
      await assert.rejects(f.ledger(staging).advance(f.subject, f.event, receipt(restaged)), /conflicting/);
      await assert.rejects(f.ledger(staging).acknowledge(f.subject, f.event, receipt(restaged), candidate), /conflicting/);
      assert.equal(staging.transactions, 1);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), restaged);
      assert.deepEqual(await snapshot(), { ...before, progress: restaged });
    }
    if (loseStageResponse) {
      // The recovered page remains durable until the actual retained room is
      // purged and absence confirmed. Peer points and earlier rooms stay exact.
      assert.deepEqual(restaged.pendingPage.roomIds, [remaining]);
      const remainingIndex = seeded.indexOf(remaining);
      const expectedRoom = structuredClone(before.rooms[remainingIndex]);
      expectedRoom.revision++; expectedRoom.room.revision++;
      expectedRoom.room.members = expectedRoom.room.members.filter((member) => member.userId !== f.subject);
      expectedRoom.room.ownerId = f.peer; expectedRoom.room.invite = null;
      const expectedPurgedState = { ...before, progress: restaged,
        rooms: before.rooms.map((room, index) => index === remainingIndex ? expectedRoom : room),
        points: before.points.map((point, index) => index === remainingIndex ? undefined : point) };
      const purgeOutage = new Error('Synthetic committed continuation purge response lost');
      let purgeCommits = 0;
      const purging = intercept(async (command, send) => {
        if (losePurgeResponse && command.constructor.name === 'TransactWriteCommand') {
          const items = command.input.TransactItems;
          assert.equal(items.length, 3);
          assert.deepEqual(items[0].ConditionCheck.ExpressionAttributeValues[':hold'], f.held.lifecycleHold);
          assert.equal(items[1].Put.TableName, f.config.roomTableName);
          assert.equal(items[1].Put.ExpressionAttributeValues[':revision'], before.rooms[remainingIndex].revision);
          assert.deepEqual(items[1].Put.Item, expectedRoom);
          assert.deepEqual(items[2].Delete, { TableName: f.config.locationTableName,
            Key: locationKey(remaining, f.subject) });
          assert.deepEqual(await snapshot(), { ...before, progress: restaged });
          // The purge really commits, but its response cannot acknowledge work.
          await send(); purgeCommits++;
          assert.deepEqual(await snapshot(), expectedPurgedState);
          throw purgeOutage;
        }
        return send();
      });
      if (losePurgeResponse) {
        await assert.rejects(f.purge(purging).purgeRoom(f.subject, f.event, remaining), (error) => error === purgeOutage);
        assert.equal(purgeCommits, 1);
        assert.deepEqual(await snapshot(), expectedPurgedState);
        // Recover durable pending work first. Neither receipt may restage it,
        // and an ambiguous purge result cannot justify advancing the cursor.
        restaged = await f.ledger().read(f.subject, f.event);
        assert.deepEqual(restaged, stagedWinner);
        for (const row of [recovered, restaged]) {
          await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, receipt(row), nextPage), /conflicting/);
          await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(row)), /conflicting/);
          await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(row), candidate), /conflicting/);
        }
        assert.equal(denied.transactions, 0);
        assert.deepEqual(await snapshot(), expectedPurgedState);
        await assertHeld(f);
      } else assert.deepEqual(await f.purge(purging).purgeRoom(f.subject, f.event, remaining), { membershipRemoved: true });
      assert.equal(purging.transactions, 1);
      const purgedRemaining = await f.room(remaining);
      assert.deepEqual(purgedRemaining, expectedRoom);
      assert.equal(purgedRemaining.revision, before.rooms[seeded.indexOf(remaining)].revision + 1);
      assert.ok(!purgedRemaining.room.members.some((member) => member.userId === f.subject));
      assert.equal(await f.point(remaining), undefined);
      assert.deepEqual(await f.purge().purgeRoom(f.subject, f.event, remaining), { membershipRemoved: false });
      assert.deepEqual(await f.room(remaining), purgedRemaining);
      const purgedState = { ...before, progress: restaged,
        rooms: before.rooms.map((room, index) => seeded[index] === remaining ? purgedRemaining : room),
        points: before.points.map((point, index) => seeded[index] === remaining ? undefined : point) };
      assert.deepEqual(purgedState, expectedPurgedState);
      assert.deepEqual(await snapshot(), purgedState);
      assert.deepEqual(await f.ledger().read(f.subject, f.event), restaged);
      const acknowledgedWinner = { ...restaged, revision: restaged.revision + 1,
        pendingPage: { roomIds: [], next: nextPage.next } };
      const ackOutage = new Error('Synthetic committed continuation acknowledgement response lost');
      let ackCommits = 0;
      const acknowledging = intercept(async (command, send) => {
        if (loseAckResponse && command.constructor.name === 'TransactWriteCommand') {
          const items = command.input.TransactItems;
          assert.equal(items.length, 2);
          assert.equal(items[0].ConditionCheck.TableName, f.config.sessionTableName);
          assert.deepEqual(items[0].ConditionCheck.Key, userKey(f.subject));
          assert.deepEqual(items[0].ConditionCheck.ExpressionAttributeValues[':hold'], f.held.lifecycleHold);
          assert.equal(items[1].Put.TableName, f.config.tableName);
          assert.equal(items[1].Put.ExpressionAttributeValues[':revision'], restaged.revision);
          assert.deepEqual(items[1].Put.Item, acknowledgedWinner);
          assert.deepEqual(await snapshot(), purgedState);
          // Purge replay was confirmed above. Lose only delivery of this real
          // acknowledgement; the drained page is durable before any advance.
          await send(); ackCommits++;
          assert.deepEqual(await snapshot(), { ...purgedState, progress: acknowledgedWinner });
          throw ackOutage;
        }
        return send();
      });
      let acknowledged;
      if (loseAckResponse) {
        await assert.rejects(f.ledger(acknowledging).acknowledge(f.subject, f.event, receipt(restaged), remaining), (error) => error === ackOutage);
        assert.equal(ackCommits, 1);
        assert.deepEqual(await snapshot(), { ...purgedState, progress: acknowledgedWinner });
        // A fresh authorised read, rather than an assumed success or a retry,
        // supplies the winning revision and exact drained page for advancement.
        acknowledged = await f.ledger().read(f.subject, f.event);
        assert.deepEqual(acknowledged, acknowledgedWinner);
        for (const row of [restaged, acknowledged]) {
          for (const id of [remaining, candidate])
            await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(row), id), /conflicting/);
          await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, receipt(row), nextPage), /conflicting/);
        }
        assert.equal(denied.transactions, 0);
        assert.deepEqual(await snapshot(), { ...purgedState, progress: acknowledgedWinner });
        await assertHeld(f);
      } else acknowledged = await f.ledger(acknowledging).acknowledge(f.subject, f.event, receipt(restaged), remaining);
      assert.equal(acknowledging.transactions, 1);
      assert.deepEqual(acknowledged, acknowledgedWinner);
      assert.deepEqual(await snapshot(), { ...purgedState, progress: acknowledged });
      await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(restaged), remaining), /conflicting/);
      await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(restaged)), /conflicting/);
      assert.equal(denied.transactions, 0);
      let advancedWinner = { ...acknowledged, revision: acknowledged.revision + 1,
        cursor: nextPage.next, pendingPage: null, traversalEnded: nextPage.next === null };
      if (replaceHoldOnAdvance) {
        const drainedState = { ...purgedState, progress: acknowledged };
        assert.ok(f.clock.at < acknowledged.lease.until);
        let forwarded = false;
        const replacing = intercept(async (command, send) => {
          if (command.constructor.name !== 'TransactWriteCommand') return send();
          const items = command.input.TransactItems;
          assert.equal(items.length, 2);
          assert.equal(items[0].ConditionCheck.TableName, f.config.sessionTableName);
          assert.deepEqual(items[0].ConditionCheck.Key, userKey(f.subject));
          assert.deepEqual(items[0].ConditionCheck.ExpressionAttributeValues[':hold'], f.held.lifecycleHold);
          assert.equal(items[1].Put.TableName, f.config.tableName);
          assert.equal(items[1].Put.ExpressionAttributeValues[':revision'], acknowledged.revision);
          assert.deepEqual(items[1].Put.Item, advancedWinner);
          assert.deepEqual(await f.ledger().read(f.subject, f.event), acknowledged);
          assert.deepEqual(await snapshot(), drainedState);
          // Validation has passed. Change only the fixture hold before sending
          // the real transaction; the progress Put must be cancelled atomically.
          await put(f.config.sessionTableName, replacement);
          assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);
          forwarded = true;
          return send();
        });
        await assert.rejects(f.ledger(replacing).advance(f.subject, f.event, receipt(acknowledged)), (error) => {
          assert.equal(error.name, 'TransactionCanceledException');
          assert.deepEqual(error.CancellationReasons.map((reason) => reason.Code), ['ConditionalCheckFailed', 'None']);
          return true;
        });
        assert.equal(replacing.transactions, 1); assert.equal(forwarded, true);
        assert.deepEqual(await snapshot(), drainedState);
        await assert.rejects(f.ledger(denied).read(f.subject, f.event), /lifecycle hold/);
        await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(acknowledged)), /lifecycle hold/);
        await assert.rejects(f.purge(denied).purgeRoom(f.subject, f.event, remaining), /lifecycle hold|not authorised/);
        assert.equal(denied.transactions, 0);
        assert.deepEqual(await snapshot(), drainedState);
        assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);
        if (expireBlockedAdvance) {
          // The drained page stays durable throughout expiry under a foreign hold.
          f.clock.at = acknowledged.lease.until;
          await assert.rejects(f.ledger(denied).read(f.subject, f.event), /lifecycle hold/);
          await assert.rejects(f.ledger(denied).claim(f.subject, f.event, receipt(acknowledged, token())), /lifecycle hold/);
          await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(acknowledged)), /conflicting/);
          assert.equal(denied.transactions, 0);
          assert.deepEqual(await snapshot(), drainedState);
          assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);
        }
        // Identical test-fixture restoration supplies no production release API
        // or durable cross-call hold-incarnation fence. Reread before retrying.
        await put(f.config.sessionTableName, f.held);
        acknowledged = await f.ledger().read(f.subject, f.event);
        assert.deepEqual(acknowledged, acknowledgedWinner);
        assert.deepEqual(await snapshot(), drainedState);
        await assertHeld(f);
        if (expireBlockedAdvance) {
          // An authorised reread is recovery, not lease renewal or page replay.
          assert.equal(acknowledged.lease.until, f.clock.at);
          await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(acknowledged)), /conflicting/);
          await assert.rejects(f.ledger(denied).claim(f.subject, f.event, receipt(acknowledged)), /conflicting/);
          await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, receipt(acknowledged), nextPage), /conflicting/);
          await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(acknowledged), remaining), /conflicting/);
          assert.equal(denied.transactions, 0);
          assert.deepEqual(await snapshot(), drainedState);
          const fresh = receipt(acknowledged, token());
          assert.notEqual(fresh.token, acknowledged.lease.token);
          const claimed = { ...acknowledged, revision: acknowledged.revision + 1,
            lease: { token: fresh.token, until: f.clock.at + 30_000 } };
          const claimOutage = new Error('Synthetic committed recovered drained-page claim response lost');
          let claimCommits = 0;
          const claiming = intercept(async (command, send) => {
            if (command.constructor.name !== 'TransactWriteCommand') return send();
            const items = command.input.TransactItems;
            assert.equal(items.length, 2);
            assert.equal(items[0].ConditionCheck.TableName, f.config.sessionTableName);
            assert.deepEqual(items[0].ConditionCheck.Key, userKey(f.subject));
            assert.deepEqual(items[0].ConditionCheck.ExpressionAttributeValues[':hold'], f.held.lifecycleHold);
            assert.equal(items[1].Put.TableName, f.config.tableName);
            assert.equal(items[1].Put.ExpressionAttributeValues[':revision'], acknowledged.revision);
            assert.deepEqual(items[1].Put.Item, claimed);
            assert.deepEqual(await snapshot(), drainedState);
            const result = await send(); claimCommits++;
            assert.deepEqual(await snapshot(), { ...drainedState, progress: claimed });
            if (loseDrainedClaimResponse) throw claimOutage;
            return result;
          });
          if (loseDrainedClaimResponse) {
            // Only response delivery fails. Do not retry the claim, rediscover
            // work or advance until a fresh authorised read recovers its lease.
            await assert.rejects(f.ledger(claiming).claim(f.subject, f.event, fresh), (error) => error === claimOutage);
            assert.deepEqual(await snapshot(), { ...drainedState, progress: claimed });
            assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), f.held);
          } else assert.deepEqual(await f.ledger(claiming).claim(f.subject, f.event, fresh), claimed);
          assert.equal(claiming.transactions, 1); assert.equal(claimCommits, 1);
          if (expireLostDrainedClaim) f.clock.at = claimed.lease.until;
          acknowledged = await f.ledger().read(f.subject, f.event);
          assert.deepEqual(acknowledged, claimed);
          for (const old of [receipt(acknowledgedWinner), fresh, receipt(claimed, acknowledgedWinner.lease.token)]) {
            await assert.rejects(f.ledger(denied).advance(f.subject, f.event, old), /conflicting/);
            // At expiry a different token with the current revision is a valid
            // new claim, not a stale claim. Only stale revisions reject here.
            if (!expireLostDrainedClaim || old.revision !== claimed.revision)
              await assert.rejects(f.ledger(denied).claim(f.subject, f.event, old), /conflicting/);
            await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, old, nextPage), /conflicting/);
            await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, old, remaining), /conflicting/);
          }
          if (expireLostDrainedClaim) {
            // The lost claim really committed, but recovery cannot renew it.
            // Expired current receipts must fail before any ledger transaction.
            assert.equal(acknowledged.lease.until, f.clock.at);
            await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(acknowledged)), /conflicting/);
            await assert.rejects(f.ledger(denied).claim(f.subject, f.event, receipt(acknowledged)), /conflicting/);
            await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, receipt(acknowledged), nextPage), /conflicting/);
            await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(acknowledged), remaining), /conflicting/);
            assert.equal(denied.transactions, 0);
            assert.deepEqual(await snapshot(), { ...drainedState, progress: claimed });
            const replacementReceipt = receipt(acknowledged, token());
            assert.notEqual(replacementReceipt.token, claimed.lease.token);
            assert.notEqual(replacementReceipt.token, acknowledgedWinner.lease.token);
            const reclaimed = { ...claimed, revision: claimed.revision + 1,
              lease: { token: replacementReceipt.token, until: f.clock.at + 30_000 } };
            let reclaimCommits = 0, reclaimHoldReplaced = false;
            const reclaiming = intercept(async (command, send) => {
              if (command.constructor.name !== 'TransactWriteCommand') return send();
              const items = command.input.TransactItems;
              assert.equal(items.length, 2);
              assert.equal(items[0].ConditionCheck.TableName, f.config.sessionTableName);
              assert.deepEqual(items[0].ConditionCheck.Key, userKey(f.subject));
              assert.deepEqual(items[0].ConditionCheck.ExpressionAttributeValues[':hold'], f.held.lifecycleHold);
              assert.equal(items[1].Put.TableName, f.config.tableName);
              assert.equal(items[1].Put.ExpressionAttributeValues[':revision'], claimed.revision);
              assert.deepEqual(items[1].Put.Item, reclaimed);
              assert.deepEqual(await snapshot(), { ...drainedState, progress: claimed });
              if (replaceHoldOnReclaim && !reclaimHoldReplaced) {
                // Validation passed, but the second reclaim must still fence
                // the hold in its real transaction, preserving expired work.
                await put(f.config.sessionTableName, replacement);
                assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);
                reclaimHoldReplaced = true;
              }
              const result = await send(); reclaimCommits++;
              assert.deepEqual(await snapshot(), { ...drainedState, progress: reclaimed });
              return result;
            });
            if (replaceHoldOnReclaim) {
              await assert.rejects(f.ledger(reclaiming).claim(f.subject, f.event, replacementReceipt), (error) => {
                assert.equal(error.name, 'TransactionCanceledException');
                assert.deepEqual(error.CancellationReasons.map((reason) => reason.Code), ['ConditionalCheckFailed', 'None']);
                return true;
              });
              assert.equal(reclaiming.transactions, 1); assert.equal(reclaimCommits, 0);
              assert.equal(reclaimHoldReplaced, true);
              assert.deepEqual(await snapshot(), { ...drainedState, progress: claimed });
              await assert.rejects(f.ledger(denied).read(f.subject, f.event), /lifecycle hold/);
              await assert.rejects(f.ledger(denied).claim(f.subject, f.event, replacementReceipt), /lifecycle hold/);
              await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(claimed)), /conflicting/);
              await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, receipt(claimed), nextPage), /conflicting/);
              await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(claimed), remaining), /conflicting/);
              await assert.rejects(f.purge(denied).purgeRoom(f.subject, f.event, remaining), /lifecycle hold|not authorised/);
              assert.equal(denied.transactions, 0);
              assert.deepEqual(await snapshot(), { ...drainedState, progress: claimed });
              assert.deepEqual(await read(f.config.sessionTableName, userKey(f.subject)), replacement);
              // Restore only test-fixture state, then recover through a fresh
              // authorised adapter before retrying the uncommitted receipt.
              await put(f.config.sessionTableName, f.held);
              acknowledged = await f.ledger().read(f.subject, f.event);
              assert.deepEqual(acknowledged, claimed);
              assert.equal(acknowledged.lease.until, f.clock.at);
              assert.deepEqual(await snapshot(), { ...drainedState, progress: claimed });
              await assertHeld(f);
            }
            acknowledged = await f.ledger(reclaiming).claim(f.subject, f.event, replacementReceipt);
            assert.equal(reclaiming.transactions, replaceHoldOnReclaim ? 2 : 1); assert.equal(reclaimCommits, 1);
            assert.deepEqual(acknowledged, reclaimed);
            assert.deepEqual(await f.ledger().read(f.subject, f.event), reclaimed);
            for (const old of [receipt(claimed), replacementReceipt, receipt(reclaimed, claimed.lease.token)]) {
              await assert.rejects(f.ledger(denied).advance(f.subject, f.event, old), /conflicting/);
              await assert.rejects(f.ledger(denied).claim(f.subject, f.event, old), /conflicting/);
              await assert.rejects(f.ledger(denied).stagePage(f.subject, f.event, old, nextPage), /conflicting/);
              await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, old, remaining), /conflicting/);
            }
          }
          await assert.rejects(f.ledger(denied).claim(f.subject, f.event, receipt(acknowledged, token())), /conflicting/);
          assert.equal(denied.transactions, 0);
          assert.deepEqual(await snapshot(), { ...drainedState, progress: acknowledged });
          advancedWinner = { ...acknowledged, revision: acknowledged.revision + 1,
            cursor: nextPage.next, pendingPage: null, traversalEnded: nextPage.next === null };
          await assertHeld(f);
        }
      }
      const advanceOutage = new Error('Synthetic committed recovered advance response lost');
      let advanceCommits = 0;
      const advancing = intercept(async (command, send) => {
        if ((loseAdvanceResponse || replaceHoldOnAdvance) && command.constructor.name === 'TransactWriteCommand') {
          const items = command.input.TransactItems;
          assert.equal(items.length, 2);
          assert.equal(items[0].ConditionCheck.TableName, f.config.sessionTableName);
          assert.deepEqual(items[0].ConditionCheck.Key, userKey(f.subject));
          assert.deepEqual(items[0].ConditionCheck.ExpressionAttributeValues[':hold'], f.held.lifecycleHold);
          assert.equal(items[1].Put.TableName, f.config.tableName);
          assert.equal(items[1].Put.ExpressionAttributeValues[':revision'], acknowledged.revision);
          assert.deepEqual(items[1].Put.Item, advancedWinner);
          assert.deepEqual(await snapshot(), { ...purgedState, progress: acknowledged });
          // Forward the actual conditional advance after recovery. Verify its
          // durable cursor before returning or losing only response delivery.
          const result = await send(); advanceCommits++;
          assert.deepEqual(await snapshot(), { ...purgedState, progress: advancedWinner });
          if (loseAdvanceResponse) throw advanceOutage;
          return result;
        }
        return send();
      });
      let advanced;
      if (loseAdvanceResponse) {
        await assert.rejects(f.ledger(advancing).advance(f.subject, f.event, receipt(acknowledged)), (error) => error === advanceOutage);
        assert.equal(advanceCommits, 1);
        assert.deepEqual(await snapshot(), { ...purgedState, progress: advancedWinner });
        // Recover through a fresh authorised adapter, before any retry or scan.
        advanced = await f.ledger().read(f.subject, f.event);
        assert.deepEqual(advanced, advancedWinner);
        assert.deepEqual(advanced.lease, acknowledged.lease);
        assert.deepEqual(advanced.cursor, acknowledged.pendingPage.next);
        assert.notDeepEqual(advanced.cursor, acknowledged.cursor);
        for (const row of [restaged, acknowledged, advanced]) {
          await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(row)), /conflicting/);
          for (const id of [remaining, candidate])
            await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(row), id), /conflicting/);
        }
        assert.equal(denied.transactions, 0);
        assert.deepEqual(await snapshot(), { ...purgedState, progress: advancedWinner });
        await assertHeld(f);
      } else advanced = await f.ledger(advancing).advance(f.subject, f.event, receipt(acknowledged));
      assert.equal(advancing.transactions, 1);
      if (replaceHoldOnAdvance) {
        assert.equal(advanceCommits, 1);
        for (const row of [restaged, acknowledged, advanced]) {
          await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(row)), /conflicting/);
          for (const id of [remaining, candidate])
            await assert.rejects(f.ledger(denied).acknowledge(f.subject, f.event, receipt(row), id), /conflicting/);
        }
        assert.equal(denied.transactions, 0);
      }
      assert.deepEqual(advanced, advancedWinner);
      assert.deepEqual(await snapshot(), { ...purgedState, progress: advanced });
      await assert.rejects(f.ledger(denied).advance(f.subject, f.event, receipt(acknowledged)), /conflicting/);
      assert.equal(denied.transactions, 0);
      assert.equal(Object.hasOwn(advanced, 'complete'), false); assert.equal(Object.hasOwn(advanced, 'ttl'), false);
    }
    assert.equal(Object.hasOwn(restaged, 'complete'), false); assert.equal(Object.hasOwn(restaged, 'ttl'), false);
    await assertHeld(f);
  });
});
