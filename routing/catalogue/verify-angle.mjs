// Public angle fixtures; successful start coordinates are never persisted here.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { conePolygon, coneRadiusKm, insideCone } from '../service/cone.mjs';
import { geometry } from '../service/engine.mjs';
const {values}=parseArgs({options:{base:{type:'string',default:'https://api.bendboundapp.com'},'env-file':{type:'string'},output:{type:'string'}}});
let token=process.env.EXPO_PUBLIC_ROUTING_TOKEN;
if(values['env-file']){const line=readFileSync(values['env-file'],'utf8').split('\n').find(l=>/^(EXPO_PUBLIC_ROUTING_TOKEN|ROUTING_API_TOKEN)=/.test(l));if(line)token=line.slice(line.indexOf('=')+1).trim().replace(/^['"]|['"]$/g,'');}
const cases=[
 {name:'Dorking-east-150',center:{latitude:51.2328,longitude:-0.3297},direction:90,targetKm:40,coneAngleDegrees:150},
 {name:'Dorking-east-120',center:{latitude:51.2328,longitude:-0.3297},direction:90,targetKm:40,coneAngleDegrees:120},
 {name:'Dorking-east-180',center:{latitude:51.2328,longitude:-0.3297},direction:90,targetKm:40,coneAngleDegrees:180},
];
const checks=[];
for(const {name,...input} of cases){
 const started=performance.now(),response=await fetch(values.base+'/round-trip',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({...input,profile:'winding',avoidMotorways:true}),signal:AbortSignal.timeout(35000)});
 const result=await response.json();assert.equal(response.status,200,`${name}: ${result.message}`);
 const p=result.planner;assert.equal(p.valid,true);assert.equal(p.coneAngleDegrees,input.coneAngleDegrees);assert.equal(p.coneRadiusKm,coneRadiusKm(input.targetKm));assert.ok(Math.abs(p.distanceKm-input.targetKm)<10);assert.ok(p.maxTraversals<=2&&p.repeatedRatio<=0.1);
 const ring=conePolygon({...input,radiusKm:coneRadiusKm(input.targetKm)},true);assert.ok(geometry(result).every(point=>insideCone(point,ring)));
 assert.ok(result.trip.legs.every(l=>l.maneuvers?.length));
 checks.push({name,status:response.status,requestId:response.headers.get('x-request-id'),distanceKm:p.distanceKm,repeatedRatio:p.repeatedRatio,internalRepeatedRatio:p.internalRepeatedRatio,internalExcursionKm:p.internalExcursionKm,angle:p.coneAngleDegrees,radiusKm:p.coneRadiusKm,durationMs:Math.round(performance.now()-started)});
 console.log(JSON.stringify(checks.at(-1)));
}
const report={verifiedAt:new Date().toISOString(),checks};if(values.output)writeFileSync(values.output,JSON.stringify(report,null,2)+'\n');
