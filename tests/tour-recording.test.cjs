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
const t = Date.UTC(2026, 9, 1, 10);
const point = (seconds, latitude = 51.5, longitude = -0.12) => ({ latitude, longitude, timestamp: t + seconds * 1000, accuracy: 5 });
const append = (session, fix) => recording.appendRecordingFix(session, fix, fix.timestamp);

test('completed rides persist measured GPS geometry and seconds, independently of the planned tour', () => {
  const plan = routes.tourFromDraft({ title: 'Long planned ride', route: [point(0), point(10, 52)], distanceKm: 180, durationMin: 240, curves: 200 });
  let session = recording.startRecording(t);
  session = append(session, point(1));
  session = append(session, point(11, 51.5005));
  const tour = recording.tourFromRecording(session, t + 73500, plan.title);
  assert.equal(plan.place, 'Created in Bendbound');
  assert.equal(tour.place, 'Recorded in Bendbound');
  assert.deepEqual(tour.route, [point(1), point(11, 51.5005)]);
  assert.ok(tour.distanceKm > 0 && tour.distanceKm < 0.1);
  assert.equal(tour.durationMin, 73 / 60);
  assert.equal(routes.formatDuration(tour.durationMin), '1 min');
  assert.equal(tour.recording.durationSeconds, 73);
  assert.equal(tour.completed, true);
  assert.equal(tour.saved, false);
  assert.equal(tour.maneuvers, undefined);
  assert.equal(plan.completed, false);
  assert.equal(plan.saved, true);
  assert.equal(plan.distanceKm, 180);
  assert.deepEqual(JSON.parse(JSON.stringify(tour)), tour);
  session.segments[0][0].latitude = 0;
  assert.equal(tour.route[0].latitude, 51.5);
});

test('riding time uses timestamps, excludes pauses, and does not connect paused travel', () => {
  let session = recording.startRecording(t);
  session = append(session, point(1));
  session = append(session, point(11, 51.5005));
  session = recording.pauseRecording(session, t + 60000);
  assert.equal(recording.recordingSeconds(session, t + 3600000), 60);
  assert.equal(append(session, point(70, 52)), session);
  session = recording.resumeRecording(session, t + 3600000);
  session = append(session, point(3601, 52));
  session = append(session, point(3611, 52.0005));
  const tour = recording.tourFromRecording(session, t + 3630000);
  assert.equal(tour.recording.durationSeconds, 90);
  assert.equal(tour.recording.segments.length, 2);
  assert.ok(tour.distanceKm < 0.2);
  assert.ok(routes.routeDistance(tour.route) > 50);
  assert.equal(recording.formatRidingTime(90), '01:30');
  assert.equal(recording.formatRidingTime(3661), '1:01:01');
});

test('rejects invalid, stale, inaccurate, duplicate and implausibly jumping GPS samples', () => {
  let session = append(recording.startRecording(t), point(1));
  for (const fix of [
    point(1), point(-1), { ...point(2), accuracy: 100 }, { ...point(2), accuracy: -1 },
    { ...point(2), latitude: NaN }, point(2, 91), point(2, 52), { ...point(2), longitude: 190 },
    { ...point(2), timestamp: NaN },
  ]) assert.equal(recording.appendRecordingFix(session, fix, t + 2000), session);
  assert.equal(recording.appendRecordingFix(session, point(2), t + 30000), session);
  session = append(session, point(40, 51.51));
  assert.equal(session.segments.length, 2);
  assert.equal(recording.recordedDistance(session.segments), 0);
});

test('no GPS is saved honestly as zero measured distance, never replaced with a planned route', () => {
  const tour = recording.tourFromRecording(recording.startRecording(t), t + 20000);
  assert.deepEqual(tour.route, []);
  assert.deepEqual(tour.recording.segments, []);
  assert.equal(tour.distanceKm, 0);
  assert.equal(tour.recording.durationSeconds, 20);
});

