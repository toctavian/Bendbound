import { createHash, createPrivateKey, sign, timingSafeEqual } from 'node:crypto';
import { JwtVerifier } from 'aws-jwt-verify';
const issuer = 'https://appleid.apple.com';
export class AppleAuthenticationError extends Error {
  constructor() { super('Apple sign-in could not be verified.'); this.status = 401; }
}
const equal = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
/** Native audience is the bundle ID, not the web Services ID. No email linking. */
export function createNativeAppleVerifier({ bundleId, verifier, now = Date.now } = {}) {
  if (!bounded(bundleId, 255)) throw new Error('The native Apple audience must be configured.');
  const jwtVerifier = verifier ?? JwtVerifier.create({ issuer, audience: bundleId,
    jwksUri: `${issuer}/auth/keys`,
    customJwtCheck: ({ header }) => { if (header.alg !== 'RS256') throw new AppleAuthenticationError(); },
  });
  return async function verify(identityToken, nonce, authorizationCode) {
    try {
      if (!bounded(identityToken, 16_384) || !/^[a-f0-9]{64}$/.test(nonce ?? '')
        || !bounded(authorizationCode, 4096)) throw new AppleAuthenticationError();
      const claims = await jwtVerifier.verify(identityToken);
      const at = now() / 1000;
      if (!Number.isFinite(at) || claims.iss !== issuer || claims.aud !== bundleId
        || !bounded(claims.sub, 255) || !equal(claims.nonce, nonce)
        || !Number.isSafeInteger(claims.iat) || claims.iat < 0 || claims.iat > at + 5 || at - claims.iat > 300
        || !Number.isSafeInteger(claims.exp) || claims.exp <= at || claims.exp <= claims.iat) throw new AppleAuthenticationError();
      // When Apple supplies c_hash, bind the returned code to this signed token.
      if (claims.c_hash !== undefined) {
        const hash = createHash('sha256').update(authorizationCode).digest().subarray(0, 16).toString('base64url');
        if (!equal(claims.c_hash, hash)) throw new AppleAuthenticationError();
      }
      return Object.freeze({ provider: 'apple', subject: claims.sub });
    } catch { throw new AppleAuthenticationError(); }
  };
}
/** A definite token-endpoint rejection; no new token was returned for this call. */
export class AppleExchangeRejectedError extends AppleAuthenticationError {}
export function createAppleClientSecret({ bundleId, teamId, keyId, readSigningKey, now = Date.now }) {
  if (!bounded(bundleId, 255) || !/^[A-Z0-9]{10}$/.test(teamId ?? '') || !/^[A-Z0-9]{10}$/.test(keyId ?? '')
    || typeof readSigningKey !== 'function') throw new Error('Apple signing must be configured.');
  return async () => {
    const at = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('Apple signing clock unavailable.');
    const key = createPrivateKey(await readSigningKey());
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Apple signing key is not configured correctly.');
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const body = `${encode({ alg: 'ES256', kid: keyId })}.${encode({ iss: teamId, iat: at, exp: at + 300, aud: issuer, sub: bundleId })}`;
    return `${body}.${sign('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
}
async function revoke({ bundleId, clientSecret, refreshToken, request }) {
  if (!bounded(refreshToken, 16_384)) throw new Error('Apple revocation material unavailable.');
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await request(`${issuer}/auth/revoke`, { method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: controller.signal,
      body: new URLSearchParams({ client_id: bundleId, client_secret: clientSecret, token: refreshToken, token_type_hint: 'refresh_token' }).toString() });
    // Apple documents 200 for a revoked or previously invalidated token. Never
    // infer success from a 400, redirect, outage, timeout or an invalid_grant body.
    if (response.status !== 200) throw new Error();
  } catch { throw new Error('Apple revocation could not be confirmed.'); }
  finally { clearTimeout(timeout); }
}
export function createNativeAppleRevoker(options) {
  const signSecret = createAppleClientSecret(options), request = options.request ?? fetch;
  return async (refreshToken) => revoke({ bundleId: options.bundleId, clientSecret: await signSecret(), refreshToken, request });
}
/** Prepare signing before journalling/contacting Apple; capture refresh material
 * before any subsequent identity validation can fail. Never expose it to clients. */
export function createNativeAppleCodeExchange(options = {}) {
  const { bundleId, verifyIdentity, request = fetch } = options;
  const signSecret = createAppleClientSecret(options);
  if (typeof verifyIdentity !== 'function') throw new Error('Native Apple exchange is not configured.');
  async function prepare() {
    const clientSecret = await signSecret();
    return {
      revoke: (refreshToken) => revoke({ bundleId, clientSecret, refreshToken, request }),
      async exchange({ identityToken, authorizationCode, nonce, capture }) {
        let identity;
        try { identity = await verifyIdentity(identityToken, nonce, authorizationCode); }
        catch { throw new AppleExchangeRejectedError(); }
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8_000);
        try {
          const response = await request(`${issuer}/auth/token`, { method: 'POST', redirect: 'error', cache: 'no-store',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({ client_id: bundleId, client_secret: clientSecret,
              grant_type: 'authorization_code', code: authorizationCode }).toString(), signal: controller.signal });
          if (response.status === 400 || response.status === 401) throw new AppleExchangeRejectedError();
          if (!response.ok) throw new AppleAuthenticationError();
          const result = await response.json();
          if (!result || !bounded(result.refresh_token, 16_384)) throw new AppleAuthenticationError();
          // The production journal requires this capture; the standalone verifier
          // helper also supports synthetic tests without persistence.
          await capture?.(result.refresh_token);
          if (result.token_type?.toLowerCase() !== 'bearer' || !bounded(result.id_token, 16_384)) throw new AppleAuthenticationError();
          const exchanged = await verifyIdentity(result.id_token, nonce, authorizationCode);
          if (!equal(exchanged.subject, identity.subject)) throw new AppleAuthenticationError();
          return Object.freeze({ ...identity, refreshToken: result.refresh_token });
        } catch (error) {
          if (error instanceof AppleExchangeRejectedError) throw error;
          throw new AppleAuthenticationError();
        } finally { clearTimeout(timeout); }
      },
    };
  }
  const exchange = async (input) => (await prepare()).exchange(input);
  exchange.prepare = prepare;
  return exchange;
}
