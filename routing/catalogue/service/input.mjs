import { coneRadiusKm } from '../../service/cone.mjs';
import { validateInput as legacyValidate } from '../../service/planner.mjs';
import { RoutingError } from '../../service/engine.mjs';
export function validateInput(raw) {
  const input = legacyValidate(raw);
  input.center = { latitude: input.center.latitude, longitude: input.center.longitude };
  // Additive protocol: clients without a radius keep their existing policy.
  if (raw.radiusKm !== undefined) {
    if (!Number.isFinite(raw.radiusKm) || raw.radiusKm < 5 || raw.radiusKm > 100)
      throw new RoutingError('INVALID_REQUEST', 'Choose a cone radius between 5 and 100 km.', 400);
    input.radiusKm = raw.radiusKm;
  }
  if (raw.coneAngleDegrees !== undefined) {
    if (!Number.isFinite(raw.coneAngleDegrees) || raw.coneAngleDegrees < 10 || raw.coneAngleDegrees > 180)
      throw new RoutingError('INVALID_REQUEST', 'Choose a cone angle between 10 and 180 degrees.', 400);
    input.coneAngleDegrees = raw.coneAngleDegrees;
    input.radiusKm = coneRadiusKm(input.targetKm);
  }
  if(input.coneAngleDegrees!==undefined) {
    const {radiusKm,coneAngleDegrees,...basic}=input;
    return {...basic,coneAngleDegrees,radiusKm};
  }
  return input;
}
