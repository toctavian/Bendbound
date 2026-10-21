const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
function load(file, imports = {}) {
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)((name) => imports[name] ?? require(name), module, module.exports);
  return module.exports;
}
const { createSessionManager, SessionExpiredError } = load('src/services/auth/sessionManager.ts');
const { parseAuthConfig } = load('src/services/auth/config.ts');
const now = 1_000_000;
const grant = (overrides = {}) => ({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: now + 120_000, account: { id: 'test-user', displayName: 'Rider' }, ...overrides });
function harness(overrides = {}) {
  let stored = null; let refreshes = 0; let revoked = [];
  const deps = { binding: 'test-issuer|test-client', now: () => now,
    storage: { async read() { return stored; }, async write(value) { stored = value; }, async clear() { stored = null; } },
    async refresh() { refreshes++; return grant({ refreshToken: 'rotated' }); },
    async revoke(token) { revoked.push(token); }, ...overrides };
  return { manager: createSessionManager(deps), deps, setStored: (value) => { stored = value; }, get stored() { return stored; }, get refreshes() { return refreshes; }, get revoked() { return revoked; } };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
test('configuration rejects insecure endpoints and creates fixed callback without secrets', () => {
  assert.equal(parseAuthConfig('', 'client', 'eu-west-2_Test'), null);
  for (const url of ['http://auth.example.test', 'https://u:p@auth.example.test', 'https://auth.example.test/path', 'https://auth.example.test?token=bad', 'https://auth.example.test#token']) assert.equal(parseAuthConfig(url, 'client', 'eu-west-2_Test'), null);
  const c = parseAuthConfig('https://auth.example.test', 'client', 'eu-west-2_Test');
  assert.equal(c.redirectUri, 'bendbound://auth/callback');
  assert.equal(c.issuer, 'https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_Test');
});
test('refresh credential and display metadata are persisted, bound to provider/client; UI never receives tokens', async () => {
  const h = harness(); await h.manager.acceptSignIn(grant(), h.manager.beginSignIn());
  assert.deepEqual(h.stored, { version: 1, binding: h.deps.binding, refreshToken: 'synthetic-refresh', account: grant().account });
  assert.equal(JSON.stringify(h.manager.state()).includes('synthetic-access'), false);
  assert.equal(await h.manager.accessToken(), 'synthetic-access');
});
test('concurrent access requests share one refresh and persist the rotated token', async () => {
  const h = harness(); await h.manager.acceptSignIn(grant({ expiresAt: now + 1000 }), h.manager.beginSignIn());
  const tokens = await Promise.all([h.manager.accessToken(), h.manager.accessToken(), h.manager.accessToken()]);
  assert.equal(h.refreshes, 1); assert.deepEqual(tokens, Array(3).fill('synthetic-access')); assert.equal(h.stored.refreshToken, 'rotated');
});
test('provider rejection clears session, while network failure preserves credentials for recovery', async () => {
  for (const permanent of [true, false]) {
    const h = harness({ refresh: async () => { throw permanent ? new SessionExpiredError() : new Error('network'); } });
    await h.manager.acceptSignIn(grant({ expiresAt: now + 1000 }), h.manager.beginSignIn());
    await assert.rejects(h.manager.accessToken());
    assert.equal(h.stored === null, permanent); assert.equal(h.manager.state().account === null, permanent);
  }
});
test('logout while refresh is pending cannot resurrect the account and revokes the saved credential', async () => {
  let complete;
  const h = harness({ refresh: () => new Promise((resolve) => { complete = resolve; }) });
  await h.manager.acceptSignIn(grant({ expiresAt: now + 1000 }), h.manager.beginSignIn());
  const pending = h.manager.accessToken(); const rejected = assert.rejects(pending, SessionExpiredError);
  await flush(); await h.manager.signOut(); complete(grant()); await rejected;
  assert.equal(h.manager.state().account, null); assert.equal(h.stored, null); assert.deepEqual(h.revoked, ['synthetic-refresh']);
});
test('sign-in finishing after logout is rejected', async () => {
  const h = harness(); const attempt = h.manager.beginSignIn(); await h.manager.signOut();
  await assert.rejects(h.manager.acceptSignIn(grant(), attempt), SessionExpiredError); assert.equal(h.stored, null);
});
test('binding changes and corrupt sessions do not restore an account', async () => {
  for (const saved of [{ version: 1, binding: 'another-client', refreshToken: 'synthetic' }, { version: -1 }, 'bad']) {
    const h = harness(); h.setStored(saved); await h.manager.restore(); assert.equal(h.refreshes, 0); assert.equal(h.stored, null);
  }
});
test('remote revocation failure is reported instead of claiming server logout succeeded', async () => {
  const h = harness({ revoke: async () => { throw new Error('network'); } });
  await h.manager.acceptSignIn(grant(), h.manager.beginSignIn());
  assert.deepEqual(await h.manager.signOut(), { providerRevoked: false }); assert.equal(h.stored.kind, 'logout'); assert.equal(h.manager.state().logoutPending, true);
});
test('protected-store write failure does not create a signed-in session', async () => {
  const h = harness({ storage: { read: async () => null, write: async () => { throw new Error('disk'); }, clear: async () => {} } });
  await assert.rejects(h.manager.acceptSignIn(grant(), h.manager.beginSignIn())); assert.equal(h.manager.state().account, null);
});

test('restart refresh retains display metadata and rotated credentials without storing access tokens', async () => {
  const h = harness();
  await h.manager.acceptSignIn(grant(), h.manager.beginSignIn());
  const saved = h.stored;
  let input;
  const restarted = harness({ refresh: async (token, account) => { input = { token, account }; return grant({ refreshToken: 'restart-rotated', account }); } });
  restarted.setStored(saved); await restarted.manager.restore();
  assert.deepEqual(input, { token: 'synthetic-refresh', account: grant().account });
  assert.equal(restarted.stored.refreshToken, 'restart-rotated');
  assert.equal('accessToken' in restarted.stored, false);
});

test('backend activation rejects a revoked family and clears rejected credentials', async () => {
  const h = harness({ activate: async () => { throw new SessionExpiredError(); } });
  await assert.rejects(h.manager.acceptSignIn(grant(), h.manager.beginSignIn()), SessionExpiredError);
  assert.equal(h.stored, null); assert.equal(h.manager.state().account, null);
});
test('a temporary activation outage retains the rotated refresh credential for retry', async () => {
  let attempts = 0; const inputs = [];
  const h = harness({ activate: async () => { if (++attempts === 2) throw new Error('backend offline'); },
    refresh: async (token) => { inputs.push(token); return grant({ refreshToken: 'rotation-' + inputs.length }); } });
  await h.manager.acceptSignIn(grant({ expiresAt: now + 1000 }), h.manager.beginSignIn());
  await assert.rejects(h.manager.accessToken()); assert.equal(h.stored.refreshToken, 'rotation-1');
  await h.manager.accessToken(); assert.deepEqual(inputs, ['synthetic-refresh', 'rotation-1']);
});
test('logout passes access proof to the remote revoker and still clears state first', async () => {
  let received;
  const h = harness({ revoke: async (refresh, access) => { received = { refresh, access }; assert.equal(h.manager.state().account, null); } });
  await h.manager.acceptSignIn(grant(), h.manager.beginSignIn()); await h.manager.signOut();
  assert.deepEqual(received, { refresh: 'synthetic-refresh', access: 'synthetic-access' });
});

test('logout during backend activation revokes that unpublished family with its access proof', async () => {
  let complete, received;
  const h = harness({ activate: () => new Promise((resolve) => { complete = resolve; }),
    revoke: async (refresh, access) => { received = { refresh, access }; } });
  const install = h.manager.acceptSignIn(grant(), h.manager.beginSignIn());
  const rejected = assert.rejects(install, SessionExpiredError);
  await flush(); const logout = h.manager.signOut(); complete();
  await rejected; await logout;
  assert.deepEqual(received, { refresh: 'synthetic-refresh', access: 'synthetic-access' });
  assert.equal(h.stored, null); assert.equal(h.manager.state().account, null);
});
test('pending logout survives restart, retries revocation only and cannot restore or sign in', async () => {
  const secret = 'a'.repeat(64); let received;
  const first = harness({ createLogoutSecret: async () => secret, revoke: async () => { throw new Error('offline'); } });
  await first.manager.acceptSignIn(grant(), first.manager.beginSignIn());
  assert.deepEqual(await first.manager.signOut(), { providerRevoked: false });
  assert.deepEqual(first.stored, { version: 2, kind: 'logout', binding: first.deps.binding, refreshToken: 'synthetic-refresh', logoutSecret: secret });
  assert.equal('accessToken' in first.stored, false); assert.equal('account' in first.stored, false);
  let activations = 0;
  const restart = harness({ activate: async () => activations++, revoke: async (refresh, access, proof) => { received = { refresh, access, proof }; } });
  restart.setStored(first.stored);
  await assert.rejects(restart.manager.prepareSignIn());
  await restart.manager.restore();
  assert.deepEqual(received, { refresh: 'synthetic-refresh', access: undefined, proof: secret });
  assert.equal(restart.refreshes, 0); assert.equal(activations, 0); assert.equal(restart.stored, null);
  assert.equal(restart.manager.state().account, null); assert.equal(restart.manager.state().logoutPending, false);
});
test('pending intent is durable before remote revocation and retries are coalesced', async () => {
  let complete, calls = 0;
  const h = harness({ createLogoutSecret: async () => 'a'.repeat(64), revoke: async () => {
    calls++; assert.equal(h.stored.kind, 'logout'); await new Promise((resolve) => { complete = resolve; });
  } });
  await h.manager.acceptSignIn(grant(), h.manager.beginSignIn());
  const first = h.manager.signOut(); await flush();
  const retry = h.manager.retrySignOut();
  assert.throws(() => h.manager.beginSignIn()); await assert.rejects(h.manager.accessToken());
  complete(); await Promise.all([first, retry]); assert.equal(calls, 1); assert.equal(h.stored, null);
});
test('pending logout with another configuration is never sent to the current service or discarded', async () => {
  const h = harness(); const marker = { version: 2, kind: 'logout', binding: 'another-issuer', refreshToken: 'synthetic', logoutSecret: 'b'.repeat(64) };
  h.setStored(marker); await assert.rejects(h.manager.restore());
  assert.deepEqual(h.stored, marker); assert.equal(h.revoked.length, 0); assert.equal(h.manager.state().logoutPending, true);
  await assert.rejects(h.manager.prepareSignIn());
});
test('failed pending-marker write reports failure and can be retried without losing the credential', async () => {
  let saved = null, fail = false;
  const h = harness({ storage: { read: async () => saved, write: async (value) => { if (fail) throw new Error('disk'); saved = value; }, clear: async () => { saved = null; } } });
  await h.manager.acceptSignIn(grant(), h.manager.beginSignIn()); fail = true;
  await assert.rejects(h.manager.signOut()); assert.equal(h.manager.state().account, null);
  assert.equal(saved.version, 1); assert.equal(h.revoked.length, 0);
  fail = false; assert.deepEqual(await h.manager.signOut(), { providerRevoked: true }); assert.equal(saved, null);
});
test('refresh keeps the same revocation secret while a new login receives a new one', async () => {
  let generated = 0; const activated = [];
  const h = harness({ createLogoutSecret: async () => (++generated).toString(16).padStart(64, '0'), activate: async (_token, _account, secret) => activated.push(secret) });
  await h.manager.acceptSignIn(grant({ expiresAt: now + 1000 }), h.manager.beginSignIn());
  await h.manager.accessToken(); assert.equal(generated, 1); assert.equal(activated[0], activated[1]);
  await h.manager.signOut(); await h.manager.acceptSignIn(grant(), h.manager.beginSignIn());
  assert.equal(generated, 2); assert.notEqual(activated[2], activated[0]);
});
test('a failure clearing confirmed logout preserves pending state for an idempotent retry', async () => {
  let saved, fail = true;
  const h = harness({ storage: { read: async () => saved ?? null, write: async (value) => { saved = value; }, clear: async () => { if (fail) throw new Error('disk'); saved = null; } } });
  await h.manager.acceptSignIn(grant(), h.manager.beginSignIn());
  await assert.rejects(h.manager.signOut()); assert.equal(saved.kind, 'logout'); assert.equal(h.manager.state().logoutPending, true);
  fail = false; await h.manager.retrySignOut(); assert.equal(saved, null); assert.equal(h.manager.state().logoutPending, false);
});
test('late refresh after logout is preserved only as pending revocation and never reactivated', async () => {
  let complete;
  const h = harness({ createLogoutSecret: async () => 'a'.repeat(64), refresh: () => new Promise((resolve) => { complete = resolve; }) });
  await h.manager.acceptSignIn(grant({ expiresAt: now + 1000 }), h.manager.beginSignIn());
  const refresh = h.manager.accessToken(), rejected = assert.rejects(refresh, SessionExpiredError);
  await flush(); await h.manager.signOut(); assert.equal(h.stored, null);
  assert.throws(() => h.manager.beginSignIn());
  complete(grant({ refreshToken: 'late-rotated-refresh' })); await rejected;
  assert.equal(h.manager.state().account, null); assert.equal(h.stored.kind, 'logout');
  assert.equal(h.stored.refreshToken, 'late-rotated-refresh'); assert.equal('accessToken' in h.stored, false);
  await h.manager.retrySignOut(); assert.equal(h.stored, null);
});
test('confirmed logout cannot clear a newer pending refresh credential written during revocation', async () => {
  let refreshComplete, revokeComplete, calls = 0;
  const h = harness({ createLogoutSecret: async () => 'a'.repeat(64), refresh: () => new Promise((resolve) => { refreshComplete = resolve; }),
    revoke: async () => { if (++calls === 1) await new Promise((resolve) => { revokeComplete = resolve; }); } });
  await h.manager.acceptSignIn(grant({ expiresAt: now + 1000 }), h.manager.beginSignIn());
  const refresh = h.manager.accessToken(), rejected = assert.rejects(refresh, SessionExpiredError);
  await flush(); const logout = h.manager.signOut(); await flush();
  refreshComplete(grant({ refreshToken: 'late-rotated-refresh' })); await rejected;
  revokeComplete(); assert.deepEqual(await logout, { providerRevoked: false });
  assert.equal(h.stored.refreshToken, 'late-rotated-refresh'); assert.equal(h.stored.kind, 'logout');
  await h.manager.retrySignOut(); assert.equal(h.stored, null); assert.equal(calls, 2);
});

test('display name edit persists without changing identity, tokens or approval and rejects after logout', async () => {
  const h = harness(); await h.manager.acceptSignIn(grant(), h.manager.beginSignIn());
  const before = h.stored;
  await h.manager.updateDisplayName('  Octavian  ');
  assert.equal(h.manager.state().account.displayName, 'Octavian');
  assert.equal(h.stored.account.id, before.account.id);
  assert.equal(h.stored.refreshToken, before.refreshToken);
  for (const invalid of ['', 'x'.repeat(81), 'bad\nname']) await assert.rejects(h.manager.updateDisplayName(invalid));
  await h.manager.signOut();
  await assert.rejects(h.manager.updateDisplayName('Another'));
});
