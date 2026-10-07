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
const motorcycles = load('src/data/motorcycles.ts');
const routeColorData = load('src/data/routeColors.ts');
const settingsUtils = load('src/utils/settings.ts', { '@/data/motorcycles': motorcycles, '@/data/routeColors': routeColorData });
const jsx = (type, props) => ({ type, props });
const rn = { StyleSheet: { create: (styles) => styles }, View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput', ScrollView: 'ScrollView' };

test('named motorcycles retain the requested models and the existing Octav selection', () => {
  assert.equal(motorcycles.motorcycles.funventure.label, 'Octav');
  assert.equal(settingsUtils.restoreSettings({ motorcycleType: 'funventure' }).motorcycleType, 'funventure');
  const expected = {
    bogdan: ['Bogdan', 'Kawasaki Z650 (2020)'],
    radu: ['Radu', 'BMW R1200GS (2025)'],
    petre: ['Petre', 'Yamaha Tracer 900 GT (2018)'],
    foca: ['Foca', 'Triumph Bonneville T100 (2008)'],
  };
  for (const [type, [label, model]] of Object.entries(expected)) {
    assert.equal(motorcycles.motorcycles[type].label, label);
    assert.equal(motorcycles.motorcycles[type].model, model);
    assert.equal(settingsUtils.restoreSettings({ motorcycleType: type }).motorcycleType, type);
  }
});

test('each motorcycle uses its own RGBA bitmap at a stable, compact size', () => {
  const assets = Object.fromEntries(Object.keys(motorcycles.motorcycles).map((type) => {
    const asset = `../../assets/motorcycles/${type}.png`;
    const png = readFileSync(path.join(__dirname, '../assets/motorcycles', `${type}.png`));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.subarray(12, 16).toString(), 'IHDR');
    assert.equal(png[25], 6, `${type} must retain an RGBA alpha channel`);
    return [asset, asset];
  }));
  const { MotorcycleGlyph } = load('src/components/MotorcycleGlyph.tsx', {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Image: 'Image' },
    '@/data/motorcycles': motorcycles,
    ...assets,
  });
  for (const type of Object.keys(motorcycles.motorcycles)) {
    const glyph = MotorcycleGlyph({ type });
    assert.equal(glyph.type, 'Image');
    assert.equal(glyph.props.source, `../../assets/motorcycles/${type}.png`);
    assert.equal(glyph.props.resizeMode, 'contain');
    assert.deepEqual(glyph.props.style, { height: 63, width: 63 });
    assert.deepEqual(MotorcycleGlyph({ type, size: 81 }).props.style, { height: 81, width: 81 });
  }
  assert.equal(MotorcycleGlyph({ type: 'unknown' }).props.source, '../../assets/motorcycles/adventure.png');
});

test('old settings gain safe defaults and unknown motorcycle types cannot break the map', () => {
  const settings = settingsUtils.restoreSettings({ avoidMotorways: false, voiceGuidance: false, offlineMaps: true });
  assert.equal(settings.motorcycleType, 'adventure');
  assert.equal(settings.motorcycleName, '');
  assert.equal(settings.routingProfile, 'winding');
  assert.equal(settings.avoidMotorways, false);
  assert.equal(settings.voiceGuidance, false);
  assert.equal(settings.offlineMaps, false);
  assert.equal(settings.routeColor, 'red');
  for (const routeColor of ['invalid', '#ffffff', '__proto__', null]) assert.equal(settingsUtils.restoreSettings({ routeColor }).routeColor, 'red');
  assert.equal(settings.speedUnit, 'km/h');
  for (const speedUnit of ['knots', null, undefined, 42]) {
    assert.equal(settingsUtils.restoreSettings({ speedUnit }).speedUnit, 'km/h');
  }
  assert.equal(settingsUtils.restoreSettings({ speedUnit: 'mph' }).speedUnit, 'mph');
  for (const motorcycleType of ['unknown', '__proto__', 'toString', null]) {
    assert.equal(settingsUtils.restoreSettings({ motorcycleType }).motorcycleType, 'adventure');
  }
});

