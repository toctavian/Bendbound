import { AppleAuthenticationError } from './nativeApple.mjs';
import { NativeEnrollmentRequired } from './nativeAppleStore.mjs';
import { LogoutRateLimitedError } from './logoutBudget.mjs';
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
export function createNativeAppleApi({ apiId, store, consumeBudget, verifyIdentity, exchangeCode, issueSession, admitted }) {
  if (!apiId || ![store?.begin, store?.consumeChallenge, store?.findIdentity,
    consumeBudget, verifyIdentity, exchangeCode, issueSession, admitted].every((fn) => typeof fn === 'function')) throw new Error('Native Apple API must be configured.');
  return async function handler(event) {
    if (event.requestContext?.apiId !== apiId) return reply(503, { error: 'AUTH_SERVICE_UNAVAILABLE' });
    const begin = event.rawPath === '/v1/auth/apple/challenge';
    if (event.requestContext?.http?.method !== 'POST' || !begin && event.rawPath !== '/v1/auth/apple/exchange') return reply(404, { error: 'NOT_FOUND' });
    if (event.rawQueryString || event.headers?.authorization || event.headers?.Authorization) return reply(400, { error: 'INVALID_REQUEST' });
    try {
      // Gateway source IP, never client-supplied forwarding headers/body IDs.
      await consumeBudget(event.requestContext?.http?.sourceIp);
      let input;
      try {
        if (typeof event.body !== 'string' || Buffer.byteLength(event.body) > 30_000) throw new Error();
        const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
        if (Buffer.byteLength(raw) > 22_000) throw new Error();
        input = JSON.parse(raw);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
        const fields = Object.keys(input).sort().join(',');
        if (begin ? fields !== '' : fields !== 'authorizationCode,challengeId,identityToken') throw new Error();
        if (!begin && (typeof input.challengeId !== 'string' || !/^[a-f0-9]{64}$/.test(input.challengeId)
          || typeof input.identityToken !== 'string' || !input.identityToken || input.identityToken.length > 16_384
          || typeof input.authorizationCode !== 'string' || !input.authorizationCode || input.authorizationCode.length > 4096)) throw new Error();
      } catch { return reply(400, { error: 'INVALID_REQUEST' }); }
      if (begin) return reply(200, await store.begin());
      const { nonce } = await store.consumeChallenge(input.challengeId);
      const verified = await verifyIdentity(input.identityToken, nonce, input.authorizationCode);
      let mapping;
      try { mapping = await store.findIdentity(verified.subject); }
      catch (error) {
        if (!(error instanceof NativeEnrollmentRequired)) throw error;
        const pending = await store.requestEnrollment(verified.subject);
        return reply(403, { error: 'PILOT_APPROVAL_REQUIRED', requestId: pending.requestId });
      }
      if (!await admitted(mapping.subject)) throw new AppleAuthenticationError();
      const provider = await exchangeCode({ ...input, nonce }, mapping);
      if (provider.subject !== verified.subject) throw new AppleAuthenticationError();
      // Journalled exchange has already captured/validated provider material.
      // A later issuance failure retains it for hold-gated cleanup.
      if (!await admitted(mapping.subject)) throw new AppleAuthenticationError();
      return reply(200, await issueSession(mapping));
    } catch (error) {
      if (error instanceof LogoutRateLimitedError) return { ...reply(429, { error: 'AUTH_RATE_LIMITED' }),
        headers: { ...headers, 'Retry-After': String(error.retryAfter) } };
      if (error instanceof AppleAuthenticationError) return reply(401, { error: 'UNAUTHORIZED' });
      return reply(503, { error: 'AUTH_SERVICE_UNAVAILABLE' });
    }
  };
}
