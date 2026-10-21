/** Both readings must come from the same live process; never persist calibration. */
export type ClockReading = Readonly<{ wallTimeMs: number; monotonicTimeMs: number }>;
export type ServerClockSample = Readonly<{
  serverTimeMs: number; roundTripMs: number; received: ClockReading;
}>;
export const CLOCK_LIMITS = {
  maxRoundTripMs: 2_000, maxSampleAgeMs: 60_000, maxWallDiscontinuityMs: 100,
  driftPartsPerMillion: 100, timestampResolutionMs: 1,
} as const;
function validReading(reading: ClockReading): boolean {
  return !!reading && Number.isSafeInteger(reading.wallTimeMs) && reading.wallTimeMs >= 0
    && Number.isFinite(reading.monotonicTimeMs) && reading.monotonicTimeMs >= 0;
}
function elapsed(start: ClockReading, end: ClockReading): number | null {
  if (!validReading(start) || !validReading(end)) return null;
  const duration = end.monotonicTimeMs - start.monotonicTimeMs;
  if (duration < 0 || Math.abs(end.wallTimeMs - start.wallTimeMs - duration) > CLOCK_LIMITS.maxWallDiscontinuityMs) return null;
  return duration;
}
/** serverTime is generated during this uncached authenticated request, not a Date header. */
export function sampleServerClock(start: ClockReading, end: ClockReading, serverTimeMs: number): ServerClockSample | null {
  const roundTripMs = elapsed(start, end);
  if (roundTripMs === null || roundTripMs > CLOCK_LIMITS.maxRoundTripMs
    || !Number.isSafeInteger(serverTimeMs) || serverTimeMs < 0
    || !Number.isSafeInteger(Math.ceil(serverTimeMs + roundTripMs + CLOCK_LIMITS.maxSampleAgeMs + 1000))) return null;
  return Object.freeze({ serverTimeMs, roundTripMs, received: Object.freeze({ ...end }) });
}
/** Single server timestamp: allow the entire RTT on either side of network asymmetry. */
export function serverTimeBounds(sample: ServerClockSample | null, reading: ClockReading): { earliest: number; latest: number } | null {
  if (!sample || !Number.isSafeInteger(sample.serverTimeMs) || sample.serverTimeMs < 0
    || !Number.isFinite(sample.roundTripMs) || sample.roundTripMs < 0 || sample.roundTripMs > CLOCK_LIMITS.maxRoundTripMs) return null;
  const age = elapsed(sample.received, reading);
  if (age === null || age > CLOCK_LIMITS.maxSampleAgeMs) return null;
  const error = CLOCK_LIMITS.timestampResolutionMs
    + (age + sample.roundTripMs) * CLOCK_LIMITS.driftPartsPerMillion / 1_000_000;
  const earliest = sample.serverTimeMs + age - error;
  const latest = sample.serverTimeMs + sample.roundTripMs + age + error;
  return Number.isFinite(earliest) && Number.isFinite(latest) && latest <= Number.MAX_SAFE_INTEGER ? { earliest, latest } : null;
}
