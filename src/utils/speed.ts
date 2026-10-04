import type { SpeedUnit } from '@/types';

// Keep GPS, routing and warning thresholds in km/h; convert only for display.
export function displaySpeed(speedKph: number, unit: SpeedUnit = 'km/h'): number {
  const speed = Number.isFinite(speedKph) ? Math.max(0, speedKph) : 0;
  return Math.round(unit === 'mph' ? speed / 1.609344 : speed);
}

export function speedUnitName(unit: SpeedUnit = 'km/h'): string {
  return unit === 'mph' ? 'miles per hour' : 'kilometres per hour';
}
