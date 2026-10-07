import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import type { DraftRoute } from '@/types';
import { appendRecordingFix, pauseRecording, resumeRecording, startRecording, tourFromRecording } from '@/utils/recording';
import { ActiveRide, readRideState, updateRideState } from './rideStore';

export const RIDE_LOCATION_TASK = 'bendbound-active-ride-location-v1';
const listeners = new Set<(ride: ActiveRide | null) => void>();
let operations: Promise<unknown> = Promise.resolve();
let hasRecoveredInThisProcess = false;

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = operations.then(operation, operation);
  operations = result.catch(() => undefined);
  return result;
}

function publish(ride: ActiveRide | null) {
  for (const listener of listeners) {
    try { listener(ride); } catch { console.warn('A ride display could not refresh.'); }
  }
  return ride;
}

function storeActive(ride: ActiveRide | null) {
  updateRideState((state) => ({ ...state, active: ride }));
  return publish(ride);
}

export function subscribeToRide(listener: (ride: ActiveRide | null) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

async function stopNativeTracking() {
  if (await Location.hasStartedLocationUpdatesAsync(RIDE_LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(RIDE_LOCATION_TASK);
  }
}

async function persistPauseAndStop(ride: ActiveRide) {
  try {
    storeActive(ride);
  } catch (error) {
    // Even when storage is full, pause/discard must release native GPS.
    publish(ride);
    throw error;
  } finally {
    await stopNativeTracking();
  }
}

export async function ensureBackgroundLocation(explainPermission: () => Promise<boolean>) {
  if (!await TaskManager.isAvailableAsync()) {
    throw new Error('Background recording needs the updated Bendbound app. Install a new native build; Expo Go cannot record rides in the background.');
  }
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) throw new Error('Allow location access to record a ride.');
  if ((await Location.getBackgroundPermissionsAsync()).granted) return;
  if (!await explainPermission()) throw new Error('Background location is needed to keep recording with the screen locked.');
  const background = await Location.requestBackgroundPermissionsAsync();
  if (!background.granted) {
    throw new Error('Enable Always / Allow all the time for Bendbound location access in Settings, then start the ride again.');
  }
}

async function startNativeTracking() {
  await Location.startLocationUpdatesAsync(RIDE_LOCATION_TASK, {
    accuracy: Location.Accuracy.BestForNavigation,
    distanceInterval: 3,
    timeInterval: 1000,
    deferredUpdatesInterval: 5000,
    activityType: Location.ActivityType.AutomotiveNavigation,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Bendbound is recording your ride',
      notificationBody: 'GPS recording continues with the screen locked. Open Bendbound to pause or finish.',
      notificationColor: '#ef3340',
      killServiceOnDestroy: true,
    },
  });
}

export function startRide(mode: ActiveRide['mode'], route: DraftRoute | null) {
  return serial(async () => {
    if (readRideState().active) throw new Error('Finish or resume your existing ride first.');
    await stopNativeTracking();
    const now = Date.now();
    const ride: ActiveRide = { mode, route, session: startRecording(now), updatedAt: now };
    storeActive(ride);
    try {
      await startNativeTracking();
    } catch (error) {
      // Keep the ride recoverable if a native start partially succeeded.
      await persistPauseAndStop({ ...ride, session: pauseRecording(ride.session, Date.now()) });
      throw error;
    }
    return ride;
  });
}

export function pauseRide() {
  return serial(async () => {
    const ride = readRideState().active;
    // Persist the pause before stopping native updates so late batches are ignored.
    const paused = ride ? { ...ride, session: pauseRecording(ride.session, Date.now()) } : null;
    if (paused) await persistPauseAndStop(paused);
    else await stopNativeTracking();
    return paused;
  });
}

export function resumeRide() {
  return serial(async () => {
    let ride = readRideState().active;
    if (!ride) throw new Error('No ride is available to resume.');
    if (ride.session.activeSince !== null) {
      if (await Location.hasStartedLocationUpdatesAsync(RIDE_LOCATION_TASK)) return ride;
      // A failed disk write can leave an older active snapshot after GPS stopped.
      ride = { ...ride, session: pauseRecording(ride.session, ride.updatedAt) };
    }
    await stopNativeTracking();
    const resumed = { ...ride, session: resumeRecording(ride.session, Date.now()), updatedAt: Date.now(), error: undefined };
    storeActive(resumed);
    try {
      await startNativeTracking();
    } catch (error) {
      await persistPauseAndStop({ ...resumed, session: pauseRecording(resumed.session, Date.now()) });
      throw error;
    }
    return resumed;
  });
}

