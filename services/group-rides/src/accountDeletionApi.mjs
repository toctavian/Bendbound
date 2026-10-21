import { UnauthorizedError } from './authorizer.mjs';
import { LogoutRateLimitedError } from './logoutBudget.mjs';
import { DeletionConflictError } from './accountDeletionStore.mjs';
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const response = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
export function createAccountDeletionApi({ verifyToken, verifyProvider, consumeBudget, jobs, now = Date.now }) {
  return async (event) => {
    const start = event.rawPath === '/v1/account/deletion';
    if (!start && event.rawPath !== '/v1/account/deletion/status' || event.requestContext?.http?.method !== 'POST') return response(404, { error: 'NOT_FOUND' });
    try {
      if (event.rawQueryString || event.isBase64Encoded || typeof event.body !== 'string' || event.body.length > 256) return response(400, { error: 'INVALID_REQUEST' });
      let input;
      try { input = JSON.parse(event.body); } catch { return response(400, { error: 'INVALID_REQUEST' }); }
      if (!input || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.receiptSecret !== 'string' || !/^[a-f0-9]{64}$/.test(input.receiptSecret)) return response(400, { error: 'INVALID_REQUEST' });
      await consumeBudget(event.requestContext.http.sourceIp);
      if (!start) {
        const status = await jobs.status(input.receiptSecret);
        return status ? response(200, status) : response(404, { error: 'NOT_FOUND' });
      }
      const auth = event.headers?.authorization ?? event.headers?.Authorization;
      const principal = await verifyToken(auth);
      const at = now();
      if (!Number.isSafeInteger(at) || principal.expiresAt <= at || at - principal.authenticatedAt > 10 * 60_000) return response(401, { error: 'RECENT_SIGN_IN_REQUIRED' });
      const username = await verifyProvider(auth.slice(7), principal.userId);
      if (principal.expiresAt <= now()) throw new UnauthorizedError();
      await jobs.start({ subject: principal.userId, username }, input.receiptSecret);
      return response(202, { accepted: true });
    } catch (error) {
      if (error instanceof UnauthorizedError) return response(401, { error: 'UNAUTHORIZED' });
      if (error instanceof DeletionConflictError) return response(409, { error: 'USE_ORIGINAL_DELETION_RECEIPT' });
      if (error instanceof LogoutRateLimitedError) return { ...response(429, { error: 'RATE_LIMITED' }), headers: { ...headers, 'Retry-After': String(error.retryAfter) } };
      return response(503, { error: 'DELETION_SERVICE_UNAVAILABLE' });
    }
  };
}
