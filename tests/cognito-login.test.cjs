const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
function load(file, imports) {
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)((name) => {
    if (!(name in imports)) throw new Error(`Unmocked dependency: ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}
const core = load('src/services/auth/sessionManager.ts', {});
function harness(result = 'success', enabled = true, failures = {}) {
  let stored = null, config, exchanged, keychain; let profileRequests = 0; const remote = [];
  const response = () => ({ accessToken: 'synthetic', refreshToken: 'synthetic-refresh', issuedAt: Date.now() / 1000, expiresIn: 300 });
  const sdk = {
    TokenResponse: class { constructor(tokens) { Object.assign(this, tokens); this.issuedAt = Date.now() / 1000; } },
    async refreshAsync() { return { ...response(), refreshToken: 'synthetic-rotated' }; },
  };
  const originalFetch = global.fetch;
  global.fetch = async () => { profileRequests++; return { ok: true, status: 200, json: async () => ({ UserAttributes: [{ Name: 'sub', Value: 'synthetic-user' }, { Name: 'name', Value: 'Test Rider' }] }) }; };
  const previousPreview = process.env.EXPO_PUBLIC_ACCOUNTS_PREVIEW;
  process.env.EXPO_PUBLIC_ACCOUNTS_PREVIEW = enabled ? 'true' : 'false';
  const auth = load('src/services/auth/cognito.ts', {
    'expo-auth-session': sdk,
    'expo-crypto': { getRandomBytesAsync: async () => new Uint8Array(32).fill(17) },
    'expo-apple-authentication': {
      isAvailableAsync: async () => true, AppleAuthenticationScope: { EMAIL: 1, FULL_NAME: 2 }, formatFullName: () => 'Apple Rider',
      async signInAsync(options) {
        config = options;
        if (result === 'cancel') throw { code: 'ERR_REQUEST_CANCELED' };
        return { identityToken: 'synthetic-apple-token', authorizationCode: 'synthetic-code',
          fullName: result === 'name' ? { givenName: 'Apple', familyName: 'Rider' } : null, user: 'synthetic-apple-user',
          state: result === 'wrong-state' ? 'forged' : options.state };
      },
    },
    './nativeApple': { nativeAppleClient: {
      begin: async () => ({ challengeId: 'synthetic-state', nonce: 'synthetic-nonce' }),
      async complete(challenge, credential) {
        if (credential.state !== challenge.challengeId) throw new Error('State mismatch');
        exchanged = { challenge, credential }; return { accessToken: 'synthetic', refreshToken: 'synthetic-refresh', expiresIn: 300 };
      },
    } },
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device-only-after-first-unlock',
      async isAvailableAsync() { return true; }, async getItemAsync() { return stored; },
      async setItemAsync(_key, value, options) { stored = value; keychain = options; }, async deleteItemAsync() { stored = null; },
    },
    'react-native': { Platform: { OS: 'ios' } },
    './sessionManager': core,
    './providerRevocation': { revokeCognitoRefreshToken: async () => { remote.push('provider'); if (failures.provider) throw new Error('offline'); } },
    './groupSessions': { groupSessionApi: { register: async () => {}, revokeWithSecret: async () => { remote.push('backend'); if (failures.backend) throw new Error('offline'); }, revoke: async () => {} } },
    './config': { authConfig: { domain: 'https://auth.example.test', issuer: 'https://issuer.example.test', clientId: 'syntheticclient', redirectUri: 'bendbound://auth/callback' } },
  });
  if (previousPreview === undefined) delete process.env.EXPO_PUBLIC_ACCOUNTS_PREVIEW; else process.env.EXPO_PUBLIC_ACCOUNTS_PREVIEW = previousPreview;
  return { auth, remote, setStored: (value) => { stored = value; }, cleanup: () => { global.fetch = originalFetch; }, get config() { return config; }, get exchanged() { return exchanged; }, get stored() { return stored; }, get keychain() { return keychain; }, get profileRequests() { return profileRequests; } };
}
test('native Apple sheet exchanges bound credentials for Cognito tokens and preserves protected storage', async () => {
  const h = harness();
  try {
    assert.equal(await h.auth.signInWithApple(), true);
    assert.equal(h.config.nonce, 'synthetic-nonce'); assert.equal(h.config.state, 'synthetic-state');
    assert.equal(h.exchanged.credential.authorizationCode, 'synthetic-code');
    assert.equal(h.keychain.keychainAccessible, 'device-only-after-first-unlock');
    assert.equal('accessToken' in JSON.parse(h.stored), false); assert.equal(h.auth.accountSession.state().account.id, 'synthetic-user');
    assert.equal(h.stored.includes('synthetic-apple-token'), false);
  } finally { h.cleanup(); }
});
test('cancellation and mismatched callback state never exchange or persist credentials', async () => {
  for (const result of ['cancel', 'wrong-state']) {
    const h = harness(result);
    try {
      if (result === 'cancel') assert.equal(await h.auth.signInWithApple(), false); else await assert.rejects(h.auth.signInWithApple());
      assert.equal(h.exchanged, undefined); assert.equal(h.stored, null);
    } finally { h.cleanup(); }
  }
});
test('preview must be explicitly enabled; production defaults cannot open account creation', async () => {
  const h = harness('success', false);
  try { assert.equal(h.auth.accountsAvailable, false); await assert.rejects(h.auth.signInWithApple()); assert.equal(h.exchanged, undefined); }
  finally { h.cleanup(); }
});
test('refresh persists rotation without a second profile call that could lose the rotated credential', async () => {
  const h = harness();
  try {
    await h.auth.signInWithApple(); assert.equal(h.profileRequests, 1);
    await h.auth.accountSession.restore(); assert.equal(h.profileRequests, 1);
    assert.equal(JSON.parse(h.stored).refreshToken, 'synthetic-rotated');
  } finally { h.cleanup(); }
});

test('backend and provider revocation are attempted independently and restart retries do not refresh or sign in', async () => {
  const failures = { backend: true };
  const first = harness('success', true, failures);
  let saved;
  try {
    await first.auth.signInWithApple();
    assert.deepEqual(await first.auth.accountSession.signOut(), { providerRevoked: false });
    assert.deepEqual(first.remote.sort(), ['backend', 'provider']);
    saved = first.stored; assert.equal(JSON.parse(saved).kind, 'logout');
    assert.equal(JSON.parse(saved).logoutSecret.length, 64);
    await assert.rejects(first.auth.signInWithApple());
  } finally { first.cleanup(); }
  const restart = harness();
  try {
    restart.setStored(saved); await restart.auth.retryPendingAccountSignOut();
    assert.deepEqual(restart.remote.sort(), ['backend', 'provider']);
    assert.equal(restart.stored, null); assert.equal(restart.profileRequests, 0);
    assert.equal(restart.auth.accountSession.state().account, null);
  } finally { restart.cleanup(); }
});

test('Apple full name becomes display metadata without replacing the verified Cognito subject', async () => {
  const h = harness('name');
  try {
    await h.auth.signInWithApple();
    assert.deepEqual(h.config.requestedScopes, [2, 1]);
    assert.deepEqual(h.auth.accountSession.state().account, { id: 'synthetic-user', displayName: 'Apple Rider' });
  } finally { h.cleanup(); }
});
