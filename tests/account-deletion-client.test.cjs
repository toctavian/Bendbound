const assert=require('node:assert/strict');const {test}=require('node:test');const {readFileSync}=require('node:fs');const ts=require('typescript');
const mod={exports:{}};new Function('module','exports',ts.transpileModule(readFileSync('src/services/auth/deletionClient.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(mod,mod.exports);
const {createDeletionClient,RecentSignInRequiredError}=mod.exports,secret='a'.repeat(64);
test('deletion receipt travels in a no-store POST body; status has no account bearer and validates honest completion',async()=>{
 const calls=[];const c=createDeletionClient('https://accounts.example.test',async(url,o)=>{calls.push({url,o});return{ok:true,json:async()=>url.endsWith('/status')?{appDataDeleted:true,provider:'manual',delayed:false,complete:false}:{accepted:true}};});
 await c.start('synthetic',secret);assert.equal((await c.status(secret)).complete,false);
 assert.equal(calls[0].o.headers.Authorization,'Bearer synthetic');assert.equal(calls[1].o.headers.Authorization,undefined);
 for(const {url,o} of calls){assert.equal(url.includes(secret),false);assert.equal(o.redirect,'error');assert.equal(o.cache,'no-store');assert.deepEqual(JSON.parse(o.body),{receiptSecret:secret});}
 const bad=createDeletionClient('https://accounts.example.test',async()=>({ok:true,json:async()=>({appDataDeleted:false,provider:'drained',complete:true,delayed:false})}));await assert.rejects(bad.status(secret));
});
test('invalid endpoints and stale authentication cannot masquerade as accepted deletion',async()=>{
 for(const url of ['http://example.test','https://u:p@example.test','https://example.test/path','https://example.test?secret=x'])assert.equal(createDeletionClient(url),null);
 const c=createDeletionClient('https://accounts.example.test',async()=>({status:401,ok:false}));await assert.rejects(c.start('synthetic',secret),e=>e instanceof RecentSignInRequiredError);
});
test('protected receipt is persisted before dispatch, retained on uncertainty and reused on retry',async()=>{
 const events=[];let stored=null,fail=true,current='synthetic-user',changeAccount=false;
 const fakeSession={state:()=>({account:{id:current}}),accessToken:async()=>{if(changeAccount)current='another-user';return'synthetic';},signOut:async()=>events.push('signOut')};
 const fakeClient={baseUrl:'https://accounts.example.test',start:async()=>{events.push('request');assert.ok(stored);if(fail)throw new Error('Synthetic response lost');},status:async()=>null};
 const m={exports:{}};const load=(name)=>name==='expo-crypto'?{getRandomBytesAsync:async()=>new Uint8Array(32).fill(1)}:name==='expo-secure-store'?{AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:1,getItemAsync:async()=>stored,setItemAsync:async(_k,v)=>{events.push('persist');stored=v;},deleteItemAsync:async()=>{stored=null;}}:name==='./cognito'?{accountSession:fakeSession}:{createDeletionClient:()=>fakeClient,RecentSignInRequiredError};
 new Function('module','exports','require',ts.transpileModule(readFileSync('src/services/auth/accountDeletion.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(m,m.exports,load);
 await assert.rejects(m.exports.requestAccountDeletion());assert.deepEqual(events,['persist','request']);const first=stored;
 fail=false;await m.exports.requestAccountDeletion();assert.equal(stored,first);assert.deepEqual(events,['persist','request','request','signOut']);
 changeAccount=true;await assert.rejects(m.exports.requestAccountDeletion(),/Account changed/);assert.deepEqual(events,['persist','request','request','signOut']);
});
