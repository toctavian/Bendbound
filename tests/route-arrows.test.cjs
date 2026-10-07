const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const compiled = ts.transpileModule(readFileSync(path.join(__dirname, '../src/utils/routeArrows.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const api = {};
new Function('exports', compiled)(api);
const { prepareArrowRoute, routeArrowFeatures } = api;
const R = 6378137;
// Fixtures in metres in the map projection so angles and widths are measurable.
const point = (x, y) => ({ longitude: x / R * 180 / Math.PI, latitude: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI });
const project = ([lon, lat]) => [lon * Math.PI / 180 * R, R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
const near = (a, b, epsilon = 0.00001) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
const instruction = (index, type = 10) => ({ beginShapeIndex: index, endShapeIndex: index + 1, type, instruction: 'Turn', streetName: 'New name', bearingAfter: 219 });
const route = [[0, -80], [0, 0], [80, 0], [80, 80], [160, 80]].map(([x, y]) => point(x, y));
const turns = [instruction(1), instruction(2, 15), instruction(3)];
const parts = (data, turn) => Object.fromEntries(data.features.filter(f => f.properties.turn === turn).map(f => [f.properties.part, f.geometry]));

test('three turns produce three arrows, with shafts retaining the exact route corners', () => {
  const model = prepareArrowRoute(route, turns);
  const data = routeArrowFeatures(model, 17);
  assert.equal(data.features.length, 9);
  for (const turn of [1, 2, 3]) {
    const shaft = parts(data, turn).shaft.coordinates.map(project);
    const center = project([route[turn].longitude, route[turn].latitude]);
    assert.ok(shaft.some(p => Math.hypot(p[0] - center[0], p[1] - center[1]) < 0.00001));
  }
});

test('head axes follow the outgoing route tangent exactly, regardless of provider bearing', () => {
  const data = routeArrowFeatures(prepareArrowRoute(route, turns), 17);
  for (const turn of [1, 2, 3]) {
    const [tip, left, right] = parts(data, turn)['head-outline'].coordinates[0].map(project);
    const axis = [tip[0] - (left[0] + right[0]) / 2, tip[1] - (left[1] + right[1]) / 2];
    if (turn === 2) { near(axis[0], 0); assert.ok(axis[1] > 0); }
    else { near(axis[1], 0); assert.ok(axis[0] > 0); }
  }
});

test('straight road name changes, continue, arrival and tiny directional noise show no arrows', () => {
  const straight = [[0, -80], [0, 0], [1, 80]].map(([x, y]) => point(x, y));
  for (const type of [7, 8, 4, 22, 10]) assert.equal(routeArrowFeatures(prepareArrowRoute(straight, [instruction(1, type)]), 17).features.length, 0);
  assert.equal(prepareArrowRoute(route, [instruction(1, 7)]).turns.length, 0);
});

test('curved shafts keep every original vertex instead of substituting a generic turn shape', () => {
  const curved = [[0,-80], [0,-10], [2,-4], [5,-1], [10,0], [80,0]].map(([x,y]) => point(x,y));
  const data = routeArrowFeatures(prepareArrowRoute(curved, [instruction(2)]), 17);
  const shaft = data.features.find(f => f.properties.part === 'shaft').geometry.coordinates.map(project);
  for (const [x,y] of [[0,-10],[2,-4],[5,-1],[10,0]]) assert.ok(shaft.some(p => Math.hypot(p[0]-x,p[1]-y)<0.00001));
});

test('dense points and duplicates do not drop turn arrows or produce invalid coordinates', () => {
  const dense = [point(0,-80), point(0,0), point(0,0), ...Array.from({length: 81}, (_, i) => point(i,0))];
  const data = routeArrowFeatures(prepareArrowRoute(dense, [instruction(1)]), 17);
  assert.equal(data.features.length, 3);
  assert.ok(data.features.every(f => f.geometry.coordinates.flat(Infinity).every(Number.isFinite)));
});

test('zoom scales geometry, route progress removes passed arrows, distant overview stays uncluttered', () => {
  const model = prepareArrowRoute(route, turns);
  assert.equal(routeArrowFeatures(model, 14).features.length, 0);
  assert.deepEqual([...new Set(routeArrowFeatures(model, 17, 3).features.map(f => f.properties.turn))], [3]);
  const width = zoom => {
    const [,a,b] = parts(routeArrowFeatures(model, zoom),1)['head-outline'].coordinates[0].map(project);
    return Math.hypot(a[0]-b[0], a[1]-b[1]);
  };
  near(width(17) / width(18), 2);
  near(width(17) / (2*Math.PI*R/(512*2**17)), 19.2);
});

test('geometry-only routes detect turns, but a straight line never gets arrows', () => {
  assert.equal(prepareArrowRoute(route).turns.length, 3);
  assert.equal(prepareArrowRoute([point(0,0),point(0,50),point(0,100)]).turns.length, 0);
  for (const points of [[],[point(0,0)],[point(0,0),point(0,0)]]) assert.equal(routeArrowFeatures(prepareArrowRoute(points),17).features.length,0);
});

test('close turns shorten their shafts so adjacent arrows cannot overlap', () => {
  const close = [[0,-80],[0,0],[25,0],[25,80]].map(([x,y])=>point(x,y));
  const data = routeArrowFeatures(prepareArrowRoute(close,[instruction(1),instruction(2,15)]),17);
  assert.equal(data.features.length,6);
  const firstTip = parts(data,1)['head-outline'].coordinates[0][0];
  const secondStart = parts(data,2).shaft.coordinates[0];
  assert.ok(project(firstTip)[0] < project(secondStart)[0]);
});