function find(element, predicate) {
  if (!element || typeof element !== 'object') return;
  if (predicate(element)) return element;
  for (const child of [element.props?.children].flat(Infinity)) {
    const match = find(child, predicate);
    if (match) return match;
  }
}

test('bike settings controls update the motorcycle, model, route profile and motorway preference', () => {
  let settings = { ...settingsUtils.initialSettings };
  const { default: Screen } = load('src/app/bike.tsx', {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': rn,
    '@expo/vector-icons/Ionicons': { default: 'Icon' },
    'expo-router': { router: {} },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0 }) },
    '@/components/RouteColorPicker': { RouteColorPicker: 'RouteColorPicker' },
    '@/components/ui': { IconButton: 'IconButton', ToggleRow: 'ToggleRow' },
    '@/components/MotorcycleGlyph': { MotorcycleGlyph: 'MotorcycleGlyph' },
    '@/state/AppProvider': { useApp: () => ({ ready: true, settings, updateSettings: (next) => { settings = { ...settings, ...next }; } }) },
    '@/theme': { colors: {}, spacing: {} },
    '@/data/motorcycles': motorcycles,
  });
  for (const [type, metadata] of Object.entries(motorcycles.motorcycles)) {
    const radio = find(Screen(), (node) => node.props?.accessibilityLabel === metadata.label);
    radio.props.onPress();
    assert.equal(settings.motorcycleType, type);
    assert.equal(find(Screen(), (node) => node.props?.accessibilityLabel === metadata.label).props.accessibilityState.checked, true);
  }
  find(Screen(), (node) => node.type === 'TextInput').props.onChangeText('Honda Africa Twin');
  assert.equal(settings.motorcycleName, 'Honda Africa Twin');
  find(Screen(), (node) => node.props?.accessibilityLabel === 'twisty routes').props.onPress();
  assert.equal(settings.routingProfile, 'twisty');
  find(Screen(), (node) => node.type === 'ToggleRow').props.onPress();
  assert.equal(settings.avoidMotorways, false);
  find(Screen(), (node) => node.type === 'RouteColorPicker').props.onChange('purple');
  assert.equal(settings.routeColor, 'purple');
  assert.equal(find(Screen(), (node) => node.type === 'RouteColorPicker').props.value, 'purple');
});

test('profile bike and routes rows open settings or tours, while unsupported services report their status', () => {
  const navigation = [];
  const alerts = [];
  let settings = { ...settingsUtils.initialSettings };
  const { default: Screen } = load('src/app/profile.tsx', {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { ...rn, Image: 'Image', Alert: { alert: (...args) => alerts.push(args) } },
    '../../assets/bendbound-logo.png': 'bendbound-logo',
    '@expo/vector-icons/Ionicons': { default: 'Icon' },
    'expo-router': { router: { push: (route) => navigation.push(route), navigate: (route) => navigation.push(route) } },
    'expo-document-picker': {},
    'expo-file-system/legacy': {},
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0 }) },
    '@/components/RouteColorPicker': { RouteColorPicker: 'RouteColorPicker' },
    '@/components/ui': { ActionButton: 'ActionButton', ToggleRow: 'ToggleRow' },
    '@/state/AppProvider': { useApp: () => ({ tours: [], settings, updateSettings: (next) => { settings = { ...settings, ...next }; } }) },
    '@/theme': { colors: {}, spacing: {} },
    '@/utils/routes': {},
    '@/data/motorcycles': motorcycles,
  });
  find(Screen(), (node) => node.type === 'RouteColorPicker').props.onChange('teal');
  assert.equal(settings.routeColor, 'teal');
  const screen = Screen();
  const logo = find(screen, (node) => node.type === 'Image');
  assert.equal(logo.props.source, 'bendbound-logo');
  assert.equal(logo.props.accessibilityLabel, 'Bendbound');
  assert.equal(logo.props.resizeMode, 'contain');
  for (const label of ['My motorcycle', 'Route preferences', 'My tours & saved routes', 'Offline map regions', 'Group rides']) {
    const row = find(screen, (node) => node.props?.label === label);
    const button = row.type(row.props);
    assert.equal(button.props.accessibilityRole, 'button');
    button.props.onPress();
  }
  find(screen, (node) => node.props?.accessibilityLabel === 'Routes and bike settings').props.onPress();
  assert.deepEqual(navigation, ['/bike', '/bike', '/tours', '/bike']);
  assert.deepEqual(alerts.map((args) => args[0]), ['Offline maps unavailable', 'Live group rides unavailable']);
  for (const speedUnit of ['mph', 'km/h']) {
    const radio = find(Screen(), (node) => node.props?.accessibilityLabel === speedUnit);
    radio.props.onPress();
    assert.equal(settings.speedUnit, speedUnit);
    assert.equal(find(Screen(), (node) => node.props?.accessibilityLabel === speedUnit).props.accessibilityState.checked, true);
  }
});

