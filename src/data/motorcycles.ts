import type { MotorcycleType } from '@/types';

export const motorcycles: Record<MotorcycleType, { label: string; model: string; color: string }> = {
  sports: { label: 'Sports', model: 'BMW S 1000 RR', color: '#ec3347' },
  adventure: { label: 'Adventure', model: 'BMW R 1300 GS Adventure', color: '#149ed0' },
  // Retain the persisted identifier so existing selections now display as Octav.
  funventure: { label: 'Octav', model: 'Suzuki V-Strom DL650 (2016)', color: '#d91b32' },
  bogdan: { label: 'Bogdan', model: 'Kawasaki Z650 (2020)', color: '#75d51c' },
  radu: { label: 'Radu', model: 'BMW R1200GS (2025)', color: '#e52a32' },
  petre: { label: 'Petre', model: 'Yamaha Tracer 900 GT (2018)', color: '#a1a7af' },
  foca: { label: 'Foca', model: 'Triumph Bonneville T100 (2008)', color: '#969a9f' },
  cruiser: { label: 'Cruiser', model: 'Honda Rebel 500', color: '#a32945' },
  motocross: { label: 'Motocross', model: 'Honda CRF250R', color: '#e62d38' },
  scooter: { label: 'Scooter', model: 'Honda PCX - Deliveroo', color: '#00bdc8' },
};

export function motorcycleTypeOrDefault(value: unknown): MotorcycleType {
  return typeof value === 'string' && Object.hasOwn(motorcycles, value) ? value as MotorcycleType : 'adventure';
}
