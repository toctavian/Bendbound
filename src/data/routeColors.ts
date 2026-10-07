import type { RouteColor } from '@/types';

export const routeColors: Record<RouteColor, { label: string; value: string }> = {
  red: { label: 'Red', value: '#ec3347' },
  blue: { label: 'Blue', value: '#2856d8' },
  purple: { label: 'Purple', value: '#7c3aed' },
  green: { label: 'Green', value: '#15803d' },
  orange: { label: 'Orange', value: '#b9630c' },
  teal: { label: 'Teal', value: '#087f8c' },
};

export function routeColorOrDefault(value: unknown): RouteColor {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(routeColors, value) ? value as RouteColor : 'red';
}