function providerHarness(stored, { legacy = null, readFailure, writeFailure = false, pending = [] } = {}) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let value;
  const storage = new Map([['bendbound-state-v2', stored], ['roams-state-v2', legacy]]);
  const reads = [];
  const writes = [];
  const acknowledged = [];
  const react = {
    createContext: () => ({ Provider: 'Provider' }),
    useMemo: (factory) => { cursor++; return factory(); },
    useState: (initial) => {
      const i = cursor++;
      slots[i] ??= { value: initial };
      return [slots[i].value, (next) => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }];
    },
    useEffect: (effect, deps) => {
      const i = cursor++;
      if (slots[i] && deps.every((dep, n) => Object.is(dep, slots[i].deps[n]))) return;
      effects.push(() => { slots[i] = { deps, cleanup: effect() }; });
    },
  };
  const { AppProvider } = load('src/state/AppProvider.tsx', {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'expo-sqlite/kv-store': { __esModule: true, default: {
      getItem: async (key) => {
        reads.push(key);
        assert.ok(storage.has(key));
        if (key === readFailure) throw new Error('Read failed');
        return storage.get(key);
      },
      setItem: async (key, next) => {
        assert.equal(key, 'bendbound-state-v2');
        writes.push(key);
        if (writeFailure) throw new Error('Write failed');
        storage.set(key, next);
      },
    } },
    '@/data/seed': { seedTours: [] },
    '@/utils/routes': {},
    '@/utils/settings': settingsUtils,
    '@/services/rideStore': {
      pendingRecordedTours: () => pending,
      acknowledgeRecordedTours: (tours) => {
        assert.deepEqual(JSON.parse(storage.get('bendbound-state-v2')).tours, tours);
        acknowledged.push(...tours.map((tour) => tour.id));
      },
    },
  });
  return {
    get value() { return value; },
    get serialized() { return storage.get('bendbound-state-v2'); },
    get legacy() { return storage.get('roams-state-v2'); },
    reads,
    writes,
    acknowledged,
    async render() {
      cursor = 0;
      effects = [];
      value = AppProvider({ children: null }).props.value;
      effects.forEach((effect) => effect());
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('completed ride recovery merges once and is acknowledged only after a successful tour write', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const ride = { id: 'recorded', title: 'Recovery ride', completed: true, route: [] };
  const stored = JSON.stringify({ tours: [{ id: 'plan', route: [], saved: true }], settings: {}, routingVersion: 7 });
  const failed = providerHarness(stored, { pending: [ride], writeFailure: true });
  await failed.render(); await failed.render();
  assert.equal(failed.value.tours[0].id, ride.id);
  assert.deepEqual(failed.acknowledged, []);
  assert.equal(failed.serialized, stored);
  const retry = providerHarness(stored, { pending: [ride] });
  await retry.render(); await retry.render();
  assert.deepEqual(JSON.parse(retry.serialized).tours.map((tour) => tour.id), ['recorded', 'plan']);
  assert.ok(retry.acknowledged.includes(ride.id));
  const restarted = providerHarness(retry.serialized, { pending: [ride] });
  await restarted.render(); await restarted.render();
  assert.equal(restarted.value.tours.filter((tour) => tour.id === ride.id).length, 1);
});

test('bike settings are written to storage and restored across app restarts', async () => {
  const first = providerHarness(null);
  await first.render();
  await new Promise((resolve) => setImmediate(resolve));
  await first.render();
  first.value.updateSettings({ motorcycleType: 'funventure', motorcycleName: 'My V-Strom', routingProfile: 'twisty', avoidMotorways: false, speedUnit: 'mph', routeColor: 'purple' });
  await first.render();
  const second = providerHarness(first.serialized);
  await second.render();
  await new Promise((resolve) => setImmediate(resolve));
  await second.render();
  assert.equal(second.value.settings.motorcycleType, 'funventure');
  assert.equal(second.value.settings.motorcycleName, 'My V-Strom');
  assert.equal(second.value.settings.speedUnit, 'mph');
  assert.equal(second.value.settings.routeColor, 'purple');
  assert.equal(second.value.settings.routingProfile, 'twisty');
  assert.equal(second.value.settings.avoidMotorways, false);
  second.value.updateSettings({ motorcycleType: 'scooter' });
  await second.render();
  const third = providerHarness(second.serialized);
  await third.render();
  await new Promise((resolve) => setImmediate(resolve));
  await third.render();
  assert.equal(third.value.settings.motorcycleType, 'scooter');
  assert.equal(third.value.settings.speedUnit, 'mph');
});

test('rebranding preserves stored tours and preferences and updates only generated place labels', async () => {
  const route = [{ latitude: 51.5, longitude: -0.12 }];
  const tours = [
    { id: 'old-plan', title: 'Roams weekend', route, place: 'Created in Roams', saved: true },
    { id: 'old-ride', route, place: 'Recorded in Roams', completed: true, recording: { segments: [route], durationSeconds: 73 } },
    { id: 'custom', route, place: 'Roams cafe', saved: true },
  ];
  const legacy = JSON.stringify({ tours, settings: { speedUnit: 'mph', motorcycleType: 'funventure' }, routingVersion: 7 });
  const h = providerHarness(null, { legacy });
  await h.render();
  await new Promise((resolve) => setImmediate(resolve));
  await h.render();
  const expected = tours.map((tour, index) => ({ ...tour, place: ['Created in Bendbound', 'Recorded in Bendbound', 'Roams cafe'][index] }));
  assert.deepEqual(h.value.tours, expected);
  assert.deepEqual(JSON.parse(h.serialized).tours, expected);
  assert.equal(h.value.settings.speedUnit, 'mph');
  assert.equal(h.value.settings.motorcycleType, 'funventure');
  assert.equal(h.legacy, legacy);
  assert.deepEqual(h.reads, ['bendbound-state-v2', 'roams-state-v2']);
  assert.deepEqual(h.writes, ['bendbound-state-v2']);
});

test('new storage takes precedence over the legacy backup', async () => {
  const stored = JSON.stringify({ tours: [], settings: { motorcycleType: 'bogdan' }, routingVersion: 7 });
  const legacy = JSON.stringify({ tours: [{ id: 'deleted-tour' }], settings: { motorcycleType: 'funventure' } });
  const h = providerHarness(stored, { legacy });
  await h.render();
  await new Promise((resolve) => setImmediate(resolve));
  await h.render();
  assert.equal(h.value.settings.motorcycleType, 'bogdan');
  assert.deepEqual(h.value.tours, []);
  assert.deepEqual(h.reads, ['bendbound-state-v2']);
  assert.equal(h.legacy, legacy);
});

test('fresh installs persist defaults under the Bendbound key only', async () => {
  const h = providerHarness(null);
  await h.render();
  assert.deepEqual(h.writes, []);
  await new Promise((resolve) => setImmediate(resolve));
  await h.render();
  assert.equal(h.value.ready, true);
  assert.deepEqual(JSON.parse(h.serialized).settings, settingsUtils.initialSettings);
  assert.deepEqual(h.writes, ['bendbound-state-v2']);
  assert.equal(h.legacy, null);
});

test('unreadable saved data is never replaced with defaults or older data', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const valid = JSON.stringify({ tours: [], settings: { motorcycleType: 'radu' }, routingVersion: 7 });
  for (const invalid of ['{', 'null', '[]', '{"tours":{}}', '{"settings":[]}']) {
    for (const [stored, legacy] of [[invalid, valid], [null, invalid]]) {
      const h = providerHarness(stored, { legacy });
      await h.render();
      await new Promise((resolve) => setImmediate(resolve));
      await h.render();
      assert.equal(h.value.ready, true);
      h.value.updateSettings({ motorcycleType: 'petre' });
      await h.render();
      assert.deepEqual(h.writes, []);
      assert.equal(h.serialized, stored);
      assert.equal(h.legacy, legacy);
      if (stored !== null) assert.deepEqual(h.reads, ['bendbound-state-v2']);
    }
  }
  for (const readFailure of ['bendbound-state-v2', 'roams-state-v2']) {
    const h = providerHarness(null, { legacy: valid, readFailure });
    await h.render();
    await new Promise((resolve) => setImmediate(resolve));
    await h.render();
    assert.equal(h.value.ready, true);
    assert.deepEqual(h.writes, []);
    assert.equal(h.serialized, null);
    assert.equal(h.legacy, valid);
  }
});

