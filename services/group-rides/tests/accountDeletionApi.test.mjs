import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccountDeletionApi } from '../src/accountDeletionApi.mjs';
const secret='a'.repeat(64), at=1_000_000;
const event=(path='/v1/account/deletion',body={receiptSecret:secret})=>({rawPath:path,rawQueryString:'',body:JSON.stringify(body),headers:{authorization:'Bearer synthetic'},requestContext:{http:{method:'POST',sourceIp:'127.0.0.1'}}});
test('deletion derives verified identity and persists request; receipt status does not need a live account',async()=>{
 const calls=[];const api=createAccountDeletionApi({verifyToken:async()=>({userId:'verified-user',expiresAt:at+300000,authenticatedAt:at}),verifyProvider:async(token,sub)=>{assert.equal(sub,'verified-user');return'provider-name';},consumeBudget:async()=>{},jobs:{start:async(...args)=>calls.push(args),status:async()=>({complete:false})},now:()=>at});
 const r=await api(event());assert.equal(r.statusCode,202);assert.deepEqual(calls,[[{subject:'verified-user',username:'provider-name'},secret]]);assert.equal(r.headers['Cache-Control'],'no-store');
 const status=await api({...event('/v1/account/deletion/status'),headers:{}});assert.equal(status.statusCode,200);
 for(const body of [{subject:'forged',receiptSecret:secret},{receiptSecret:'invalid'},{receiptSecret:[secret]}])assert.equal((await api(event(undefined,body))).statusCode,400);
});
test('stale authentication and query credentials never start destructive work',async()=>{
 let writes=0;const api=createAccountDeletionApi({verifyToken:async()=>({userId:'verified',expiresAt:at+300000,authenticatedAt:at-601000}),verifyProvider:async()=>{throw new Error('Must not call');},consumeBudget:async()=>{},jobs:{start:async()=>writes++},now:()=>at});
 assert.equal((await api(event())).statusCode,401);assert.equal((await api({...event(),rawQueryString:'token=synthetic'})).statusCode,400);assert.equal(writes,0);
});
