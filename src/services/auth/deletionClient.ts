export type DeletionStatus = { appDataDeleted: boolean; provider: 'pending' | 'manual' | 'drained'; delayed: boolean; complete: boolean };
export class RecentSignInRequiredError extends Error {}
export function createDeletionClient(value?: string, request: typeof fetch = fetch) {
  let base: string;
  try {
    const url = new URL(value ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)) return null;
    base = url.origin;
  } catch { return null; }
  async function send(receiptSecret: string, token?: string) {
    if (!/^[a-f0-9]{64}$/.test(receiptSecret)) throw new Error('Protected deletion receipt unavailable.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const r = await request(`${base}/v1/account/deletion${token ? '' : '/status'}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ receiptSecret }), redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (token && r.status === 401) throw new RecentSignInRequiredError('Sign in again before deleting your account.');
      if (!token && r.status === 404) return null;
      if (!r.ok) throw new Error('Account deletion could not be confirmed.');
      return await r.json() as unknown;
    } finally { clearTimeout(timer); }
  }
  return {
    baseUrl: base,
    async start(token: string, receiptSecret: string) {
      if (!token) throw new Error('Sign in before deleting your account.');
      const r = await send(receiptSecret, token);
      if (!r || typeof r !== 'object' || !('accepted' in r) || r.accepted !== true) throw new Error('Account deletion could not be confirmed.');
    },
    async status(receiptSecret: string): Promise<DeletionStatus | null> {
      const r = await send(receiptSecret);
      if (r === null) return null;
      if (!r || typeof r !== 'object') throw new Error('Invalid deletion status.');
      const v = r as Partial<DeletionStatus>;
      if (typeof v.appDataDeleted !== 'boolean' || typeof v.delayed !== 'boolean' || typeof v.complete !== 'boolean'
        || !['pending', 'manual', 'drained'].includes(v.provider ?? '') || v.complete !== (v.appDataDeleted && v.provider === 'drained')) throw new Error('Invalid deletion status.');
      return v as DeletionStatus;
    },
  };
}
