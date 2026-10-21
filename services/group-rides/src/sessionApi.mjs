import { validLogoutSecret } from './sessionRegistry.mjs';
import { AccountRateLimitedError } from './accountBudget.mjs';
import { LogoutRateLimitedError } from './logoutBudget.mjs';
import { UnauthorizedError } from './authorizer.mjs';
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const result = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
/** HTTP API v2 Lambda handler; no cookies, credential query parameters or body IDs. */
export function createSessionApi({ verifyToken, registry, probeProvider, consumeLogoutBudget, consumeAccountBudget, now = Date.now }) {
  if (![verifyToken, probeProvider, consumeLogoutBudget, consumeAccountBudget, registry?.registerWithLogout, registry?.admitted, registry?.active, registry?.revoke, registry?.revokeWithLogout].every((value) => typeof value === 'function')) throw new Error('Session API must be configured.');
  return async function handler(event) {
    const method = event.requestContext?.http?.method;
    const path = event.rawPath;
    const logout = path === '/v1/session/logout' && method === 'POST';
    if (!logout && (path !== '/v1/session' || !['POST', 'GET', 'DELETE'].includes(method))) return result(404, { error: 'NOT_FOUND' });
    if ((event.rawQueryString ?? '') !== '') return result(400, { error: 'INVALID_REQUEST' });
    let secret;
    if (logout || method === 'POST') {
      try {
        const raw = event.body ?? '';
        if (typeof raw !== 'string' || raw.length > 1024) throw new Error();
        const input = JSON.parse(event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
          || !validLogoutSecret(input.logoutSecret)) throw new Error();
        secret = input.logoutSecret;
      } catch { return result(400, { error: 'INVALID_REQUEST' }); }
    } else if ((event.body ?? '') !== '') return result(400, { error: 'INVALID_REQUEST' });
    const auth = event.headers?.authorization ?? event.headers?.Authorization;
    try {
      if (logout) { await consumeLogoutBudget(event.requestContext?.http?.sourceIp); await registry.revokeWithLogout(secret); return result(200, { revoked: true }); }
      const principal = await verifyToken(auth);
      await consumeAccountBudget(method === 'POST' ? 'bootstrap' : method === 'DELETE' ? 'logout' : 'status', principal.userId);
      const session = { subject: principal.userId, familyId: principal.sessionId, expiresAt: principal.expiresAt, authenticatedAt: principal.authenticatedAt };
      if (method === 'POST') {
        if (!await registry.admitted(principal.userId)) throw new UnauthorizedError();
        // Signature validity alone is insufficient for initial registration.
        await probeProvider(auth.slice(7), principal.userId);
        await registry.registerWithLogout(session, secret);
      } else if (method === 'DELETE') {
        // Signed identity may revoke an unknown family too. Do not require it
        // to be active first; unknown/repeated logout must be safe/idempotent.
        await registry.revoke(session);
        return result(200, { revoked: true });
      } else if (!await registry.active(session)) throw new UnauthorizedError();
      const serverTime = now();
      if (!Number.isFinite(serverTime) || !Number.isFinite(principal.expiresAt) || principal.expiresAt <= serverTime) throw new UnauthorizedError();
      return result(200, { userId: principal.userId, expiresAt: principal.expiresAt, serverTime });
    } catch (error) {
      if (error instanceof AccountRateLimitedError) return { ...result(429, { error: 'ACCOUNT_RATE_LIMITED' }), headers: { ...headers, 'Retry-After': String(error.retryAfter) } };
      if (error instanceof LogoutRateLimitedError) return { ...result(429, { error: 'LOGOUT_RATE_LIMITED' }), headers: { ...headers, 'Retry-After': String(error.retryAfter) } };
      if (error instanceof UnauthorizedError) return result(401, { error: 'UNAUTHORIZED' });
      // Never expose SDK exception strings, credentials or request bodies.
      return result(503, { error: 'ACCOUNT_SERVICE_UNAVAILABLE' });
    }
  };
}
