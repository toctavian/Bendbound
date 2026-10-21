import { SessionExpiredError } from './sessionManager';
import type { Account } from './sessionManager';
import { sampleServerClock } from '@/utils/groups/clock';
import type { ClockReading } from '@/utils/groups/clock';
export function createGroupSessionClient(baseUrl: string | undefined, request: typeof fetch = fetch) {
  if (!baseUrl?.trim()) return null;
  let base: string;
  try {
    const url = new URL(baseUrl.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    base = url.href.replace(/\/$/, '');
  } catch { return null; }
  async function send(method: 'POST' | 'GET' | 'DELETE', token: string | null, logoutSecret?: string, logout = false) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = (async () => {
        const response = await request(`${base}/v1/session${logout ? '/logout' : ''}`, {
          method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(logoutSecret ? { 'Content-Type': 'application/json' } : {}) },
          ...(logoutSecret ? { body: JSON.stringify({ logoutSecret }) } : {}), signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) throw new SessionExpiredError();
        if (!response.ok) throw new Error('The account service could not be reached.');
        return await response.json() as unknown;
      })();
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('The account service timed out.')); }, 10_000);
      })]);
    } finally { clearTimeout(timer); }
  }
  const validateSecret = (secret: string) => { if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) throw new Error('Protected sign-out is unavailable.'); };
  return {
    baseUrl: base,
    // Explicitly opt-in; not a polling loop, admission proof or persisted calibration.
    async sampleClock(token: string, account: Account, readClock: () => ClockReading) {
      const started = { ...readClock() };
      const result = await send('GET', token);
      const received = { ...readClock() };
      if (!result || typeof result !== 'object' || !('userId' in result) || result.userId !== account.id) throw new SessionExpiredError();
      if (!('serverTime' in result) || !('expiresAt' in result)
        || typeof result.serverTime !== 'number' || typeof result.expiresAt !== 'number'
        || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= result.serverTime) throw new Error('Account clock calibration is unavailable.');
      const sample = sampleServerClock(started, received, result.serverTime);
      if (!sample || result.expiresAt <= sample.serverTimeMs + sample.roundTripMs) throw new Error('Account clock calibration is unavailable.');
      return sample;
    },
    async register(token: string, account: Account, logoutSecret: string) {
      validateSecret(logoutSecret);
      const result = await send('POST', token, logoutSecret);
      if (!result || typeof result !== 'object' || !('userId' in result) || result.userId !== account.id) throw new SessionExpiredError();
    },
    async revokeWithSecret(logoutSecret: string) {
      validateSecret(logoutSecret);
      const result = await send('POST', null, logoutSecret, true);
      if (!result || typeof result !== 'object' || !('revoked' in result) || result.revoked !== true) throw new Error('Remote sign-out could not be confirmed.');
    },
    async revoke(token: string) {
      const result = await send('DELETE', token);
      if (!result || typeof result !== 'object' || !('revoked' in result) || result.revoked !== true) throw new Error('Remote sign-out could not be confirmed.');
    },
  };
}
export const groupSessionApi = createGroupSessionClient(process.env.EXPO_PUBLIC_GROUP_API_URL);
