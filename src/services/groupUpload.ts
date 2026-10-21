import type { GroupFix } from '@/types/groupRide';
import { GROUP_LIMITS } from '@/types/groupRide';
import { newestShareableFix, validGroupFix } from '@/utils/groups/location';
import type { LocationSample } from '@/utils/groups/location';
export type SharingLease = { roomId: string; deviceEpoch: string; expiresAt: number };
export type UploadResult = 'sent' | 'inactive' | 'busy' | 'throttled' | 'no-fresh-fix' | 'failed';
/** Bounded latest-only transport. Not registered with native GPS until P02/M01. */
export function createGroupUploader({ now = Date.now, accessToken, send }: {
  now?: () => number;
  accessToken: () => Promise<string>;
  send: (lease: SharingLease, fix: GroupFix, token: string, signal: AbortSignal) => Promise<void>;
}) {
  let lease: SharingLease | null = null;
  let epoch = 0, sequence = 0;
  let activeRequest: AbortController | null = null;
  let lastAttempt = -Infinity;
  let lastCapture = -Infinity;
  function stop() {
    ++epoch; lease = null; activeRequest?.abort(); activeRequest = null;
  }
  return {
    // Only a server-authorised membership/device session can supply this lease.
    start(next: SharingLease) {
      if (!/^[A-Za-z0-9-]{16,64}$/.test(next.deviceEpoch) || !/^[A-Za-z0-9-]{8,128}$/.test(next.roomId)
        || !Number.isFinite(next.expiresAt) || next.expiresAt <= now()) throw new Error('Invalid sharing session.');
      stop(); lease = { ...next }; sequence = 0; lastAttempt = -Infinity; lastCapture = -Infinity;
    },
    stop,
    async upload(samples: LocationSample[]): Promise<UploadResult> {
      const current = lease, attemptEpoch = epoch;
      if (!current || current.expiresAt <= now()) { stop(); return 'inactive'; }
      if (activeRequest) return 'busy';
      if (now() - lastAttempt < GROUP_LIMITS.movingUploadMs) return 'throttled';
      const fix = newestShareableFix(samples, now(), current.deviceEpoch, sequence);
      if (!fix || fix.capturedAt <= lastCapture) return 'no-fresh-fix';
      const controller = new AbortController(); activeRequest = controller; lastAttempt = now();
      let onAbort = () => {};
      const aborted = new Promise<UploadResult>((resolve) => {
        onAbort = () => resolve(attemptEpoch === epoch ? 'failed' : 'inactive');
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const publication = async (): Promise<UploadResult> => {
        const token = await accessToken();
        if (attemptEpoch !== epoch || controller.signal.aborted || current.expiresAt <= now()) return 'inactive';
        if (!validGroupFix(fix, now())) return 'no-fresh-fix';
        await send(current, fix, token, controller.signal);
        if (attemptEpoch !== epoch || controller.signal.aborted) return 'inactive';
        lastCapture = fix.capturedAt; ++sequence;
        return 'sent';
      };
      try { return await Promise.race([publication(), aborted]); }
      catch { return attemptEpoch === epoch ? 'failed' : 'inactive'; }
      finally {
        clearTimeout(timeout); controller.signal.removeEventListener('abort', onAbort);
        if (activeRequest === controller) activeRequest = null;
      }
      // No coordinate backlog or retry queue: the next callback supplies a new fix.
    },
  };
}
export function createHttpGroupSender(baseUrl: string, request: typeof fetch = fetch) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Group sharing requires a configured HTTPS endpoint.');
  const base = url.href.replace(/\/$/, '');
  return async (lease: SharingLease, fix: GroupFix, token: string, signal: AbortSignal) => {
    // Identity is taken from the bearer token, never a body userId/pilot credential.
    const response = await request(`${base}/v1/rooms/${encodeURIComponent(lease.roomId)}/fix`, {
      method: 'PUT', signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, fix }),
    });
    if (!response.ok) throw new Error('Location could not be shared.');
  };
}
