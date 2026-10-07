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

const arrowModule = { exports: {} };
new Function('exports', ts.transpileModule(readFileSync(path.join(__dirname, '../src/utils/routeArrows.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(arrowModule.exports);

const routeColorData = {};
new Function('exports', ts.transpileModule(readFileSync(path.join(__dirname, '../src/data/routeColors.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(routeColorData);

function mapHarness() {
  const slots = [];
  const timers = new Map();
  const calls = { animate: [], set: [], fit: [], follow: [] };
  let cursor = 0;
  let effects = [];
  let timerId = 0;
  let element;
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
  const styleModule = { exports: {} };
  new Function('exports', ts.transpileModule(readFileSync(path.join(__dirname, '../src/utils/mapStyle.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(styleModule.exports);
  const imports = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { StyleSheet: { create: (styles) => styles }, Text: 'Text', View: 'View' },
    '@expo/vector-icons/Ionicons': { default: 'Icon' },
    '@maplibre/maplibre-react-native': Object.fromEntries(['Map', 'Camera', 'Marker', 'Layer', 'GeoJSONSource', 'UserLocation'].map((name) => [name, name])),
    '@/utils/mapStyle': styleModule.exports,
    '@/utils/routeArrows': arrowModule.exports,
    '@/data/routeColors': routeColorData,
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
    easeTo: (camera) => calls.animate.push(camera),
    jumpTo: (camera) => calls.set.push(camera),
    fitBounds: (bounds, options) => calls.fit.push({ bounds, options }),
  };
  const harness = {
    calls,
    get map() { return element.props.children.props; },
    get wrapper() { return element.props; },
    render(overrides = {}) {
      props = { ...props, ...overrides };
      cursor = 0;
      effects = [];
      element = module.exports.RideMap(props);
      harness.map.children.find((child) => child?.type === 'Camera').props.ref.current = nativeMap;
      effects.forEach((effect) => effect());
    },
    ready() { harness.map.onDidFinishLoadingStyle(); harness.render(); },
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

function nodes(node, type) {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap((child) => nodes(child, type));
  return [...(node.type === type ? [node] : []), ...nodes(node.props?.children, type)];
}
const viewport = (bearing = 0, userInteraction = false) => ({ nativeEvent: { bearing, userInteraction, center: [-0.12, 51.5] } });

test('standard trip markers follow stop order without duplicate destination labels', () => {
  const h=mapHarness();
  const stops=[{...next,id:'cafe',name:'Cafe'},{...start,id:'home',name:'Home'},{...next,id:'cafe',name:'Cafe'}];
  h.render({navigationMode:false,route:[start,next,start,next],tripStops:stops});
  const markers=nodes(h.map.children,'Marker');
  const stopMarkers=markers.filter(n=>n.props.id.startsWith('trip-stop-'));
  assert.deepEqual(stopMarkers.map(n=>n.props.id),['trip-stop-0','trip-stop-1','trip-stop-2']);
  assert.deepEqual(stopMarkers.map(n=>nodes(n,'Text')[0].props.children),['A','B','C']);
  assert.ok(!markers.some(n=>n.props.id==='route-end'));
  assert.match(nodes(stopMarkers[2],'View')[0].props.accessibilityLabel,/Destination C: Cafe/);
});

test('round-trip preview numbers match cards, pin to the route and disappear in navigation', () => {
  const h=mapHarness();
  const point={id:'viewpoint',name:'Hilltop',number:3,latitude:51.501,longitude:-0.115,routePoint:next,category:'sight',detail:'viewpoint',distanceAlongKm:12,distanceFromRouteKm:0.1};
  let selected;
  h.render({navigationMode:false,roundTripPreview:true,route:[start,next,start],routePois:[point],selectedRoutePoiId:point.id,onRoutePoiSelect:p=>{selected=p;}});
  const markers=nodes(h.map.children,'Marker');
  assert.ok(!markers.some(n=>n.props.id==='route-end'));
  const marker=markers.find(n=>n.props.id==='route-poi-viewpoint');
  assert.deepEqual(marker.props.lngLat,[next.longitude,next.latitude]);
  assert.equal(nodes(marker,'Text')[0].props.children,3);
  marker.props.onPress();assert.equal(selected,point);
  assert.equal(nodes(marker,'View')[0].props.accessibilityState.selected,true);
  h.render({navigationMode:true});
  assert.ok(!nodes(h.map.children,'Marker').some(n=>n.props.id==='route-poi-viewpoint'));
});

test('one validated vector map is used in browsing, previews and riding without 3D buildings', () => {
  const { validateStyleMin } = require('@maplibre/maplibre-gl-style-spec');
  const h = mapHarness();
  const style = h.map.mapStyle;
  assert.deepEqual(validateStyleMin(style), []);
  assert.equal(Object.keys(style.sources).length, 1);
  assert.equal(style.sources.openmaptiles.type, 'vector');
  assert.ok(style.layers.every((layer) => !['raster', 'fill-extrusion'].includes(layer.type)));
  assert.ok(style.layers.every((layer) => layer['source-layer'] !== 'poi'));
  for (const props of [{}, { navigationMode: false }, { compact: true }]) {
    h.render({ ...props, bottomInset: 120 });
    assert.deepEqual(h.map.mapStyle, style);
    assert.equal(h.map.attribution, true);
    assert.ok(h.map.attributionPosition.bottom > 120);
  }
  h.unmount();
});

test('camera waits for style readiness, follows course with tilt, centers GPS above footer', () => {
  const h = mapHarness();
  assert.equal(h.calls.animate.length, 0);
  h.ready();
  h.render({ followLocation: next, followSpeedKph: 100, followHeading: 270, bottomInset: 116 });
  const camera = h.calls.animate.at(-1);
  assert.deepEqual(camera.center, [next.longitude, next.latitude]);
  assert.equal(camera.bearing, 270);
  assert.equal(camera.pitch, 45);
  assert.equal(camera.padding.bottom, 116);
  assert.ok(camera.zoom >= 16.4);
  h.map.onRegionDidChange(viewport(270));
  assert.deepEqual(h.calls.follow, []);
  h.unmount();
});

test('route and disconnected recordings are GeoJSON drawn over the basemap', () => {
  const h = mapHarness();
  h.render({ route: [start, next], trackSegments: [[start, next], [], [start], [next, start]] });
  const sources = nodes(h.map.children, 'GeoJSONSource');
  assert.equal(sources.length, 2);
  assert.deepEqual(sources[0].props.data.geometry.coordinates, [[start.longitude, start.latitude], [next.longitude, next.latitude]]);
  assert.equal(sources[1].props.data.geometry.coordinates.length, 2);
  const lines = nodes(sources[0], 'Layer');
  assert.equal(lines[1].props.afterId, 'route-outline');
  assert.equal(lines[1].props.paint['line-width'], 6);
  assert.ok(!lines[0].props.beforeId);
  h.unmount();
});

test('endpoint markers yield to rider and rider rotates relative to map bearing', () => {
  const h = mapHarness();
  h.ready();
  h.render({ route: [start, next], followHeading: 120, motorcycleType: 'cruiser' });
  h.map.onRegionIsChanging(viewport(90));
  h.render();
  const markers = nodes(h.map.children, 'Marker');
  assert.deepEqual(markers.map((m) => m.props.id), ['rider', 'route-end']);
  const glyph = nodes(markers[0], 'MotorcycleGlyph')[0];
  assert.equal(glyph.props.type, 'cruiser');
  assert.equal(glyph.props.size, 63);
  assert.equal(markers[0].props.children.props.children.props.style[1].transform[0].rotate, '30deg');
  assert.equal(nodes(h.map.children, 'UserLocation').length, 0);
  h.render({ navigationMode: false });
  assert.equal(nodes(h.map.children, 'UserLocation').length, 1);
  assert.deepEqual(nodes(h.map.children, 'Marker').map((m) => m.props.id), ['route-start', 'route-end']);
  h.unmount();
});

test('gestures suspend follow immediately until explicit recenter, taps do not', () => {
  for (const gesture of ['drag', 'pinch', 'native']) {
    const h = mapHarness();
    h.ready();
    h.wrapper.onTouchStart(touch(100, 100));
    h.wrapper.onTouchMove(touch(102, 101));
    assert.deepEqual(h.calls.follow, []);
    if (gesture === 'native') h.map.onRegionWillChange(viewport(20, true));
    else h.wrapper.onTouchMove(touch(gesture === 'drag' ? 120 : 100, 100, gesture === 'pinch' ? 2 : 1));
    const count = h.calls.animate.length;
    h.render({ followLocation: next });
    assert.equal(h.calls.animate.length, count);
    assert.deepEqual(h.calls.follow, [false]);
    h.render({ following: false });
    h.render({ following: true });
    assert.equal(h.calls.animate.length, count + 1);
    h.unmount();
  }
});

test('leaving navigation resets tilt and previews fit route bounds with footer padding', () => {
  const h = mapHarness();
  h.ready();
  h.render({ navigationMode: false, followLocation: undefined });
  h.flushTimers();
  assert.equal(h.calls.set.at(-1).pitch, 0);
  assert.equal(h.calls.set.at(-1).bearing, 0);
  h.render({ route: [start, next], bottomInset: 200 });
  h.flushTimers();
  assert.deepEqual(h.calls.fit.at(-1).bounds, [-0.12, 51.5, -0.119, 51.501]);
  assert.equal(h.calls.fit.at(-1).options.padding.bottom, 234);
  h.render({ bottomInset: 201 });
  const count = h.calls.fit.length;
  h.render({ navigationMode: true });
  h.flushTimers();
  assert.equal(h.calls.fit.length, count);
  h.unmount();
});

test('map events convert longitude-first coordinates to app coordinates', () => {
  const h = mapHarness();
  let center, destination;
  h.render({ onRegionChange: (value) => center = value, onLongPress: (value) => destination = value });
  h.map.onRegionDidChange(viewport());
  h.map.onLongPress({ nativeEvent: { lngLat: [next.longitude, next.latitude] } });
  assert.deepEqual(center, start);
  assert.deepEqual(destination, next);
  h.unmount();
});

test('turn arrows render above the route at riding zoom and respect progress and compact views', () => {
  const h = mapHarness();
  const corner = { latitude: 51.501, longitude: -0.12 };
  const end = { latitude: 51.501, longitude: -0.118 };
  h.ready();
  h.render({ route: [start, corner, end], maneuvers: [{ type: 10, beginShapeIndex: 1, endShapeIndex: 2, instruction: 'Turn right' }] });
  const arrows = () => nodes(h.map.children, 'GeoJSONSource').find(node => node.props.id === 'turn-arrows');
  assert.equal(arrows(), undefined);
  h.map.onRegionDidChange({ nativeEvent: { ...viewport().nativeEvent, zoom: 17.4 } });
  h.render();
  assert.equal(arrows().props.data.features.length, 3);
  const sources = nodes(h.map.children, 'GeoJSONSource');
  assert.ok(sources.findIndex(node => node.props.id === 'turn-arrows') > sources.findIndex(node => node.props.id === 'route'));
  assert.equal(sources.find(node => node.props.id === 'route').props.tolerance, 0);
  assert.equal(arrows().props.tolerance, 0);
  const layers = nodes(arrows(), 'Layer');
  assert.equal(layers.find(node => node.props.id === 'turn-shaft').props.paint['line-width'], 7.2);
  h.render({ routeIndex: 2 });
  assert.equal(arrows(), undefined);
  h.render({ navigationMode: false });
  assert.ok(arrows());
  h.render({ compact: true });
  assert.equal(arrows(), undefined);
  h.unmount();
});

test('browsing recenter waits for the map, keeps the fix above the sheet, and is one-shot', () => {
  const h = mapHarness();
  h.render({ navigationMode: false, followLocation: undefined, recenterTarget: next, bottomInset: 390 });
  assert.equal(h.calls.animate.length, 0);
  h.ready();
  assert.equal(h.calls.animate.length, 1);
  const camera = h.calls.animate[0];
  assert.deepEqual(camera.center, [next.longitude, next.latitude]);
  assert.equal(camera.bearing, 0);
  assert.equal(camera.pitch, 0);
  assert.equal(camera.padding.bottom, 390);
  assert.equal(camera.zoom, 15);
  h.map.onRegionDidChange(viewport(30, true));
  h.render({ bottomInset: 420 });
  assert.equal(h.calls.animate.length, 1, 'browsing and sheet changes must not repeat recenter');
  h.render({ recenterTarget: { ...next } });
  assert.equal(h.calls.animate.length, 2, 'another tap recenters even if GPS has not moved');
  h.unmount();
});

test('recenter overrides queued route fitting but a later new route can still fit', () => {
  const h = mapHarness();
  h.render({ navigationMode: false, followLocation: undefined, route: [start, next] });
  h.ready();
  h.render({ recenterTarget: start });
  h.flushTimers();
  assert.equal(h.calls.fit.length, 0);
  assert.deepEqual(h.calls.animate.at(-1).center, [start.longitude, start.latitude]);
  h.render({ route: [next, start] });
  h.flushTimers();
  assert.equal(h.calls.fit.length, 1);
  h.unmount();
});

test('browsing recenter cannot override active riding or replay when the ride ends', () => {
  const h = mapHarness();
  h.ready();
  const count = h.calls.animate.length;
  h.render({ recenterTarget: next });
  assert.equal(h.calls.animate.length, count);
  h.render({ navigationMode: false, followLocation: undefined });
  h.flushTimers();
  assert.equal(h.calls.animate.length, count);
  h.render({ recenterTarget: { ...next } });
  assert.equal(h.calls.animate.length, count + 1);
  h.unmount();
});


test('one route colour updates the line and both arrow outlines without changing white centres', () => {
  const h = mapHarness();
  const corner = { latitude: 51.501, longitude: -0.12 };
  const end = { latitude: 51.501, longitude: -0.118 };
  h.ready();
  h.map.onRegionDidChange({ nativeEvent: { ...viewport().nativeEvent, zoom: 17 } });
  h.render({ route: [start, corner, end], maneuvers: [{ type: 10, beginShapeIndex: 1, endShapeIndex: 2, instruction: 'Turn' }] });
  for (const [routeColor, { value }] of Object.entries(routeColorData.routeColors)) {
    h.render({ routeColor });
    const layers = Object.fromEntries(nodes(h.map.children, 'Layer').map(node => [node.props.id, node.props.paint]));
    assert.equal(layers['route-line']['line-color'], value);
    assert.equal(layers['turn-shaft-outline']['line-color'], value);
    assert.equal(layers['turn-head-outline']['fill-color'], value);
    assert.equal(layers['turn-shaft']['line-color'], '#ffffff');
    assert.equal(layers['turn-head']['fill-color'], '#ffffff');
    assert.equal(layers['route-outline']['line-color'], '#ffffff');
  }
  h.unmount();
});
