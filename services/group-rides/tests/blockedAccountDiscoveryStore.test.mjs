import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBlockedAccountDiscoveryStore, createLifecycleDiscoveryStore } from '../src/blockedAccountDiscoveryStore.mjs';
import { userKey } from '../src/sessionRegistry.mjs';
import { locationKey, hash } from '../src/locationKeys.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';

const event = 'synthetic-event';
const heldUser = () => ({ ...userKey(subject), subject, state: 'blocked',
  lifecycleHold: { version: 1, binding: hash(JSON.stringify([subject, event, 'sessions'])), startedAt: 90_000 } });
const subject = 'synthetic-blocked', id = 'a'.repeat(64), otherId = 'b'.repeat(64);
const key = { pk: `ROOM#${id}` }, otherKey = { pk: `ROOM#${otherId}` };
// Request-contract stub only: does not execute expressions or simulate a DB snapshot.
function fixture(pages = [], lifecycle = false) {
  const state = { user: lifecycle ? heldUser() : { subject, state: 'blocked' }, calls: [], beforeScan: null, beforeGet: null };
  const config = { tableName: 'rooms', sessionTableName: 'sessions', locationTableName: 'locations' };
  const client = { async send(command) {
    state.calls.push(command); const p = command.input;
    if (command.constructor.name === 'GetCommand') {
      assert.deepEqual(p, { TableName: 'sessions', Key: userKey(subject), ConsistentRead: true });
      await state.beforeGet?.(); return { Item: structuredClone(state.user) };
    }
    assert.equal(command.constructor.name, 'ScanCommand');
    assert.equal(p.ConsistentRead, true); assert.ok(p.Limit <= 100);
    assert.ok(!Object.hasOwn(p, 'IndexName')); assert.ok(!Object.hasOwn(p, 'Segment'));
    await state.beforeScan?.();
    const page = pages.shift(); if (page instanceof Error) throw page;
    assert.ok(page, 'Unexpected scan'); return structuredClone(page);
  } };
  const store = lifecycle ? createLifecycleDiscoveryStore({ client, ...config }) : createBlockedAccountDiscoveryStore({ client, ...config });
  return { state, config, client, store };
}

test('conservative room-key discovery is bounded, resumable and projects no room content', async () => {
  const f = fixture([{ Items: [key], LastEvaluatedKey: key }, { Items: [otherKey] }]);
  const first = await f.store.readPage(subject, { limit: 1 });
  assert.deepEqual(first.roomIds, [id]); assert.equal(first.next.phase, 'rooms');
  const second = await f.store.readPage(subject, { cursor: JSON.parse(JSON.stringify(first.next)), limit: 2 });
  assert.deepEqual(second.roomIds, [otherId]); assert.equal(second.next.phase, 'points'); assert.equal(second.next.key, null);
  const scans = f.state.calls.filter((c) => c.constructor.name === 'ScanCommand').map((c) => c.input);
  assert.deepEqual(scans[0], { TableName: 'rooms', ConsistentRead: true, Limit: 1,
    ProjectionExpression: '#pk', ExpressionAttributeNames: { '#pk': 'pk' } });
  assert.deepEqual(scans[1].ExclusiveStartKey, key);
  assert.equal(f.state.calls.length, 6);
});

test('empty filtered pages continue using another rider evaluated key; orphan points survive discovery', async () => {
  const target = locationKey(id, subject), otherRider = locationKey(otherId, 'synthetic-peer');
  const f = fixture([{ Items: [] }, { Items: [], LastEvaluatedKey: otherRider }, { Items: [target, target] }]);
  const rooms = await f.store.readPage(subject);
  const empty = await f.store.readPage(subject, { cursor: rooms.next });
  assert.deepEqual(empty.roomIds, []); assert.deepEqual(empty.next.key, otherRider);
  const points = await f.store.readPage(subject, { cursor: empty.next });
  assert.deepEqual(points, { roomIds: [id], next: null });
  const scans = f.state.calls.filter((c) => c.constructor.name === 'ScanCommand').map((c) => c.input);
  assert.deepEqual(scans[1], { TableName: 'locations', ConsistentRead: true, Limit: 100,
    ProjectionExpression: '#pk, #sk', ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
    FilterExpression: '#sk = :rider', ExpressionAttributeValues: { ':rider': target.sk } });
  assert.deepEqual(scans[2].ExclusiveStartKey, otherRider);
});

