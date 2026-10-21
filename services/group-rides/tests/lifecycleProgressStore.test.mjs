import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLifecycleProgressStore } from '../src/lifecycleProgressStore.mjs';
import { createLifecycleDiscoveryStore } from '../src/blockedAccountDiscoveryStore.mjs';
import { hash } from '../src/locationKeys.mjs';
import { userKey } from '../src/sessionRegistry.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';
const subject = 'synthetic-lifecycle', event = 'synthetic-event', token = 'a'.repeat(64), replacement = 'b'.repeat(64);
const room = 'c'.repeat(64), otherRoom = 'd'.repeat(64);
const config = { tableName: 'progress', sessionTableName: 'sessions', roomTableName: 'rooms', locationTableName: 'locations' };
const binding = hash(JSON.stringify([subject, event, 'rooms', 'sessions', 'locations']));
const points = { version: 1, binding, phase: 'points', key: null };
const rooms = { version: 1, binding, phase: 'rooms', key: { pk: `ROOM#${room}` } };
const hold = () => ({ version: 1, binding: hash(JSON.stringify([subject, event, 'sessions'])), startedAt: 90_000 });
const heldUser = () => ({ ...userKey(subject), subject, state: 'blocked', lifecycleHold: hold() });
const receipt = (row, value = row.lease?.token ?? token) => ({ revision: row.revision, token: value });
const conflict = () => Object.assign(new Error('synthetic conditional failure'), { name: 'TransactionCanceledException' });
// Request-contract stub only, not DynamoDB expression/integration proof.
function fixture() {
  const state = { rows: new Map(), user: heldUser(), at: 100_000, calls: [], beforeWrite: null };
  const client = { async send(command) {
    const p = command.input; state.calls.push(command);
    if (command.constructor.name === 'GetCommand') {
      assert.equal(p.ConsistentRead, true);
      if (p.TableName === 'sessions') { assert.deepEqual(p.Key, userKey(subject)); return { Item: structuredClone(state.user) }; }
      assert.equal(p.TableName, 'progress'); return { Item: structuredClone(state.rows.get(p.Key.pk)) };
    }
    assert.equal(command.constructor.name, 'TransactWriteCommand');
    assert.equal(p.TransactItems.length, 2);
    const [gate, put] = p.TransactItems;
    assert.deepEqual(gate.ConditionCheck, { TableName: 'sessions', Key: userKey(subject),
      ConditionExpression: '#state = :blocked AND subject = :subject AND lifecycleHold = :hold AND attribute_not_exists(#ttl) AND attribute_not_exists(expiresAt) AND attribute_not_exists(pilotExpiresAt)',
      ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':blocked': 'blocked', ':subject': subject, ':hold': hold() } });
    assert.equal(put.Put.TableName, 'progress');
    await state.beforeWrite?.();
    const write = put.Put, old = state.rows.get(write.Item.pk);
    if (state.user?.subject !== subject || state.user.state !== 'blocked'
      || JSON.stringify(state.user.lifecycleHold) !== JSON.stringify(gate.ConditionCheck.ExpressionAttributeValues[':hold'])
      || ['ttl', 'expiresAt', 'pilotExpiresAt'].some((key) => Object.hasOwn(state.user, key))) throw conflict();
    if (write.ConditionExpression === 'attribute_not_exists(pk)') { if (old) throw conflict(); }
    else {
      assert.equal(write.ConditionExpression, '#revision = :revision AND #binding = :binding');
      assert.deepEqual(write.ExpressionAttributeNames, { '#revision': 'revision', '#binding': 'binding' });
      if (!old || old.revision !== write.ExpressionAttributeValues[':revision'] || old.binding !== write.ExpressionAttributeValues[':binding']) throw conflict();
    }
    state.rows.set(write.Item.pk, structuredClone(write.Item)); return {};
  } };
  return { state, client, store: createLifecycleProgressStore({ client, ...config, now: () => state.at }) };
}
async function claimed(f) { const row = await f.store.initialize(subject, event); return f.store.claim(subject, event, receipt(row)); }