test('a failed migration write leaves the legacy backup intact for the next launch', async () => {
  const legacy = JSON.stringify({ tours: [], settings: { motorcycleType: 'foca' }, routingVersion: 7 });
  const h = providerHarness(null, { legacy, writeFailure: true });
  await h.render();
  await new Promise((resolve) => setImmediate(resolve));
  await h.render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.value.settings.motorcycleType, 'foca');
  assert.equal(h.serialized, null);
  assert.equal(h.legacy, legacy);
  const retry = providerHarness(h.serialized, { legacy: h.legacy });
  await retry.render();
  await new Promise((resolve) => setImmediate(resolve));
  await retry.render();
  assert.equal(JSON.parse(retry.serialized).settings.motorcycleType, 'foca');
});

test('every named motorcycle survives saving and restarting without overwriting custom bike names', async () => {
  for (const motorcycleType of ['funventure', 'bogdan', 'radu', 'petre', 'foca']) {
    const first = providerHarness(null);
    await first.render();
    await new Promise((resolve) => setImmediate(resolve));
    await first.render();
    first.value.updateSettings({ motorcycleType, motorcycleName: 'My personal bike', speedUnit: 'mph' });
    await first.render();
    const second = providerHarness(first.serialized);
    await second.render();
    await new Promise((resolve) => setImmediate(resolve));
    await second.render();
    assert.equal(second.value.settings.motorcycleType, motorcycleType);
    assert.equal(second.value.settings.motorcycleName, 'My personal bike');
    assert.equal(second.value.settings.speedUnit, 'mph');
  }
});


test('route colour picker has one accessible selection and persists every offered colour', async () => {
  let value = 'red';
  const { RouteColorPicker } = load('src/components/RouteColorPicker.tsx', {
    'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': rn,
    '@expo/vector-icons/Ionicons': { default: 'Icon' },
    '@/data/routeColors': routeColorData, '@/theme': { colors: {} },
  });
  const render = () => RouteColorPicker({ value, onChange: (next) => { value = next; } });
  for (const [color, metadata] of Object.entries(routeColorData.routeColors)) {
    const selected = find(render(), (node) => node.props?.accessibilityLabel === `${metadata.label} route and arrows`);
    selected.props.onPress();
    assert.equal(value, color);
    assert.equal(find(render(), (node) => node.props?.accessibilityLabel === `${metadata.label} route and arrows`).props.accessibilityState.checked, true);
    const h = providerHarness(JSON.stringify({ tours: [], settings: { routeColor: color }, routingVersion: 7 }));
    await h.render();
    await new Promise((resolve) => setImmediate(resolve));
    await h.render();
    assert.equal(h.value.settings.routeColor, color);
  }
});
