import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { createAccountDeletionStore, deletionKey } from '../src/accountDeletionStore.mjs';
import { createAccountDeletionWorker } from '../src/accountDeletionWorker.mjs';
import { createLifecycleRoomCoordinator } from '../src/lifecycleRoomCoordinator.mjs';
import { createDynamoSessionRegistry, userKey, familyKey } from '../src/sessionRegistry.mjs';
import { hash, locationKey } from '../src/locationKeys.mjs';
const endpoint = process.env.GROUP_DYNAMO_LOCAL_ENDPOINT;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint ?? '')) throw new Error('Localhost required.');
const raw = new DynamoDBClient({ endpoint, region: 'eu-west-2', credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1 });
const client = DynamoDBDocumentClient.from(raw); after(() => raw.destroy());
const put = (TableName, Item) => client.send(new PutCommand({ TableName, Item }));
const read = async (TableName, Key) => (await client.send(new GetCommand({ TableName, Key, ConsistentRead: true }))).Item;
const token = () => randomBytes(32).toString('hex');
async function fixture(work) {
 const names = Object.fromEntries(['jobs','sessions','auth','rooms','points','progress'].map((k) => [k,`deletion-${k}-${randomUUID()}`])), created=[];
 try {
  for (const [key,TableName] of Object.entries(names)) {
   const attrs=[{AttributeName:'pk',AttributeType:'S'}], schema=[{AttributeName:'pk',KeyType:'HASH'}];
   if(key==='points'){attrs.push({AttributeName:'sk',AttributeType:'S'});schema.push({AttributeName:'sk',KeyType:'RANGE'});}
   if(key==='jobs')attrs.push({AttributeName:'queue',AttributeType:'S'},{AttributeName:'dueAt',AttributeType:'N'});
   await raw.send(new CreateTableCommand({TableName,BillingMode:'PAY_PER_REQUEST',AttributeDefinitions:attrs,KeySchema:schema,...(key==='jobs'?{GlobalSecondaryIndexes:[{IndexName:'DueIndex',KeySchema:[{AttributeName:'queue',KeyType:'HASH'},{AttributeName:'dueAt',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}:{})}));created.push(TableName);
  }
  const subject=randomUUID(),peer=randomUUID(),clock={at:1_000_000},receipt=token();
  await put(names.sessions,{...userKey(subject),subject,state:'active',pilotExpiresAt:clock.at+86400000});
  const makeJobs=(storage=client)=>createAccountDeletionStore({client:storage,tableName:names.jobs,sessionTableName:names.sessions,now:()=>clock.at});
  let exists=true,providerFails=false,manual=false,providerPages=null; const commands=[];
  const cognito={async send(command){commands.push(command);assert.equal(command.input.Username,subject);if(command.constructor.name==='AdminDeleteUserCommand'){exists=false;return{};}if(!exists)throw Object.assign(new Error('Synthetic absent'),{name:'UserNotFoundException'});return{UserAttributes:[{Name:'sub',Value:subject}]};}};
  const jobs=makeJobs();
  const run=()=>createAccountDeletionWorker({client,cognito,poolId:'synthetic',jobs,sessionTableName:names.sessions,authTableName:names.auth,now:()=>clock.at,
   runRooms:createLifecycleRoomCoordinator({client,sessionTableName:names.sessions,roomTableName:names.rooms,locationTableName:names.points,progressTableName:names.progress,now:()=>clock.at}),
   cleanupProvider:async(context)=>{if(providerPages){const p=providerPages.shift();assert.deepEqual(context.cursor??null,p.expectedCursor);return p.result;}if(providerFails)throw new Error('Synthetic provider outage');return{providerTokensDrained:!manual,manualProviderActionMayBeRequired:manual};}})();
  async function drain(){for(let i=0;i<100;i++){const job=await read(names.jobs,deletionKey(receipt));if(!job.queue)return job;clock.at=Math.max(clock.at,job.dueAt);await run();}throw new Error('Not drained');}
  await work({names,subject,peer,clock,receipt,jobs,makeJobs,run,drain,commands,setProviderFailure:(v)=>{providerFails=v;},setManual:()=>{manual=true;},setProviderPages:(pages)=>{providerPages=pages;}});
 }finally{const r=await Promise.allSettled(created.map(TableName=>raw.send(new DeleteTableCommand({TableName}))));if(r.some(v=>v.status==='rejected'))throw new Error('Cleanup failed');}
}
test('atomic intake immediately denies access; full worker purges records and points while preserving peer and permanent hold',async()=>fixture(async f=>{
 const family=token(),room=token();
 await put(f.names.sessions,{...familyKey(family),subject:f.subject,state:'active',expiresAt:f.clock.at+86400000});
 await put(f.names.sessions,{...familyKey('peer'),subject:f.peer,state:'active'});
 for(const prefix of ['NATIVEAPPLE','NATIVEUSER','ENROLL','ENROLLIDENTITY','PROOF'])await put(f.names.auth,{pk:`${prefix}#${token()}`,subject:f.subject,state:'active'});
 await put(f.names.rooms,{pk:`ROOM#${room}`,revision:1,room:{id:room,revision:1,ownerId:f.subject,state:'riding',expiresAt:f.clock.at+100000,members:[{userId:f.subject},{userId:f.peer}],invite:null},purgeAt:f.clock.at+86400000,ttl:999999999});
 await put(f.names.points,{...locationKey(room,f.subject),synthetic:true});
 await put(f.names.points,{...locationKey(room,f.peer),synthetic:'peer'});
 await f.jobs.start({subject:f.subject,username:'synthetic'},f.receipt);
 const registry=createDynamoSessionRegistry({client,tableName:f.names.sessions,now:()=>f.clock.at});
 assert.equal(await registry.active({subject:f.subject,familyId:family,expiresAt:f.clock.at+300000}),false);
 assert.equal((await f.jobs.status(f.receipt)).complete,false);
 const job=await f.drain();assert.equal(job.phase,'app_deleted');assert.equal(job.provider,'drained');
 assert.deepEqual(await f.jobs.status(f.receipt),{appDataDeleted:true,provider:'drained',delayed:false,complete:true});
 assert.equal(await read(f.names.sessions,familyKey(family)),undefined);assert.ok(await read(f.names.sessions,familyKey('peer')));
 assert.equal((await client.send(new ScanCommand({TableName:f.names.auth}))).Count,0);
 assert.equal(await read(f.names.points,locationKey(room,f.subject)),undefined);assert.ok(await read(f.names.points,locationKey(room,f.peer)));
 assert.ok((await read(f.names.sessions,userKey(f.subject))).lifecycleHold);assert.ok(f.commands.some(c=>c.constructor.name==='AdminDeleteUserCommand'));
}));
test('same receipt retries lost intake response; another receipt cannot replace a hold or queue a second deletion',async()=>fixture(async f=>{
 let lost=false;const storage={async send(c){const r=await client.send(c);if(c.constructor.name==='TransactWriteCommand'&&!lost){lost=true;throw new Error('Synthetic lost response');}return r;}};
 const first=await f.makeJobs(storage).start({subject:f.subject,username:'synthetic'},f.receipt);
 const again=await f.jobs.start({subject:f.subject,username:'synthetic'},f.receipt);assert.equal(first.eventId,again.eventId);
 await assert.rejects(f.jobs.start({subject:f.subject,username:'synthetic'},token()));
 assert.equal((await client.send(new ScanCommand({TableName:f.names.jobs}))).Count,1);
}));
test('provider outage/manual uncertainty never blocks own-data deletion or becomes false complete',async()=>fixture(async f=>{
 f.setProviderFailure(true);await f.jobs.start({subject:f.subject,username:'synthetic'},f.receipt);
 for(let i=0;i<40;i++){const job=await read(f.names.jobs,deletionKey(f.receipt));f.clock.at=Math.max(f.clock.at,job.dueAt);await f.run();if((await f.jobs.status(f.receipt)).appDataDeleted)break;}
 assert.equal((await f.jobs.status(f.receipt)).appDataDeleted,true);assert.equal((await f.jobs.status(f.receipt)).complete,false);
 f.setProviderFailure(false);f.setManual();const final=await f.drain();assert.equal(final.provider,'manual');assert.equal((await f.jobs.status(f.receipt)).complete,false);
}));
test('replacement hold prevents a queued job from acting or claiming deletion',async()=>fixture(async f=>{
 const job=await f.jobs.start({subject:f.subject,username:'synthetic'},f.receipt),row=await read(f.names.sessions,userKey(f.subject));
 await put(f.names.sessions,{...row,lifecycleHold:{...row.lifecycleHold,startedAt:row.lifecycleHold.startedAt+1}});
 await assert.rejects(f.run());assert.equal(f.commands.length,0);assert.equal((await read(f.names.jobs,{pk:job.pk})).phase,'rooms');await assert.rejects(f.jobs.status(f.receipt));
}));

test('provider pagination persists across uncertain first pages and still reaches/retries later stored grants',async()=>fixture(async f=>{
 await f.jobs.start({subject:f.subject,username:'synthetic'},f.receipt);
 for(let i=0;i<40;i++){const job=await read(f.names.jobs,deletionKey(f.receipt));f.clock.at=Math.max(f.clock.at,job.dueAt);await f.run();if((await f.jobs.status(f.receipt)).appDataDeleted)break;}
 const cursor={pk:'synthetic-partition',sk:'synthetic-last-key'};
 f.setProviderPages([
  {expectedCursor:null,result:{providerTokensDrained:false,manualProviderActionMayBeRequired:true,nextCursor:cursor,failed:0}},
  {expectedCursor:cursor,result:{providerTokensDrained:false,nextCursor:null,failed:1}},
  {expectedCursor:null,result:{providerTokensDrained:false,manualProviderActionMayBeRequired:true,nextCursor:cursor,failed:0}},
  {expectedCursor:cursor,result:{providerTokensDrained:false,nextCursor:null,failed:1}},
  {expectedCursor:null,result:{providerTokensDrained:false,manualProviderActionMayBeRequired:true,nextCursor:cursor,failed:0}},
  {expectedCursor:cursor,result:{providerTokensDrained:false,nextCursor:null,failed:0}},
 ]);
 const first=await read(f.names.jobs,deletionKey(f.receipt));f.clock.at=first.dueAt;await f.run();
 let job=await read(f.names.jobs,deletionKey(f.receipt));assert.ok(job.queue);assert.deepEqual(job.providerCursor,cursor);assert.equal(job.provider,'pending');
 f.clock.at=job.dueAt;await f.run();job=await read(f.names.jobs,deletionKey(f.receipt));assert.ok(job.queue);assert.equal(job.providerCursor,null);assert.equal(job.failures,1);
 for(let i=0;i<2;i++){job=await read(f.names.jobs,deletionKey(f.receipt));f.clock.at=job.dueAt;await f.run();}
 job=await read(f.names.jobs,deletionKey(f.receipt));assert.equal(job.failures,2);
 const final=await f.drain();assert.equal(final.provider,'manual');assert.equal(final.phase,'app_deleted');assert.equal((await f.jobs.status(f.receipt)).complete,false);
}));