test('page persists before erasure, acknowledgements fence cursor advancement and terminal means traversal only', async () => {
  const f = fixture(); let row = await claimed(f);
  row = await f.store.stagePage(subject, event, receipt(row), { roomIds: [room, otherRoom], next: points });
  assert.equal(row.cursor, null); assert.equal(row.traversalEnded, false);
  await assert.rejects(f.store.advance(subject, event, receipt(row)), /conflicting/);
  await assert.rejects(f.store.acknowledge(subject, event, receipt(row), otherRoom), /conflicting/);
  const beforeAck = receipt(row);
  row = await f.store.acknowledge(subject, event, beforeAck, room);
  await assert.rejects(f.store.acknowledge(subject, event, beforeAck, room), /conflicting/);
  row = await f.store.acknowledge(subject, event, receipt(row), otherRoom);
  assert.equal(row.cursor, null);
  row = await f.store.advance(subject, event, receipt(row)); assert.deepEqual(row.cursor, points);
  row = await f.store.stagePage(subject, event, receipt(row), { roomIds: [], next: null });
  row = await f.store.advance(subject, event, receipt(row));
  assert.equal(row.traversalEnded, true); assert.equal(row.cursor, null); assert.equal(row.pendingPage, null);
  assert.ok(!Object.hasOwn(row, 'ttl')); assert.ok(!Object.hasOwn(row, 'complete'));
  await assert.rejects(f.store.claim(subject, event, receipt(row, replacement)), /conflicting/);
});

test('restart resumes saved candidates; expired lease takeover rejects old owner and old revisions', async () => {
  const f = fixture(); let row = await claimed(f);
  row = await f.store.stagePage(subject, event, receipt(row), { roomIds: [room], next: points });
  await assert.rejects(f.store.claim(subject, event, receipt(row, replacement)), /conflicting/);
  f.state.at = row.lease.until;
  await assert.rejects(f.store.acknowledge(subject, event, receipt(row), room), /conflicting/);
  await assert.rejects(f.store.claim(subject, event, receipt(row)), /conflicting/);
  const restarted = createLifecycleProgressStore({ client: f.client, ...config, now: () => f.state.at });
  const persisted = await restarted.read(subject, event); assert.deepEqual(persisted, row);
  const takeover = await restarted.claim(subject, event, receipt(persisted, replacement));
  assert.deepEqual(takeover.pendingPage, row.pendingPage);
  await assert.rejects(f.store.acknowledge(subject, event, receipt(row), room), /conflicting/);
  const ack = await restarted.acknowledge(subject, event, receipt(takeover), room);
  assert.deepEqual(ack.pendingPage.roomIds, []);
});

test('hold-read latency cannot send expired claims or leased mutations', async () => {
  const operations = [
    async (f) => {
      const row = await f.store.initialize(subject, event);
      return { row, until: f.state.at + 30_000, run: () => f.store.claim(subject, event, receipt(row)) };
    },
    async (f) => {
      const row = await claimed(f); f.state.at = row.lease.until;
      return { row, until: f.state.at + 30_000, run: () => f.store.claim(subject, event, receipt(row, replacement)) };
    },
    async (f) => {
      const row = await claimed(f);
      return { row, until: row.lease.until,
        run: () => f.store.stagePage(subject, event, receipt(row), { roomIds: [room], next: points }) };
    },
    async (f) => {
      const row = await f.store.stagePage(subject, event, receipt(await claimed(f)), { roomIds: [room], next: points });
      return { row, until: row.lease.until, run: () => f.store.acknowledge(subject, event, receipt(row), room) };
    },
    async (f) => {
      const row = await f.store.stagePage(subject, event, receipt(await claimed(f)), { roomIds: [], next: points });
      return { row, until: row.lease.until, run: () => f.store.advance(subject, event, receipt(row)) };
    },
  ];
  // Change time only after the original operation clock check, during hold I/O.
  for (const prepare of operations) for (const timing of ['live', 'boundary', 'expired', 'invalid', 'unsafe']) {
    const f = fixture(), { row, until, run } = await prepare(f);
    const before = structuredClone([...f.state.rows]), user = structuredClone(f.state.user), send = f.client.send;
    let holdReads = 0;
    f.state.calls.length = 0;
    f.client.send = async (command) => {
      const response = await send(command);
      if (command.constructor.name === 'GetCommand' && command.input.TableName === 'sessions') {
        holdReads++;
        f.state.at = timing === 'live' ? until - 1 : timing === 'boundary' ? until
          : timing === 'expired' ? until + 1 : timing === 'invalid' ? NaN : Number.MAX_SAFE_INTEGER;
      }
      return response;
    };
    if (timing === 'live') {
      const updated = await run();
      assert.equal(updated.revision, row.revision + 1);
      assert.equal(updated.lease.until, until);
      assert.deepEqual(f.state.rows.get(row.pk), updated);
    } else {
      await assert.rejects(run(), /conflicting/);
      assert.deepEqual([...f.state.rows], before);
    }
    assert.equal(holdReads, 1);
    assert.equal(f.state.calls.filter((c) => c.constructor.name === 'TransactWriteCommand').length, timing === 'live' ? 1 : 0);
    assert.deepEqual(f.state.user, user);
  }
});

