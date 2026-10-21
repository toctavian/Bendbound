const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
function load(file, imports = {}) {
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)((name) => imports[name], module, module.exports);
  return module.exports;
}
for (const budgetStatus of [null, 429, 503]) test(`app -> session HTTP -> registry: offline logout resumes with budget status ${budgetStatus ?? 'available'}`, async () => {
  const { createSessionApi } = await import('../services/group-rides/src/sessionApi.mjs');
  const { createDynamoSessionRegistry, userKey } = await import('../services/group-rides/src/sessionRegistry.mjs');
  const { LogoutRateLimitedError } = await import('../services/group-rides/src/logoutBudget.mjs');
  const { UnauthorizedError } = await import('../services/group-rides/src/authorizer.mjs');
  const { store } = await import('../services/group-rides/tests/support/fakeDynamo.mjs');
  const core = load('src/services/auth/sessionManager.ts');
  const { createGroupSessionClient } = load('src/services/auth/groupSessions.ts', { './sessionManager': core });
  const at = 1_000_000, principal = { userId: 'synthetic-user', sessionId: 'synthetic-family', expiresAt: at + 120_000, authenticatedAt: at };
  const database = store();
  database.items.set(userKey(principal.userId).pk, { ...userKey(principal.userId), subject: principal.userId, state: 'active', pilotExpiresAt: at + 120_000 });
  const registry = createDynamoSessionRegistry({ client: database.client, tableName: 'synthetic-sessions', now: () => at });
  let budgetBlocked = false;
  let offline = false, accessExpired = false, saved = null, activations = 0, refreshes = 0;
  const api = createSessionApi({ consumeAccountBudget: async () => {}, consumeLogoutBudget: async () => {
    if (budgetBlocked) throw budgetStatus === 429 ? new LogoutRateLimitedError(30) : new Error('budget unavailable');
  }, registry, now: () => at, probeProvider: async () => {}, verifyToken: async (token) => {
    if (accessExpired || token !== 'Bearer synthetic-access') throw new UnauthorizedError(); return principal;
  } });
  const request = async (url, options) => {
    if (offline) throw new Error('offline');
    const response = await api({ rawPath: new URL(url).pathname, requestContext: { http: { method: options.method, sourceIp: '192.0.2.1' } }, headers: options.headers, body: options.body });
    return { ok: response.statusCode === 200, status: response.statusCode, json: async () => JSON.parse(response.body) };
  };
  const client = createGroupSessionClient('https://groups.example.test', request);
  const deps = { binding: 'synthetic-binding', now: () => at, createLogoutSecret: async () => 'a'.repeat(64),
    storage: { read: async () => saved, write: async (value) => { saved = value; }, clear: async () => { saved = null; } },
    refresh: async () => { refreshes++; throw new Error('must not refresh logout'); },
    activate: async (access, account, secret) => { activations++; await client.register(access, account, secret); },
    revoke: async (_refresh, _access, secret) => { await client.revokeWithSecret(secret); },
  };
  const first = core.createSessionManager(deps);
  await first.acceptSignIn({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: at + 120_000,
    account: { id: 'synthetic-user', displayName: 'Rider' } }, first.beginSignIn());
  assert.equal(await registry.active({ subject: principal.userId, familyId: principal.sessionId, expiresAt: principal.expiresAt }), true);
  offline = true; assert.deepEqual(await first.signOut(), { providerRevoked: false }); assert.equal(saved.kind, 'logout');
  offline = false; accessExpired = true; budgetBlocked = budgetStatus !== null;
  const restart = core.createSessionManager(deps); await restart.restore();
  if (budgetBlocked) {
    assert.equal(saved.kind, 'logout'); assert.equal(restart.state().logoutPending, true);
    assert.equal(restart.state().account, null);
    assert.throws(() => restart.beginSignIn());
    assert.equal(await registry.active({ subject: principal.userId, familyId: principal.sessionId, expiresAt: principal.expiresAt }), true);
    budgetBlocked = false; await restart.retrySignOut();
  }
  assert.equal(saved, null); assert.equal(refreshes, 0); assert.equal(activations, 1);
  assert.equal(restart.state().account, null); assert.equal(restart.state().logoutPending, false);
  assert.equal(await registry.active({ subject: principal.userId, familyId: principal.sessionId, expiresAt: principal.expiresAt }), false);
});
