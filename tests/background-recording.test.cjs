const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(file, imports = {}) {
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)((name) => imports[name] ?? require(name), module, module.exports);
  return module.exports;
}
const routes = load('src/utils/routes.ts');
const recording = load('src/utils/recording.ts', { '@/utils/routes': routes });
const t0 = Date.UTC(2026, 9, 5, 10);
const fix = (seconds, latitude = 51.5 + seconds * 0.00001, extra = {}) => ({
  timestamp: t0 + seconds * 1000,
  coords: { latitude, longitude: -0.1, accuracy: 5, heading: 0, speed: 5, ...extra },
});

function harness(t) {
  let now = t0;
  t.mock.method(Date, 'now', () => now);
  const state = { running: false, foreground: true, background: true, available: true, failStart: false, failStop: false, failWrite: false };
  const database = new Map();
  const events = [];
  let task;
  const store = load('src/services/rideStore.ts', {
    'expo-sqlite/kv-store': { __esModule: true, default: {
      getItemSync: (key) => database.get(key) ?? null,
      setItemSync: (key, value) => { if (state.failWrite) throw new Error('Disk full'); database.set(key, value); },
    } },
  });
  const imports = {
    '@/utils/recording': recording,
    './rideStore': store,
    'expo-task-manager': {
      isAvailableAsync: async () => state.available,
      defineTask: (name, handler) => { task = handler; events.push(['define', name]); },
    },
    'expo-location': {
      Accuracy: { BestForNavigation: 6 }, ActivityType: { AutomotiveNavigation: 1 },
      requestForegroundPermissionsAsync: async () => ({ granted: state.foreground }),
      getBackgroundPermissionsAsync: async () => ({ granted: state.background }),
      requestBackgroundPermissionsAsync: async () => { events.push(['permission']); return { granted: state.background }; },
      hasStartedLocationUpdatesAsync: async () => state.running,
      startLocationUpdatesAsync: async (name, options) => {
        assert.notEqual(store.readRideState().active.session.activeSince, null);
        events.push(['start', name, options]);
        if (state.failStart) throw new Error('Native start failed');
        state.running = true;
      },
      stopLocationUpdatesAsync: async () => {
        events.push(['stop']);
        if (state.failStop) throw new Error('Native stop failed');
        state.running = false;
      },
    },
  };
  const reload = () => load('src/services/rideTracking.ts', imports);
  const service = reload();
  return { service, reload, store, state, events, database,
    at: (seconds) => { now = t0 + seconds * 1000; },
    deliver: (locations, error = null) => task({ data: { locations }, error }),
  };
}

test('background batches are recorded without mounted views, sorted, validated and persisted', async (t) => {
  const h = harness(t);
  await h.service.startRide('recording', null);
  const options = h.events.find(([event]) => event === 'start')[2];
  assert.equal(options.showsBackgroundLocationIndicator, true);
  assert.equal(options.pausesUpdatesAutomatically, false);
  assert.match(options.foregroundService.notificationTitle, /recording/);
  h.at(120);
  await h.deliver([fix(11), fix(1), fix(11), fix(-1), fix(12, 52), fix(15, 51.501, { accuracy: 100 }), fix(130)]);
  const saved = h.store.readRideState().active;
  assert.deepEqual(saved.session.segments[0].map((p) => p.timestamp), [fix(1).timestamp, fix(11).timestamp]);
  assert.equal(saved.updatedAt, t0 + 120000);
  h.reload();
  await h.deliver([fix(21)]);
  assert.equal(h.store.readRideState().active.session.segments[0].length, 3);
});

test('pause stops the native task, ignores late fixes, and resume excludes paused time and travel', async (t) => {
  const h = harness(t);
  await h.service.startRide('recording', null);
  h.at(20); await h.deliver([fix(1), fix(11)]);
  h.at(30); await h.service.pauseRide();
  assert.equal(h.state.running, false);
  await h.deliver([fix(21)]);
  assert.equal(h.store.readRideState().active.session.segments[0].length, 2);
  h.at(90); await h.service.resumeRide();
  h.at(110); await h.deliver([fix(89), fix(91, 52), fix(101, 52.0001)]);
  h.at(120);
  const tour = await h.service.endRide(false);
  assert.equal(tour.recording.durationSeconds, 60);
  assert.equal(tour.recording.segments.length, 2);
  assert.ok(tour.distanceKm < 0.1);
  assert.equal(h.state.running, false);
  assert.equal(h.store.readRideState().active, null);
  assert.deepEqual(h.store.pendingRecordedTours(), [tour]);
});