test('initialization and event/storage binding cannot reset another job or reinterpret its progress', async () => {
  const f = fixture(), row = await claimed(f);
  await assert.rejects(f.store.initialize(subject, event), { name: 'TransactionCanceledException' });
  assert.deepEqual(await f.store.read(subject, event), row);
  await assert.rejects(f.store.read(subject, 'synthetic-other-event'), /lifecycle hold/);
  await assert.rejects(f.store.initialize(subject, 'synthetic-other-event'), /lifecycle hold/);
  const changed = createLifecycleProgressStore({ client: f.client, ...config, roomTableName: 'other-rooms' });
  await assert.rejects(changed.read(subject, event), /conflicting/);
  assert.deepEqual(await f.store.read(subject, event), row);
});

test('block denial/readmission and concurrent ownership races never persist progress', async () => {
  for (const user of [undefined, { subject, state: 'active' }, { subject: 'synthetic-other', state: 'blocked' }]) {
    const f = fixture(); f.state.user = user;
    await assert.rejects(f.store.initialize(subject, event), /lifecycle hold|not authorised/);
    await assert.rejects(f.store.read(subject, event), /lifecycle hold|not authorised/); assert.equal(f.state.rows.size, 0);
  }
  const f = fixture(); const row = await claimed(f);
  f.state.beforeWrite = () => { f.state.user.state = 'active'; };
  await assert.rejects(f.store.stagePage(subject, event, receipt(row), { roomIds: [room], next: points }), { name: 'TransactionCanceledException' });
  f.state.user.state = 'blocked'; assert.deepEqual(await f.store.read(subject, event), row);
  f.state.beforeWrite = () => { f.state.rows.get(row.pk).revision++; };
  await assert.rejects(f.store.stagePage(subject, event, receipt(row), { roomIds: [], next: points }), { name: 'TransactionCanceledException' });
  assert.equal(f.state.rows.get(row.pk).pendingPage, null);
});

test('ambiguous write success recovers by rereading persisted state rather than skipping work', async () => {
  const f = fixture(); let row = await claimed(f); const send = f.client.send;
  f.client.send = async (c) => { const response = await send(c); if (c.constructor.name === 'TransactWriteCommand') throw new Error('synthetic response lost'); return response; };
  await assert.rejects(f.store.stagePage(subject, event, receipt(row), { roomIds: [room], next: points }), /response lost/);
  row = await f.store.read(subject, event); assert.deepEqual(row.pendingPage.roomIds, [room]); assert.equal(row.cursor, null);
  f.client.send = send;
  await assert.rejects(f.store.stagePage(subject, event, receipt(row), { roomIds: [], next: points }), /conflicting/);
  const error = new Error('synthetic outage'); f.state.beforeWrite = () => { throw error; };
  await assert.rejects(f.store.acknowledge(subject, event, receipt(row), room), (e) => e === error);
  assert.deepEqual(await f.store.read(subject, event), row);
});

test('invalid inputs, malformed persisted rows and phase regressions fail closed', async () => {
  const f = fixture(); let row = await claimed(f);
  for (const value of [{ roomIds: [], next: null }, { roomIds: [room, room], next: points },
    { roomIds: ['bad'], next: points }, { roomIds: Array(101).fill(room), next: points },
    { roomIds: [], next: { ...points, binding: 'wrong' } }, { roomIds: [], next: points, extra: true }])
    await assert.rejects(f.store.stagePage(subject, event, receipt(row), value), /conflicting/);
  for (const ms of [0, 999, 60_001, NaN]) await assert.rejects(f.store.claim(subject, event, receipt(row), ms), /conflicting/);
  for (const r of [null, { revision: row.revision, token: 'bad' }, { ...receipt(row), extra: true }])
    await assert.rejects(f.store.advance(subject, event, r), /conflicting/);
  row = await f.store.stagePage(subject, event, receipt(row), { roomIds: [], next: points });
  row = await f.store.advance(subject, event, receipt(row));
  for (const next of [points, rooms]) await assert.rejects(f.store.stagePage(subject, event, receipt(row), { roomIds: [], next }), /conflicting/);
  f.state.rows.get(row.pk).ttl = 123;
  await assert.rejects(f.store.read(subject, event), /conflicting/);
  assert.throws(() => createLifecycleProgressStore({ client: f.client, ...config, tableName: 'sessions' }));
  await assert.rejects(f.store.initialize('', event), /conflicting/);
});

