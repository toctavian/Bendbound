// Synthetic localhost-only integration preparation; never creates cloud resources.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { createLifecycleDiscoveryStore, createBlockedAccountDiscoveryStore } from '../src/blockedAccountDiscoveryStore.mjs';
import { createLifecycleHoldStore } from '../src/lifecycleHoldStore.mjs';
import { userKey } from '../src/sessionRegistry.mjs';
import { hash, locationKey } from '../src/locationKeys.mjs';

const endpoint = process.env.GROUP_DYNAMO_LOCAL_ENDPOINT;
if (!endpoint || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw new Error('Localhost-only DynamoDB endpoint required.');
const raw = new DynamoDBClient({ endpoint, region: 'eu-west-2', credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1 });
const client = DynamoDBDocumentClient.from(raw);
after(() => raw.destroy());

// Each case has independent tables: no scan-order assumptions or cross-case rows.
async function fixture(work) {
  const suffix = randomUUID(), config = { tableName: `discovery-rooms-${suffix}`,
    sessionTableName: `discovery-sessions-${suffix}`, locationTableName: `discovery-points-${suffix}` };
  const created = [];
  try {
    for (const TableName of Object.values(config)) {
      const points = TableName === config.locationTableName;
      await raw.send(new CreateTableCommand({ TableName, BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, ...(points ? [{ AttributeName: 'sk', KeyType: 'RANGE' }] : [])],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, ...(points ? [{ AttributeName: 'sk', AttributeType: 'S' }] : [])] }));
      created.push(TableName);
    }
    const subject = randomUUID(), event = randomUUID();
    const held = await createLifecycleHoldStore({ client, tableName: config.sessionTableName, now: () => 1_000_000 }).begin(subject, event);
    const store = (storage = client, overrides = {}) => createLifecycleDiscoveryStore({ ...config, ...overrides, client: storage });
    const put = (TableName, Item) => client.send(new PutCommand({ TableName, Item }));
    const setHold = (row) => row === undefined
      ? client.send(new DeleteCommand({ TableName: config.sessionTableName, Key: userKey(subject) }))
      : put(config.sessionTableName, row);
    await work({ config, subject, event, held, store, put, setHold });
  } finally {
    // Try every confirmed-created table even when the test or another cleanup fails.
    const cleanup = await Promise.allSettled(created.map((TableName) => raw.send(new DeleteTableCommand({ TableName }))));
    const failures = cleanup.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Synthetic discovery table cleanup failed.');
  }
}
const roomId = () => hash(randomUUID());
// Hooks affect timing/errors only; real DynamoDB evaluates scans and projections.
function intercept(hook) {
  const calls = [];
  return { calls, async send(command) {
    calls.push(command);
    return hook(command, () => client.send(command));
  } };
}
async function pointsCursor(f) {
  const page = await f.store().readPage(f.subject, f.event);
  assert.equal(page.next?.phase, 'points');
  return page.next;
}

test('real small-limit traversal includes expired rooms and orphan points, continuing empty filtered pages', async () => {
  await fixture(async (f) => {
    const rooms = [roomId(), roomId(), roomId()], orphan = roomId();
    for (const id of rooms) await f.put(f.config.tableName, { pk: `ROOM#${id}`, state: 'ended', expiresAt: 0, ttl: 0, title: 'synthetic-private-content' });
    for (const id of [rooms[0], orphan]) await f.put(f.config.locationTableName, { ...locationKey(id, f.subject), ttl: 0, syntheticPayload: 'not-projected' });
    for (let i = 0; i < 4; i++) await f.put(f.config.locationTableName, { ...locationKey(roomId(), randomUUID()), syntheticPayload: 'other-rider' });
    const checked = intercept(async (command, send) => {
      const result = await send();
      if (command.constructor.name === 'ScanCommand') {
        assert.equal(command.input.Limit, 1); assert.equal(command.input.ConsistentRead, true);
        const keys = command.input.TableName === f.config.tableName ? ['pk'] : ['pk', 'sk'];
        for (const item of result.Items ?? []) assert.deepEqual(Object.keys(item).sort(), keys);
        assert.ok((result.ScannedCount ?? 0) <= 1);
      }
      return result;
    });
    const found = { rooms: [], points: [] }; let cursor = null, emptyPoints = 0, pages = 0;
    do {
      const phase = cursor?.phase ?? 'rooms';
      // Restart the adapter and JSON-roundtrip every continuation.
      const page = await f.store(checked).readPage(f.subject, f.event, { cursor: JSON.parse(JSON.stringify(cursor)), limit: 1 });
      assert.deepEqual(Object.keys(page).sort(), ['next', 'roomIds']);
      found[phase].push(...page.roomIds);
      if (phase === 'points' && page.roomIds.length === 0 && page.next !== null) emptyPoints++;
      cursor = page.next; assert.ok(++pages < 30, 'Traversal must terminate');
    } while (cursor !== null);
    assert.deepEqual(found.rooms.sort(), [...rooms].sort());
    assert.deepEqual(found.points.sort(), [rooms[0], orphan].sort());
    assert.ok(emptyPoints > 0, 'Filtered evaluated pages must retain continuation');
  });
});

test('real empty tables transition through both phases and terminate', async () => {
  await fixture(async (f) => {
    const page = await f.store().readPage(f.subject, f.event, { limit: 1 });
    assert.deepEqual(page.roomIds, []); assert.equal(page.next.phase, 'points'); assert.equal(page.next.key, null);
    assert.deepEqual(await f.store().readPage(f.subject, f.event, { cursor: page.next, limit: 1 }), { roomIds: [], next: null });
  });
});

