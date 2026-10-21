import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDynamoSessionRegistry, familyKey, logoutKey } from '../src/sessionRegistry.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';
import { store } from './support/fakeDynamo.mjs';

const at = 1_000_000, lifetime = 60_000, secret = 'c'.repeat(64);
const session = { subject: 'synthetic-user', familyId: 'synthetic-family' };
function fixture({ now = () => at, send, expiry } = {}) {
  const db = store();
  if (expiry !== undefined) {
    db.items.set(logoutKey(secret).pk, { ...logoutKey(secret), ...session, state: 'active',
      familyKey: familyKey(session.familyId).pk, expiresAt: expiry });
    db.items.set(familyKey(session.familyId).pk, { ...familyKey(session.familyId), subject: session.subject,
      state: 'active', logoutKey: logoutKey(secret).pk, expiresAt: expiry });
  }
  const registry = createDynamoSessionRegistry({ tableName: 'synthetic-sessions', maxSessionMs: lifetime,
    now, client: { send: (command) => send ? send(command, db) : db.client.send(command) } });
  return { db, registry };
}

test('revocation rejects invalid clocks without attempting a tombstone write', async (t) => {
  for (const method of ['revoke', 'revokeWithLogout']) {
    for (const invalid of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
      await t.test(`${method} / ${String(invalid)}`, async () => {
        const f = fixture({ now: () => invalid });
        await assert.rejects(f.registry[method](method === 'revoke' ? session : secret), UnauthorizedError);
        assert.equal(f.db.inputs.filter((input) => input.TransactItems || input.UpdateExpression).length, 0);
        assert.equal(f.db.items.size, 0);
      });
    }
  }
});

test('family revocation uses one clock sample for timestamp and full retention', async () => {
  let samples = 0;
  const f = fixture({ now: () => at + samples++ });
  await f.registry.revoke(session);
  const row = f.db.items.get(familyKey(session.familyId).pk);
  assert.equal(row.revokedAt, at);
  assert.equal(row.expiresAt, at + lifetime);
  assert.equal(row.ttl, Math.ceil(row.expiresAt / 1000));
  assert.equal(samples, 1);
});

test('logout uses one post-read sample for exact capability expiry and transaction timestamps', async (t) => {
  for (const remaining of [undefined, -1, 0, 1]) {
    await t.test(`remaining ${remaining}`, async () => {
      let time = at - 100, samples = 0;
      const expiry = remaining === undefined ? undefined : at + remaining;
      const f = fixture({ expiry, now: () => time + samples++, send: async (command, db) => {
        const result = await db.client.send(command);
        if (command.constructor.name === 'GetCommand') { await Promise.resolve(); time = at; }
        return result;
      } });
      await f.registry.revokeWithLogout(secret);
      const transaction = f.db.inputs.find((input) => input.TransactItems).TransactItems;
      const cap = f.db.items.get(logoutKey(secret).pk);
      assert.equal(cap.expiresAt, expiry ?? at + lifetime + 1000);
      assert.equal(cap.ttl, Math.ceil(cap.expiresAt / 1000));
      assert.equal(transaction.length, remaining > 0 ? 2 : 1);
      if (remaining > 0) {
        const row = f.db.items.get(familyKey(session.familyId).pk);
        assert.equal(row.state, 'revoked');
        assert.equal(row.revokedAt, at);
        assert.equal(row.expiresAt, at + lifetime + 1000);
      }
      assert.equal(samples, 1);
    });
  }
});

test('logout retries resample after reads and do not write when the clock becomes invalid', async (t) => {
  for (const invalidRetry of [false, true]) {
    await t.test(`invalid retry ${invalidRetry}`, async () => {
      let time = at, writes = 0, samples = 0;
      const f = fixture({ now: () => { samples++; return time; }, send: (command, db) => {
        if (command.constructor.name === 'TransactWriteCommand' && ++writes === 1) {
          time = invalidRetry ? NaN : at + 10_000;
          throw Object.assign(new Error('synthetic conflict'), { name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'TransactionConflict' }] });
        }
        return db.client.send(command);
      } });
      if (invalidRetry) {
        await assert.rejects(f.registry.revokeWithLogout(secret), UnauthorizedError);
        assert.equal(writes, 1);
        assert.equal(f.db.items.size, 0);
      } else {
        await f.registry.revokeWithLogout(secret);
        assert.equal(writes, 2);
        assert.equal(f.db.items.get(logoutKey(secret).pk).expiresAt, time + lifetime + 1000);
      }
      assert.equal(samples, 2);
    });
  }
});

