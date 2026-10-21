import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLifecycleHoldStore } from '../src/lifecycleHoldStore.mjs';
import { createDynamoSessionRegistry, userKey } from '../src/sessionRegistry.mjs';
import { store } from './support/fakeDynamo.mjs';
const subject = 'synthetic-held-user', event = 'synthetic-lifecycle-event', tableName = 'synthetic-sessions';
const session = { subject, familyId: 'synthetic-held-family', expiresAt: 200_000, authenticatedAt: 100_000 };
// Expression contract fake only; no actual DynamoDB/concurrency/IAM evidence.
function fixture() {
  const db = store(); let at = 100_000;
  const client = { async send(command) {
    try { return await db.client.send(command); }
    catch (error) {
      if (command.constructor.name === 'PutCommand' && error.name === 'TransactionCanceledException')
        throw Object.assign(new Error('synthetic conditional failure'), { name: 'ConditionalCheckFailedException' });
      throw error;
    }
  } };
  return { db, client, advance: () => { at += 100_000; },
    hold: createLifecycleHoldStore({ client, tableName, now: () => at }),
    registry: createDynamoSessionRegistry({ client, tableName, now: () => at }) };
}

test('hold atomically removes TTL and approval from absent, legacy, admitted and temporary-blocked users', async () => {
  for (const old of [undefined, { subject }, { subject, state: 'active', pilotExpiresAt: 200_000 },
    { subject, state: 'blocked', expiresAt: 120_000, ttl: 120 }]) {
    const f = fixture(); if (old) f.db.items.set(userKey(subject).pk, { ...userKey(subject), ...old });
    const row = await f.hold.begin(subject, event);
    assert.deepEqual(row, await f.hold.read(subject, event));
    assert.equal(row.state, 'blocked'); assert.equal(row.lifecycleHold.version, 1);
    assert.equal(row.lifecycleHold.startedAt, 100_000);
    for (const field of ['ttl', 'expiresAt', 'pilotExpiresAt']) assert.equal(Object.hasOwn(row, field), false);
    assert.equal(JSON.stringify(row).includes(event), false);
    const put = f.db.inputs[0]; assert.equal(put.TableName, tableName);
    assert.equal(put.ConditionExpression, 'attribute_not_exists(lifecycleHold) AND (attribute_not_exists(pk) OR subject = :subject)');
  }
});

test('same-event retry preserves hold start; conflicting events and storage contexts cannot claim it', async () => {
  const f = fixture(), original = await f.hold.begin(subject, event); f.advance();
  assert.deepEqual(await f.hold.begin(subject, event), original);
  const restarted = createLifecycleHoldStore({ client: f.client, tableName });
  assert.deepEqual(await restarted.read(subject, event), original);
  await assert.rejects(f.hold.begin(subject, 'synthetic-other-event'), /conflicting/);
  await assert.rejects(f.hold.read(subject, 'synthetic-other-event'), /conflicting/);
  const other = createLifecycleHoldStore({ client: f.client, tableName: 'synthetic-other-table' });
  // The contract fake shares rows across tables; this exercises binding rejection.
  await assert.rejects(other.read(subject, event), /conflicting/);
  assert.deepEqual(await f.hold.read(subject, event), original);
});

test('temporary block before hold is migrated; after hold it cannot restore expiry or overwrite binding', async () => {
  const f = fixture(); await f.registry.blockUser(subject);
  assert.ok(f.db.items.get(userKey(subject).pk).ttl);
  const row = await f.hold.begin(subject, event);
  await assert.rejects(f.registry.blockUser(subject), { name: 'ConditionalCheckFailedException' });
  assert.deepEqual(await f.hold.read(subject, event), row);
  const foreign = fixture(); foreign.db.items.set(userKey(subject).pk, { ...userKey(subject), subject: 'synthetic-other' });
  await assert.rejects(foreign.registry.blockUser(subject));
  await assert.rejects(foreign.hold.begin(subject, event), /conflicting/);
});

