import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnauthorizedError } from '../src/authorizer.mjs';
import { createDynamoSessionRegistry, familyKey, userKey } from '../src/sessionRegistry.mjs';
import { store } from './support/fakeDynamo.mjs';

const at = 1_000_000;
const session = { subject: 'synthetic-user', familyId: 'synthetic-family',
  expiresAt: at + 120_000, authenticatedAt: at };
const malformed = [
  ['numeric string', String(at + 60_000)], ['infinite string', 'Infinity'],
  ['positive infinity', Infinity], ['negative infinity', -Infinity], ['NaN', NaN],
  ['missing', undefined], ['null', null], ['true', true], ['false', false],
  ['empty string', ''], ['empty array', []], ['numeric array', [at + 60_000]],
  ['object', {}], ['bigint', BigInt(at + 60_000)],
];
function setup(deadline) {
  const database = store();
  const family = { ...familyKey(session.familyId), subject: session.subject,
    state: 'active', expiresAt: deadline };
  if (deadline === undefined) delete family.expiresAt;
  database.items.set(family.pk, family);
  database.items.set(userKey(session.subject).pk, { ...userKey(session.subject),
    subject: session.subject, state: 'active', pilotExpiresAt: at + 120_000 });
  const registry = createDynamoSessionRegistry({ client: database.client,
    tableName: 'synthetic-sessions', now: () => at, maxSessionMs: 60_000 });
  return { database, registry };
}

test('active denies malformed stored family deadlines without coercion or writes', async (t) => {
  for (const [label, deadline] of malformed) {
    await t.test(label, async () => {
      const { database, registry } = setup(deadline);
      const before = structuredClone(database.items);
      assert.equal(await registry.active(session), false);
      assert.deepEqual(database.items, before);
      assert.equal(database.inputs.length, 2);
      assert.ok(database.inputs.every((input) => input.ConsistentRead === true));
    });
  }
});

test('active accepts only future finite numeric family deadlines', async (t) => {
  for (const deadline of [-1, 0, at - 1, at, at + 0.5, at + 1, Number.MAX_VALUE]) {
    await t.test(String(deadline), async () => {
      const { database, registry } = setup(deadline);
      const before = structuredClone(database.items);
      assert.equal(await registry.active(session), deadline > at);
      assert.deepEqual(database.items, before);
    });
  }
});

test('idempotent registration cannot authorize or replace a malformed stored family', async (t) => {
  for (const [label, deadline] of malformed) {
    await t.test(label, async () => {
      const { database, registry } = setup(deadline);
      const before = structuredClone(database.items);
      await assert.rejects(registry.register(session), UnauthorizedError);
      assert.deepEqual(database.items, before);
      assert.equal(database.inputs.filter((input) => input.TransactItems).length, 1);
      assert.equal(database.inputs.filter((input) => input.ConsistentRead).length, 2);
    });
  }
});

test('finite family deadlines retain subject, state, pilot and hold denial gates', async (t) => {
  for (const gate of ['family subject', 'family state', 'missing family', 'user subject',
    'user state', 'missing user', 'pilot string', 'pilot expiry', 'hold']) {
    await t.test(gate, async () => {
      const { database, registry } = setup(at + 60_000);
      const family = database.items.get(familyKey(session.familyId).pk);
      const user = database.items.get(userKey(session.subject).pk);
      if (gate === 'family subject') family.subject = 'synthetic-other';
      if (gate === 'family state') family.state = 'revoked';
      if (gate === 'missing family') database.items.delete(family.pk);
      if (gate === 'user subject') user.subject = 'synthetic-other';
      if (gate === 'user state') user.state = 'blocked';
      if (gate === 'missing user') database.items.delete(user.pk);
      if (gate === 'pilot string') user.pilotExpiresAt = String(at + 60_000);
      if (gate === 'pilot expiry') user.pilotExpiresAt = at;
      if (gate === 'hold') user.lifecycleHold = null;
      const before = structuredClone(database.items);
      assert.equal(await registry.active(session), false);
      assert.deepEqual(database.items, before);
    });
  }
});