test('revoked capabilities remain idempotent even if the clock is unavailable', async () => {
  let samples = 0;
  const f = fixture({ now: () => { samples++; return NaN; } });
  f.db.items.set(logoutKey(secret).pk, { ...logoutKey(secret), state: 'revoked', expiresAt: at });
  const before = structuredClone(f.db.items);
  await f.registry.revokeWithLogout(secret);
  assert.equal(samples, 0);
  assert.deepEqual(f.db.items, before);
});

test('logout rejects invalid stored deadlines without replacing capability or family', async (t) => {
  for (const expiry of [NaN, Infinity, -Infinity, 'invalid', null]) {
    await t.test(String(expiry), async () => {
      const f = fixture({ expiry });
      const before = structuredClone(f.db.items);
      await assert.rejects(f.registry.revokeWithLogout(secret), UnauthorizedError);
      assert.equal(f.db.inputs.length, 1); // Strongly consistent read only.
      assert.deepEqual(f.db.items, before);
    });
  }
});

test('logout validates the clock after its read and preserves active families on denial', async () => {
  let time = at;
  const f = fixture({ expiry: at + 1, now: () => time, send: async (command, db) => {
    const result = await db.client.send(command);
    time = NaN;
    return result;
  } });
  const before = structuredClone(f.db.items);
  await assert.rejects(f.registry.revokeWithLogout(secret), UnauthorizedError);
  assert.equal(f.db.inputs.length, 1);
  assert.deepEqual(f.db.items, before);
});

test('logout rereads concurrent registration on conditional conflict and retains retry bounds', async (t) => {
  for (const busy of [false, true]) {
    await t.test(`busy ${busy}`, async () => {
      let time = at, writes = 0;
      const f = fixture({ now: () => time, send: (command, db) => {
        if (command.constructor.name === 'TransactWriteCommand') {
          writes++;
          if (busy || writes === 1) {
            db.items.set(logoutKey(secret).pk, { ...logoutKey(secret), subject: session.subject,
              state: 'active', familyKey: familyKey(session.familyId).pk, expiresAt: at + lifetime });
            db.items.set(familyKey(session.familyId).pk, { ...familyKey(session.familyId), subject: session.subject,
              state: 'active', logoutKey: logoutKey(secret).pk, expiresAt: at + lifetime });
            time += 1000;
            throw Object.assign(new Error('synthetic concurrent registration'), { name: 'TransactionCanceledException',
              CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
          }
        }
        return db.client.send(command);
      } });
      if (busy) {
        await assert.rejects(f.registry.revokeWithLogout(secret), /Session revocation busy/);
        assert.equal(writes, 6);
        assert.equal(f.db.items.get(familyKey(session.familyId).pk).state, 'active');
      } else {
        await f.registry.revokeWithLogout(secret);
        assert.equal(writes, 2);
        const row = f.db.items.get(familyKey(session.familyId).pk);
        assert.equal(row.state, 'revoked');
        assert.equal(row.revokedAt, time);
        assert.equal(row.expiresAt, time + lifetime + 1000);
        assert.equal(f.db.items.get(logoutKey(secret).pk).expiresAt, at + lifetime);
      }
    });
  }
});

test('revocation keeps committed tombstones on late responses and propagates storage failures', async (t) => {
  for (const method of ['revoke', 'revokeWithLogout']) {
    for (const failure of ['none', 'outage', 'unclassified cancellation']) {
      await t.test(`${method} / ${failure}`, async () => {
        let time = at;
        const error = Object.assign(new Error('synthetic storage failure'), {
          name: failure === 'outage' ? 'Error' : 'TransactionCanceledException',
        });
        const f = fixture({ now: () => time, send: async (command, db) => {
          if (command.constructor.name !== 'GetCommand' && failure !== 'none') throw error;
          const result = await db.client.send(command);
          if (command.constructor.name !== 'GetCommand') time = NaN;
          return result;
        } });
        const call = () => f.registry[method](method === 'revoke' ? session : secret);
        if (failure !== 'none') {
          await assert.rejects(call(), (caught) => caught === error);
          assert.equal(f.db.items.size, 0);
        } else {
          await call();
          const key = method === 'revoke' ? familyKey(session.familyId) : logoutKey(secret);
          assert.equal(f.db.items.get(key.pk).state, 'revoked');
        }
      });
    }
  }
});
