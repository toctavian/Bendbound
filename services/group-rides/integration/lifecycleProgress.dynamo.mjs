// Synthetic localhost-only integration preparation; never creates cloud resources.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { createLifecycleProgressStore } from '../src/lifecycleProgressStore.mjs';
import { createLifecycleDiscoveryStore } from '../src/blockedAccountDiscoveryStore.mjs';
import { createLifecycleHoldStore } from '../src/lifecycleHoldStore.mjs';
import { userKey } from '../src/sessionRegistry.mjs';
import { hash } from '../src/locationKeys.mjs';

const endpoint = process.env.GROUP_DYNAMO_LOCAL_ENDPOINT;
if (!endpoint || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw new Error('Localhost-only DynamoDB endpoint required.');
const raw = new DynamoDBClient({ endpoint, region: 'eu-west-2', credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1 });
const client = DynamoDBDocumentClient.from(raw);
after(() => raw.destroy());
const token = () => randomBytes(32).toString('hex');
const roomId = () => hash(randomUUID());
const receipt = (row, value = row.lease?.token ?? token()) => ({ revision: row.revision, token: value });

async function fixture(work) {
  const suffix = randomUUID(), config = { tableName: `ledger-progress-${suffix}`,
    sessionTableName: `ledger-sessions-${suffix}`, roomTableName: `ledger-rooms-${suffix}`,
    locationTableName: `ledger-points-${suffix}` }, alternate = `ledger-alternate-${suffix}`;
  const created = [];
  try {
    for (const TableName of [...Object.values(config), alternate]) {
      const points = TableName === config.locationTableName;
      await raw.send(new CreateTableCommand({ TableName, BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, ...(points ? [{ AttributeName: 'sk', KeyType: 'RANGE' }] : [])],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, ...(points ? [{ AttributeName: 'sk', AttributeType: 'S' }] : [])] }));
      created.push(TableName);
    }
    const subject = randomUUID(), event = randomUUID(), clock = { at: 1_000_000 };
    const held = await createLifecycleHoldStore({ client, tableName: config.sessionTableName, now: () => clock.at }).begin(subject, event);
    const store = (storage = client, overrides = {}) => createLifecycleProgressStore({ ...config, ...overrides, client: storage, now: () => clock.at });
    const put = (TableName, Item) => client.send(new PutCommand({ TableName, Item }));
    const setHold = (row) => row === undefined
      ? client.send(new DeleteCommand({ TableName: config.sessionTableName, Key: userKey(subject) }))
      : put(config.sessionTableName, row);
    const stored = async () => (await client.send(new GetCommand({ TableName: config.tableName,
      Key: { pk: `LIFECYCLE#${hash(JSON.stringify([subject, event]))}` }, ConsistentRead: true }))).Item;
    const points = { version: 1, binding: hash(JSON.stringify([subject, event, config.roomTableName, config.sessionTableName, config.locationTableName])), phase: 'points', key: null };
    await work({ config, alternate, subject, event, clock, held, store, put, setHold, stored, points });
  } finally {
    const cleanup = await Promise.allSettled(created.map((TableName) => raw.send(new DeleteTableCommand({ TableName }))));
    const failures = cleanup.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Synthetic ledger table cleanup failed.');
  }
}
// Hooks control real command timing/responses; DynamoDB evaluates every condition.
function intercept(hook) {
  const calls = [];
  return { calls, async send(command) { calls.push(command); return hook(command, () => client.send(command)); } };
}
async function claimed(f) {
  const row = await f.store().initialize(f.subject, f.event);
  return f.store().claim(f.subject, f.event, receipt(row));
}
const discovery = (f) => createLifecycleDiscoveryStore({ client, tableName: f.config.roomTableName,
  sessionTableName: f.config.sessionTableName, locationTableName: f.config.locationTableName });

