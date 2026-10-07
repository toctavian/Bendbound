const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(file, imports = {}, globals = {}) {
  const { outputText } = ts.transpileModule(readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), outputText)(
    (name) => imports[name] ?? require(name), module, module.exports, ...Object.values(globals));
  return module.exports;
}
const feature = (id, name = 'Richmond', longitude = -0.3, latitude = 51.46) => ({
  properties: { osm_type: 'N', osm_id: id, name, city: 'London', country: 'United Kingdom' },
  geometry: { type: 'Point', coordinates: [longitude, latitude] },
});
const payload = { features: [feature(1), feature(2, 'Richmond Station')] };
const center = { latitude: 51.5, longitude: -0.12 };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('parses exact coordinates, readable addresses and unique matches; rejects invalid geometry', () => {
  const { parsePlaceSuggestions } = load('src/utils/places.ts');
  const result = parsePlaceSuggestions({ features: [...payload.features, feature(1), feature(3, 'Bad', 181), feature(4, 'Bad', 0, NaN), null] });
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'Richmond');
  assert.equal(result[0].address, 'London, United Kingdom');
  assert.equal(result[0].longitude, -0.3);
  assert.equal(result[0].latitude, 51.46);
  assert.throws(() => parsePlaceSuggestions({}), /Invalid/);
  const address = feature(5, '');
  address.properties.street = 'High Street';
  address.properties.housenumber = '14';
  assert.equal(parsePlaceSuggestions({ features: [address] })[0].name, '14 High Street');
});

test('search requests encode text, bias nearby results, and can be cancelled', async () => {
  const calls = [];
  const { fetchPlaceSuggestions } = load('src/utils/places.ts', {}, {
    fetch: async (url, options) => { calls.push({ url: new URL(url), signal: options.signal }); return { ok: true, json: async () => payload }; },
  });
  assert.deepEqual(await fetchPlaceSuggestions(' ', center), []);
  assert.equal(calls.length, 0);
  const results = await fetchPlaceSuggestions('  King & Queen  ', center);
  assert.equal(calls[0].url.searchParams.get('q'), 'King & Queen');
  assert.equal(calls[0].url.searchParams.get('lat'), '51.50');
  assert.equal(calls[0].url.searchParams.get('limit'), '8');
  assert.equal(results.length, 2);
  const controller = new AbortController();
  const pending = fetchPlaceSuggestions('Richmond', center, controller.signal);
  controller.abort();
  assert.equal(calls[1].signal.aborted, true);
  await pending;
});