test('missing, active and mismatched blocks deny before scan; readmission during scan denies results', async () => {
  for (const user of [undefined, { subject, state: 'active' }, { subject: 'synthetic-other', state: 'blocked' }]) {
    const f = fixture(); f.state.user = user;
    await assert.rejects(f.store.readPage(subject), UnauthorizedError); assert.equal(f.state.calls.length, 1);
  }
  const f = fixture([{ Items: [key] }]);
  f.state.beforeScan = () => { f.state.user.state = 'active'; };
  await assert.rejects(f.store.readPage(subject), UnauthorizedError); assert.equal(f.state.calls.length, 3);
});

test('cursors reject wrong subject/table/schema and invalid parameters before I/O', async () => {
  const f = fixture([{ Items: [], LastEvaluatedKey: key }]);
  const { next } = await f.store.readPage(subject); f.state.calls.length = 0;
  for (const cursor of [{ ...next, version: 2 }, { ...next, extra: true }, { ...next, phase: 'unknown' },
    { ...next, key: null }, { ...next, key: { pk: 'invalid' } }, { ...next, key: { ...key, extra: true } },
    { ...next, binding: 'wrong' }, 'bad']) await assert.rejects(f.store.readPage(subject, { cursor }), /cursor/);
  await assert.rejects(f.store.readPage('synthetic-other', { cursor: next }), /cursor/);
  const changed = createBlockedAccountDiscoveryStore({ client: f.client, ...f.config, tableName: 'other-rooms' });
  await assert.rejects(changed.readPage(subject, { cursor: next }), /cursor/);
  for (const limit of [0, -1, 101, 1.5, NaN, Infinity, '1']) await assert.rejects(f.store.readPage(subject, { limit }), /context/);
  for (const value of ['', null, 'x'.repeat(257)]) await assert.rejects(f.store.readPage(value), /context/);
  assert.equal(f.state.calls.length, 0);
  assert.throws(() => createBlockedAccountDiscoveryStore({ client: f.client, ...f.config, tableName: 'sessions' }));
});

test('malformed pages and non-progressing continuations fail closed', async () => {
  for (const page of [{ Items: {} }, { Items: [{ pk: 'unknown' }] }, { Items: [{ ...key, room: {} }] },
    { Items: [key, otherKey] }, { Items: [], LastEvaluatedKey: { pk: 'invalid' } }, { Items: [], LastEvaluatedKey: null }]) {
    const f = fixture([page]); await assert.rejects(f.store.readPage(subject, { limit: 1 }), /Invalid lifecycle discovery/);
  }
  const f = fixture([{ Items: [], LastEvaluatedKey: key }, { Items: [], LastEvaluatedKey: key }]);
  const first = await f.store.readPage(subject);
  await assert.rejects(f.store.readPage(subject, { cursor: first.next }), /continuation/);
  for (const point of [{ ...key, sk: 'invalid' }, locationKey(id, 'synthetic-peer')]) {
    const p = fixture([{ Items: [] }, { Items: [point] }]);
    const rooms = await p.store.readPage(subject);
    await assert.rejects(p.store.readPage(subject, { cursor: rooms.next }), /page/);
  }
});

test('empty LastEvaluatedKey is a terminal page, including an entirely empty table', async () => {
  const f = fixture([{ LastEvaluatedKey: {} }, { Items: [], LastEvaluatedKey: {} }]);
  const rooms = await f.store.readPage(subject);
  assert.deepEqual(rooms.roomIds, []); assert.equal(rooms.next.phase, 'points');
  assert.deepEqual(await f.store.readPage(subject, { cursor: rooms.next }), { roomIds: [], next: null });
});