test('discovery pages serialize into the ledger without exposing profile or location content', async () => {
  const f = fixture(); let row = await claimed(f);
  const discovery = createLifecycleDiscoveryStore({ ...config, tableName: 'rooms', client: { async send(c) {
    return c.constructor.name === 'GetCommand' ? { Item: f.state.user } : { Items: [{ pk: `ROOM#${room}` }] };
  } } });
  const page = await discovery.readPage(subject, event, { cursor: row.cursor });
  row = await f.store.stagePage(subject, event, receipt(row), JSON.parse(JSON.stringify(page)));
  assert.deepEqual(row.pendingPage, { roomIds: [room], next: points });
});

test('caller mutation during I/O cannot alter staged work or expected ownership', async () => {
  const f = fixture(), row = await claimed(f), expected = receipt(row);
  const value = { roomIds: [room], next: structuredClone(points) }, send = f.client.send;
  f.client.send = async (c) => {
    if (c.constructor.name === 'GetCommand') { value.roomIds[0] = otherRoom; value.next.binding = 'wrong'; expected.token = replacement; expected.revision++; }
    return send(c);
  };
  const staged = await f.store.stagePage(subject, event, expected, value);
  assert.deepEqual(staged.pendingPage, { roomIds: [room], next: points });
  staged.pendingPage.roomIds[0] = otherRoom;
  assert.deepEqual((await f.store.read(subject, event)).pendingPage.roomIds, [room]);
});

test('non-progressing cursors, sparse pages, unsafe clocks and corrupt terminal state are rejected', async () => {
  const f = fixture(); let row = await claimed(f);
  await assert.rejects(f.store.stagePage(subject, event, receipt(row), { roomIds: Array(1), next: points }), /conflicting/);
  row = await f.store.stagePage(subject, event, receipt(row), { roomIds: [], next: rooms });
  row = await f.store.advance(subject, event, receipt(row));
  const reordered = { key: { pk: rooms.key.pk }, phase: 'rooms', binding, version: 1 };
  await assert.rejects(f.store.stagePage(subject, event, receipt(row), { roomIds: [], next: reordered }), /conflicting/);
  for (const at of [NaN, -1, Number.MAX_SAFE_INTEGER]) {
    f.state.at = at;
    await assert.rejects(f.store.stagePage(subject, event, receipt(row), { roomIds: [], next: points }), /conflicting/);
  }
  f.state.at = 100_000;
  f.state.rows.get(row.pk).pendingPage = { roomIds: [], next: null };
  await assert.rejects(f.store.read(subject, event), /conflicting/);
  f.state.rows.get(row.pk).pendingPage = null; f.state.rows.get(row.pk).traversalEnded = true;
  await assert.rejects(f.store.read(subject, event), /conflicting/);
});

test('temporary blocks, foreign events and malformed or expiring holds cannot read or mutate a ledger', async () => {
  const invalid = [
    undefined,
    { ...userKey(subject), subject, state: 'blocked', expiresAt: 200_000, ttl: 200 },
    { ...heldUser(), state: 'active' },
    { ...heldUser(), subject: 'synthetic-other' },
    { ...heldUser(), pk: 'USER#wrong' },
    { ...heldUser(), lifecycleHold: { ...hold(), binding: hash('synthetic-other-event') } },
    { ...heldUser(), lifecycleHold: { ...hold(), version: 2 } },
    { ...heldUser(), lifecycleHold: { ...hold(), startedAt: -1 } },
    { ...heldUser(), lifecycleHold: { ...hold(), extra: true } },
    ...['ttl', 'expiresAt', 'pilotExpiresAt'].map((key) => ({ ...heldUser(), [key]: 200_000 })),
  ];
  for (const user of invalid) {
    const f = fixture(), row = await claimed(f); f.state.user = user;
    const before = structuredClone([...f.state.rows]), calls = f.state.calls.length;
    await assert.rejects(f.store.read(subject, event), /lifecycle hold|not authorised/);
    await assert.rejects(f.store.initialize(subject, event), /lifecycle hold|not authorised/);
    await assert.rejects(f.store.stagePage(subject, event, receipt(row), { roomIds: [], next: points }), /lifecycle hold|not authorised/);
    assert.deepEqual([...f.state.rows], before);
    assert.equal(f.state.calls.slice(calls).some((c) => c.constructor.name === 'TransactWriteCommand'), false);
  }
});

