import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../service/server.mjs';
import { createShareStore } from '../service/route-shares.mjs';

test('Caddy protects share creation while allowing link retrieval and preserving routing body limits', {skip:!process.env.CADDY_BIN}, async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'bendbound-share-proxy-'));
  const api=createServer({shares:createShareStore({directory}),log:()=>{}});
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const config=(await readFile(new URL('../Caddyfile',import.meta.url),'utf8'))
    .replace('log default {','admin off\n    log default {').replaceAll('api:8080',`127.0.0.1:${api.address().port}`);
  const file=path.join(directory,'Caddyfile');await writeFile(file,config);
  const child=spawn(process.env.CADDY_BIN,['run','--config',file,'--adapter','caddyfile'],{env:{...process.env,ROUTING_HOSTNAME:`http://127.0.0.1:${port}`,ROUTING_API_TOKEN:'local-test-only'},stdio:'ignore'});
  const base=`http://127.0.0.1:${port}`,payload={version:1,avoidMotorways:true,route:{title:'Proxy test',profile:'fast',distanceKm:1,durationMin:1,curves:1,route:[{latitude:51.5,longitude:-0.1},{latitude:51.51,longitude:-0.11}]}};
  try{
    let ready=false;
    for(let i=0;i<40;i++) {
      try{await fetch(base);ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}
    }
    assert.ok(ready,'Caddy must start');
    const post=(body,auth=true,url='/shared-routes')=>fetch(`${base}${url}`,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer local-test-only'}:{})},body:JSON.stringify(body)});
    assert.equal((await post(payload,false)).status,401);
    const response=await post({...payload,padding:'x'.repeat(70000)});assert.equal(response.status,201,'share snapshots can exceed the old 64KB routing limit');
    const {id}=await response.json();
    assert.deepEqual(await (await fetch(`${base}/shared-routes/${id}`)).json(),payload);
    assert.equal((await fetch(`${base}/shared/${id}`)).status,200);
    assert.equal((await fetch(`${base}/.well-known/apple-app-site-association`)).status,200);
    assert.equal((await post({padding:'x'.repeat(70000)},true,'/route')).status,413);
    assert.equal((await fetch(`${base}/health`)).status,401);
  }finally{
    if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}
    await new Promise(resolve=>api.close(resolve));await rm(directory,{recursive:true,force:true});
  }
});
