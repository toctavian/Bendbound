import { distanceBetween, routeDistance, repeatedRoadRatio } from '../../service/geometry.mjs';

// Remove a road spur only when most of the closed excursion retraces itself.
// Preserve genuine loops and near-start access, including offset finish snaps.
export function removeInternalExcursions(points) {
  if(points.length<4)return points;
  const totalKm=routeDistance(points);
  const stack=[],indices=new Map();
  const key=p=>`${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`;
  for(const point of points) {
    const id=key(point),previous=indices.get(id);
    if(previous!==undefined && distanceBetween(point,points[0])>0.2) {
      const excursion=[...stack.slice(previous),point];
      const km=routeDistance(excursion),repeat=repeatedRoadRatio(excursion);
      // A smaller side loop reached through a doubled connector is also an
      // internal detour. Keep the main circuit and all truly independent loops.
      if(km>0.05 && (repeat>=0.35 || (repeat>=0.05 && km<totalKm*0.5))) {
        stack.splice(previous+1);
        indices.clear();for(let i=0;i<stack.length;i++)indices.set(key(stack[i]),i);
        continue;
      }
    }
    indices.set(id,stack.length);stack.push(point);
  }
  return stack;
}
