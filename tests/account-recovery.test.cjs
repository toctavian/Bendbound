const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
function load(file, imports = {}, timers = {}) {
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', outputText)((name) => imports[name], module, module.exports, timers.setTimeout ?? setTimeout, timers.clearTimeout ?? clearTimeout);
  return module.exports;
}
test('provider revocation form encodes refresh credentials and accepts only confirmed HTTP 200', async () => {
  const { revokeCognitoRefreshToken } = load('src/services/auth/providerRevocation.ts');
  let received;
  await revokeCognitoRefreshToken('https://auth.example.test/oauth2/revoke', 'public-client', 'synthetic+/=token', async (url, options) => { received = { url, options }; return { status: 200 }; });
  assert.equal(received.options.method, 'POST'); assert.equal(received.options.headers.Authorization, undefined);
  assert.equal(new URLSearchParams(received.options.body).get('token'), 'synthetic+/=token');
  assert.equal(new URLSearchParams(received.options.body).get('token_type_hint'), 'refresh_token');
  await assert.rejects(revokeCognitoRefreshToken('https://auth.example.test/oauth2/revoke', 'public', 'synthetic', async () => ({ status: 503 })), /could not be confirmed/);
  for (const endpoint of ['http://auth.example.test', 'https://u:p@auth.example.test', 'https://auth.example.test?token=hidden']) await assert.rejects(revokeCognitoRefreshToken(endpoint, 'client', 'synthetic'));
});
test('provider revocation deadline aborts and returns even if a transport ignores abort', async () => {
  let trigger, signal, cleared = false;
  const { revokeCognitoRefreshToken } = load('src/services/auth/providerRevocation.ts', {}, { setTimeout: (fn, duration) => { assert.equal(duration, 10_000); trigger = fn; return 7; }, clearTimeout: (id) => { cleared = id === 7; } });
  const pending = revokeCognitoRefreshToken('https://auth.example.test/oauth2/revoke', 'public', 'synthetic', async (_url, options) => { signal = options.signal; return new Promise(() => {}); });
  trigger(); await assert.rejects(pending, /could not be confirmed/); assert.equal(signal.aborted, true); assert.equal(cleared, true);
});
test('root recovery retries only on launch/foreground, removes listener, and ignores release-disabled accounts', async () => {
  for (const available of [true, false]) {
    let retry = 0, listener, cleanup, removed = false;
    const { useAccountSignOutRecovery } = load('src/hooks/useAccountSignOutRecovery.ts', {
      react: { useEffect: (effect) => { cleanup = effect(); } },
      'react-native': { AppState: { addEventListener: (event, fn) => { assert.equal(event, 'change'); listener = fn; return { remove: () => { removed = true; } }; } } },
      '@/services/auth/cognito': { accountsAvailable: available, retryPendingAccountSignOut: async () => { retry++; throw new Error('offline'); } },
    });
    useAccountSignOutRecovery();
    if (available) { assert.equal(retry, 1); listener('background'); assert.equal(retry, 1); listener('active'); assert.equal(retry, 2); cleanup(); assert.equal(removed, true); }
    else { assert.equal(retry, 0); assert.equal(listener, undefined); }
    await new Promise((resolve) => setImmediate(resolve)); // recovery catches outage
  }
});
test('backend revocation deadline also bounds a stalled response body', async () => {
  let trigger, signal;
  const core = load('src/services/auth/sessionManager.ts');
  const { createGroupSessionClient } = load('src/services/auth/groupSessions.ts', { './sessionManager': core }, { setTimeout: (fn) => { trigger = fn; return 1; }, clearTimeout() {} });
  const api = createGroupSessionClient('https://groups.example.test', async (_url, options) => { signal = options.signal; return { ok: true, json: () => new Promise(() => {}) }; });
  const pending = api.revokeWithSecret('a'.repeat(64));
  trigger(); await assert.rejects(pending, /timed out/); assert.equal(signal.aborted, true);
});