test('save survives restart until acknowledged, discard never creates a tour or alters older saved rides', async (t) => {
  const h = harness(t);
  const route = { title: 'Coastal ride', route: [], distanceKm: 50, durationMin: 60, curves: 10 };
  await h.service.startRide('navigation', route);
  h.at(10); const tour = await h.service.endRide(false);
  assert.equal(tour.title, route.title);
  h.reload();
  assert.equal(h.store.pendingRecordedTours()[0].id, tour.id);
  h.at(20); await h.service.startRide('recording', null);
  h.at(30); await h.deliver([fix(21)]);
  assert.equal(await h.service.endRide(true), null);
  assert.equal(h.state.running, false);
  assert.equal(h.store.readRideState().active, null);
  await h.deliver([fix(29)]);
  assert.deepEqual(h.store.pendingRecordedTours(), [tour]);
  h.store.acknowledgeRecordedTours([]);
  assert.deepEqual(h.store.pendingRecordedTours(), [tour]);
  h.store.acknowledgeRecordedTours([tour]);
  assert.deepEqual(h.store.pendingRecordedTours(), []);
});

test('permission denial or unsupported native build never starts GPS recording', async (t) => {
  const h = harness(t);
  h.state.available = false;
  await assert.rejects(h.service.ensureBackgroundLocation(async () => true), /native build/);
  h.state.available = true; h.state.foreground = false;
  await assert.rejects(h.service.ensureBackgroundLocation(async () => true), /Allow location/);
  h.state.foreground = true; h.state.background = false;
  await assert.rejects(h.service.ensureBackgroundLocation(async () => false), /screen locked/);
  assert.equal(h.events.some(([event]) => event === 'permission'), false);
  await assert.rejects(h.service.ensureBackgroundLocation(async () => true), /Settings/);
  assert.equal(h.state.running, false);
  assert.equal(h.store.readRideState().active, null);
});

test('recovery resumes a running task, but a stopped or stale cold-launch recording is paused at its last update', async (t) => {
  const h = harness(t);
  await h.service.startRide('recording', null);
  h.at(20); await h.deliver([fix(10)]);
  h.at(30); assert.notEqual((await h.service.recoverRide()).session.activeSince, null);
  h.at(300); h.state.running = false;
  const recovered = await h.service.recoverRide();
  assert.equal(recovered.session.activeSince, null);
  assert.equal(recovered.session.elapsedMs, 20000);
  assert.equal(recovered.session.segments[0].length, 1);
  await h.service.resumeRide();
  h.at(600);
  const afterRelaunch = await h.reload().recoverRide();
  assert.equal(afterRelaunch.session.activeSince, null);
  assert.equal(afterRelaunch.session.elapsedMs, 20000);
  assert.equal(h.state.running, false);
});

test('native start, stop and task errors preserve a recoverable recording', async (t) => {
  const h = harness(t);
  h.state.failStart = true;
  await assert.rejects(h.service.startRide('recording', null), /Native start failed/);
  assert.equal(h.store.readRideState().active.session.activeSince, null);
  h.state.failStart = false;
  await h.service.resumeRide();
  h.state.failStop = true;
  await assert.rejects(h.service.endRide(true), /Native stop failed/);
  assert.ok(h.store.readRideState().active);
  h.state.failStop = false;
  await h.service.resumeRide();
  await h.deliver([], { message: 'Location services disabled' });
  assert.equal(h.state.running, false);
  assert.equal(h.store.readRideState().active.session.activeSince, null);
  assert.match(h.store.readRideState().active.error, /disabled/);
});

