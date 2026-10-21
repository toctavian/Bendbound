/** An approval reference identifies a verified request; it never authenticates a rider. */
export class PilotApprovalRequiredError extends Error {
  constructor(public readonly requestId: string) { super('Group ride access needs pilot approval.'); }
}
/** Native credentials stay in memory and go only to the configured account service. */
export type NativeAppleCredential = { identityToken: string | null; authorizationCode: string | null; state: string | null };
export type NativeAppleChallenge = { challengeId: string; nonce: string };
export type NativeAppleTokens = { accessToken: string; refreshToken: string; expiresIn: number };
export function createNativeAppleClient(baseUrl: string | undefined, request: typeof fetch = fetch) {
  if (!baseUrl?.trim()) return null;
  let base: string;
  try {
    const url = new URL(baseUrl.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port
      || (url.pathname !== '/' && url.pathname !== '')) return null;
    base = url.origin;
  } catch { return null; }
  async function post(path: string, body: object): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await request(`${base}/v1/auth/apple/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body), cache: 'no-store', redirect: 'error', signal: controller.signal,
      });
      // Never surface provider payloads/codes or forward credentials after redirects.
      if (response.status === 403) {
        const error: unknown = await response.json();
        if (error && typeof error === 'object' && 'error' in error && error.error === 'PILOT_APPROVAL_REQUIRED'
          && 'requestId' in error && typeof error.requestId === 'string' && /^[a-f0-9]{64}$/.test(error.requestId)) {
          throw new PilotApprovalRequiredError(error.requestId);
        }
      }
      if (!response.ok) throw new Error('Apple sign-in could not be completed.');
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  return {
    async begin(): Promise<NativeAppleChallenge> {
      const value = await post('challenge', {});
      if (!value || typeof value !== 'object' || !('challengeId' in value) || !('nonce' in value)
        || typeof value.challengeId !== 'string' || !/^[a-f0-9]{64}$/.test(value.challengeId)
        || typeof value.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(value.nonce)) throw new Error('Apple sign-in is unavailable.');
      return { challengeId: value.challengeId, nonce: value.nonce };
    },
    async complete(challenge: NativeAppleChallenge, credential: NativeAppleCredential): Promise<NativeAppleTokens> {
      if (credential.state !== challenge.challengeId || !credential.identityToken || !credential.authorizationCode) {
        throw new Error('Apple sign-in could not be verified.');
      }
      const value = await post('exchange', { challengeId: challenge.challengeId,
        identityToken: credential.identityToken, authorizationCode: credential.authorizationCode });
      if (!value || typeof value !== 'object' || !('accessToken' in value) || !('refreshToken' in value) || !('expiresIn' in value)
        || typeof value.accessToken !== 'string' || !value.accessToken || value.accessToken.length > 16_384
        || typeof value.refreshToken !== 'string' || !value.refreshToken || value.refreshToken.length > 16_384
        || typeof value.expiresIn !== 'number' || !Number.isSafeInteger(value.expiresIn) || value.expiresIn < 1 || value.expiresIn > 300) {
        throw new Error('The account service returned an invalid session.');
      }
      // These must be Cognito tokens, never the raw Apple identity token.
      if (value.accessToken === credential.identityToken) throw new Error('The account session could not be verified.');
      return { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresIn: value.expiresIn };
    },
  };
}
export const nativeAppleClient = createNativeAppleClient(process.env.EXPO_PUBLIC_NATIVE_APPLE_API_URL);
