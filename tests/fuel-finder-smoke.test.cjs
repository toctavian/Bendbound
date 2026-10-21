const assert = require('node:assert/strict');
const {test} = require('node:test');
const api = import('../scripts/fuel-finder-smoke.mjs');

test('live smoke test uses official endpoints, reuses its token and preserves diagnostic prices without logging secrets',async()=>{
  const {smokeTest}=await api;
  const calls=[],logs=[];
  const price={fuel_type:'E10',price:'0139.9500',price_last_updated:'2026-10-12T08:00:00',price_change_effective_timestamp:'2026-10-12T07:59:00'};
  const bodies=[{success:true,data:{access_token:'private-access-token',refresh_token:'private-refresh-token'}},
    [{node_id:'forecourt-1',trading_name:'Test station',fuel_prices:[price]}],
    {data:[{node_id:'forecourt-1',location:{postcode:'AB1 2CD'}}]}];
  const result=await smokeTest({clientId:'private-client-id',clientSecret:'private-client-secret',log:line=>logs.push(line),
    fetchImpl:async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>bodies.shift()};}});
  assert.deepEqual(result,{priceRecords:1,forecourtRecords:1});assert.equal(calls.length,3);
  assert.equal(calls[0].url,'https://www.fuel-finder.service.gov.uk/api/v1/oauth/generate_access_token');
  assert.deepEqual(JSON.parse(calls[0].options.body),{client_id:'private-client-id',client_secret:'private-client-secret'});
  for(const call of calls)assert.equal(call.options.redirect,'error');
  for(const call of calls.slice(1)){assert.equal(call.options.method,'GET');assert.equal(call.options.headers.Authorization,'Bearer private-access-token');}
  const output=logs.join('\n');
  for(const secret of ['private-client-id','private-client-secret','private-access-token','private-refresh-token'])assert.ok(!output.includes(secret));
  assert.ok(output.includes(price.price));assert.ok(output.includes(price.price_last_updated));
  assert.match(output,/price-report/);assert.match(output,/Open Government Licence/);
});

test('authentication failure is sanitized and does not trigger retries or price calls',async()=>{
  const {smokeTest}=await api;let calls=0;
  await assert.rejects(smokeTest({clientId:'id',clientSecret:'secret',log:()=>{},fetchImpl:async()=>{calls++;return{ok:false,status:401,json:async()=>({message:'secret'})};}}),/OAuth: HTTP 401/);
  assert.equal(calls,1);
});

test('missing credentials, missing tokens and empty prices cannot pass',async()=>{
  const {smokeTest,records}=await api;
  await assert.rejects(smokeTest({clientId:'',clientSecret:'',fetchImpl:()=>assert.fail('Must not request')}),/Fill in/);
  await assert.rejects(smokeTest({clientId:'id',clientSecret:'secret',fetchImpl:async()=>({ok:true,json:async()=>({success:true,data:{}})})}),/no usable access token/);
  assert.throws(()=>records([], 'Fuel prices'),/no station records/);
});