// Every operation is prepared independently so retries and races cannot borrow prior state.
const preparations = [
  async (f) => ({ run: (s) => s.initialize(f.subject, f.event), before: undefined }),
  async (f) => { const row = await f.store().initialize(f.subject, f.event), expected = receipt(row);
    return { run: (s) => s.claim(f.subject, f.event, expected), before: row }; },
  async (f) => { const row = await claimed(f), expected = receipt(row);
    return { run: (s) => s.stagePage(f.subject, f.event, expected, { roomIds: [roomId()], next: f.points }), before: row }; },
  async (f) => { const id = roomId(), row = await f.store().stagePage(f.subject, f.event, receipt(await claimed(f)), { roomIds: [id], next: f.points }), expected = receipt(row);
    return { run: (s) => s.acknowledge(f.subject, f.event, expected, id), before: row }; },
  async (f) => { const row = await f.store().stagePage(f.subject, f.event, receipt(await claimed(f)), { roomIds: [], next: f.points }), expected = receipt(row);
    return { run: (s) => s.advance(f.subject, f.event, expected), before: row }; },
];

test('real discovery pages survive restart without advancing the original cursor before acknowledgement', async () => {
  await fixture(async (f) => {
    for (let i = 0; i < 3; i++) await f.put(f.config.roomTableName, { pk: `ROOM#${roomId()}`, title: 'synthetic-private-content' });
    let row = await claimed(f);
    const page = await discovery(f).readPage(f.subject, f.event, { cursor: row.cursor, limit: 1 });
    assert.equal(page.roomIds.length, 1); assert.equal(page.next.phase, 'rooms'); assert.ok(page.next.key);
    row = await f.store().stagePage(f.subject, f.event, receipt(row), JSON.parse(JSON.stringify(page)));
    assert.equal(row.cursor, null);
    assert.deepEqual(await f.store().read(f.subject, f.event), row);
    await assert.rejects(f.store().initialize(f.subject, f.event), { name: 'TransactionCanceledException' });
    await assert.rejects(f.store().advance(f.subject, f.event, receipt(row)), /conflicting/);
    assert.deepEqual(await f.stored(), row);
    const stale = receipt(row);
    row = await f.store().acknowledge(f.subject, f.event, stale, page.roomIds[0]);
    await assert.rejects(f.store().acknowledge(f.subject, f.event, stale, page.roomIds[0]), /conflicting/);
    assert.equal(row.cursor, null); assert.deepEqual(row.pendingPage, { roomIds: [], next: page.next });
    row = await f.store().advance(f.subject, f.event, receipt(row));
    assert.deepEqual(row.cursor, page.next); assert.equal(row.pendingPage, null);
    assert.deepEqual(await f.store().read(f.subject, f.event), row);
  });
});

test('real empty discovery pages persist and terminal traversal neither releases the hold nor means completion', async () => {
  await fixture(async (f) => {
    let row = await claimed(f);
    for (let phase = 0; phase < 2; phase++) {
      const page = await discovery(f).readPage(f.subject, f.event, { cursor: row.cursor, limit: 1 });
      assert.deepEqual(page.roomIds, []);
      row = await f.store().stagePage(f.subject, f.event, receipt(row), page);
      assert.equal(row.traversalEnded, false);
      row = await f.store().advance(f.subject, f.event, receipt(row));
      assert.equal(row.traversalEnded, phase === 1);
    }
    assert.equal(row.cursor, null); assert.equal(row.pendingPage, null);
    assert.ok(!Object.hasOwn(row, 'ttl')); assert.ok(!Object.hasOwn(row, 'complete'));
    assert.deepEqual(await createLifecycleHoldStore({ client, tableName: f.config.sessionTableName }).read(f.subject, f.event), f.held);
    await assert.rejects(f.store().claim(f.subject, f.event, receipt(row, token())), /conflicting/);
  });
});