test('disk failure stops GPS and notifies the screen while keeping the previous durable track', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const h = harness(t);
  await h.service.startRide('recording', null);
  h.at(20); await h.deliver([fix(1), fix(11)]);
  let displayed;
  h.service.subscribeToRide((ride) => { displayed = ride; });
  h.state.failWrite = true;
  h.at(30); await h.deliver([fix(21)]);
  assert.equal(h.state.running, false);
  assert.equal(displayed.session.activeSince, null);
  assert.match(displayed.error, /Disk full/);
  assert.equal(h.store.readRideState().active.session.segments[0].length, 2);
  await assert.rejects(h.service.endRide(false), /Disk full/);
  assert.ok(h.store.readRideState().active);
  h.state.failWrite = false;
  h.at(300); await h.service.resumeRide();
  assert.equal(h.state.running, true);
  h.at(310);
  const tour = await h.service.endRide(false);
  assert.equal(tour.recording.durationSeconds, 30);
});

test('overlapping start and finish operations cannot leave an orphan native task', async (t) => {
  const h = harness(t);
  await Promise.all([h.service.startRide('recording', null), h.service.endRide(true)]);
  assert.equal(h.state.running, false);
  assert.equal(h.store.readRideState().active, null);
});

test('malformed saved data is preserved instead of silently starting a replacement recording', async (t) => {
  const h = harness(t);
  const key = 'bendbound-ride-recording-v1';
  h.database.set(key, '{broken');
  await assert.rejects(h.service.startRide('recording', null));
  assert.equal(h.database.get(key), '{broken');
  assert.equal(h.state.running, false);
});

test('finish menu exposes cancel, destructive discard and save; each invokes the correct action', async () => {
  for (const discard of [true, false]) {
    const alerts = [], ended = [], saved = [], routesSet = [];
    let stateIndex = 0;
    let mode;
    const jsx = (type, props) => ({ type, props });
    const tour = recording.tourFromRecording(recording.startRecording(t0), t0 + 10000);
    const { default: Screen } = load('src/app/ride.tsx', {
      react: {
        useState: (initial) => {
          const i = stateIndex++;
          return [i === 0 ? 'recording' : initial, (value) => { if (i === 0) mode = value; }];
        },
        useRef: (initial) => ({ current: initial === null ? recording.startRecording(t0) : initial }),
        useCallback: (fn) => fn, useMemo: (fn) => fn(), useEffect() {},
      },
      'react/jsx-runtime': { jsx, jsxs: jsx },
      'react-native': { StyleSheet: { create: (s) => s }, Alert: { alert: (...args) => alerts.push(args) }, View: 'View', Text: 'Text' },
      '@expo/vector-icons/Ionicons': {}, '@react-native-community/slider': {},
      'expo-haptics': {}, 'expo-location': {}, 'expo-router': { Tabs: { Screen: 'Tabs.Screen' } },
      'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
      '@/components/RideMap': { RideMap: 'RideMap' }, '@/components/DriveOverlay': { DriveOverlay: 'DriveOverlay' },
      '@/components/RoutePoiCards': {}, '@/components/DestinationSearch': {}, '@/components/StandardTripPlanner': {}, '@/components/ui': {},
      '@/hooks/useRoutePois': { useRoutePois: () => ({ points: [] }) }, '@/data/routeColors': {},
      '@/data/seed': { defaultCenter: { latitude: 51.5, longitude: 0 }, nearbyPlaces: [] },
      '@/state/AppProvider': { useApp: () => ({ settings: {}, activeRoute: null, saveTour: (tour) => saved.push(tour), setActiveRoute: (route) => routesSet.push(route) }) },
      '@/theme': { colors: {}, spacing: {} }, '@/utils/guidance': { upcomingManeuver: () => undefined },
      '@/utils/navigation': { cumulativeRouteDistances: () => [] }, '@/utils/pois': {}, '@/utils/routes': routes,
      '@/utils/recording': recording,
      '@/services/rideTracking': { endRide: async (discard) => { ended.push(discard); return discard ? null : tour; } },
    });
    const overlay = Screen().props.children.flat(Infinity).find((child) => child?.type === 'DriveOverlay');
    overlay.props.onFinish();
    const buttons = alerts[0][2];
    assert.deepEqual(buttons.map((button) => button.text), ['Cancel', 'Finish & discard', 'Finish & save']);
    assert.equal(buttons[0].style, 'cancel');
    assert.equal(buttons[1].style, 'destructive');
    assert.deepEqual(ended, []);
    await buttons[discard ? 1 : 2].onPress();
    assert.deepEqual(ended, [discard]);
    assert.deepEqual(saved, discard ? [] : [tour]);
    assert.deepEqual(routesSet, [null]);
    assert.equal(mode, 'home');
  }
});