test('real cursors reject foreign event, subject, each table and temporary reconciliation before I/O', async () => {
  await fixture(async (f) => {
    const cursor = await pointsCursor(f);
    const counted = intercept((_command, send) => send());
    await assert.rejects(f.store(counted).readPage(f.subject, randomUUID(), { cursor }), /cursor/);
    await assert.rejects(f.store(counted).readPage(randomUUID(), f.event, { cursor }), /cursor/);
    for (const field of Object.keys(f.config)) {
      await assert.rejects(f.store(counted, { [field]: `${f.config[field]}-other` }).readPage(f.subject, f.event, { cursor }), /cursor/);
    }
    const temporary = createBlockedAccountDiscoveryStore({ ...f.config, client: counted });
    await assert.rejects(temporary.readPage(f.subject, { cursor }), /cursor/);
    const legacy = { ...cursor, binding: hash(JSON.stringify([f.subject, ...Object.values(f.config)])) };
    await assert.rejects(f.store(counted).readPage(f.subject, f.event, { cursor: legacy }), /cursor/);
    assert.equal(counted.calls.length, 0);
  });
});

test('real missing, temporary, foreign, malformed and expiring holds deny before scanning', async () => {
  await fixture(async (f) => {
    const variants = [undefined, { ...userKey(f.subject), subject: f.subject, state: 'blocked' },
      { ...f.held, state: 'active' }, { ...f.held, subject: randomUUID() },
      ...[null, false, {}, { ...f.held.lifecycleHold, version: 2 },
        { ...f.held.lifecycleHold, binding: hash('foreign-event') },
        { ...f.held.lifecycleHold, startedAt: -1 }, { ...f.held.lifecycleHold, extra: true }].map((lifecycleHold) => ({ ...f.held, lifecycleHold })),
      ...['ttl', 'expiresAt', 'pilotExpiresAt'].map((name) => ({ ...f.held, [name]: 0 }))];
    for (const row of variants) {
      await f.setHold(row);
      const counted = intercept((_command, send) => send());
      await assert.rejects(f.store(counted).readPage(f.subject, f.event), /lifecycle hold|not authorised/);
      assert.deepEqual(counted.calls.map((command) => command.constructor.name), ['GetCommand']);
    }
  });
});

test('real hold removal or mutation after either scan denies the entire page', async () => {
  await fixture(async (f) => {
    const id = roomId();
    // Get the points-phase cursor before seeding a nonempty room table.
    const cursor = await pointsCursor(f);
    await f.put(f.config.tableName, { pk: `ROOM#${id}` });
    await f.put(f.config.locationTableName, locationKey(id, f.subject));
    const variants = [undefined, { ...userKey(f.subject), subject: f.subject, state: 'blocked' },
      { ...f.held, state: 'active' },
      { ...f.held, lifecycleHold: { ...f.held.lifecycleHold, binding: hash('foreign-event') } },
      { ...f.held, lifecycleHold: { ...f.held.lifecycleHold, startedAt: f.held.lifecycleHold.startedAt + 1 } },
      ...['ttl', 'expiresAt', 'pilotExpiresAt'].map((name) => ({ ...f.held, [name]: 0 }))];
    for (const continuation of [null, cursor]) for (const row of variants) {
      await f.setHold(f.held);
      let scannedCandidates = 0;
      const racing = intercept(async (command, send) => {
        const result = await send();
        if (command.constructor.name === 'ScanCommand') {
          scannedCandidates += result.Items.length;
          await f.setHold(row);
        }
        return result;
      });
      await assert.rejects(f.store(racing).readPage(f.subject, f.event, { cursor: continuation }), /lifecycle hold|not authorised/);
      assert.equal(scannedCandidates, 1);
      assert.deepEqual(racing.calls.map((command) => command.constructor.name), ['GetCommand', 'ScanCommand', 'GetCommand']);
    }
  });
});

test('real unchanged hold across scan permits restart and copies a caller cursor before awaiting storage', async () => {
  await fixture(async (f) => {
    const cursor = await pointsCursor(f), id = roomId();
    await f.put(f.config.locationTableName, locationKey(id, f.subject));
    const saved = structuredClone(cursor);
    const racing = intercept(async (command, send) => {
      if (command.constructor.name === 'GetCommand') { cursor.phase = 'rooms'; cursor.binding = 'changed'; }
      const result = await send();
      if (command.constructor.name === 'ScanCommand') await f.setHold(structuredClone(f.held));
      return result;
    });
    assert.deepEqual(await f.store(racing).readPage(f.subject, f.event, { cursor }), { roomIds: [id], next: null });
    assert.equal(racing.calls.find((command) => command.constructor.name === 'ScanCommand').input.TableName, f.config.locationTableName);
    assert.deepEqual(await f.store().readPage(f.subject, f.event, { cursor: saved }), { roomIds: [id], next: null });
  });
});

test('real scan and hold-read response failures return no progress; original cursor retries successfully', async () => {
  await fixture(async (f) => {
    const cursor = await pointsCursor(f), saved = structuredClone(cursor), id = roomId();
    await f.put(f.config.locationTableName, locationKey(id, f.subject));
    for (const failAt of [1, 2, 3]) {
      let calls = 0; const outage = new Error('Synthetic response lost');
      const failing = intercept(async (_command, send) => {
        const result = await send(); if (++calls === failAt) throw outage; return result;
      });
      await assert.rejects(f.store(failing).readPage(f.subject, f.event, { cursor }), (error) => error === outage);
      assert.equal(calls, failAt); assert.deepEqual(cursor, saved);
      assert.deepEqual(await f.store().readPage(f.subject, f.event, { cursor }), { roomIds: [id], next: null });
    }
  });
});
