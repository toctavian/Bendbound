import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBlockedAccountRoomStore, createLifecycleRoomStore } from '../src/blockedAccountRoomStore.mjs';
import { userKey } from '../src/sessionRegistry.mjs';
import { hash, locationKey } from '../src/locationKeys.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';
const id = 'a'.repeat(64), subject = 'synthetic-deleted', at = 1_000_000;
const member = (userId) => ({ userId, displayName: 'Synthetic', sharing: true, deviceEpoch: 'synthetic-epoch', deviceFamily: 'synthetic-family' });
const row = (members = [member(subject), member('synthetic-peer')]) => ({ pk: `ROOM#${id}`, revision: 3,
  cleanupBucket: 'ROOMS', purgeAt: 90_000_000, ttl: 90_060,
  room: { id, revision: 3, ownerId: subject, state: 'riding', expiresAt: 4_000_000,
    routeSnapshotId: null, members, invite: { hash: 'synthetic', expiresAt: at + 1000 }, commands: [] } });
const event = 'synthetic-event';
const holdRow = () => ({ ...userKey(subject), subject, state: 'blocked', lifecycleHold: {
  version: 1, binding: hash(JSON.stringify([subject, event, 'sessions'])), startedAt: at,
} });
const cancelled = (codes) => Object.assign(new Error('synthetic cancellation'), {
  name: 'TransactionCanceledException', CancellationReasons: codes.map((Code) => ({ Code })),
});
// Exact request contract fake with atomic failure and table-qualified point keys.
// It deliberately does not claim to execute DynamoDB expressions.
function fixture(initial = row(), lifecycle = false) {
  const state = { row: structuredClone(initial), user: lifecycle ? holdRow() : { subject, state: 'blocked' }, point: { synthetic: true }, calls: [], beforeWrite: null };
  const client = { async send(command) {
    const p = command.input; state.calls.push(command);
    if (command.constructor.name === 'GetCommand') {
      if (state.beforeRead) await state.beforeRead(p);
      if (lifecycle && p.TableName === 'sessions') {
        assert.equal(p.ConsistentRead, true); assert.deepEqual(p.Key, userKey(subject));
        return { Item: structuredClone(state.user) };
      }
      assert.equal(p.TableName, 'rooms'); assert.equal(p.ConsistentRead, true); assert.deepEqual(p.Key, { pk: `ROOM#${id}` });
      return { Item: structuredClone(state.row) };
    }
    assert.equal(command.constructor.name, 'TransactWriteCommand');
    const [gate, metadata, point] = p.TransactItems;
    assert.deepEqual(gate.ConditionCheck, { TableName: 'sessions', Key: userKey(subject),
      ConditionExpression: '#state = :blocked AND subject = :subject' + (lifecycle
        ? ' AND lifecycleHold = :hold AND attribute_not_exists(#ttl) AND attribute_not_exists(expiresAt) AND attribute_not_exists(pilotExpiresAt)' : ''),
      ExpressionAttributeNames: { '#state': 'state', ...(lifecycle ? { '#ttl': 'ttl' } : {}) },
      ExpressionAttributeValues: { ':blocked': 'blocked', ':subject': subject, ...(lifecycle ? { ':hold': holdRow().lifecycleHold } : {}) } });
    assert.deepEqual(point, { Delete: { TableName: 'locations', Key: locationKey(id, subject) } });
    if (state.beforeWrite) await state.beforeWrite();
    const m = metadata.Put ?? metadata.ConditionCheck;
    assert.equal(m.TableName, 'rooms');
    const matched = m.ConditionExpression === 'attribute_not_exists(pk)' ? !state.row
      : state.row?.revision === m.ExpressionAttributeValues[':revision'];
    if (state.user?.state !== 'blocked' || state.user.subject !== subject) throw cancelled(['ConditionalCheckFailed', 'None', 'None']);
    if (lifecycle && (!assertHoldMatches(state.user, gate.ConditionCheck.ExpressionAttributeValues[':hold'])))
      throw cancelled(['ConditionalCheckFailed', 'None', 'None']);
    if (!matched) throw cancelled(['None', 'ConditionalCheckFailed', 'None']);
    if (metadata.Put) state.row = structuredClone(metadata.Put.Item);
    state.point = undefined;
    if (state.afterWrite) await state.afterWrite();
    return {};
  } };
  const factory = lifecycle ? createLifecycleRoomStore : createBlockedAccountRoomStore;
  const store = factory({ client, tableName: 'rooms', sessionTableName: 'sessions', locationTableName: 'locations', now: () => at });
  return { state, store };
}
function assertHoldMatches(user, hold) {
  return JSON.stringify(user?.lifecycleHold) === JSON.stringify(hold)
    && !['ttl', 'expiresAt', 'pilotExpiresAt'].some((k) => Object.hasOwn(user ?? {}, k));
}

