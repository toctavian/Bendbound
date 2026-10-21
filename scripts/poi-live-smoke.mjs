import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
const local = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8'));
const base = (local.EXPO_PUBLIC_ROUTING_URL || 'https://api.bendboundapp.com').replace(/\/$/, '');
const headers = { Authorization: `Bearer ${local.EXPO_PUBLIC_ROUTING_TOKEN || ''}` };
async function get(path, options={}) {
  const response = await fetch(base+path,{...options,headers:{...headers,...options.headers},signal:AbortSignal.timeout(45000)});
  const value = await response.json();
  if (!response.ok) throw new Error(`${path.split('?')[0]}${path.includes('category=') ? ` (${new URLSearchParams(path.split('?')[1]).get('category')})` : ''} returned ${response.status} (${value.code ?? 'unknown'})`);
  return value;
}
try {
  const result = { verifiedAt:new Date().toISOString(),base,health:await get('/poi-health'),categories:{} };
  let fuelPoint, highlight;
  for (const category of ['fuel','meet','sight','forest','pass']) {
    const value = await get(`/pois?category=${category}&latitude=51.5074&longitude=-0.1278`);
    if (!Array.isArray(value.points)) throw new Error(`Invalid ${category} results`);
    result.categories[category]={count:value.points.length,sample:value.points.slice(0,2).map(p=>({name:p.name,latitude:p.latitude,longitude:p.longitude}))};
    if (category==='fuel') fuelPoint=value.points[0];
    if (category==='sight') highlight=value.points.find(p=>p.wikipedia);
  }
  if (fuelPoint) {
    const prices=await get(`/fuel-prices?stationId=${encodeURIComponent(fuelPoint.fuelStationId)}`);
    if (prices.stationId!==fuelPoint.fuelStationId || Date.now()-Date.parse(prices.checkedAt)>=300000) throw new Error('Fuel station identity or freshness check failed');
    result.fuelSample={name:fuelPoint.name,checkedAt:prices.checkedAt,prices:prices.prices};
  }
  const epping=await get('/pois?category=forest&latitude=51.67&longitude=0.05');
  if(!epping.points?.some(p=>p.name==='Epping Forest'))throw new Error('Reviewed Epping forest road is missing');
  result.eppingForest=epping.points;
  const route=await get('/route-pois',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({route:[{latitude:51.5074,longitude:-.1278},{latitude:51.51,longitude:-.12}]})});
  if(!Array.isArray(route.elements))throw new Error('Invalid route POIs');
  result.routePoiCount=route.elements.length;
  if(highlight) result.photo=await get(`/poi-photo?wikipedia=${encodeURIComponent(highlight.wikipedia)}`);
  result.routingHealth=(await get('/health')).status;
  const denied=await fetch(base+'/pois?category=fuel&latitude=51.5&longitude=-.1',{signal:AbortSignal.timeout(10000)});
  if(denied.status!==401)throw new Error('Unauthenticated request was not rejected');
  result.unauthenticatedStatus=denied.status;
  console.log(JSON.stringify(result,null,2));
} catch (error) {
  console.error(error.message);
  process.exitCode=1;
}
