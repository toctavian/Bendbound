import type { NavigationManeuver } from '../types';

export function upcomingManeuver(maneuvers: NavigationManeuver[], routeIndex: number) {
  return maneuvers.find((maneuver) => maneuver.type > 3 && maneuver.beginShapeIndex >= routeIndex);
}

export function voiceCue(maneuver: NavigationManeuver | undefined, distanceKm: number, speedKph: number) {
  if (!maneuver || !Number.isFinite(distanceKm)) return null;
  const metres = Math.max(0, distanceKm * 1000);
  const metresPerSecond = Math.max(0, speedKph) / 3.6;
  const now = Math.min(60, Math.max(25, metresPerSecond * 2));
  const approach = Math.min(300, Math.max(150, metresPerSecond * 8));
  const advance = Math.min(1000, Math.max(500, metresPerSecond * 20));
  if (metres > advance) return null;
  const stage = metres <= now ? 3 : metres <= approach ? 2 : 1;
  const instruction = maneuver.spokenInstruction ?? maneuver.instruction;
  const roundedMetres = Math.max(50, Math.round(metres / 50) * 50);
  return {
    key: `${maneuver.beginShapeIndex}:${maneuver.type}`,
    stage,
    text: stage === 3 ? instruction : `In ${roundedMetres} metres. ${instruction}`,
  };
}