test('blocked owner removal erases membership/point, transfers owner, invalidates invite; retry is harmless', async () => {
  const { state, store } = fixture(), peer = structuredClone(state.row.room.members[1]);
  assert.deepEqual(await store.purgeRoom(subject, id), { membershipRemoved: true });
  assert.equal(state.row.revision, 4); assert.equal(state.row.room.revision, 4);
  assert.equal(state.row.room.ownerId, peer.userId); assert.equal(state.row.room.invite, null);
  assert.deepEqual(state.row.room.members, [peer]); assert.equal(state.point, undefined);
  assert.equal(state.row.purgeAt, 90_000_000); assert.equal(state.row.ttl, 90_060);
  const after = structuredClone(state.row);
  assert.deepEqual(await store.purgeRoom(subject, id), { membershipRemoved: false });
  assert.deepEqual(state.row, after);
});
test('member removal preserves owner and other riders, including their publication grants', async () => {
  const initial = row([member('synthetic-owner'), member(subject), member('synthetic-peer')]); initial.room.ownerId = 'synthetic-owner';
  const { state, store } = fixture(initial);
  await store.purgeRoom(subject, id);
  assert.equal(state.row.room.ownerId, 'synthetic-owner');
  assert.deepEqual(state.row.room.members, [initial.room.members[0], initial.room.members[2]]);
  assert.equal(state.row.room.state, 'riding'); assert.equal(state.row.room.invite, null);
});
test('last member ends room, removes retained owner and never extends metadata retention', async () => {
  for (const deadline of [90_000_000, 500_000]) {
    const initial = row([member(subject)]); initial.purgeAt = deadline; initial.ttl = Math.ceil((deadline + 60_000) / 1000);
    const { state, store } = fixture(initial); await store.purgeRoom(subject, id);
    assert.equal(state.row.room.state, 'ended'); assert.equal(state.row.room.endedAt, at);
    assert.equal(state.row.room.ownerId, null); assert.deepEqual(state.row.room.members, []);
    assert.equal(state.row.purgeAt, Math.min(deadline, at + 86_400_000 - 60_000));
    assert.equal(state.row.ttl, Math.min(initial.ttl, Math.ceil((at + 86_400_000) / 1000)));
  }
});
test('legacy empty ended room scrubs owner without extending original end/retention', async () => {
  const initial = row([]); initial.room.state = 'ended'; initial.room.endedAt = at - 1000;
  const { state, store } = fixture(initial); await store.purgeRoom(subject, id);
  assert.equal(state.row.room.ownerId, null); assert.equal(state.row.room.endedAt, at - 1000);
  assert.equal(state.row.room.revision, 4);
});
test('absent membership or absent room still erases orphan point under the block gate', async () => {
  const initial = row([member('synthetic-peer')]); initial.room.ownerId = 'synthetic-peer';
  for (const item of [initial, undefined]) {
    const { state, store } = fixture(item); if (!item) state.row = undefined;
    assert.deepEqual(await store.purgeRoom(subject, id), { membershipRemoved: false });
    assert.deepEqual(state.row, item); assert.equal(state.point, undefined);
  }
});
test('active, absent, mismatched and concurrently readmitted accounts fail atomically', async () => {
  for (const user of [undefined, { subject, state: 'active' }, { subject: 'synthetic-other', state: 'blocked' }]) {
    const { state, store } = fixture(); const before = structuredClone(state.row);
    state.user = user;
    await assert.rejects(store.purgeRoom(subject, id), UnauthorizedError);
    assert.deepEqual(state.row, before); assert.ok(state.point);
  }
  const { state, store } = fixture(); const before = structuredClone(state.row);
  state.beforeWrite = async () => { state.user.state = 'active'; };
  await assert.rejects(store.purgeRoom(subject, id), UnauthorizedError);
  assert.deepEqual(state.row, before); assert.ok(state.point);
});
test('revision race retries with current membership and preserves unrelated concurrent edits', async () => {
  const { state, store } = fixture();
  state.beforeWrite = async () => {
    state.beforeWrite = null; state.row.revision++; state.row.room.revision++;
    state.row.room.title = 'Concurrent title'; state.row.room.members.push(member('synthetic-new-peer'));
  };
  await store.purgeRoom(subject, id);
  assert.equal(state.row.revision, 5); assert.equal(state.row.room.title, 'Concurrent title');
  assert.deepEqual(state.row.room.members.map((m) => m.userId), ['synthetic-peer', 'synthetic-new-peer']);
});
test('bounded conflicts and unclassified/storage failures never report successful erasure', async () => {
  const { state, store } = fixture();
  state.beforeWrite = async () => { state.row.revision++; state.row.room.revision++; };
  await assert.rejects(store.purgeRoom(subject, id), { code: 'ROOM_BUSY' });
  assert.equal(state.calls.filter((c) => c.constructor.name === 'TransactWriteCommand').length, 6); assert.ok(state.point);
  for (const error of [new Error('synthetic outage'), cancelled(['None', 'ProvisionedThroughputExceeded', 'None']),
    cancelled(['None', 'TransactionConflict', 'ConditionalCheckFailed']),
    Object.assign(new Error('unknown cancellation'), { name: 'TransactionCanceledException' })]) {
    const f = fixture(); f.state.beforeWrite = async () => { throw error; };
    await assert.rejects(f.store.purgeRoom(subject, id), (actual) => actual === error); assert.ok(f.state.point);
  }
});
test('invalid context, shared storage and malformed legacy metadata fail closed', async () => {
  assert.throws(() => createBlockedAccountRoomStore({ client: { send() {} }, tableName: 'rooms', sessionTableName: 'rooms', locationTableName: 'locations' }));
  const { state, store } = fixture();
  for (const args of [['', id], [subject, 'invalid'], [subject, null]]) await assert.rejects(store.purgeRoom(...args), /Invalid lifecycle context/);
  assert.equal(state.calls.length, 0);
  for (const patch of [{ revision: 4 }, { room: { ...row().room, members: null } }, { room: { ...row().room, endedAt: NaN } }]) {
    const f = fixture({ ...row(), ...patch }); await assert.rejects(f.store.purgeRoom(subject, id), /Invalid lifecycle room metadata/);
    assert.equal(f.state.calls.length, 1); assert.ok(f.state.point);
  }
});