test('hold denies existing and new sessions; marker presence also rejects malformed active approval', async () => {
  const f = fixture();
  f.db.items.set(userKey(subject).pk, { ...userKey(subject), subject, state: 'active', pilotExpiresAt: 200_000 });
  await f.registry.register(session); assert.equal(await f.registry.active(session), true);
  await f.hold.begin(subject, event);
  assert.equal(await f.registry.admitted(subject), false); assert.equal(await f.registry.active(session), false);
  await assert.rejects(f.registry.register({ ...session, familyId: 'synthetic-new-family' }));
  await assert.rejects(f.registry.registerWithLogout(session, 'a'.repeat(64)));
  for (const marker of [null, false, {}, { version: 1 }]) {
    const row = { ...userKey(subject), subject, state: 'active', pilotExpiresAt: 200_000, lifecycleHold: marker };
    f.db.items.set(row.pk, row);
    assert.equal(f.registry.allowsUser(row, subject, 100_000), false);
    assert.equal(await f.registry.active(session), false);
    await assert.rejects(f.registry.register(session));
    const gate = f.registry.transactionChecks(session, 100_000)[1].ConditionCheck;
    assert.match(gate.ConditionExpression, /attribute_not_exists\(lifecycleHold\)/);
  }
});

test('admission withdrawn after preflight is atomically rejected at session write', async () => {
  const f = fixture();
  f.db.items.set(userKey(subject).pk, { ...userKey(subject), subject, state: 'active', pilotExpiresAt: 200_000 });
  assert.equal(await f.registry.admitted(subject), true);
  const send = f.client.send;
  f.client.send = async (command) => {
    if (command.constructor.name === 'TransactWriteCommand') await f.hold.begin(subject, event);
    return send(command);
  };
  await assert.rejects(f.registry.register(session));
  assert.equal([...f.db.items.keys()].some((key) => key.startsWith('SESSION#')), false);
});

test('lost response requires reread; arbitrary outages and throttles never become duplicate success', async () => {
  const f = fixture(), send = f.client.send;
  f.client.send = async (command) => {
    const response = await send(command);
    if (command.constructor.name === 'PutCommand') throw new Error('synthetic response lost');
    return response;
  };
  await assert.rejects(f.hold.begin(subject, event), /response lost/);
  const row = await f.hold.read(subject, event); assert.equal(row.state, 'blocked');
  f.client.send = send; assert.deepEqual(await f.hold.begin(subject, event), row);
  for (const name of ['Error', 'ThrottlingException', 'TransactionCanceledException']) {
    const failure = Object.assign(new Error('synthetic outage'), { name });
    f.client.send = async () => { throw failure; };
    await assert.rejects(f.hold.begin(subject, event), (error) => error === failure);
    await assert.rejects(f.hold.read(subject, event), (error) => error === failure);
  }
});

test('malformed holds, identity collisions, inputs and unsafe clocks fail closed', async () => {
  const f = fixture(), row = await f.hold.begin(subject, event);
  for (const corrupt of [{ ...row, ttl: 1 }, { ...row, state: 'active' }, { ...row, subject: 'synthetic-other' },
    { ...row, lifecycleHold: null }, { ...row, lifecycleHold: { ...row.lifecycleHold, version: 2 } },
    { ...row, lifecycleHold: { ...row.lifecycleHold, startedAt: NaN } }]) {
    f.db.items.set(row.pk, corrupt);
    await assert.rejects(f.hold.read(subject, event), /conflicting/);
    await assert.rejects(f.hold.begin(subject, event), /conflicting/);
  }
  for (const value of ['', null, 'x'.repeat(257)]) {
    await assert.rejects(f.hold.begin(value, event), /conflicting/);
    await assert.rejects(f.hold.read(subject, value), /conflicting/);
  }
  for (const at of [NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = createLifecycleHoldStore({ client: f.client, tableName, now: () => at });
    await assert.rejects(bad.begin(subject, event), /conflicting/);
  }
  assert.throws(() => createLifecycleHoldStore({ client: f.client, tableName: '' }));
});

test('competing event requests preserve one subject-wide hold; duplicate contenders converge', async () => {
  const f = fixture();
  const outcomes = await Promise.allSettled([f.hold.begin(subject, event), f.hold.begin(subject, 'synthetic-competing-event')]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1);
  const row = outcomes.find((result) => result.status === 'fulfilled').value;
  assert.deepEqual(f.db.items.get(userKey(subject).pk), row);
  const d = fixture();
  const duplicates = await Promise.all([d.hold.begin(subject, event), d.hold.begin(subject, event)]);
  assert.deepEqual(duplicates[0], duplicates[1]);
  duplicates[0].lifecycleHold.startedAt = 1;
  assert.equal((await d.hold.read(subject, event)).lifecycleHold.startedAt, 100_000);
});
