const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const start = { latitude: 51.5, longitude: -0.12 };
const next = { latitude: 51.501, longitude: -0.119 };
const touch = (pageX, pageY, count = 1) => ({ nativeEvent: { pageX, pageY, touches: Array(count).fill({}) } });
const bikeModule = { exports: {} };
new Function('exports', ts.transpileModule(readFileSync(path.join(__dirname, '../src/data/motorcycles.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(bikeModule.exports);
const routeModule = { exports: {} };
new Function('exports', ts.transpileModule(readFileSync(path.join(__dirname, '../src/utils/routes.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(routeModule.exports);

function mapHarness() {
  const slots = [];
  const timers = new Map();
  const calls = { animate: [], set: [], fit: [], follow: [] };
  let cursor = 0;
  let effects = [];
  let timerId = 0;
  let element;
  let cameraHeading = 0;
  let props = {
    navigationMode: true, followLocation: start, following: true,
    onFollowChange: (value) => { calls.follow.push(value); },
  };
  const react = {
    useMemo: (factory) => { cursor++; return factory(); },
    useRef: (value) => { const i = cursor++; return slots[i] ??= { current: value }; },
    useState: (value) => {
      const i = cursor++;
      slots[i] ??= { value };
      return [slots[i].value, (updated) => { slots[i].value = updated; }];
    },
    useEffect: (effect, deps) => {
      const i = cursor++;
      const previous = slots[i];
      if (previous && deps.every((dep, n) => Object.is(dep, previous.deps[n]))) return;
      effects.push(() => {
        previous?.cleanup?.();
        slots[i] = { deps, cleanup: effect() };
      });
    },
  };
  const jsx = (type, props) => ({ type, props });
  const imports = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { StyleSheet: { create: (styles) => styles }, Text: 'Text', View: 'View' },
    '@expo/vector-icons/Ionicons': { default: 'Icon' },
    'react-native-maps': { default: 'MapView', Marker: 'Marker', Polyline: 'Polyline' },
    '@/data/seed': { defaultCenter: start },
    '@/theme': { colors: {} },
    '@/components/MotorcycleGlyph': { MotorcycleGlyph: 'MotorcycleGlyph' },
    '@/data/motorcycles': bikeModule.exports,
    '@/utils/routes': routeModule.exports,
  };
  const source = readFileSync(path.join(__dirname, '../src/components/RideMap.tsx'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', outputText)(
    (name) => imports[name] ?? require(name), module, module.exports,
    (callback) => { timers.set(++timerId, callback); return timerId; },
    (id) => timers.delete(id),
  );
  const nativeMap = {
    getCamera: async () => ({ heading: cameraHeading }),
    animateCamera: (camera) => calls.animate.push(camera),
    setCamera: (camera) => calls.set.push(camera),
    fitToCoordinates: (coordinates) => calls.fit.push(coordinates),
  };
  const harness = {
    calls,
    get map() { return element.props; },
    setCameraHeading(heading) { cameraHeading = heading; },
    render(overrides = {}) {
      props = { ...props, ...overrides };
      cursor = 0;
      effects = [];
      element = module.exports.RideMap(props);
      element.props.ref.current = nativeMap;
      effects.forEach((effect) => effect());
    },
    ready() { element.props.onMapReady(); harness.render(); },
    flushTimers() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((callback) => callback());
    },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
  harness.render();
  return harness;
}

test('waits for map readiness and follows in 2D at a close speed-aware zoom', () => {
  const h = mapHarness();
  assert.equal(h.calls.animate.length, 0);
  h.ready();
  assert.equal(h.calls.animate.length, 1);
  assert.equal(h.calls.animate[0].pitch, 0);
  assert.equal(h.map.pitchEnabled, false);
  assert.equal(h.map.showsBuildings, false);
  assert.ok(h.calls.animate[0].zoom >= 16.4);
  h.map.onRegionChangeComplete(start, { isGesture: false });
  h.render({ followLocation: next, followSpeedKph: 100 });
  assert.equal(h.calls.animate.length, 2);
  assert.equal(h.calls.animate[1].pitch, 0);
  assert.deepEqual(h.calls.follow, []);
  h.unmount();
});

function riderMarker(map) {
  return map.children.flat(Infinity).find((node) => node?.props?.identifier === 'rider');
}

test('route endpoint pins yield to the rider at the start and finish, but remain in previews', () => {
  const h = mapHarness();
  const endpointIds = () => h.map.children.flat(Infinity)
    .flatMap((node) => node?.props?.children ?? [])
    .filter((node) => node?.props?.identifier?.startsWith('route-'))
    .map((node) => node.props.identifier);
  h.ready();
  h.render({ route: [start, next] });
  assert.deepEqual(endpointIds(), ['route-end']);
  h.render({ followLocation: next });
  assert.deepEqual(endpointIds(), ['route-start']);
  h.render({ route: [start, next, start], followLocation: start });
  assert.deepEqual(endpointIds(), []);
  assert.ok(riderMarker(h.map));
  h.render({ navigationMode: false });
  assert.deepEqual(endpointIds(), ['route-start', 'route-end']);
  h.unmount();
});

test('the selected motorcycle replaces the blue dot at the GPS coordinate only during a ride', () => {
  const h = mapHarness();
  h.ready();
  for (const motorcycleType of Object.keys(bikeModule.exports.motorcycles)) {
    h.render({ motorcycleType, followLocation: next });
    const marker = riderMarker(h.map);
    assert.equal(marker.props.coordinate, next);
    assert.equal(marker.props.children.props.children.props.children.props.type, motorcycleType);
    assert.equal(marker.props.children.props.children.props.children.props.size, 42);
    const containerStyles = [marker.props.children.props.style, marker.props.children.props.children.props.style].flat();
    for (const style of containerStyles) {
      assert.equal(style.backgroundColor, undefined);
      assert.equal(style.borderWidth, undefined);
      assert.equal(style.borderRadius, undefined);
    }
    assert.equal(h.map.showsUserLocation, false);
  }
  h.render({ navigationMode: false });
  assert.equal(riderMarker(h.map), undefined);
  assert.equal(h.map.showsUserLocation, true);
  h.render({ navigationMode: true, showUser: false });
  assert.equal(riderMarker(h.map), undefined);
  assert.equal(h.map.showsUserLocation, false);
  h.render({ showUser: true, compact: true });
  assert.equal(riderMarker(h.map), undefined);
  h.render({ compact: false, followLocation: undefined });
  assert.equal(riderMarker(h.map), undefined);
  assert.equal(h.map.showsUserLocation, true);
  h.unmount();
});

test('all ride speeds and screen sizes keep the GPS marker at the camera center, above the footer', () => {
  const h = mapHarness();
  h.ready();
  for (const height of [874, 568, 320]) {
    h.map.onLayout({ nativeEvent: { layout: { height } } });
    for (const speed of [0, 40, 80, 100, 130]) {
      h.render({ followSpeedKph: speed, bottomInset: 116, followHeading: 90 });
      const camera = h.calls.animate.at(-1);
      assert.deepEqual(camera.center, start);
      assert.equal(camera.heading, 90);
      assert.equal(camera.pitch, 0);
      assert.ok(camera.zoom >= 16.4);
      assert.equal(riderMarker(h.map).props.coordinate, start);
    }
  }
  h.unmount();
});

test('preview-to-ride layout changes, GPS updates and recentering never reapply a forward offset', () => {
  const h = mapHarness();
  h.render({ navigationMode: false, followLocation: undefined, route: [start, next], bottomInset: 205 });
  h.ready();
  h.flushTimers();
  h.render({ navigationMode: true, followLocation: start, bottomInset: 116 });
  h.map.onLayout({ nativeEvent: { layout: { height: 874 } } });
  h.render({ followLocation: next, followSpeedKph: 100 });
  assert.deepEqual(h.calls.animate.at(-1).center, next);
  assert.equal(riderMarker(h.map).props.coordinate, next);
  h.map.onPanDrag();
  h.render({ following: false });
  h.render({ following: true });
  assert.deepEqual(h.calls.animate.at(-1).center, next);
  h.unmount();
});

test('the motorcycle heading stays relative to the camera while browsing and keeps receiving GPS updates', async () => {
  const h = mapHarness();
  h.ready();
  h.render({ followHeading: 90, following: false });
  h.setCameraHeading(45);
  h.map.onRegionChangeComplete(start, { isGesture: true });
  await new Promise((resolve) => setImmediate(resolve));
  h.render({ followLocation: next });
  const marker = riderMarker(h.map);
  assert.equal(marker.props.coordinate, next);
  const glyphStyle = marker.props.children.props.children.props.style;
  assert.equal(glyphStyle[1].transform[0].rotate, '45deg');
  h.unmount();
});

test('pan suspends follow immediately, GPS cannot recenter, and the recenter action resumes it', () => {
  const h = mapHarness();
  h.ready();
  h.map.onPanDrag();
  h.render({ followLocation: next });
  assert.equal(h.calls.animate.length, 1);
  assert.deepEqual(h.calls.follow, [false]);
  h.render({ following: false });
  h.render({ followLocation: start });
  assert.equal(h.calls.animate.length, 1);
  h.render({ following: true });
  assert.equal(h.calls.animate.length, 2);
  assert.equal(h.calls.animate[1].zoom, 17.4);
  assert.equal(h.calls.animate[1].pitch, 0);
  assert.equal(h.map.pitchEnabled, false);
  h.unmount();
});

test('Apple Maps touch gestures and Google Maps gesture events suspend follow', () => {
  for (const gesture of [
    (map) => { map.onTouchStart(touch(20, 20)); map.onTouchMove(touch(40, 20)); },
    (map) => map.onTouchStart(touch(20, 20, 2)),
    (map) => map.onTouchMove(touch(20, 20, 2)),
    (map) => map.onDoublePress(),
    (map) => map.onRegionChangeComplete(start, { isGesture: true }),
  ]) {
    const h = mapHarness();
    h.ready();
    gesture(h.map);
    h.map.onPanDrag();
    assert.deepEqual(h.calls.follow, [false]);
    h.render({ followLocation: next });
    assert.equal(h.calls.animate.length, 1);
    h.unmount();
  }
});

test('a tap or tiny finger movement does not disable follow', () => {
  const h = mapHarness();
  h.ready();
  h.map.onTouchStart(touch(20, 20));
  h.map.onTouchMove(touch(22, 21));
  h.map.onTouchEnd();
  h.render({ followLocation: next });
  assert.deepEqual(h.calls.follow, []);
  assert.equal(h.calls.animate.length, 2);
  h.unmount();
});

test('ending a ride with route and trace cleared restores a flat camera at the last fix without zero zoom limits', () => {
  const h = mapHarness();
  h.ready();
  const limits = h.map.cameraZoomRange;
  h.render({ followLocation: next, route: [start, next], trace: [start, next] });
  h.map.onPanDrag();
  h.render({ navigationMode: false, followLocation: undefined, following: false, route: undefined, trace: [], bottomInset: 390 });
  h.flushTimers();
  assert.deepEqual(h.calls.set, [{ center: next, heading: 0, pitch: 0, altitude: 5000, zoom: 14 }]);
  assert.equal(h.map.cameraZoomRange, limits);
  assert.ok(limits.maxCenterCoordinateDistance > 5000);
  h.render({ bottomInset: 420 });
  h.flushTimers();
  assert.equal(h.calls.set.length, 1);
  h.map.onPanDrag();
  assert.deepEqual(h.calls.follow, [false]);
  h.unmount();
});

test('route previews still fit and a restarted ride cancels the pending overview reset', () => {
  const h = mapHarness();
  h.ready();
  h.render({ navigationMode: false, route: [start, next] });
  h.flushTimers();
  assert.deepEqual(h.calls.fit, [[start, next]]);
  h.render({ navigationMode: true });
  h.render({ navigationMode: false, route: undefined });
  h.render({ navigationMode: true });
  h.flushTimers();
  assert.equal(h.calls.set.length, 1);
  h.unmount();
});
