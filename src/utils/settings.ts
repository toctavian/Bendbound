import type { AppSettings } from '@/types';
import { motorcycleTypeOrDefault } from '@/data/motorcycles';

export const initialSettings: AppSettings = {
  motorcycleType: 'adventure',
  motorcycleName: '',
  routingProfile: 'winding',
  avoidMotorways: true,
  offlineMaps: false,
  voiceGuidance: true,
  hazards: true,
  speedLimits: true,
  speedUnit: 'km/h',
  privateProfile: false,
};

export function restoreSettings(stored?: Partial<AppSettings>): AppSettings {
  return {
    ...initialSettings,
    ...stored,
    motorcycleType: motorcycleTypeOrDefault(stored?.motorcycleType),
    motorcycleName: typeof stored?.motorcycleName === 'string' ? stored.motorcycleName.slice(0, 60) : '',
    routingProfile: stored?.routingProfile === 'fast' || stored?.routingProfile === 'twisty' ? stored.routingProfile : 'winding',
    speedUnit: stored?.speedUnit === 'mph' ? 'mph' : 'km/h',
    offlineMaps: false,
  };
}
