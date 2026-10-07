const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync(`${__dirname}/../src/utils/routes.ts`, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const api = {};
new Function('exports', source)(api);
const point = (x, y) => ({ latitude: y / 111195, longitude: x / 111195 });
const route = pairs => pairs.map(([x,y]) => point(x,y));
const loop = [[0,0],[2000,0],[2000,2000],[0,2000],[0,0]];
const stem = metres => route([[0,-metres],...loop,[0,-metres]]);

test('allows only a short contiguous departure/arrival section', () => {
  const result = api.roundTripRoadUse(stem(257));
  assert.equal(result.valid,true);
  assert.ok(Math.abs(result.sharedAccessKm-0.257)<0.00001);
  assert.ok(api.repeatedRoadRatio(stem(257))>0);
  assert.equal(result.remainingRepeatedRatio,0);
  assert.equal(api.roundTripRoadUse(stem(501)).valid,false);
});
test('access allowance works with different samples, turns and duplicate vertices', () => {
  const path = route([[-100,-100],[-100,-100],[-100,0],[-50,0],...loop,[-100,0],[-100,-50],[-100,-100]]);
  assert.equal(api.roundTripRoadUse(path).valid,true);
  assert.ok(Math.abs(api.roundTripRoadUse(path).sharedAccessKm-0.2)<0.00001);
  const partial = route([[0,-100],...loop,[0,-40],[0,-100]]);
  assert.equal(api.roundTripRoadUse(partial).valid,true);
});
test('two access traversals cannot exceed ten percent of the ride', () => {
  const small = route([[0,-100],[0,0],[200,0],[200,200],[0,200],[0,0],[0,-100]]);
  assert.equal(api.roundTripRoadUse(small).valid,false);
  assert.equal(api.roundTripRoadUse(route([[0,0],[100,0],[0,0]])).valid,false);
  assert.equal(api.roundTripRoadUse([]).valid,false);
});
test('repeated roads inside the loop or extra traversals of the access remain invalid', () => {
  const internalSpur = route([[0,-100],[0,0],[2000,0],[2010,0],[2000,0],...loop.slice(2),[0,-100]]);
  assert.equal(api.roundTripRoadUse(internalSpur).valid,false);
  const thirdVisit = route([[0,-100],...loop,[0,-100],[0,0],...loop.slice(1),[0,-100]]);
  assert.equal(api.roundTripRoadUse(thirdVisit).valid,false);
  assert.equal(api.roundTripRoadUse(route([...loop,...loop.slice(1)])).valid,false);
});
test('ordinary clean loops keep the original zero-repeat behavior', () => {
  assert.deepEqual(api.roundTripRoadUse(route(loop)),{valid:true,sharedAccessKm:0,remainingRepeatedRatio:0});
});

function encode(points) {
  let lat=0,lon=0,out='';
  const write=delta=>{let n=delta<0?~(delta<<1):delta<<1;while(n>=32){out+=String.fromCharCode((32|(n&31))+63);n>>>=5;}out+=String.fromCharCode(n+63);};
  for(const p of points){const a=Math.round(p.latitude*1e6),b=Math.round(p.longitude*1e6);write(a-lat);write(b-lon);lat=a;lon=b;}
  return out;
}
test('self-hosted app accepts server-approved routes even when overlap policy changes', async () => {
  for (const points of [stem(257),stem(501),
    route([[0,-100],[0,0],[2000,0],[2010,0],[2000,0],...loop.slice(2),[0,-100]])]) {
    const client={};
    const payload={planner:{valid:true,sharedAccessKm:0},trip:{status:0,summary:{length:9,time:1200},legs:[{shape:encode(points),maneuvers:[]}]}};
    new Function('exports','fetch','process',source)(client,async()=>({ok:true,json:async()=>payload}),{env:{EXPO_PUBLIC_ROUTING_URL:'https://routing.example.test'}});
    const request=client.calculateRoundTrip(points[0],9,0,'winding');
    const result=await request;assert.equal(result.roundTrip,true);assert.equal(result.roadDistanceKm,9);assert.equal(result.route.length,points.length);
  }
});
