import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDynamoSessionRegistry, familyKey, userKey, logoutKey } from '../src/sessionRegistry.mjs';
import { createSessionApi } from '../src/sessionApi.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';
import { store } from './support/fakeDynamo.mjs';

const startedAt = 1_000_000, secret = 'a'.repeat(64);
const session = { subject: 'synthetic-user', familyId: 'synthetic-family', authenticatedAt: startedAt, expiresAt: startedAt + 60_000 };
function fixture({ gate = 'token', existing = false, delayed = 'USER#', elapsed = 1000, retry = false, afterWrite = false } = {}) {
  const db = store(); let time = startedAt, writes = 0;
  const candidate = { ...session, expiresAt: startedAt + (gate === 'token' ? 1000 : 60_000) };
  db.items.set(userKey(session.subject).pk, { ...userKey(session.subject), subject: session.subject, state: 'active', pilotExpiresAt: startedAt + (gate === 'admission' ? 1000 : 60_000) });
  if (existing) {
    const deadline = startedAt + (gate === 'family' || gate === 'capability' ? 1000 : 60_000);
    db.items.set(familyKey(session.familyId).pk, { ...familyKey(session.familyId), subject: session.subject, state: 'active', expiresAt: deadline, logoutKey: logoutKey(secret).pk });
    db.items.set(logoutKey(secret).pk, { ...logoutKey(secret), subject: session.subject, familyKey: familyKey(session.familyId).pk, state: 'active', expiresAt: deadline });
  }
  const registry = createDynamoSessionRegistry({ tableName: 'synthetic-sessions', now: () => time,
    maxSessionMs: gate === 'family' && !existing ? 1000 : 60_000,
    client: { async send(command) {
      if (command.constructor.name === 'TransactWriteCommand') {
        writes++;
        if (retry && writes === 1) {
          time = startedAt + elapsed;
          throw Object.assign(new Error('synthetic conflict'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'TransactionConflict' }] });
        }
        const result = await db.client.send(command);
        if (afterWrite) time = startedAt + elapsed;
        return result;
      }
      const result = await db.client.send(command);
      if (!retry && !afterWrite && command.input.Key.pk.startsWith(delayed)) time = startedAt + elapsed;
      return result;
    } },
  });
  return { db, registry, candidate, writes: () => writes, restoreClock: () => { time = startedAt; } };
}

test('bootstrap rechecks deadlines after each awaited registry read before writing', async (t) => {
  for (const gate of ['token', 'family', 'capability', 'admission']) {
    for (const existing of gate === 'capability' ? [true] : [false, true]) {
      for (const delayed of ['SESSION#', 'LOGOUT#', 'USER#']) {
        for (const elapsed of [999, 1000, 1001, NaN, Infinity, -Infinity]) {
          await t.test(`${gate}/${existing}/${delayed}/${elapsed}`, async () => {
            const h = fixture({ gate, existing, delayed, elapsed });
            const before = structuredClone(h.db.items);
            if (elapsed === 999) {
              await h.registry.registerWithLogout(h.candidate, secret);
              assert.equal(h.writes(), 1);
              assert.equal(h.db.items.get(familyKey(session.familyId).pk).expiresAt,
                existing ? before.get(familyKey(session.familyId).pk).expiresAt : startedAt + (gate === 'family' ? 1000 : 60_000));
            } else {
              await assert.rejects(h.registry.registerWithLogout(h.candidate, secret), UnauthorizedError);
              assert.equal(h.writes(), 0);
              assert.deepEqual(h.db.items, before);
            }
          });
        }
      }
    }
  }
});

test('retry cannot send a second registration after token expiry; live retry remains idempotent', async () => {
  for (const elapsed of [999, 1000, 1001]) {
    const h = fixture({ retry: true, elapsed });
    const before = structuredClone(h.db.items);
    if (elapsed === 999) {
      await h.registry.registerWithLogout(h.candidate, secret); assert.equal(h.writes(), 2);
      const saved = structuredClone(h.db.items);
      await h.registry.registerWithLogout(h.candidate, secret); assert.deepEqual(h.db.items, saved);
    } else {
      await assert.rejects(h.registry.registerWithLogout(h.candidate, secret), UnauthorizedError);
      assert.equal(h.writes(), 1); assert.deepEqual(h.db.items, before);
    }
  }
});