test('storage errors propagate without progress; retry uses original continuation', async () => {
  const error = new Error('synthetic outage');
  const f = fixture([{ Items: [], LastEvaluatedKey: key }, error, { Items: [otherKey] }]);
  const first = await f.store.readPage(subject); const before = structuredClone(first.next);
  await assert.rejects(f.store.readPage(subject, { cursor: first.next }), (e) => e === error);
  const retry = await f.store.readPage(subject, { cursor: first.next });
  assert.deepEqual(first.next, before); assert.deepEqual(retry.roomIds, [otherId]);
  f.state.beforeGet = () => { throw error; };
  await assert.rejects(f.store.readPage(subject), (e) => e === error);
});

test('copies caller continuation before awaiting the block read', async () => {
  const f = fixture([{ Items: [], LastEvaluatedKey: key }, { Items: [] }]);
  const first = await f.store.readPage(subject);
  f.state.beforeGet = () => { first.next.key.pk = otherKey.pk; };
  await f.store.readPage(subject, { cursor: first.next });
  const scans = f.state.calls.filter((c) => c.constructor.name === 'ScanCommand');
  assert.deepEqual(scans[1].input.ExclusiveStartKey, key);
});


test('durable lifecycle discovery resumes both phases with event-bound cursors and only key projections', async () => {
  const target = locationKey(id, subject), otherRider = locationKey(otherId, 'synthetic-peer');
  const f = fixture([{ Items: [key], LastEvaluatedKey: key }, { Items: [] },
    { Items: [], LastEvaluatedKey: otherRider }, { Items: [target] }], true);
  const first = await f.store.readPage(subject, event, { limit: 1 });
  assert.equal(first.next.binding, hash(JSON.stringify([subject, event, 'rooms', 'sessions', 'locations'])));
  const restarted = createLifecycleDiscoveryStore({ client: f.client, ...f.config });
  const rooms = await restarted.readPage(subject, event, { cursor: JSON.parse(JSON.stringify(first.next)) });
  const empty = await restarted.readPage(subject, event, { cursor: rooms.next });
  const last = await restarted.readPage(subject, event, { cursor: empty.next });
  assert.deepEqual(first.roomIds, [id]); assert.deepEqual(empty.roomIds, []);
  assert.deepEqual(last, { roomIds: [id], next: null });
  const scans = f.state.calls.filter((c) => c.constructor.name === 'ScanCommand');
  assert.deepEqual(scans.map((c) => c.input.ProjectionExpression), ['#pk', '#pk', '#pk, #sk', '#pk, #sk']);
  assert.equal(f.state.calls.length, 12);
});

test('lifecycle discovery rejects temporary, foreign, malformed or expiring holds before scanning', async () => {
  const invalid = [undefined, { subject, state: 'blocked' },
    { ...heldUser(), state: 'active' }, { ...heldUser(), subject: 'synthetic-other' },
    { ...heldUser(), pk: 'USER#wrong' },
    { ...heldUser(), lifecycleHold: { ...heldUser().lifecycleHold, version: 2 } },
    { ...heldUser(), lifecycleHold: { ...heldUser().lifecycleHold, binding: hash('other-event') } },
    { ...heldUser(), lifecycleHold: { ...heldUser().lifecycleHold, startedAt: -1 } },
    { ...heldUser(), lifecycleHold: { ...heldUser().lifecycleHold, extra: true } },
    ...['ttl', 'expiresAt', 'pilotExpiresAt'].map((name) => ({ ...heldUser(), [name]: 0 })),
  ];
  for (const user of invalid) {
    const f = fixture([], true); f.state.user = user;
    await assert.rejects(f.store.readPage(subject, event), /lifecycle hold|not authorised/);
    assert.equal(f.state.calls.length, 1);
  }
});

