// Probe the real application reader against the country overlay and native bridge.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSqliteGraphCatalogue } from '../service/graph-catalogue-sqlite.mjs';
import { createGraphCatalogue, ratingFactors } from '../service/graph-catalogue.mjs';
const [file,bridge='http://127.0.0.1:8093',report]=process.argv.slice(2);
assert(file,'Pass ratings.sqlite, optional bridge URL and report path');
let catalogue;
const lookup=async ids=>{
  const response=await fetch(`${bridge}/edges`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({graphVersion:catalogue.data.graphVersion,edgeIds:ids}),signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,200,'Native bridge rejected graph/edge identity');
  return response.json();
};
function encode(points){
  let a=0,b=0,out='';
  for(const [lon,lat] of points){
    const x=Math.round(lat*1e6),y=Math.round(lon*1e6);
    for(let v of [x-a,y-b]){v=v<0?~(v<<1):v<<1;while(v>=32){out+=String.fromCharCode((32|(v&31))+63);v>>>=5;}out+=String.fromCharCode(v+63);}
    a=x;b=y;
  }
  return out;
}
catalogue=createSqliteGraphCatalogue(file,createGraphCatalogue,lookup);
try {
  const results=[];
  for(const [name,longitude,latitude] of [['London',-.1278,51.5074],['Lake District',-3.08,54.46],
    ['Snowdonia',-3.9,53],['Scottish Highlands',-4.7,57],['Belfast',-5.93,54.6]]) {
    const roads=await catalogue.nearby({center:{longitude,latitude},radiusKm:20,limit:5});
    assert(roads.length>0,`Missing rated roads near ${name}`);
    const factors=ratingFactors(roads);
    assert(factors.length>0 && factors.every(f=>f.factor>=.75 && f.factor<=1 && !f.ignore_access_restrictions));
    const section=roads[0],edgeId=section.edgeIds[0];
    assert(edgeId,'No native cost edge in selected section');
    const native=(await lookup([edgeId])).edges[0];
    const physical=section.physicalIds.find(id=>id.endsWith(':'+native.physicalId));
    assert(physical,'Rating edge geometry differs from the pinned native graph');
    const coords=native.flipped?[...native.coordinates].reverse():native.coordinates;
    const payload={nativePath:[{shape:encode(coords),edges:[{id:edgeId,way_id:physical.split(':')[0],
      source_along_edge:0,target_along_edge:1,begin_shape_index:0,end_shape_index:coords.length-1}]}]};
    const usage=await catalogue.nativeUsage(payload,coords.map(([longitude,latitude])=>({longitude,latitude})));
    assert(usage.valid && usage.maxTraversals===1 && Math.abs(usage.verifiedRatio-1)<1e-6,'Native traversal verification failed');
    await catalogue.matchRoute(null,null,payload);
    results.push({area:name,roads:roads.length,ratingFactors:factors.length,nativeIdentity:'verified'});
  }
  const result={status:'verified',graphVersion:catalogue.data.graphVersion,areas:results,rssMiB:Math.round(process.memoryUsage().rss/1024**2)};
  if(report)fs.writeFileSync(report,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
} finally {
  catalogue.close();
}
