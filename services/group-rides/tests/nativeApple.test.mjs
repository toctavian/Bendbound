import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync, sign, verify as verifySignature } from 'node:crypto';
import { JwtVerifier } from 'aws-jwt-verify';
import { AppleAuthenticationError, createNativeAppleVerifier, createNativeAppleCodeExchange } from '../src/nativeApple.mjs';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const now = Math.floor(Date.now() / 1000);
const bundleId = 'com.example.synthetic', nonce = 'a'.repeat(64), code = 'synthetic-code';
const verifier = JwtVerifier.create({ issuer: 'https://appleid.apple.com', audience: bundleId, jwksUri: 'https://appleid.apple.com/auth/keys' });
verifier.cacheJwks({ keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'synthetic', alg: 'RS256', use: 'sig' }] });
const verify = createNativeAppleVerifier({ bundleId, verifier });
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(patch = {}) {
  const body = `${encode({ alg: 'RS256', kid: 'synthetic' })}.${encode({ iss: 'https://appleid.apple.com', aud: bundleId,
    sub: 'synthetic-apple-subject', nonce, iat: now, exp: now + 300,
    c_hash: createHash('sha256').update(code).digest().subarray(0, 16).toString('base64url'), ...patch })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), rsa.privateKey).toString('base64url')}`;
}
test('signed native Apple identity binds bundle, nonce and code; web audience is rejected', async () => {
  assert.deepEqual(await verify(jwt(), nonce, code), { provider: 'apple', subject: 'synthetic-apple-subject' });
  for (const patch of [{ aud: 'com.example.synthetic.signin' }, { iss: 'https://attacker.example' }, { nonce: 'b'.repeat(64) },
    { exp: now - 1 }, { iat: now - 301 }, { iat: now + 60 }, { sub: '' }, { c_hash: 'wrong' }]) {
    await assert.rejects(verify(jwt(patch), nonce, code), AppleAuthenticationError);
  }
  await assert.rejects(verify(jwt(), nonce, 'another-code'), AppleAuthenticationError);
  const parts = jwt().split('.'); const claims = JSON.parse(Buffer.from(parts[1], 'base64url')); claims.sub = 'victim'; parts[1] = encode(claims);
  await assert.rejects(verify(parts.join('.'), nonce, code), AppleAuthenticationError);
});
function exchange(request, verifyIdentity = verify) {
  return createNativeAppleCodeExchange({ bundleId, teamId: 'SYNTHETIC1', keyId: 'SYNTHETIC2',
    readSigningKey: async () => ec.privateKey.export({ format: 'pem', type: 'pkcs8' }), verifyIdentity, request });
}
test('native code exchange signs an ES256 client secret for the bundle ID and verifies the returned identity', async () => {
  let calls = 0;
  const run = exchange(async (url, options) => {
    calls++; assert.equal(url, 'https://appleid.apple.com/auth/token'); assert.equal(options.redirect, 'error');
    const params = new URLSearchParams(options.body);
    assert.equal(params.get('client_id'), bundleId); assert.equal(params.get('code'), code); assert.equal(params.has('redirect_uri'), false);
    const [header, payload, signature] = params.get('client_secret').split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'ES256');
    const secret = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(secret.sub, bundleId); assert.equal(secret.iss, 'SYNTHETIC1'); assert.equal(secret.exp - secret.iat, 300);
    assert.equal(verifySignature('sha256', Buffer.from(`${header}.${payload}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
    return { ok: true, json: async () => ({ token_type: 'Bearer', refresh_token: 'synthetic-provider-refresh', id_token: jwt() }) };
  });
  const result = await run({ identityToken: jwt(), authorizationCode: code, nonce });
  assert.equal(calls, 1); assert.equal(result.subject, 'synthetic-apple-subject'); assert.equal(result.refreshToken, 'synthetic-provider-refresh');
});
test('invalid input never exchanges; provider rejection, mismatched exchange identity and outages fail closed', async () => {
  let calls = 0;
  const run = exchange(async () => { calls++; return { ok: false }; });
  await assert.rejects(run({ identityToken: jwt({ nonce: 'b'.repeat(64) }), authorizationCode: code, nonce }), AppleAuthenticationError);
  assert.equal(calls, 0);
  await assert.rejects(run({ identityToken: jwt(), authorizationCode: code, nonce }), AppleAuthenticationError);
  for (const result of [{ token_type: 'Bearer', refresh_token: 'synthetic', id_token: jwt({ sub: 'another-user' }) },
    { token_type: 'Bearer', id_token: jwt() }, { token_type: 'Bearer', refresh_token: 'synthetic', id_token: jwt({ nonce: 'b'.repeat(64) }) }]) {
    await assert.rejects(exchange(async () => ({ ok: true, json: async () => result }))({ identityToken: jwt(), authorizationCode: code, nonce }), AppleAuthenticationError);
  }
  const down = exchange(async () => { throw new Error('sensitive provider diagnostics'); });
  await assert.rejects(down({ identityToken: jwt(), authorizationCode: code, nonce }), (error) => error instanceof AppleAuthenticationError && !error.message.includes('sensitive'));
});
test('refresh material is captured before a later token validation failure; revocation confirms only HTTP200', async () => {
  const { createNativeAppleRevoker } = await import('../src/nativeApple.mjs');
  const captured = [];
  const run = exchange(async () => ({ ok: true, status: 200, json: async () => ({ refresh_token: 'synthetic-refresh', token_type: 'Bearer', id_token: jwt({ sub: 'other' }) }) }));
  await assert.rejects(run({ identityToken: jwt(), authorizationCode: code, nonce, capture: async (token) => { captured.push(token); } }), AppleAuthenticationError);
  assert.deepEqual(captured, ['synthetic-refresh']);
  for (const status of [200, 400, 429, 500]) {
    const revoke = createNativeAppleRevoker({ bundleId, teamId: 'SYNTHETIC1', keyId: 'SYNTHETIC2',
      readSigningKey: async () => ec.privateKey.export({ format: 'pem', type: 'pkcs8' }), request: async (url, options) => {
        assert.equal(url, 'https://appleid.apple.com/auth/revoke'); assert.equal(options.redirect, 'error');
        const params = new URLSearchParams(options.body);
        assert.equal(params.get('token_type_hint'), 'refresh_token'); assert.equal(params.get('token'), 'synthetic-refresh');
        assert.equal(params.get('client_id'), bundleId); return { status };
      } });
    if (status === 200) await revoke('synthetic-refresh'); else await assert.rejects(revoke('synthetic-refresh'), /could not be confirmed/);
  }
});