test('real expired lease takeover preserves pending candidates and fences the old owner', async () => {
  await fixture(async (f) => {
    const id = roomId(); let row = await claimed(f);
    row = await f.store().stagePage(f.subject, f.event, receipt(row), { roomIds: [id], next: f.points });
    await assert.rejects(f.store().claim(f.subject, f.event, receipt(row, token())), /conflicting/);
    f.clock.at = row.lease.until;
    await assert.rejects(f.store().acknowledge(f.subject, f.event, receipt(row), id), /conflicting/);
    await assert.rejects(f.store().claim(f.subject, f.event, receipt(row)), /conflicting/);
    const saved = await f.store().read(f.subject, f.event);
    const takeover = await f.store().claim(f.subject, f.event, receipt(saved, token()));
    assert.deepEqual(takeover.pendingPage, row.pendingPage); assert.equal(takeover.cursor, null);
    await assert.rejects(f.store().acknowledge(f.subject, f.event, receipt(row), id), /conflicting/);
    const ack = await f.store().acknowledge(f.subject, f.event, receipt(takeover), id);
    assert.deepEqual(ack.pendingPage.roomIds, []);
  });
});

async function compete(operations) {
  let waiting = 0, release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const racing = intercept(async (command, send) => {
    if (command.constructor.name === 'TransactWriteCommand') { if (++waiting === operations.length) release(); await barrier; }
    return send();
  });
  const results = await Promise.allSettled(operations.map((op) => op(racing)));
  assert.equal(waiting, operations.length);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, operations.length - 1);
  for (const r of results.filter((r) => r.status === 'rejected')) assert.equal(r.reason.name, 'TransactionCanceledException');
  return results.find((r) => r.status === 'fulfilled').value;
}

test('real concurrent initialization and same-revision claims produce one persisted winner', async () => {
  await fixture(async (f) => {
    const row = await compete([0, 1].map(() => (storage) => f.store(storage).initialize(f.subject, f.event)));
    assert.deepEqual(await f.stored(), row);
    const winner = await compete([token(), token()].map((value) => (storage) => f.store(storage).claim(f.subject, f.event, receipt(row, value))));
    assert.equal(winner.revision, row.revision + 1); assert.deepEqual(await f.stored(), winner);
  });
});

test('every real ledger transaction cancels atomically after exact hold removal, replacement or expiry', async () => {
  const changes = [() => undefined, (f) => ({ ...userKey(f.subject), subject: f.subject, state: 'blocked' }),
    (f) => ({ ...f.held, state: 'active' }),
    (f) => ({ ...f.held, lifecycleHold: { ...f.held.lifecycleHold, binding: hash('foreign-event') } }),
    (f) => ({ ...f.held, lifecycleHold: { ...f.held.lifecycleHold, startedAt: f.held.lifecycleHold.startedAt + 1 } }),
    ...['ttl', 'expiresAt', 'pilotExpiresAt'].map((key) => (f) => ({ ...f.held, [key]: 0 }))];
  // Reuse the isolated tables but reset progress and the exact hold before each operation.
  await fixture(async (f) => {
    for (const prepare of preparations) for (const change of changes) {
      const previous = await f.stored();
      if (previous) await client.send(new DeleteCommand({ TableName: f.config.tableName, Key: { pk: previous.pk } }));
      await f.setHold(f.held);
      const { run, before } = await prepare(f);
      let transactions = 0;
      const racing = intercept(async (command, send) => {
        if (command.constructor.name === 'TransactWriteCommand') { transactions++; await f.setHold(change(f)); }
        return send();
      });
      await assert.rejects(run(f.store(racing)), { name: 'TransactionCanceledException' });
      assert.equal(transactions, 1); assert.deepEqual(await f.stored(), before);
    }
  });
});

test('real initial hold denial and post-load hold changes never return or mutate retained progress', async () => {
  await fixture(async (f) => {
    const row = await claimed(f);
    const changes = [undefined, { ...userKey(f.subject), subject: f.subject, state: 'blocked' },
      { ...f.held, ttl: 0 }, { ...f.held, lifecycleHold: { ...f.held.lifecycleHold, startedAt: f.held.lifecycleHold.startedAt + 1 } }];
    for (const changed of changes) {
      await f.setHold(changed);
      // A different valid start time is still a valid initial hold; only the read race rejects that change.
      if (changed?.lifecycleHold?.startedAt !== f.held.lifecycleHold.startedAt + 1) {
        const counted = intercept((_command, send) => send());
        await assert.rejects(f.store(counted).read(f.subject, f.event), /lifecycle hold|not authorised/);
        await assert.rejects(f.store(counted).stagePage(f.subject, f.event, receipt(row), { roomIds: [], next: f.points }), /lifecycle hold|not authorised/);
        assert.equal(counted.calls.some((c) => c.constructor.name === 'TransactWriteCommand'), false);
      }
      await f.setHold(f.held);
      const racing = intercept(async (command, send) => {
        const result = await send();
        if (command.input.TableName === f.config.tableName) await f.setHold(changed);
        return result;
      });
      await assert.rejects(f.store(racing).read(f.subject, f.event), /lifecycle hold|not authorised/);
      assert.deepEqual(await f.stored(), row);
    }
  });
});

