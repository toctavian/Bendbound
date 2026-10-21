import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDynamoSessionRegistry, familyKey, userKey } from '../src/sessionRegistry.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';
import { store } from './support/fakeDynamo.mjs';

const at = 1_000_000;
const session = { subject: 'synthetic-user', familyId: 'synthetic-family', expiresAt: at + 10_000, authenticatedAt: at };
function fixture({ now = () => at, send } = {}) {
  const db = store();
  db.items.set(userKey(session.subject).pk, { ...userKey(session.subject), subject: session.subject,
    state: 'active', pilotExpiresAt: at + 120_000 });
  const registry = createDynamoSessionRegistry({ tableName: 'synthetic-sessions', maxSessionMs: 60_000,
    now, client: { send: (command) => send ? send(command, db) : db.client.send(command) } });
  return { db, registry };
}

test('legacy registration rejects invalid initial clocks before any storage operation', async (t) => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    for (const recovers of [false, true]) {
      await t.test(`${String(invalid)} / recovers ${recovers}`, async () => {
        let samples = 0;
        const f = fixture({ now: () => samples++ === 0 || !recovers ? invalid : at });
        const before = structuredClone(f.db.items);
        await assert.rejects(f.registry.register(session), UnauthorizedError);
        assert.equal(f.db.inputs.length, 0);
        assert.deepEqual(f.db.items, before);
      });
    }
  }
});

test('legacy registration uses one pre-send sample for deadlines, admission and creation time', async () => {
  let samples = 0;
  const f = fixture({ now: () => at + samples++, send: async (command, db) => {
    if (command.constructor.name === 'TransactWriteCommand') {
      assert.equal(samples, 1);
      const [admission, family] = command.input.TransactItems;
      assert.equal(admission.ConditionCheck.ExpressionAttributeValues[':now'], at);
      assert.equal(family.Put.Item.createdAt, at);
      assert.equal(family.Put.Item.expiresAt, at + 60_000);
    }
    return db.client.send(command);
  } });
  await f.registry.register(session);
  assert.equal(samples, 3); // One send sample, then active() before and after reads.
});

test('legacy registration checks exact token/family expiry and authentication tolerance before sending', async (t) => {
  for (const [name, changes, clock, allowed] of [
    ['token last live', { expiresAt: at + 1 }, at, true],
    ['token boundary', { expiresAt: at }, at, false],
    ['family last live', {}, at + 59_999, true],
    ['family boundary', {}, at + 60_000, false],
    ['auth tolerance live', { authenticatedAt: at + 1000 }, at, true],
    ['auth tolerance exceeded', { authenticatedAt: at + 1001 }, at, false],
    ['negative auth time', { authenticatedAt: -1 }, at, false],
    ['invalid token', { expiresAt: Infinity }, at, false],
    ['invalid auth time', { authenticatedAt: NaN }, at, false],
  ]) {
    await t.test(name, async () => {
      const f = fixture({ now: () => clock });
      const value = { ...session, expiresAt: at + 120_000, ...changes };
      if (allowed) await f.registry.register(value);
      else {
        await assert.rejects(f.registry.register(value), UnauthorizedError);
        assert.equal(f.db.inputs.length, 0);
      }
    });
  }
});

test('legacy registration denies a stale write response without erasing its committed family', async (t) => {
  for (const completedAt of [at + 10_000, NaN, Infinity, -Infinity]) {
    await t.test(String(completedAt), async () => {
      let time = at;
      const f = fixture({ now: () => time, send: async (command, db) => {
        const result = await db.client.send(command);
        if (command.constructor.name === 'TransactWriteCommand') time = completedAt;
        return result;
      } });
      await assert.rejects(f.registry.register(session), UnauthorizedError);
      assert.equal(f.db.items.get(familyKey(session.familyId).pk).state, 'active');
      assert.equal(f.db.items.get(familyKey(session.familyId).pk).expiresAt, at + 60_000);
    });
  }
});

test('legacy registration only treats confirmed conditional failures as idempotent reads', async (t) => {
  for (const [name, error, idempotent] of [
    ['conditional', { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] }, true],
    ['conflict', { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'TransactionConflict' }] }, false],
    ['unclassified cancellation', { name: 'TransactionCanceledException' }, false],
    ['outage', { name: 'Error' }, false],
  ]) {
    await t.test(name, async () => {
      let fail = false;
      const failure = Object.assign(new Error('synthetic failure'), error);
      const f = fixture({ send: (command, db) => {
        if (fail && command.constructor.name === 'TransactWriteCommand') throw failure;
        return db.client.send(command);
      } });
      await f.registry.register(session);
      const before = structuredClone(f.db.items);
      fail = true;
      if (idempotent) await f.registry.register(session);
      else await assert.rejects(f.registry.register(session), (caught) => caught === failure);
      assert.deepEqual(f.db.items, before);
    });
  }
});