export function recoverRide() {
  return serial(async () => {
    const firstRecovery = !hasRecoveredInThisProcess;
    hasRecoveredInThisProcess = true;
    const ride = readRideState().active;
    if (!ride || ride.session.activeSince === null) {
      await stopNativeTracking();
      return publish(ride);
    }
    const running = await Location.hasStartedLocationUpdatesAsync(RIDE_LOCATION_TASK);
    const permitted = (await Location.getBackgroundPermissionsAsync()).granted;
    // A persisted native registration alone is not proof that a force-quit ride
    // kept running. On a cold launch, recover a stale session as paused.
    if (!running || !permitted || (firstRecovery && Date.now() - ride.updatedAt > 30000)) {
      const paused = { ...ride, session: pauseRecording(ride.session, ride.updatedAt),
        error: 'GPS recording was interrupted. Your recorded track is safe. Resume the ride or finish it.' };
      await persistPauseAndStop(paused);
      return paused;
    }
    return publish(ride);
  });
}

export function endRide(discard: boolean) {
  return serial(async () => {
    let ride = readRideState().active;
    if (!ride) return null;
    const pausedAt = ride.session.activeSince !== null && !await Location.hasStartedLocationUpdatesAsync(RIDE_LOCATION_TASK)
      ? ride.updatedAt : Date.now();
    ride = { ...ride, session: pauseRecording(ride.session, pausedAt) };
    // Do not say the ride has ended if the native tracker failed to stop.
    await persistPauseAndStop(ride);
    const tour = discard ? null : tourFromRecording(ride.session, Date.now(), ride.route?.title);
    updateRideState((state) => ({ ...state, active: null, pending: tour ? [...state.pending, tour] : state.pending }));
    publish(null);
    return tour;
  });
}

// Loaded by entry.js before Expo Router: this also runs in a headless background launch.
TaskManager.defineTask<{ locations?: Location.LocationObject[] }>(RIDE_LOCATION_TASK, async ({ data, error }) => serial(async () => {
  let ride: ActiveRide | null = null;
  try {
    ride = readRideState().active;
    if (!ride || ride.session.activeSince === null) {
      await stopNativeTracking();
      return;
    }
    if (error) {
      storeActive({ ...ride, session: pauseRecording(ride.session, ride.updatedAt), error: error.message });
      await stopNativeTracking();
      return;
    }
    const now = Date.now();
    let session = ride.session;
    let lastFix = ride.lastFix;
    for (const fix of [...(data?.locations ?? [])].sort((a, b) => a.timestamp - b.timestamp)) {
      // Native background deliveries can contain old but valid batched samples.
      // Keep the chronological, accuracy, active-session and jump checks.
      session = appendRecordingFix(session, { latitude: fix.coords.latitude, longitude: fix.coords.longitude,
        timestamp: fix.timestamp, accuracy: fix.coords.accuracy ?? -1 }, now, Infinity);
      if (fix.timestamp >= session.activeSince! && fix.timestamp <= now + 1000
        && Number.isFinite(fix.coords.latitude) && Math.abs(fix.coords.latitude) <= 90
        && Number.isFinite(fix.coords.longitude) && Math.abs(fix.coords.longitude) <= 180
        && (fix.coords.accuracy ?? -1) >= 0 && (fix.coords.accuracy ?? Infinity) <= 50
        && (!lastFix || fix.timestamp > lastFix.timestamp)) lastFix = fix;
    }
    storeActive({ ...ride, session, lastFix, updatedAt: now });
  } catch (failure) {
    // A full disk must not leave the UI claiming it is safely recording.
    await stopNativeTracking();
    const message = failure instanceof Error ? failure.message : 'Recording could not be saved.';
    console.warn('Background recording stopped:', message);
    if (ride) {
      const paused = { ...ride, session: pauseRecording(ride.session, ride.updatedAt), error: `Recording stopped: ${message}` };
      try { storeActive(paused); } catch { publish(paused); }
    }
  }
}));
