import { GROUP_LIMITS } from '@/types/groupRide';
import type { GroupFix, ReceivedGroupFix } from '@/types/groupRide';
import { serverTimeBounds } from './clock';
import type { ClockReading, ServerClockSample } from './clock';
export type LocationSample = {
  timestamp: number;
  coords: { latitude: number; longitude: number; accuracy: number | null; heading?: number | null; speed?: number | null };
};
export type Freshness = 'fresh' | 'stale' | 'offline' | 'hidden';
export function validGroupFix(fix: GroupFix, now: number): boolean {
  return Number.isFinite(now) && Number.isFinite(fix.latitude) && Math.abs(fix.latitude) <= 90
    && Number.isFinite(fix.longitude) && Math.abs(fix.longitude) <= 180
    && Number.isFinite(fix.accuracyM) && fix.accuracyM >= 0 && fix.accuracyM <= GROUP_LIMITS.maxAccuracyM
    && Number.isFinite(fix.capturedAt) && now - fix.capturedAt <= GROUP_LIMITS.maxCaptureAgeMs
    && fix.capturedAt <= now + GROUP_LIMITS.futureToleranceMs
    && typeof fix.sessionEpoch === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(fix.sessionEpoch)
    && Number.isSafeInteger(fix.sequence) && fix.sequence >= 0
    && (fix.headingDeg === null || (Number.isFinite(fix.headingDeg) && fix.headingDeg >= 0 && fix.headingDeg < 360))
    && (fix.speedMps === null || (Number.isFinite(fix.speedMps) && fix.speedMps >= 0 && fix.speedMps <= 150));
}
/** Historical batches belong in the recorder; only their newest valid fix can be shared. */
export function newestShareableFix(samples: LocationSample[], now: number, sessionEpoch: string, sequence: number): GroupFix | null {
  let newest: GroupFix | null = null;
  for (const sample of samples) {
    const { coords } = sample;
    const fix: GroupFix = {
      latitude: coords.latitude, longitude: coords.longitude, accuracyM: coords.accuracy ?? -1,
      headingDeg: coords.heading !== null && coords.heading !== undefined && coords.heading >= 0 ? coords.heading : null,
      speedMps: coords.speed !== null && coords.speed !== undefined && coords.speed >= 0 ? coords.speed : null,
      capturedAt: sample.timestamp, sessionEpoch, sequence,
    };
    if (validGroupFix(fix, now) && (!newest || fix.capturedAt > newest.capturedAt)) newest = fix;
  }
  return newest;
}
export function groupFixFreshness(fix: ReceivedGroupFix | null, now: number): Freshness {
  if (!fix || !Number.isFinite(now) || !Number.isFinite(fix.capturedAt) || !Number.isFinite(fix.receivedAt)
    || fix.capturedAt > now + GROUP_LIMITS.futureToleranceMs || fix.receivedAt > now + GROUP_LIMITS.futureToleranceMs) return 'hidden';
  // Original capture age remains authoritative even after delayed delivery.
  const age = Math.max(0, now - fix.capturedAt, now - fix.receivedAt);
  if (age >= GROUP_LIMITS.hideAfterMs) return 'hidden';
  if (age >= GROUP_LIMITS.offlineAfterMs) return 'offline';
  if (age > GROUP_LIMITS.staleAfterMs) return 'stale';
  return 'fresh';
}
/** Receiver-only calibration; original publisher capture time must already be server-comparable. */
export function calibratedGroupFixFreshness(fix: ReceivedGroupFix | null, sample: ServerClockSample | null, reading: ClockReading): Freshness {
  const bounds = serverTimeBounds(sample, reading);
  if (!bounds || !fix || fix.capturedAt > bounds.earliest + GROUP_LIMITS.futureToleranceMs
    || fix.receivedAt > bounds.earliest + GROUP_LIMITS.futureToleranceMs) return 'hidden';
  // The oldest plausible age wins, including RTT, drift and delayed delivery.
  return groupFixFreshness(fix, bounds.latest);
}
