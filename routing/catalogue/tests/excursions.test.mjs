import assert from 'node:assert/strict';
import { test } from 'node:test';
import { removeInternalExcursions } from '../service/excursions.mjs';
import { routeDistance } from '../../service/geometry.mjs';
const point=(x,y)=>({latitude:51.5+y/111195,longitude:-0.12+x/(111195*Math.cos(51.5*Math.PI/180))});
const a=point(0,0),b=point(1000,0),c=point(1000,1000),d=point(0,1000);
test('an offset finish cannot collapse the main loop into a tiny near-start line',()=>{
 const loop=[a,b,c,d,a,point(4,0)];
 assert.deepEqual(removeInternalExcursions(loop),loop);
 assert.ok(routeDistance(removeInternalExcursions(loop))>3.9);
});
test('an internal out-and-back is removed while the main ride remains intact',()=>{
 const spur=point(1400,0),loop=[a,b,spur,b,c,d,a,point(4,0)];
 assert.deepEqual(removeInternalExcursions(loop),[a,b,c,d,a,point(4,0)]);
 assert.ok(routeDistance(loop)-routeDistance(removeInternalExcursions(loop))>0.79);
});
test('a real secondary loop through distinct roads is preserved at a shared junction',()=>{
 const loop=[a,b,point(1400,0),point(1400,400),point(1000,400),b,c,d,a];
 assert.deepEqual(removeInternalExcursions(loop),loop);
});
test('a smaller side circuit reached through a doubled connector is removed',()=>{
 const q=point(1300,0),r=point(1800,0),s=point(1800,700),t=point(1300,700);
 const loop=[a,b,q,r,s,t,q,b,c,d,a];
 assert.deepEqual(removeInternalExcursions(loop),[a,b,c,d,a]);
});
