import fs from 'node:fs';
import { distanceBetween } from '../../service/geometry.mjs';
export const london = Object.freeze({ latitude: 51.5074, longitude: -0.1278 });
export const radiusKm = 100;
export const ukCoverage = process.env.ROUTING_COVERAGE === 'uk';
const ukRings = JSON.parse(fs.readFileSync(new URL('./uk-boundary.json', import.meta.url), 'utf8'));
export const serviceArea = ukCoverage ? { country: 'GB', coverage: 'United Kingdom', source: 'Geofabrik United Kingdom extract boundary' } : { center: london, radiusKm };
export const coverageLabel = ukCoverage ? 'United Kingdom map coverage' : 'London 100 km pilot area';
export function inUkArea(point) {
  if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) || Math.abs(point.latitude)>90 || Math.abs(point.longitude)>180) return false;
  const x=point.longitude,y=point.latitude;
  return ukRings.some(ring => {
    let inside=false;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
      const [a,b]=ring[i],[c,d]=ring[j];
      if ((b>y)!==(d>y) && x<(c-a)*(y-b)/(d-b)+a) inside=!inside;
    }
    return inside;
  });
}
export function inArea(point) {
  if (ukCoverage) return inUkArea(point);
  return point && Number.isFinite(point.latitude) && Math.abs(point.latitude)<=90
    && Number.isFinite(point.longitude) && Math.abs(point.longitude)<=180
    && distanceBetween(london, point) <= radiusKm;
}
export function frequencyRating(count) {
  if (!Number.isInteger(count) || count < 0) throw new TypeError('Invalid recommendation count');
  return count === 0 ? null : 1 + 4 * count / (count + 2);
}
export function roadRating(quality, count) {
  const frequency = frequencyRating(count);
  return Math.max(0, Math.min(5, frequency === null ? quality : quality * 0.7 + frequency * 0.3));
}
export function candidateScore(metrics, included, targetKm) {
  const qualityKm = included.reduce((sum, s) => sum + s.traversedKm * s.rating / 5, 0);
  return qualityKm / Math.max(1, targetKm) * 100 - metrics.distanceErrorKm / Math.max(1, targetKm) * 15
    - (metrics.repeatedRatio||0)*100 - (metrics.internalExcursionKm||0)/Math.max(1,targetKm)*300 - (metrics.internalRepeatedRatio||0)*300;
}
export function betterCandidate(candidate,current) {
  if(!current)return true;
  const clean=result=>(result.metrics.internalRepeatedRatio??0)<=0.001 && (result.metrics.internalExcursionKm??0)<=0.05;
  if(clean(candidate)!==clean(current))return clean(candidate);
  return candidate.score>current.score;
}
