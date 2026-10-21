import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCache } from '../service/cache.mjs';
import { createStatus } from '../service/catalogue.mjs';
test('cache expires by creation time and enforces both LRU and byte limits',()=>{
  let time=0;const cache=createCache({ttlMs:10,maxEntries:2,maxBytes:20,now:()=>time});
  cache.set('a','one');cache.set('b','two');assert.equal(cache.get('a').value,'one');
  cache.set('c','three');assert.equal(cache.get('b'),null);
  cache.set('huge','x'.repeat(100));assert.equal(cache.get('huge'),null);
  time=10;assert.equal(cache.get('a'),null);assert.equal(cache.get('c'),null);
});
test('on-demand graph readiness still checks live PostGIS metadata and import version',async()=>{
  let countQueries=0,metadataQueries=0,version='v1',imported='v1';
  const status=createStatus({mode:'on-demand',graph:async()=>{throw Error('Graph must stay offline');},query:async sql=>{
    if(sql.includes('count(*)')){countQueries++;return {rows:[{sections:20,recommended_sections:2,edges:100}]};}
    metadataQueries++;return {rows:[{version,graph_version:imported}]};
  }});
  assert.equal((await status()).connectivity.status,'prepared-on-demand');await status();
  assert.equal(countQueries,1);assert.equal(metadataQueries,2);
  version='v2';await assert.rejects(status(),e=>e.code==='CATALOGUE_UNAVAILABLE');
  assert.equal(countQueries,2);imported='v2';await status();
});
test('required graph mode still rejects an unavailable or mismatched live graph',async()=>{
  const query=async sql=>({rows:[sql.includes('count(*)')?{sections:1}: {version:'v1',graph_version:'v1'}]});
  await assert.rejects(createStatus({mode:'required',query,graph:async()=>{throw Error('offline');}})(),/offline/);
  await assert.rejects(createStatus({mode:'required',query,graph:async()=>'v2'})(),e=>e.code==='CATALOGUE_UNAVAILABLE');
});