test('My Tours and Saved filter by ride/bookmark state, not the author name', () => {
  const ride = recording.tourFromRecording(recording.startRecording(t), t + 10000);
  const saved = { ...ride, id: 'plan', completed: false, saved: true, recording: undefined, author: 'Someone else' };
  const unsaved = { ...saved, id: 'unsaved', saved: false };
  assert.deepEqual(recording.toursForCollection([saved, ride, unsaved], 'rides'), [ride]);
  assert.deepEqual(recording.toursForCollection([saved, ride, unsaved], 'saved'), [saved]);
  const bookmarkedRide = { ...ride, saved: true };
  assert.deepEqual(recording.toursForCollection([bookmarkedRide], 'saved'), [bookmarkedRide]);
  assert.ok(load('src/data/seed.ts').seedTours.every((tour) => !tour.completed));
});

test('GPX exports preserve recording segments, sample timestamps and escaped titles', () => {
  let session = append(recording.startRecording(t), point(1));
  session = recording.pauseRecording(session, t + 10000);
  session = recording.resumeRecording(session, t + 20000);
  session = append(session, point(21, 51.51));
  const tour = recording.tourFromRecording(session, t + 30000, 'A & B <ride>');
  const gpx = routes.toGpx(tour);
  assert.ok(gpx.includes('creator="Bendbound"'));
  assert.equal((gpx.match(/<trkseg>/g) ?? []).length, 2);
  assert.equal((gpx.match(/<time>/g) ?? []).length, 2);
  assert.ok(gpx.includes('A &amp; B &lt;ride&gt;'));
  assert.ok(gpx.includes(new Date(point(1).timestamp).toISOString()));
  assert.throws(() => routes.toGpx({ ...tour, recording: undefined }), /not stored/);
});

function toursHarness(tours) {
  let state = 'rides';
  const jsx = (type, props) => ({ type, props });
  const { default: Screen } = load('src/app/tours.tsx', {
    react: { useState: () => [state, (value) => { state = value; }] },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { StyleSheet: { create: (styles) => styles }, View: 'View', Text: 'Text', FlatList: 'FlatList', Pressable: 'Pressable' },
    '@expo/vector-icons/Ionicons': { default: 'Icon' },
    'expo-router': { router: {} },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0 }) },
    '@/components/RideMap': { RideMap: 'RideMap' },
    '@/components/ui': { ActionButton: 'ActionButton' },
    '@/state/AppProvider': { useApp: () => ({ ready: true, tours, settings: { routeColor: 'purple' } }) },
    '@/theme': { colors: {}, spacing: {} },
    '@/utils/routes': routes,
    '@/utils/recording': recording,
  });
  return { render: () => Screen() };
}
function find(element, predicate) {
  if (!element || typeof element !== 'object') return;
  if (predicate(element)) return element;
  for (const child of [element.props?.children].flat(Infinity)) {
    const match = find(child, predicate);
    if (match) return match;
  }
}

test('top tabs switch the actual list and recorded cards render GPS segments rather than route estimates', () => {
  const ride = recording.tourFromRecording(append(append(recording.startRecording(t), point(1)), point(11, 51.5005)), t + 100000);
  const saved = { ...ride, id: 'saved', completed: false, saved: true, recording: undefined };
  const h = toursHarness([ride, saved]);
  let tree = h.render();
  let list = find(tree, (node) => node.type === 'FlatList');
  assert.deepEqual(list.props.data, [ride]);
  const cardElement = list.props.renderItem({ item: ride });
  const card = cardElement.type(cardElement.props);
  const map = find(card, (node) => node.type === 'RideMap');
  assert.equal(map.props.route, undefined);
  assert.equal(map.props.trackSegments, ride.recording.segments);
  const savedTab = find(tree, (node) => node.props?.accessibilityRole === 'tab' && node.props.accessibilityState.selected === false);
  savedTab.props.onPress();
  tree = h.render();
  list = find(tree, (node) => node.type === 'FlatList');
  assert.deepEqual(list.props.data, [saved]);
});
