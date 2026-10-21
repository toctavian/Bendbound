import { GROUP_LIMITS } from '@/types/groupRide';
import { CLOCK_LIMITS, serverTimeBounds } from './clock';
import type { ClockReading, ServerClockSample } from './clock';

/** Draft local contract version, independent of the unchanged v1 wire protocol. */
export type PublisherCaptureTiming = Readonly<{
  version: 1;
  rawCapturedAt: number;
  serverCaptureEarliestMs: number;
  serverCaptureLatestMs: number;
}>;

/**
 * One live API/account/clock-continuity scope. Discard on logout, resampling,
 * restart or unvalidated sleep/resume. Never persist or serialise capture handles.
 * capture() requires a reading AT capture, not when a delayed GPS callback arrives.
 */
export function createPublisherCaptureClock(calibration: ServerClockSample) {
  const sample = Object.freeze({ ...calibration, received: Object.freeze({ ...calibration.received }) });
  const captures = new WeakMap<PublisherCaptureTiming, ClockReading>();
  let active = true;
  return {
    /** Permanently reject retained handles after the caller ends this scope. */
    invalidate() { active = false; },
    capture(reading: ClockReading): PublisherCaptureTiming | null {
      if (!active) return null;
      const bounds = serverTimeBounds(sample, reading);
      if (!bounds || bounds.earliest < 0) return null;
      const timing: PublisherCaptureTiming = Object.freeze({
        version: 1, rawCapturedAt: reading.wallTimeMs,
        serverCaptureEarliestMs: bounds.earliest, serverCaptureLatestMs: bounds.latest,
      });
      captures.set(timing, Object.freeze({ ...reading }));
      return timing;
    },
    publication(timing: PublisherCaptureTiming, reading: ClockReading) {
      if (!active) return null;
      // Object provenance prevents historical captures being rebound to a newer
      // calibration, including a serialised clone with identical public fields.
      const captured = captures.get(timing);
      const now = serverTimeBounds(sample, reading);
      if (!captured || !now) return null;
      const duration = reading.monotonicTimeMs - captured.monotonicTimeMs;
      if (duration < 0 || Math.abs(reading.wallTimeMs - captured.wallTimeMs - duration)
        > CLOCK_LIMITS.maxWallDiscontinuityMs) return null;
      const oldestAgeMs = Math.max(0, now.latest - timing.serverCaptureEarliestMs);
      const youngestAgeMs = Math.max(0, now.earliest - timing.serverCaptureLatestMs);
      // Retain the full capture uncertainty; no midpoint/receipt-time rewrite.
      if (oldestAgeMs > GROUP_LIMITS.maxCaptureAgeMs) return null;
      return Object.freeze({ capture: timing, oldestAgeMs, youngestAgeMs });
    },
  };
}
