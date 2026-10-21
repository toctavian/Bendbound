import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDynamoSessionRegistry, userKey } from '../src/sessionRegistry.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';
import { createLifecycleHoldStore } from '../src/lifecycleHoldStore.mjs';
import { store } from './support/fakeDynamo.mjs';

const subject = 'synthetic-blocked-user', tableName = 'synthetic-sessions';
const at = 1_000_000, lifetime = 60_000;
function fixture({ now = () => at, send } = {}) {
  const db = store();
  const client = { send: (command) => send ? send(command, db) : db.client.send(command) };
  return { db, client, registry: createDynamoSessionRegistry({ client, tableName, now, maxSessionMs: lifetime }) };
}

test('temporary block rejects invalid clocks and nonadvancing retention before storage', async (t) => {
  for (const invalid of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
    await t.test(String(invalid), async () => {
      const f = fixture({ now: () => invalid });
      const row = { ...userKey(subject), subject, state: 'active', pilotExpiresAt: at + lifetime };
      f.db.items.set(row.pk, row);
      await assert.rejects(f.registry.blockUser(subject), UnauthorizedError);
      assert.equal(f.db.inputs.length, 0);
      assert.deepEqual(f.db.items.get(row.pk), row);
    });
  }
});

test('temporary block uses one pre-send sample for its bounded retention deadline', async () => {
  let samples = 0;
  const f = fixture({ now: () => samples++ === 0 ? at : NaN });
  await f.registry.blockUser(subject);
  assert.equal(samples, 1);
  assert.deepEqual(f.db.items.get(userKey(subject).pk), {
    ...userKey(subject), subject, state: 'blocked', expiresAt: at + lifetime,
    ttl: Math.ceil((at + lifetime) / 1000),
  });
});

test('temporary blocks replace only absent or same-subject unheld rows and deny admission', async (t) => {
  for (const state of [undefined, 'active', 'blocked']) {
    await t.test(String(state), async () => {
      const f = fixture();
      if (state) f.db.items.set(userKey(subject).pk, { ...userKey(subject), subject, state,
        pilotExpiresAt: at + lifetime, expiresAt: at - 1, ttl: 1 });
      await f.registry.blockUser(subject);
      const row = f.db.items.get(userKey(subject).pk);
      assert.equal(row.state, 'blocked');
      assert.equal(row.expiresAt, at + lifetime);
      assert.equal(Object.hasOwn(row, 'pilotExpiresAt'), false);
      assert.equal(await f.registry.admitted(subject), false);
      assert.equal(f.db.inputs[0].ConditionExpression,
        'attribute_not_exists(lifecycleHold) AND (attribute_not_exists(pk) OR subject = :subject)');
    });
  }
});

test('temporary blocks retain subject binding and lifecycle hold presence fences', async (t) => {
  for (const previous of [{ subject: 'synthetic-other-user' },
    ...[null, false, {}, { version: 1 }].map((lifecycleHold) => ({ subject, lifecycleHold }))]) {
    await t.test(JSON.stringify(previous), async () => {
      const f = fixture(), row = { ...userKey(subject), state: 'blocked', ...previous };
      f.db.items.set(row.pk, row);
      await assert.rejects(f.registry.blockUser(subject));
      assert.deepEqual(f.db.items.get(row.pk), row);
    });
  }
});

test('a hold acquired after the clock sample prevents a delayed temporary block', async () => {
  let held;
  const f = fixture({ send: async (command, db) => {
    if (command.constructor.name === 'PutCommand') {
      const hold = createLifecycleHoldStore({ client: db.client, tableName, now: () => at });
      held = await hold.begin(subject, 'synthetic-block-race');
    }
    return db.client.send(command);
  } });
  await assert.rejects(f.registry.blockUser(subject));
  assert.deepEqual(f.db.items.get(userKey(subject).pk), held);
  assert.equal(Object.hasOwn(held, 'ttl'), false);
});

test('temporary blocks propagate storage failures and retain committed writes on lost or late responses', async (t) => {
  for (const response of ['outage', 'conditional', 'lost', 'late']) {
    await t.test(response, async () => {
      let time = at;
      const error = Object.assign(new Error('synthetic storage failure'), {
        name: response === 'conditional' ? 'ConditionalCheckFailedException' : 'Error',
      });
      const f = fixture({ now: () => time, send: async (command, db) => {
        if (['outage', 'conditional'].includes(response)) throw error;
        const result = await db.client.send(command);
        time = NaN;
        if (response === 'lost') throw error;
        return result;
      } });
      if (response === 'late') await f.registry.blockUser(subject);
      else await assert.rejects(f.registry.blockUser(subject), (caught) => caught === error);
      assert.equal(f.db.items.size, ['lost', 'late'].includes(response) ? 1 : 0);
      if (f.db.items.size) assert.equal(f.db.items.get(userKey(subject).pk).expiresAt, at + lifetime);
    });
  }
});

test('invalid subjects reject before clock sampling or storage', async () => {
  let samples = 0;
  const f = fixture({ now: () => { samples++; return at; } });
  for (const invalid of ['', null, 'x'.repeat(257)]) {
    await assert.rejects(f.registry.blockUser(invalid), UnauthorizedError);
  }
  assert.equal(samples, 0);
  assert.equal(f.db.inputs.length, 0);
});
