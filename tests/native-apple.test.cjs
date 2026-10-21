const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const moduleUnderTest = { exports: {} };
new Function('module', 'exports', ts.transpileModule(readFileSync('src/services/auth/nativeApple.ts', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(moduleUnderTest, moduleUnderTest.exports);
const { createNativeAppleClient } = moduleUnderTest.exports;
const challenge = { challengeId: 'a'.repeat(64), nonce: 'b'.repeat(64) };
const credential = { identityToken: 'synthetic-apple', authorizationCode: 'synthetic-code', state: challenge.challengeId };
test('native service sends credentials only in HTTPS POST bodies and forbids redirects', async () => {
  const calls = [];
  const client = createNativeAppleClient('https://auth.example.test', async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => url.endsWith('challenge') ? challenge
      : { accessToken: 'synthetic-cognito', refreshToken: 'synthetic-refresh', expiresIn: 300 } };
  });
  const started = await client.begin();
  assert.deepEqual(await client.complete(started, credential), { accessToken: 'synthetic-cognito', refreshToken: 'synthetic-refresh', expiresIn: 300 });
  assert.equal(calls.length, 2);
  for (const { url, options } of calls) { assert.equal(url.includes('synthetic'), false); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store'); }
  assert.deepEqual(JSON.parse(calls[1].options.body), { challengeId: challenge.challengeId, identityToken: credential.identityToken, authorizationCode: credential.authorizationCode });
});
test('missing endpoint, state mismatch, incomplete Apple credentials and malformed service responses fail closed', async () => {
  for (const value of [undefined, '', 'http://auth.example.test', 'https://u:p@auth.example.test', 'https://auth.example.test/path', 'https://auth.example.test?key=x']) assert.equal(createNativeAppleClient(value), null);
  let calls = 0;
  const client = createNativeAppleClient('https://auth.example.test', async () => { calls++; throw new Error('must not call'); });
  for (const patch of [{ state: 'forged' }, { identityToken: null }, { authorizationCode: null }]) await assert.rejects(client.complete(challenge, { ...credential, ...patch }));
  assert.equal(calls, 0);
  for (const payload of [{ accessToken: credential.identityToken, refreshToken: 'synthetic', expiresIn: 300 },
    { accessToken: 'synthetic-cognito', refreshToken: '', expiresIn: 300 }, { accessToken: 'synthetic-cognito', refreshToken: 'synthetic', expiresIn: 3600 }]) {
    const bad = createNativeAppleClient('https://auth.example.test', async () => ({ ok: true, json: async () => payload }));
    await assert.rejects(bad.complete(challenge, credential));
  }
});
test('approval reference is a typed sign-in outcome, never accepted as an account session', async () => {
  const requestId = 'c'.repeat(64);
  const client = createNativeAppleClient('https://auth.example.test', async () => ({ ok: false, status: 403,
    json: async () => ({ error: 'PILOT_APPROVAL_REQUIRED', requestId }) }));
  await assert.rejects(client.complete(challenge, credential), (error) => error instanceof moduleUnderTest.exports.PilotApprovalRequiredError && error.requestId === requestId);
  const forged = createNativeAppleClient('https://auth.example.test', async () => ({ ok: false, status: 403,
    json: async () => ({ error: 'PILOT_APPROVAL_REQUIRED', requestId: 'https://malicious.example' }) }));
  await assert.rejects(forged.complete(challenge, credential), (error) => !(error instanceof moduleUnderTest.exports.PilotApprovalRequiredError));
});
