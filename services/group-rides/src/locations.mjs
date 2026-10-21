import { hash, LOCATION_RETENTION_MS } from './locationKeys.mjs';
import { RoomError } from './rooms.mjs';
export const FIX_LIMITS = Object.freeze({ maxCaptureAgeMs: 15_000, futureToleranceMs: 1_000, maxAccuracyM: 100 });
const fields = ['latitude', 'longitude', 'accuracyM', 'headingDeg', 'speedMps', 'capturedAt', 'sessionEpoch', 'sequence'];
export function validFix(fix, at) {
  return !!fix && typeof fix === 'object' && !Array.isArray(fix) && Object.keys(fix).length === fields.length
    && Object.keys(fix).every((key) => fields.includes(key)) && Number.isFinite(at)
    && Number.isFinite(fix.latitude) && Math.abs(fix.latitude) <= 90
    && Number.isFinite(fix.longitude) && Math.abs(fix.longitude) <= 180
    && Number.isFinite(fix.accuracyM) && fix.accuracyM >= 0 && fix.accuracyM <= FIX_LIMITS.maxAccuracyM
    && Number.isFinite(fix.capturedAt) && at - fix.capturedAt <= FIX_LIMITS.maxCaptureAgeMs && fix.capturedAt <= at + FIX_LIMITS.futureToleranceMs
    && typeof fix.sessionEpoch === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(fix.sessionEpoch)
    && Number.isSafeInteger(fix.sequence) && fix.sequence >= 0
    && (fix.headingDeg === null || (Number.isFinite(fix.headingDeg) && fix.headingDeg >= 0 && fix.headingDeg < 360))
    && (fix.speedMps === null || (Number.isFinite(fix.speedMps) && fix.speedMps >= 0 && fix.speedMps <= 150));
}
/** No identity in payload, no position queue, no receipt-time rewrite on retry. */
export function createLocationService({ rooms, store, now = Date.now }) {
  if (!rooms?.publicationLease || !store?.read || !store?.commit) throw new Error('Atomic location storage is required.');
  return {
    read: (actor, roomId) => store.snapshot(actor, roomId, now),
    async publish(actor, roomId, input) {
      if (input?.version !== 1 || Object.keys(input).some((key) => !['version', 'fix'].includes(key)) || !validFix(input.fix, now())) throw new RoomError('INVALID_FIX');
      const fix = Object.fromEntries(fields.map((key) => [key, input.fix[key]]));
      const fingerprint = hash(JSON.stringify(fix));
      for (let attempt = 0; attempt < 6; attempt++) {
        const lease = await rooms.publicationLease(actor, roomId, fix.sessionEpoch);
        const previous = await store.read(roomId, actor.userId);
        const at = now(); // Recheck capture age after permission/storage latency.
        if (!validFix(fix, at)) throw new RoomError('INVALID_FIX');
        // Once an idle point has been erased, its sequence ledger is gone.
        // Only a newly issued epoch may start again; old consent cannot reset it.
        if (!previous && (!Number.isFinite(lease.startedAt) || lease.startedAt > at
          || at - lease.startedAt >= LOCATION_RETENTION_MS)) throw new RoomError('SHARING_LEASE_EXPIRED', 403);
        const sameEpoch = previous?.fix.sessionEpoch === fix.sessionEpoch;
        const duplicate = sameEpoch && previous.fix.sequence === fix.sequence && previous.fingerprint === fingerprint;
        if (sameEpoch && !duplicate && (fix.sequence <= previous.fix.sequence || fix.capturedAt <= previous.fix.capturedAt)) throw new RoomError('FIX_OUT_OF_ORDER', 409);
        if (await store.commit({ actor, lease, fix, previous, fingerprint, at, duplicate }))
          return { version: 1, sequence: fix.sequence, receivedAt: duplicate ? previous.fix.receivedAt : at };
      }
      throw new RoomError('ROOM_BUSY', 409);
    },
  };
}
