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

const speed = load('src/utils/speed.ts');

test('converts from canonical km/h once and rounds only the displayed value', () => {
  assert.equal(speed.displaySpeed(100, 'km/h'), 100);
  assert.equal(speed.displaySpeed(100, 'mph'), 62);
  assert.equal(speed.displaySpeed(48, 'mph'), 30);
  assert.equal(speed.displaySpeed(112.65408, 'mph'), 70);
  assert.equal(speed.displaySpeed(0, 'mph'), 0);
  assert.equal(speed.displaySpeed(62.5), 63);
  for (const invalid of [NaN, Infinity, -1]) assert.equal(speed.displaySpeed(invalid, 'mph'), 0);
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
const voiceInputs = [];
const { DriveOverlay } = load('src/components/DriveOverlay.tsx', {
  'react/jsx-runtime': { jsx, jsxs: jsx },
  react: { useState: (initial) => [initial, () => {}] },
  'react-native': { StyleSheet: { create: (styles) => styles }, View: 'View', Text: 'Text', Pressable: 'Pressable' },
  '@expo/vector-icons/Ionicons': { default: 'Icon' },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
  '@/components/ui': { IconButton: 'IconButton' },
  '@/hooks/useVoiceGuidance': { useVoiceGuidance: (props) => { voiceInputs.push(props); return false; } },
  '@/theme': { colors: { route: 'overspeed' } },
  '@/utils/navigation': { cardinalDirection: () => 'N', formatNavigationDistance: (km) => `${km} km` },
  '@/utils/speed': speed,
});

const defaults = {
  navigating: true, paused: false, gpsReady: true, gpsAccuracy: 5,
  speedKph: 100, speedLimitKph: 80, showSpeedLimit: true,
  remainingKm: 10, riddenKm: 5, heading: 0, following: true,
};

test('live speed and road limits change units together without changing warnings or voice timing', () => {
  for (const [unit, value, limit] of [['km/h', 100, 80], ['mph', 62, 50]]) {
    const screen = DriveOverlay({ ...defaults, speedUnit: unit });
    const readout = find(screen, (node) => node.props?.accessibilityLabel === `Speed ${value} ${speed.speedUnitName(unit)}`);
    assert.equal(readout.props.children[0].props.children, value);
    assert.equal(readout.props.children[1].props.children, unit);
    assert.equal(readout.props.style[1].backgroundColor, 'overspeed');
    const sign = find(screen, (node) => node.props?.accessibilityLabel === `Speed limit ${limit} ${speed.speedUnitName(unit)}`);
    assert.equal(sign.props.children.props.children, limit);
    assert.equal(voiceInputs.at(-1).speedKph, 100);
  }
});

test('unknown limits and paused or missing GPS remain unavailable, not zero', () => {
  for (const state of [{ paused: true }, { gpsReady: false }]) {
    const screen = DriveOverlay({ ...defaults, ...state, speedLimitKph: null, speedUnit: 'mph' });
    const readout = find(screen, (node) => node.props?.accessibilityLabel === 'Speed unavailable');
    assert.equal(readout.props.children[0].props.children, '--');
    const sign = find(screen, (node) => node.props?.accessibilityLabel === 'Speed limit unavailable');
    assert.equal(sign.props.children.props.children, '--');
  }
  const screen = DriveOverlay({ ...defaults, showSpeedLimit: false });
  assert.equal(find(screen, (node) => node.props?.accessibilityLabel?.startsWith('Speed limit')), undefined);
});

test('tour average speed uses the same preference without changing recorded distances', () => {
  let unit = 'km/h';
  const tour = { id: 'ride', date: 'Today', title: 'Recorded ride', author: 'Me', distanceKm: 100, durationMin: 60, route: [], completed: true,
    recording: { startedAt: 1, endedAt: 3600001, durationSeconds: 3600, segments: [] } };
  const { default: Screen } = load('src/app/tour/[id].tsx', {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { StyleSheet: { create: (styles) => styles }, View: 'View', Text: 'Text', ScrollView: 'ScrollView' },
    '@expo/vector-icons/Ionicons': { default: 'Icon' },
    'expo-file-system/legacy': {}, 'expo-sharing': {},
    'expo-router': { router: {}, useLocalSearchParams: () => ({ id: 'ride' }) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0 }) },
    '@/components/RideMap': { RideMap: 'RideMap' },
    '@/components/ui': { ActionButton: 'ActionButton', IconButton: 'IconButton' },
    '@/state/AppProvider': { useApp: () => ({ tours: [tour], settings: { speedUnit: unit } }) },
    '@/theme': { colors: {}, spacing: {} },
    '@/utils/routes': {}, '@/utils/recording': { formatRidingTime: () => '1:00:00' },
    '@/utils/speed': speed,
  });
  for (const [speedUnit, expected] of [['km/h', '100 km/h'], ['mph', '62 mph']]) {
    unit = speedUnit;
    const screen = Screen();
    assert.ok(find(screen, (node) => node.type === 'Text' && [].concat(node.props.children).join('') === expected));
    assert.equal(tour.distanceKm, 100);
  }
});