test('completed registration denies stale return without undoing the durable logout binding', async () => {
  for (const gate of ['token', 'family', 'admission']) {
    for (const elapsed of [999, 1000, 1001, NaN, Infinity, -Infinity]) {
      const h = fixture({ gate, afterWrite: true, elapsed });
      if (elapsed === 999) await h.registry.registerWithLogout(h.candidate, secret);
      else await assert.rejects(h.registry.registerWithLogout(h.candidate, secret), UnauthorizedError);
      assert.equal(h.writes(), 1);
      assert.equal(h.db.items.get(familyKey(session.familyId).pk).logoutKey, logoutKey(secret).pk);
      assert.equal(h.db.items.get(logoutKey(secret).pk).state, 'active');
      // Logout must still revoke a write whose response was denied.
      h.restoreClock();
      await h.registry.revokeWithLogout(secret);
      assert.equal(h.db.items.get(logoutKey(secret).pk).state, 'revoked');
    }
  }
});

test('bootstrap storage failures propagate without success or additional writes', async () => {
  for (const failAt of ['GetCommand', 'TransactWriteCommand']) {
    const db = store();
    db.items.set(userKey(session.subject).pk, { ...userKey(session.subject), subject: session.subject, state: 'active', pilotExpiresAt: startedAt + 60_000 });
    const before = structuredClone(db.items), failure = new Error('synthetic storage failure');
    const registry = createDynamoSessionRegistry({ tableName: 'synthetic-sessions', now: () => startedAt,
      client: { async send(command) { if (command.constructor.name === failAt) throw failure; return db.client.send(command); } },
    });
    await assert.rejects(registry.registerWithLogout(session, secret), (error) => error === failure);
    assert.deepEqual(db.items, before);
  }
});

test('session API denies expired post-I/O success for bootstrap and status using the response clock', async () => {
  for (const method of ['POST', 'GET']) {
    for (const elapsed of [999, 1000, 1001, NaN, Infinity, -Infinity]) {
      let time = startedAt, completed = 0;
      const complete = async () => { completed++; time = startedAt + elapsed; return true; };
      const api = createSessionApi({ now: () => time,
        verifyToken: async () => ({ userId: session.subject, sessionId: session.familyId, authenticatedAt: startedAt, expiresAt: startedAt + 1000 }),
        consumeAccountBudget: async () => {}, consumeLogoutBudget: async () => {}, probeProvider: async () => {},
        registry: { admitted: async () => true, registerWithLogout: complete, active: complete, revoke: async () => {}, revokeWithLogout: async () => {} },
      });
      const response = await api({ rawPath: '/v1/session', headers: { authorization: 'Bearer synthetic-token' },
        requestContext: { http: { method } }, ...(method === 'POST' ? { body: JSON.stringify({ logoutSecret: secret }) } : {}) });
      assert.equal(completed, 1);
      assert.equal(response.statusCode, elapsed === 999 ? 200 : 401);
      assert.deepEqual(JSON.parse(response.body), elapsed === 999
        ? { userId: session.subject, expiresAt: startedAt + 1000, serverTime: startedAt + elapsed }
        : { error: 'UNAUTHORIZED' });
      assert.equal(response.headers['Cache-Control'], 'no-store');
    }
  }
});

test('invalid initial clock denies registration before any storage access', async () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    let sends = 0;
    const registry = createDynamoSessionRegistry({ tableName: 'synthetic-sessions', now: () => invalid,
      client: { async send() { sends++; throw new Error('unexpected storage access'); } },
    });
    await assert.rejects(registry.registerWithLogout(session, secret), UnauthorizedError);
    assert.equal(sends, 0);
  }
});

test('existing longer family cannot bypass authentication lifetime consumed during reads', async () => {
  const h = fixture({ existing: true, gate: 'family', elapsed: 1000 });
  // Seed a legacy longer family, while authentication lifetime remains 1000ms.
  h.db.items.get(familyKey(session.familyId).pk).expiresAt = startedAt + 60_000;
  h.db.items.get(logoutKey(secret).pk).expiresAt = startedAt + 60_000;
  const registry = createDynamoSessionRegistry({ tableName: 'synthetic-sessions', maxSessionMs: 1000,
    now: () => h.db.inputs.length === 0 ? startedAt : startedAt + 1000, client: h.db.client });
  const before = structuredClone(h.db.items);
  await assert.rejects(registry.registerWithLogout(session, secret), UnauthorizedError);
  assert.deepEqual(h.db.items, before);
  assert.equal(h.db.inputs.filter((input) => input.TransactItems).length, 0);
});
