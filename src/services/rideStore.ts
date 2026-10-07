import Storage from 'expo-sqlite/kv-store';
import type { LocationObject } from 'expo-location';
import type { DraftRoute, Tour } from '@/types';
import type { RecordingSession } from '@/utils/recording';

export type ActiveRide = {
  mode: 'navigation' | 'recording';
  route: DraftRoute | null;
  session: RecordingSession;
  lastFix?: LocationObject;
  updatedAt: number;
  error?: string;
};

type RideState = { version: 1; active: ActiveRide | null; pending: Tour[] };
const KEY = 'bendbound-ride-recording-v1';

export function readRideState(): RideState {
  const value = Storage.getItemSync(KEY);
  if (value === null) return { version: 1, active: null, pending: [] };
  const state = JSON.parse(value) as RideState;
  if (state?.version !== 1 || !Array.isArray(state.pending) || state.active === undefined
    || (state.active !== null && (!state.active.session || !Array.isArray(state.active.session.segments)
      || !Number.isFinite(state.active.session.startedAt) || !Number.isFinite(state.active.updatedAt)
      || !Number.isFinite(state.active.session.elapsedMs) || state.active.session.elapsedMs < 0
      || (state.active.session.activeSince !== null && !Number.isFinite(state.active.session.activeSince))
      || !state.active.session.segments.every((segment) => Array.isArray(segment))
      || !['navigation', 'recording'].includes(state.active.mode)))) {
    throw new Error('The saved recording could not be read. It has been kept on this device.');
  }
  return state;
}

// A single synchronous SQLite write makes the active -> completed handoff atomic.
// There is no await between reading and writing, including background callbacks.
export function updateRideState(update: (state: RideState) => RideState) {
  const state = update(readRideState());
  Storage.setItemSync(KEY, JSON.stringify(state));
  return state;
}

export function pendingRecordedTours() {
  return readRideState().pending;
}

export function acknowledgeRecordedTours(tours: Tour[]) {
  const ids = new Set(tours.map((tour) => tour.id));
  const state = readRideState();
  if (state.pending.some((tour) => ids.has(tour.id))) {
    updateRideState((current) => ({ ...current, pending: current.pending.filter((tour) => !ids.has(tour.id)) }));
  }
}
