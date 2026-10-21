import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDynamoSessionRegistry, familyKey, userKey } from '../src/sessionRegistry.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';
import { store } from './support/fakeDynamo.mjs';
const originalTime = 1_000_000;
const account = { subject: 'synthetic-user', familyId: 'synthetic-family', expiresAt: originalTime + 120_000, authenticatedAt: originalTime };
function setup() { let time = originalTime; const database = store(); database.items.set(userKey(account.subject).pk, { ...userKey(account.subject), subject: account.subject, state: 'active', pilotExpiresAt: originalTime + 120_000 }); const registry = createDynamoSessionRegistry({ client: database.client, tableName: 'synthetic-sessions', now: () => time, maxSessionMs: 60_000 }); return { registry, database, advance: (delta) => { time += delta; } }; }
test('unknown family cannot authorise; registration is idempotent and does not extend lifetime', async () => {
  const h = setup(); assert.equal(await h.registry.active(account), false); await h.registry.register(account);
  assert.equal(await h.registry.active(account), true);
  const saved = [...h.database.items.values()].find((item) => item.pk.startsWith('SESSION#')); h.advance(5000); await h.registry.register(account);
  assert.equal([...h.database.items.values()].find((item) => item.pk.startsWith('SESSION#')).expiresAt, saved.expiresAt);
  assert.equal([...h.database.items.keys()].find((key) => key.startsWith('SESSION#')).includes(account.familyId), false);
});
test('revocation tombstones known and unknown families; bootstrap cannot resurrect either', async () => {
  for (const registered of [false, true]) {
    const h = setup(); if (registered) await h.registry.register(account);
    await h.registry.revoke(account); assert.equal(await h.registry.active(account), false);
    await assert.rejects(h.registry.register(account), UnauthorizedError); assert.equal([...h.database.items.values()].find((item) => item.pk.startsWith('SESSION#')).state, 'revoked');
  }
});
test('expired active entries deny access before TTL deletion and cannot renew after physical deletion', async () => {
  const h = setup(); await h.registry.register(account); h.advance(60_001);
  assert.equal(await h.registry.active(account), false);
  h.database.items.clear(); await assert.rejects(h.registry.register(account), UnauthorizedError);
  assert.equal(h.database.items.size, 0);
});
test('blocked users cannot register a new family or use an existing one', async () => {
  const h = setup(); await h.registry.register(account); await h.registry.blockUser(account.subject);
  assert.equal(await h.registry.active(account), false);
  await assert.rejects(h.registry.register({ ...account, familyId: 'another-synthetic-family' }), UnauthorizedError);
});
test('concurrent revocation and registration never overwrite the revoked state', async () => {
  const h = setup(); const results = await Promise.allSettled([h.registry.register(account), h.registry.revoke(account)]);
  assert.equal(results[1].status, 'fulfilled'); assert.equal(await h.registry.active(account), false);
  await assert.rejects(h.registry.register(account), UnauthorizedError);
});
test('storage outages and transaction conflicts do not become successful authorisation', async () => {
  const h = setup(); await h.registry.register(account);
  const registry = createDynamoSessionRegistry({ client: { send: async () => { throw new Error('storage down'); } }, tableName: 'synthetic-sessions' });
  await assert.rejects(registry.active({ ...account, expiresAt: Date.now() + 1000 }));
  await assert.rejects(registry.register({ ...account, expiresAt: Date.now() + 1000, authenticatedAt: Date.now() }));
});

test('active rechecks token, family and admission deadlines after either awaited read', async (t) => {
  for (const gate of ['token', 'family', 'admission']) {
    for (const delayedRead of ['SESSION#', 'USER#']) {
      for (const delta of [999, 1000, 1001]) {
        await t.test(`${gate} / ${delayedRead} / elapsed ${delta}`, async () => {
          const h = setup();
          await h.registry.register(account);
          const session = { ...account, expiresAt: originalTime + (gate === 'token' ? 1000 : 120_000) };
          if (gate === 'family') h.database.items.get(familyKey(account.familyId).pk).expiresAt = originalTime + 1000;
          if (gate === 'admission') h.database.items.get(userKey(account.subject).pk).pilotExpiresAt = originalTime + 1000;
          const before = structuredClone(h.database.items);
          let reads = 0, time = originalTime;
          const registry = createDynamoSessionRegistry({ tableName: 'synthetic-sessions',
            now: () => time,
            client: { async send(command) {
              const result = await h.database.client.send(command);
              // Yield an extra turn on the chosen read; active must await both.
              if (command.input.Key.pk.startsWith(delayedRead)) { await Promise.resolve(); time += delta; }
              reads++;
              return result;
            } },
          });
          assert.equal(await registry.active(session), delta < 1000);
          assert.equal(reads, 2);
          assert.deepEqual(h.database.items, before);
        });
      }
    }
  }
});

test('active fails closed for invalid clocks before or after reads without changing storage', async () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    for (const afterReads of [false, true]) {
      const h = setup(); await h.registry.register(account);
      const before = structuredClone(h.database.items);
      let reads = 0;
      const registry = createDynamoSessionRegistry({ tableName: 'synthetic-sessions',
        now: () => !afterReads || reads === 2 ? invalid : originalTime,
        client: { async send(command) { const result = await h.database.client.send(command); reads++; return result; } },
      });
      assert.equal(await registry.active(account), false);
      assert.equal(reads, afterReads ? 2 : 0);
      assert.deepEqual(h.database.items, before);
    }
  }
});
