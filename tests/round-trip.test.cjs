const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const compiled = ts.transpileModule(readFileSync(path.join(__dirname, '../src/utils/routes.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
function load(fetch = () => { throw new Error('Unexpected network request'); }) {
  const api = {};
  new Function('exports', 'fetch', compiled)(api, fetch);
  return api;
}
const { repeatedRoadRatio } = load();
const point = (x, y) => ({ latitude: y / 111195, longitude: x / 111195 });
const route = (pairs) => pairs.map(([x, y]) => point(x, y));
const loop = route([[0,0],[200,0],[200,200],[0,200],[0,0]]);
const retrace = route([[0,0],[200,0],[0,0]]);

function encode(points) {
  let lat = 0, lon = 0, result = '';
  const value = (delta) => {
    let n = delta < 0 ? ~(delta << 1) : delta << 1;
    while (n >= 0x20) { result += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>>= 5; }
    result += String.fromCharCode(n + 63);
  };
  for (const p of points) {
    const nextLat = Math.round(p.latitude * 1e6), nextLon = Math.round(p.longitude * 1e6);
    value(nextLat-lat); value(nextLon-lon);
    lat=nextLat; lon=nextLon;
  }
  return result;
}
const response = (points, distanceKm = 42) => ({ ok: true, json: async () => ({ trip: { status: 0, legs: [{ shape: encode(points), maneuvers: [] }], summary: { length: distanceKm, time: 3000 } } }) });

// An endpoint or intersection is allowed, but a shared length of road is not.
test('a closed loop and a crossing at a junction do not count as reusing a road', () => {
  assert.equal(repeatedRoadRatio(loop),0);
  assert.equal(repeatedRoadRatio(route([[-100,-100],[100,100],[-100,100],[100,-100]])),0);
  assert.equal(repeatedRoadRatio(route([[0,0],[100,0],[100,100],[0,100],[0,0],[-100,0],[-100,-100],[0,-100],[0,0]])),0);
});

test('out-and-back and same-direction repeats both count', () => {
  assert.ok(Math.abs(repeatedRoadRatio(retrace)-0.5)<1e-6);
  const twice = [...loop,...loop.slice(1)];
  assert.ok(Math.abs(repeatedRoadRatio(twice)-0.5)<1e-6);
});

test('split, clipped and differently sampled copies of the same road are detected', () => {
  assert.ok(Math.abs(repeatedRoadRatio(route([[0,0],[200,0],[150,0],[50,0],[0,0]]))-0.5)<1e-6);
  assert.ok(repeatedRoadRatio(route([[0,0],[200,0],[200,100],[50,100],[50,0],[150,0]]))>0);
  assert.ok(repeatedRoadRatio(route([[0,0],[50,0],[100,0],[200,0],[0,0]]))>0);
});

test('nearby parallel roads, short consecutive edges and duplicated vertices are not repeats', () => {
  assert.equal(repeatedRoadRatio(route([[0,0],[200,0],[200,5],[0,5],[0,0]])),0);
  assert.equal(repeatedRoadRatio(route([[0,0],[0,0],[0.2,0],[0.4,0],[0.6,0],[1,0],[1,0]])),0);
  assert.equal(repeatedRoadRatio([]),0);
  assert.equal(repeatedRoadRatio([point(0,0)]),0);
});

test('overlapping subdivisions are counted only once per traversal', () => {
  assert.ok(Math.abs(repeatedRoadRatio(route([[0,0],[100,0],[200,0],[0,0],[200,0]]))-2/3)<1e-6);
});

test('long diagonal and negative-coordinate road sections are indexed correctly', () => {
  assert.ok(Math.abs(repeatedRoadRatio(route([[-30000,-30000],[30000,30000],[0,0],[-30000,-30000]]))-0.5)<1e-6);
});

test('even a short repeated section inside the loop is rejected', async () => {
  const stem = route([[0,0],[2000,0],[2010,0],[2000,0],[2000,2000],[0,2000],[0,0]]);
  assert.ok(repeatedRoadRatio(stem)>0 && repeatedRoadRatio(stem)<0.04);
  const requests = [];
  const api = load(async url => {
    requests.push(JSON.parse(new URL(url).searchParams.get('json')));
    return response(requests.length===1 ? stem : loop);
  });
  const result = await api.calculateRoundTrip(point(0,0),40,90,'winding',[],{avoidMotorways:true});
  assert.equal(requests.length,2);
  assert.equal(api.repeatedRoadRatio(result.route),0);
  assert.equal(result.title,'42 km round trip');
  assert.notDeepEqual(requests[0].locations,requests[1].locations);
  assert.ok(requests.every(request=>request.costing_options.motorcycle.use_highways===0.05));
});

test('six repeated candidates fail rather than returning the least-bad route', async () => {
  const requests = [];
  const api = load(async url => { requests.push(url); return response(retrace); });
  await assert.rejects(api.calculateRoundTrip(point(0,0),40,0,'twisty'),/without repeated road sections.*direction, distance, or starting point/);
  assert.equal(requests.length,6);
  assert.ok(new Set(requests).size>=4);
});

test('failed alternate requests cannot cause fallback to an earlier repeated route', async () => {
  let calls=0;
  const api=load(async()=>{ calls++; return calls===1?response(retrace):{ok:false}; });
  await assert.rejects(api.calculateRoundTrip(point(0,0),40,0,'winding'),/without repeated road sections/);
  assert.equal(calls,6);
});

test('connection failures report a routing error and do not return waypoint geometry', async () => {
  const api=load(async()=>{ throw new Error('Offline'); });
  await assert.rejects(api.calculateRoundTrip(point(0,0),40,0,'fast'),/Check your connection/);
});

test('OSRM fallback is also checked for reuse when motorway avoidance is off', async () => {
  let osrmCalls=0;
  const api=load(async url=>{
    if(url.includes('valhalla'))return {ok:false};
    osrmCalls++;
    const points=osrmCalls===1?retrace:loop;
    return {ok:true,json:async()=>({code:'Ok',routes:[{distance:42000,duration:3000,geometry:{coordinates:points.map(p=>[p.longitude,p.latitude])}}]})};
  });
  const result=await api.calculateRoundTrip(point(0,0),40,0,'fast',[],{avoidMotorways:false});
  assert.equal(osrmCalls,2);
  assert.equal(api.repeatedRoadRatio(result.route),0);
});

test('distance must be strictly less than 10 km away, using unrounded road length', async () => {
  for (const distance of [30, 50, 29.9, 50.1, 100, 5]) {
    let calls = 0;
    const api = load(async () => response(loop, ++calls === 1 ? distance : 40));
    const result = await api.calculateRoundTrip(point(0,0),40,0,'winding');
    assert.equal(calls,2, `${distance} km must be rejected`);
    assert.equal(result.roadDistanceKm,40);
  }
  for (const distance of [30.01, 49.99, 40]) {
    let calls = 0;
    const api = load(async () => { calls++; return response(loop,distance); });
    const result = await api.calculateRoundTrip(point(0,0),40,0,'winding');
    assert.equal(calls,1);
    assert.equal(result.roadDistanceKm,distance);
  }
});

test('long and short candidates shrink and expand the next loop respectively', async () => {
  for (const [actualKm, factor] of [[80,0.5],[20,1.5]]) {
    const requests = [];
    const api = load(async url => {
      requests.push(JSON.parse(new URL(url).searchParams.get('json')));
      return response(loop,requests.length===1 ? actualKm : 40);
    });
    await api.calculateRoundTrip(point(0,0),40,0,'winding');
    const radius = request => api.distanceBetween(point(0,0), {
      latitude:request.locations[2].lat,longitude:request.locations[2].lon,
    });
    assert.ok(Math.abs(radius(requests[1])/radius(requests[0])-factor)<0.001);
  }
});

test('short loops can shrink below the old ten-kilometre waypoint radius', () => {
  const api = load();
  const draft = api.buildRoundTrip(point(0,0),14,0,'winding');
  assert.ok(Math.abs(api.distanceBetween(point(0,0),draft.route[2])-4)<0.001);
});

test('a route must satisfy both distance and road reuse constraints', async () => {
  let calls = 0;
  const api = load(async () => {
    calls++;
    return calls===1 ? response(loop,65) : response(retrace,40);
  });
  await assert.rejects(api.calculateRoundTrip(point(0,0),40,0,'winding'),/within 10 km of 40 km without repeated road sections/);
  assert.equal(calls,6);
});

test('exhausted distance attempts never return an out-of-range route', async () => {
  let calls = 0;
  const api = load(async () => { calls++; return response(loop,60); });
  await assert.rejects(api.calculateRoundTrip(point(0,0),40,0,'winding'),/within 10 km of 40 km/);
  assert.equal(calls,6);
});

test('OSRM fallback also enforces the exact distance limit', async () => {
  let calls = 0;
  const api = load(async url => {
    if (url.includes('valhalla')) return {ok:false};
    calls++;
    return {ok:true,json:async()=>({code:'Ok',routes:[{distance:calls===1?50000:49990,duration:3000,geometry:{coordinates:loop.map(p=>[p.longitude,p.latitude])}}]})};
  });
  const result = await api.calculateRoundTrip(point(0,0),40,0,'fast',[],{avoidMotorways:false});
  assert.equal(calls,2);
  assert.equal(result.roadDistanceKm,49.99);
});

test('invalid target distances are rejected without contacting the router', async () => {
  for (const distance of [0,-1,NaN,Infinity]) {
    await assert.rejects(load().calculateRoundTrip(point(0,0),distance,0,'winding'),/positive round-trip distance/);
  }
});