test('every ledger mutation atomically fences the validated hold against removal, replacement or expiry', async () => {
  const operations = [
    async (f) => () => f.store.initialize(subject, event),
    async (f) => { const row = await f.store.initialize(subject, event); return () => f.store.claim(subject, event, receipt(row)); },
    async (f) => { const row = await claimed(f); return () => f.store.stagePage(subject, event, receipt(row), { roomIds: [room], next: points }); },
    async (f) => { const row = await f.store.stagePage(subject, event, receipt(await claimed(f)), { roomIds: [room], next: points });
      return () => f.store.acknowledge(subject, event, receipt(row), room); },
    async (f) => { const row = await f.store.stagePage(subject, event, receipt(await claimed(f)), { roomIds: [], next: points });
      return () => f.store.advance(subject, event, receipt(row)); },
  ];
  const changes = [
    () => undefined,
    () => ({ ...userKey(subject), subject, state: 'blocked' }),
    () => ({ ...heldUser(), state: 'active' }),
    () => ({ ...heldUser(), lifecycleHold: { ...hold(), binding: hash('synthetic-other-event') } }),
    () => ({ ...heldUser(), lifecycleHold: { ...hold(), startedAt: 90_001 } }),
    ...['ttl', 'expiresAt', 'pilotExpiresAt'].map((key) => () => ({ ...heldUser(), [key]: 0 })),
  ];
  for (const prepare of operations) for (const change of changes) {
    const f = fixture(), operation = await prepare(f), before = structuredClone([...f.state.rows]);
    f.state.beforeWrite = () => { f.state.user = change(); };
    await assert.rejects(operation(), { name: 'TransactionCanceledException' });
    assert.deepEqual([...f.state.rows], before);
  }
});

test('ledger reads recheck the exact hold after loading progress and propagate hold storage failures', async () => {
  for (const change of [() => undefined, () => ({ ...heldUser(), ttl: 200 }),
    () => ({ ...heldUser(), lifecycleHold: { ...hold(), startedAt: 90_001 } })]) {
    const f = fixture(); await claimed(f); const send = f.client.send;
    f.client.send = async (c) => {
      const response = await send(c);
      if (c.input.TableName === 'progress') f.state.user = change();
      return response;
    };
    await assert.rejects(f.store.read(subject, event), /lifecycle hold|not authorised/);
  }
  const f = fixture(), row = await claimed(f), before = structuredClone([...f.state.rows]), send = f.client.send;
  const error = new Error('synthetic hold read outage');
  f.client.send = async (c) => { if (c.input.TableName === 'sessions') throw error; return send(c); };
  await assert.rejects(f.store.read(subject, event), (e) => e === error);
  await assert.rejects(f.store.stagePage(subject, event, receipt(row), { roomIds: [], next: points }), (e) => e === error);
  assert.deepEqual([...f.state.rows], before);
});


test('ledger rejects legacy or foreign-event discovery cursors in staged and persisted pages', async () => {
  const f = fixture(), row = await claimed(f);
  for (const parts of [[subject, 'rooms', 'sessions', 'locations'], [subject, 'other-event', 'rooms', 'sessions', 'locations']]) {
    const page = { roomIds: [room], next: { ...points, binding: hash(JSON.stringify(parts)) } };
    await assert.rejects(f.store.stagePage(subject, event, receipt(row), page), /conflicting/);
    f.state.rows.get(row.pk).pendingPage = page;
    await assert.rejects(f.store.read(subject, event), /conflicting/);
    f.state.rows.get(row.pk).pendingPage = null;
  }
  assert.deepEqual(await f.store.read(subject, event), row);
});