test('real event, subject and all table bindings reject retained progress and incompatible cursors', async () => {
  await fixture(async (f) => {
    const row = await claimed(f);
    await assert.rejects(f.store().read(f.subject, randomUUID()), /lifecycle hold|not authorised/);
    await assert.rejects(f.store().read(randomUUID(), f.event), /lifecycle hold|not authorised/);
    await f.put(f.alternate, row); await f.put(f.alternate, f.held);
    for (const field of Object.keys(f.config)) {
      await assert.rejects(f.store(client, { [field]: f.alternate }).read(f.subject, f.event), /conflicting|lifecycle hold|not authorised/);
    }
    for (const parts of [[f.subject, f.config.roomTableName, f.config.sessionTableName, f.config.locationTableName],
      [f.subject, randomUUID(), f.config.roomTableName, f.config.sessionTableName, f.config.locationTableName]]) {
      const page = { roomIds: [], next: { ...f.points, binding: hash(JSON.stringify(parts)) } };
      await assert.rejects(f.store().stagePage(f.subject, f.event, receipt(row), page), /conflicting/);
      await f.put(f.config.tableName, { ...row, pendingPage: page });
      await assert.rejects(f.store().read(f.subject, f.event), /conflicting/);
      await f.put(f.config.tableName, row);
    }
    assert.deepEqual(await f.stored(), row);
  });
});

test('real committed but lost responses recover every mutation through reread and stale-receipt rejection', async () => {
  for (const prepare of preparations) await fixture(async (f) => {
    const { run, before } = await prepare(f), outage = new Error('Synthetic committed response lost');
    let commits = 0;
    const failing = intercept(async (command, send) => {
      const result = await send();
      if (command.constructor.name === 'TransactWriteCommand') { commits++; throw outage; }
      return result;
    });
    await assert.rejects(run(f.store(failing)), (error) => error === outage);
    assert.equal(commits, 1);
    const persisted = await f.store().read(f.subject, f.event);
    assert.equal(persisted.revision, (before?.revision ?? 0) + 1);
    assert.deepEqual(await f.stored(), persisted);
    await assert.rejects(run(f.store()), /conflicting|conditional|transaction/i);
    assert.deepEqual(await f.stored(), persisted);
  });
});

test('real precommit outage preserves original cursor and pending work; caller mutation cannot change staged inputs', async () => {
  await fixture(async (f) => {
    const row = await claimed(f), id = roomId(), expected = receipt(row), page = { roomIds: [id], next: structuredClone(f.points) };
    const original = structuredClone(page), outage = new Error('Synthetic precommit outage');
    const failing = intercept((command, send) => {
      if (command.constructor.name === 'TransactWriteCommand') throw outage;
      return send();
    });
    await assert.rejects(f.store(failing).stagePage(f.subject, f.event, expected, page), (error) => error === outage);
    assert.deepEqual(await f.stored(), row);
    const mutating = intercept((command, send) => {
      if (command.constructor.name === 'GetCommand') { expected.revision++; expected.token = token(); page.roomIds[0] = roomId(); page.next.binding = 'changed'; }
      return send();
    });
    const saved = await f.store(mutating).stagePage(f.subject, f.event, expected, page);
    assert.deepEqual(saved.pendingPage, original); assert.equal(saved.cursor, null);
    saved.pendingPage.roomIds.length = 0;
    assert.deepEqual((await f.store().read(f.subject, f.event)).pendingPage, original);
  });
});