test('lifecycle discovery rejects hold changes during either scan phase without returning candidates', async () => {
  const changes = [() => undefined, () => ({ subject, state: 'blocked' }),
    () => ({ ...heldUser(), state: 'active' }),
    () => ({ ...heldUser(), lifecycleHold: { ...heldUser().lifecycleHold, binding: hash('other-event') } }),
    () => ({ ...heldUser(), lifecycleHold: { ...heldUser().lifecycleHold, startedAt: 90_001 } }),
    ...['ttl', 'expiresAt', 'pilotExpiresAt'].map((name) => () => ({ ...heldUser(), [name]: 0 })),
  ];
  for (const phase of ['rooms', 'points']) for (const change of changes) {
    const f = fixture(phase === 'rooms' ? [{ Items: [key] }] : [{ Items: [] }, { Items: [locationKey(id, subject)] }], true);
    const cursor = phase === 'points' ? (await f.store.readPage(subject, event)).next : null;
    f.state.beforeScan = () => { f.state.user = change(); };
    await assert.rejects(f.store.readPage(subject, event, { cursor }), /lifecycle hold|not authorised/);
  }
});

test('lifecycle cursors cannot cross events, tables, subjects or temporary reconciliation, and inputs snapshot before I/O', async () => {
  const f = fixture([{ Items: [], LastEvaluatedKey: key }, { Items: [] }], true);
  const { next } = await f.store.readPage(subject, event); f.state.calls.length = 0;
  await assert.rejects(f.store.readPage(subject, 'other-event', { cursor: next }), /cursor/);
  await assert.rejects(f.store.readPage('other-subject', event, { cursor: next }), /cursor/);
  const other = createLifecycleDiscoveryStore({ client: f.client, ...f.config, tableName: 'other-rooms' });
  await assert.rejects(other.readPage(subject, event, { cursor: next }), /cursor/);
  const temporary = createBlockedAccountDiscoveryStore({ client: f.client, ...f.config });
  await assert.rejects(temporary.readPage(subject, { cursor: next }), /cursor/);
  const legacy = { ...next, binding: hash(JSON.stringify([subject, 'rooms', 'sessions', 'locations'])) };
  await assert.rejects(f.store.readPage(subject, event, { cursor: legacy }), /cursor/);
  for (const value of [undefined, null, '', 'x'.repeat(257), {}])
    await assert.rejects(f.store.readPage(subject, value), /event/);
  assert.equal(f.state.calls.length, 0);
  f.state.beforeGet = () => { next.key.pk = otherKey.pk; next.binding = 'wrong'; };
  await f.store.readPage(subject, event, { cursor: next });
  assert.deepEqual(f.state.calls.find((c) => c.constructor.name === 'ScanCommand').input.ExclusiveStartKey, key);
});

test('lifecycle discovery propagates initial/final hold and scan failures; retries retain original cursor', async () => {
  const outage = new Error('synthetic outage');
  for (const failure of ['initial', 'scan', 'final']) {
    const f = fixture([{ Items: [], LastEvaluatedKey: key }, ...(failure === 'scan' ? [outage] : [{ Items: [] }]), { Items: [otherKey] }], true);
    const { next } = await f.store.readPage(subject, event), saved = structuredClone(next);
    let gets = 0;
    f.state.beforeGet = () => { gets++; if ((failure === 'initial' && gets === 1) || (failure === 'final' && gets === 2)) throw outage; };
    await assert.rejects(f.store.readPage(subject, event, { cursor: next }), (e) => e === outage);
    assert.deepEqual(next, saved); f.state.beforeGet = null;
    await f.store.readPage(subject, event, { cursor: next });
    const scans = f.state.calls.filter((c) => c.constructor.name === 'ScanCommand').slice(1);
    assert.ok(scans.every((c) => JSON.stringify(c.input.ExclusiveStartKey) === JSON.stringify(key)));
  }
});