test('exact-event lifecycle purge preserves owner/member/last-member and orphan erasure semantics', async () => {
  const nonmember = row([member('synthetic-peer')]); nonmember.room.ownerId = 'synthetic-peer';
  const ordinaryMember = row([member('synthetic-owner'), member(subject)]); ordinaryMember.room.ownerId = 'synthetic-owner';
  for (const initial of [row(), ordinaryMember, row([member(subject)]), nonmember, undefined]) {
    const { state, store } = fixture(initial, true); state.row = structuredClone(initial);
    const expected = !!initial?.room.members.some((m) => m.userId === subject);
    assert.deepEqual(await store.purgeRoom(subject, event, id), { membershipRemoved: expected });
    assert.equal(state.point, undefined);
    assert.ok(!state.row?.room.members.some((m) => m.userId === subject));
    assert.notEqual(state.row?.room.ownerId, subject);
    if (expected) assert.equal(state.row.room.invite, null);
    if (initial?.room.members.length === 1 && expected) {
      assert.equal(state.row.room.state, 'ended'); assert.equal(state.row.room.ownerId, null);
      assert.ok(state.row.purgeAt <= initial.purgeAt); assert.ok(state.row.ttl <= initial.ttl);
    }
    const after = structuredClone(state.row);
    assert.deepEqual(await store.purgeRoom(subject, event, id), { membershipRemoved: false });
    assert.deepEqual(state.row, after);
  }
});
test('lifecycle purge rejects missing, temporary, foreign, malformed and expiring holds before room reads', async () => {
  const invalid = [undefined, { subject, state: 'blocked' }, { ...holdRow(), state: 'active' },
    { ...holdRow(), subject: 'synthetic-other' },
    { ...holdRow(), lifecycleHold: { ...holdRow().lifecycleHold, binding: 'b'.repeat(64) } },
    { ...holdRow(), lifecycleHold: { ...holdRow().lifecycleHold, startedAt: -1 } },
    { ...holdRow(), lifecycleHold: { ...holdRow().lifecycleHold, extra: true } },
    { ...holdRow(), ttl: 0 }, { ...holdRow(), expiresAt: 0 }, { ...holdRow(), pilotExpiresAt: 0 }];
  for (const user of invalid) {
    const { state, store } = fixture(row(), true); state.user = user;
    const before = structuredClone(state.row);
    await assert.rejects(store.purgeRoom(subject, event, id));
    assert.equal(state.calls.length, 1); assert.deepEqual(state.row, before); assert.ok(state.point);
  }
  const { state, store } = fixture(row(), true);
  for (const badEvent of ['', null, 'x'.repeat(257)]) await assert.rejects(store.purgeRoom(subject, badEvent, id));
  assert.equal(state.calls.length, 0);
});
test('lifecycle hold changes racing any room or orphan commit cancel all erasure', async () => {
  const changes = [() => undefined, () => ({ subject, state: 'blocked' }), () => ({ ...holdRow(), state: 'active' }),
    () => ({ ...holdRow(), lifecycleHold: { ...holdRow().lifecycleHold, binding: 'b'.repeat(64) } }),
    () => ({ ...holdRow(), lifecycleHold: { ...holdRow().lifecycleHold, startedAt: at + 1 } }),
    ...['ttl', 'expiresAt', 'pilotExpiresAt'].map((k) => () => ({ ...holdRow(), [k]: 0 }))];
  for (const initial of [row(), row([member(subject)]), undefined]) {
    for (const change of changes) {
      const { state, store } = fixture(row(), true); state.row = structuredClone(initial);
      state.beforeWrite = async () => { state.user = change(); };
      await assert.rejects(store.purgeRoom(subject, event, id), UnauthorizedError);
      assert.deepEqual(state.row, initial); assert.ok(state.point);
      assert.equal(state.calls.filter((c) => c.constructor.name === 'TransactWriteCommand').length, 1);
    }
  }
});
test('lifecycle revision retries preserve original hold ownership and concurrent room edits', async () => {
  const { state, store } = fixture(row(), true);
  state.beforeWrite = async () => {
    state.beforeWrite = null; state.row.revision++; state.row.room.revision++; state.row.room.title = 'Concurrent title';
  };
  await store.purgeRoom(subject, event, id);
  assert.equal(state.row.room.title, 'Concurrent title'); assert.equal(state.row.revision, 5);
  assert.equal(state.calls.filter((c) => c.constructor.name === 'GetCommand' && c.input.TableName === 'sessions').length, 2);
  const f = fixture(row(), true);
  f.state.beforeWrite = async () => {
    f.state.beforeWrite = null; f.state.row.revision++; f.state.row.room.revision++;
    // A conflict may precede a privileged hold replacement; retries cannot adopt it.
    throw cancelled(['None', 'ConditionalCheckFailed', 'None']);
  };
  let reads = 0;
  f.state.beforeRead = async (p) => {
    if (p.TableName === 'sessions' && ++reads === 2) f.state.user.lifecycleHold.startedAt++;
  };
  await assert.rejects(f.store.purgeRoom(subject, event, id), UnauthorizedError); assert.ok(f.state.point);
  assert.equal(f.state.calls.filter((c) => c.constructor.name === 'TransactWriteCommand').length, 1);
});
test('lifecycle bounded conflicts and storage/cancellation failures never become erasure success', async () => {
  const { state, store } = fixture(row(), true);
  state.beforeWrite = async () => { state.row.revision++; state.row.room.revision++; };
  await assert.rejects(store.purgeRoom(subject, event, id), { code: 'ROOM_BUSY' });
  assert.equal(state.calls.filter((c) => c.constructor.name === 'TransactWriteCommand').length, 6); assert.ok(state.point);
  for (const error of [new Error('synthetic outage'), cancelled(['None', 'ProvisionedThroughputExceeded', 'None']),
    Object.assign(new Error('unknown cancellation'), { name: 'TransactionCanceledException' })]) {
    for (const phase of ['hold', 'room', 'write']) {
      const f = fixture(row(), true), before = structuredClone(f.state.row);
      if (phase === 'write') f.state.beforeWrite = async () => { throw error; };
      else f.state.beforeRead = async (p) => { if (p.TableName === (phase === 'hold' ? 'sessions' : 'rooms')) throw error; };
      await assert.rejects(f.store.purgeRoom(subject, event, id), (actual) => actual === error);
      assert.deepEqual(f.state.row, before); assert.ok(f.state.point);
    }
  }
});
test('lost lifecycle commit response propagates; confirmed replay is idempotent', async () => {
  const { state, store } = fixture(row(), true), error = new Error('synthetic lost response');
  state.afterWrite = async () => { throw error; };
  await assert.rejects(store.purgeRoom(subject, event, id), (actual) => actual === error);
  assert.equal(state.point, undefined); assert.equal(state.row.room.members.length, 1);
  const committed = structuredClone(state.row); state.afterWrite = null;
  assert.deepEqual(await store.purgeRoom(subject, event, id), { membershipRemoved: false });
  assert.deepEqual(state.row, committed);
});
