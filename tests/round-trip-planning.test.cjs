const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const path = require('node:path');
const center = { latitude: 51.5, longitude: -0.12 };
function find(node, predicate) {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const hit = find(child, predicate); if (hit) return hit; }
}
function harness() {
  const state = [], refs = [], planned = [], alerts = [], activated = [];
  let cursor = 0, refCursor = 0, gpsCalls = 0;
  const jsx = (type, props) => ({ type, props });
  const imports = {
    react: {
      useState: (initial) => { const i = cursor++; if (!(i in state)) state[i] = i === 0 ? 'round' : initial;
        return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; },
      useRef: value => refs[refCursor++] ??= { current: value }, useMemo: fn => fn(), useCallback: fn => fn, useEffect() {},
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { useWindowDimensions: () => ({ width: 390, height: 844 }), StyleSheet: { create: s => s }, Alert: { alert: (...args) => alerts.push(args) }, View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView' },
    '@/components/SavedToast': { SavedToast: 'SavedToast' }, '@/utils/savedRoutes': { findSavedRoute: () => undefined },
    '@/components/GroupRidePanel': { GroupRidePanel: 'GroupRidePanel' },
    '@expo/vector-icons/Ionicons': {}, '@react-native-community/slider': 'Slider',
    'expo-haptics': { NotificationFeedbackType: {}, notificationAsync: async () => {} },
    'expo-location': { requestForegroundPermissionsAsync: async () => { gpsCalls++; return { granted: false }; } },
    'expo-router': { Tabs: { Screen: 'Tabs.Screen' }, useLocalSearchParams: () => ({}) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    '@/components/PoiDetails': { PoiDetails: 'PoiDetails' }, '@/components/RideMap': { RideMap: 'RideMap' }, '@/components/DestinationSearch': { DestinationSearch: 'DestinationSearch' },
    '@/components/StandardTripPlanner': {}, '@/components/RoutePoiCards': {}, '@/components/DriveOverlay': {},
    '@/components/ui': { IconButton: 'IconButton', ActionButton: 'ActionButton', ToggleRow: 'ToggleRow' },
    '@/hooks/useRoutePois': { useRoutePois: () => ({ points: [] }) }, '@/data/routeColors': {},
    '@/data/seed': { defaultCenter: center, nearbyPlaces: [] },
    '@/state/AppProvider': { useApp: () => ({ settings: { avoidMotorways: true }, setActiveRoute: r => activated.push(r) }) },
    '@/theme': { colors: {}, spacing: {} }, '@/utils/guidance': { upcomingManeuver: () => undefined },
    '@/utils/navigation': { cumulativeRouteDistances: () => [] }, '@/utils/recording': { formatRidingTime: () => '0:00' },
    '@/services/rideTracking': {}, '@/utils/routeSharing': {}, '@/utils/pois': {}, '@/hooks/useNavigationKeepAwake': { useNavigationKeepAwake() {} },
    '@/utils/roundTripArea': { coneBufferKm: () => 1, coneRadiusKm: km => Math.max(5, Math.min(100, km / 2)) },
    '@/utils/routes': { calculateRoundTrip: async (...args) => { planned.push(args); return { route: [], roundTrip: true }; } },
  };
  const output = ts.transpileModule(readFileSync(path.join(__dirname, '../src/app/ride.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)(name => imports[name] ?? require(name), module, module.exports);
  let screen;
  return { planned, alerts, activated, get gpsCalls() { return gpsCalls; },
    render() { cursor = refCursor = 0; screen = module.exports.default(); },
    find: predicate => find(screen, predicate),
    map: () => find(screen, n => n.type === 'RideMap').props,
    search: () => find(screen, n => n.type === 'DestinationSearch').props,
    create: () => find(screen, n => n.props?.label === 'Create route').props.onPress(),
  };
}
test('selected address moves the preview and is used unchanged when creating a round trip', async () => {
 const h = harness(); h.render();
 const place = { name: 'Custom start', id: 'place', latitude: 51.4, longitude: 0.1 };
 h.search().onExpandedChange(true); h.render();
 h.search().onChangeQuery('Custom start'); h.render();
 h.search().onExpandedChange(true); h.render();
 assert.equal(h.search().query, 'Custom start', 'submit must preserve the search text');
 h.search().onSelect(place); h.render();
 assert.deepEqual(h.map().planningArea.center, place);
 await h.create();
 assert.deepEqual(h.planned[0][0], place); assert.equal(h.planned[0][5].coneAngleDegrees, 120);
 assert.equal(h.gpsCalls, 0, 'custom start must not be overwritten by a GPS request');
 assert.equal(h.activated.length, 1);
});
test('map long press requires Start from here and cancellation keeps the existing start', async () => {
 const h = harness(); h.render();
 const pin = { latitude: 51.45, longitude: -0.2 };
 await h.map().onLongPress(pin); h.render();
 assert.deepEqual(h.map().planningArea.center, center);
 assert.equal(h.alerts[0][2][0].text, 'Cancel');
 h.alerts[0][2][1].onPress(); h.render();
 assert.deepEqual(h.map().planningArea.center, { ...pin, name: 'Dropped pin' });
 await h.create(); assert.equal(h.planned[0][0].latitude, pin.latitude);
});
test('angle control changes cone width while reach follows half the ride distance', async () => {
 const h = harness(); h.render();
 h.find(n => n.type === 'Slider' && n.props.accessibilityLabel === 'Cone opening angle in degrees').props.onValueChange(60);
 h.render(); assert.equal(h.map().planningArea.radiusKm, 80); assert.equal(h.map().planningArea.coneAngleDegrees, 60);
 await h.create(); assert.equal(h.planned[0][1], 160); assert.equal(h.planned[0][5].coneAngleDegrees, 60);
});
test('heading changes the live cone and the routing request', async () => {
 const h = harness(); h.render();
 h.find(n => n.props?.accessibilityLabel === 'Heading S').props.onPress(); h.render();
 assert.equal(h.map().planningArea.direction, 180);
 await h.create(); assert.equal(h.planned[0][2], 180);
});
test('changing ride length resizes the cone without changing its selected angle',()=>{
 const h=harness();h.render();
 h.find(n=>n.type==='Slider'&&n.props.accessibilityLabel==='Total riding distance in kilometres').props.onValueChange(40);h.render();
 assert.equal(h.map().planningArea.radiusKm,20);assert.equal(h.map().planningArea.coneAngleDegrees,120);
});