test('timeouts abort the fetch and HTTP failures remain errors, not empty matches', async () => {
  let timeout;
  const service = load('src/utils/places.ts', {}, {
    setTimeout: (callback) => { timeout = callback; return 1; }, clearTimeout: () => {},
    fetch: (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')))),
  });
  const pending = service.fetchPlaceSuggestions('Richmond', center);
  timeout();
  await assert.rejects(pending, /Aborted/);
  const failed = load('src/utils/places.ts', {}, { fetch: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(failed.fetchPlaceSuggestions('Richmond', center), /429/);
});

function hookHarness() {
  const slots = [];
  const timers = new Map();
  const requests = [];
  let cursor = 0, id = 0;
  let effects = [];
  let output;
  const react = {
    useState: (initial) => {
      const i = cursor++;
      slots[i] ??= { value: initial };
      return [slots[i].value, (next) => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }];
    },
    useEffect: (effect, deps) => {
      const i = cursor++;
      const previous = slots[i];
      if (previous && deps.every((dep, n) => Object.is(dep, previous.deps[n]))) return;
      effects.push(() => { previous?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; });
    },
  };
  const { usePlaceSuggestions } = load('src/hooks/usePlaceSuggestions.ts', {
    react,
    '@/utils/places': { fetchPlaceSuggestions: (query, center, signal) => new Promise((resolve, reject) => requests.push({ query, signal, resolve, reject })) },
  }, {
    setTimeout: (callback, delay) => { assert.equal(delay, 400); timers.set(++id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  return {
    requests,
    get output() { return output; },
    render(query, enabled = true) { cursor = 0; effects = []; output = usePlaceSuggestions(query, center, enabled); effects.forEach((effect) => effect()); },
    tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach((callback) => callback()); },
    unmount() { slots.forEach((slot) => slot.cleanup?.()); },
  };
}

test('debounces typing, discards late results and clears matches when the query is cleared or closed', async () => {
  const h = hookHarness();
  h.render('R'); h.tick();
  assert.equal(h.requests.length, 0);
  h.render('Ri'); h.render('Rich'); h.tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].query, 'Rich');
  h.render('Richmond'); h.tick();
  assert.equal(h.requests[0].signal.aborted, true);
  h.requests[1].resolve([{ id: 'new' }]); await flush(); h.render('Richmond');
  assert.deepEqual(h.output.places, [{ id: 'new' }]);
  h.requests[0].resolve([{ id: 'old' }]); await flush(); h.render('Richmond');
  assert.deepEqual(h.output.places, [{ id: 'new' }]);
  h.render('');
  assert.deepEqual(h.output.places, []);
  assert.equal(h.output.loading, false);
  h.render('London'); h.tick(); h.render('London', false);
  assert.equal(h.requests[2].signal.aborted, true);
  h.requests[2].resolve([{ id: 'closed' }]); await flush(); h.render('London', false);
  assert.deepEqual(h.output.places, []);
  h.unmount();
});

test('failed searches can retry and unmount cancels the remaining request', async () => {
  const h = hookHarness();
  h.render('London'); h.tick(); h.requests[0].reject(new Error('Offline'));
  await flush(); h.render('London');
  assert.equal(h.output.error, true);
  h.output.retry(); h.render('London'); h.tick();
  assert.equal(h.output.loading, true);
  assert.equal(h.output.error, false);
  assert.equal(h.requests.length, 2);
  h.unmount();
  assert.equal(h.requests[1].signal.aborted, true);
});

function find(element, predicate) {
  if (!element || typeof element !== 'object') return;
  if (predicate(element)) return element;
  for (const child of [element.props?.children].flat(Infinity)) {
    const match = find(child, predicate);
    if (match) return match;
  }
}
const jsx = (type, props) => ({ type, props });

test('focus expands search; suggestions stay tappable with keyboard open and select exact places', () => {
  let expanded = false, query = 'Richmond', selected, dismissals = 0;
  const place = { id: 'station', name: 'Richmond Station', address: 'London', latitude: 51.4632, longitude: -0.3004 };
  let retries = 0;
  let suggestions = { places: [place], loading: false, error: false, retry: () => retries++ };
  const { DestinationSearch } = load('src/components/DestinationSearch.tsx', {
    react: { useRef: () => ({ current: { focus() {} } }), useEffect() {} },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { StyleSheet: { create: (s) => s }, Platform: { OS: 'ios' }, Keyboard: { dismiss: () => dismissals++ }, View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput', ScrollView: 'ScrollView', KeyboardAvoidingView: 'KeyboardAvoidingView' },
    '@expo/vector-icons/Ionicons': { default: 'Icon' },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 50, bottom: 20 }) },
    '@/components/ui': { Sheet: 'Sheet', IconButton: 'IconButton' },
    '@/hooks/usePlaceSuggestions': { usePlaceSuggestions: () => suggestions },
    '@/theme': { colors: {} },
  });
  const render = () => DestinationSearch({ query, expanded, onExpandedChange: (v) => { expanded = v; }, onChangeQuery: (v) => { query = v; }, onSelect: (p) => { selected = p; }, center, busy: false, children: 'home controls' });
  let screen = render();
  find(screen, (n) => n.type === 'TextInput').props.onFocus();
  assert.equal(expanded, true);
  screen = render();
  assert.equal(find(screen, (n) => n.type === 'Sheet').props.style.flex, 1);
  assert.equal(find(screen, (n) => n.type === 'ScrollView').props.keyboardShouldPersistTaps, 'handled');
  find(screen, (n) => n.props?.accessibilityLabel === 'Richmond Station, London').props.onPress();
  assert.equal(selected, place);
  assert.equal(dismissals, 1);
  find(screen, (n) => n.props?.accessibilityLabel === 'Clear search').props.onPress();
  assert.equal(query, '');
  find(screen, (n) => n.props?.label === 'Close place search').props.onPress();
  assert.equal(expanded, false);
  expanded = true; query = 'Richmond';
  suggestions = { ...suggestions, places: [], loading: true };
  assert.ok(find(render(), (n) => n.props?.children === 'Searching...'));
  suggestions = { ...suggestions, loading: false, error: true };
  screen = render();
  assert.ok(find(screen, (n) => n.props?.children === 'Place search is unavailable'));
  find(screen, (n) => n.props?.label === 'Retry place search').props.onPress();
  assert.equal(retries, 1);
  suggestions = { ...suggestions, error: false };
  assert.ok(find(render(), (n) => n.props?.children === 'No places found'));
});

test('the map plans to the selected result coordinates, not the first geocoded match', async () => {
  const planned = [], activated = [];
  const { default: Screen } = load('src/app/ride.tsx', {
    react: { useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useRef: (v) => ({ current: v }), useMemo: (fn) => fn(), useCallback: (fn) => fn, useEffect() {} },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { StyleSheet: { create: (s) => s }, Keyboard: { dismiss() {} }, Alert: { alert: (...args) => assert.fail(args.join(' ')) }, View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView' },
    '@expo/vector-icons/Ionicons': { default: 'Icon' },
    '@react-native-community/slider': {},
    'expo-haptics': { NotificationFeedbackType: {}, notificationAsync: async () => {} },
    'expo-location': { requestForegroundPermissionsAsync: async () => ({ granted: false }) },
    'expo-router': { Tabs: { Screen: 'Tabs.Screen' } },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    '@/components/RideMap': { RideMap: 'RideMap' },
    '@/components/RoutePoiCards': { RoutePoiCards: 'RoutePoiCards' },
    '@/hooks/useRoutePois': { useRoutePois: () => ({ points: [], loading: false, error: false }) },
    '@/data/routeColors': {},
    '@/components/DriveOverlay': { DriveOverlay: 'DriveOverlay' },
    '@/components/DestinationSearch': { DestinationSearch: 'DestinationSearch' },
    '@/components/StandardTripPlanner': { StandardTripPlanner: 'StandardTripPlanner' },
    '@/components/ui': { IconButton: 'IconButton', ActionButton: 'ActionButton', ToggleRow: 'ToggleRow' },
    '@/data/seed': { defaultCenter: center, nearbyPlaces: [] },
    '@/state/AppProvider': { useApp: () => ({ settings: { avoidMotorways: true }, setActiveRoute: (draft) => activated.push(draft) }) },
    '@/theme': { colors: {}, spacing: {} },
    '@/utils/guidance': { upcomingManeuver: () => undefined },
    '@/utils/navigation': { cumulativeRouteDistances: () => [] },
    '@/utils/recording': { formatRidingTime: () => '0:00' },
    '@/services/rideTracking': {},
    '@/utils/pois': {},
    '@/utils/routes': {
      buildPointToPoint: (...args) => { planned.push(args); return { title: args[3], route: [args[0], args[1]] }; },
      snapDraftToRoads: async (draft) => draft,
    },
  });
  const screen = Screen();
  const search = find(screen, (n) => n.type === 'DestinationSearch');
  const place = { id: 'exact', name: 'Richmond Station', address: 'London', latitude: 51.4632, longitude: -0.3004 };
  await Promise.all([search.props.onSelect(place), search.props.onSelect(place)]);
  assert.equal(planned.length, 1);
  assert.deepEqual(planned[0][1], { latitude: place.latitude, longitude: place.longitude });
  assert.equal(planned[0][3], place.name);
  assert.equal(activated.length, 1);
});
