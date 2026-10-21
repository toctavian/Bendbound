import { CognitoJwtVerifier } from 'aws-jwt-verify';
export class UnauthorizedError extends Error {
  constructor() { super('Account access is not authorised.'); this.status = 401; }
}
/** Verifies identity only; callers must still check live session and membership. */
export function createAccountTokenVerifier({ userPoolId, clientId, verifier, now = Date.now } = {}) {
  if (!userPoolId || !clientId) throw new Error('Account verification must be configured.');
  const jwtVerifier = verifier ?? CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'access' });
  return async function verifyToken(authorization) {
    if (typeof authorization !== 'string' || authorization.length > 16_384 || !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)) throw new UnauthorizedError();
    let claims;
    try { claims = await jwtVerifier.verify(authorization.slice(7)); } catch { throw new UnauthorizedError(); }
    // JWT verification can await key retrieval; use one clock sample after it.
    const at = now(), authenticatedAt = claims.auth_time * 1000, expiresAt = claims.exp * 1000;
    if (!Number.isFinite(at) || typeof claims.sub !== 'string' || !claims.sub || typeof claims.origin_jti !== 'string' || !claims.origin_jti
      || !Number.isFinite(claims.auth_time) || !Number.isFinite(authenticatedAt) || authenticatedAt < 0 || authenticatedAt - at > 1000
      || !Number.isFinite(claims.exp) || !Number.isFinite(expiresAt) || expiresAt <= at
      || typeof claims.scope !== 'string' || !claims.scope.split(' ').includes('bendbound/groups')) throw new UnauthorizedError();
    return Object.freeze({ userId: claims.sub, sessionId: claims.origin_jti, expiresAt, authenticatedAt });
  };
}
/** No pilot-token fallback; live session status is mandatory, beyond JWT validity. */
export function createAccountAuthorizer({ sessionActive, now = Date.now, ...options } = {}) {
  if (typeof sessionActive !== 'function') throw new Error('A live session registry must be configured.');
  const verifyToken = createAccountTokenVerifier({ ...options, now });
  return async function authorize(authorization) {
    const principal = await verifyToken(authorization);
    try {
      if (!await sessionActive({ subject: principal.userId, familyId: principal.sessionId, expiresAt: principal.expiresAt })) throw new UnauthorizedError();
      // Live-session validation may finish after the verified token expires.
      const at = now();
      if (!Number.isFinite(at) || principal.expiresAt <= at) throw new UnauthorizedError();
    } catch { throw new UnauthorizedError(); }
    return principal;
  };
}
