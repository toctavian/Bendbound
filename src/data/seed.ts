import { Coordinate, PoiCategory, Tour } from '@/types';

const triglav: Coordinate[] = [
  { latitude: 46.369, longitude: 14.113 },
  { latitude: 46.485, longitude: 13.786 },
  { latitude: 46.337, longitude: 13.552 },
  { latitude: 46.185, longitude: 13.733 },
  { latitude: 46.271, longitude: 13.953 },
  { latitude: 46.369, longitude: 14.113 },
];

const surrey: Coordinate[] = [
  { latitude: 51.236, longitude: -0.57 },
  { latitude: 51.214, longitude: -0.8 },
  { latitude: 51.09, longitude: -0.71 },
  { latitude: 50.986, longitude: -0.61 },
  { latitude: 51.063, longitude: -0.327 },
  { latitude: 51.233, longitude: -0.332 },
  { latitude: 51.236, longitude: -0.57 },
];

const wales: Coordinate[] = [
  { latitude: 53.092, longitude: -3.801 },
  { latitude: 52.912, longitude: -3.597 },
  { latitude: 52.744, longitude: -3.886 },
  { latitude: 52.723, longitude: -4.056 },
  { latitude: 52.929, longitude: -4.134 },
  { latitude: 53.118, longitude: -4.129 },
  { latitude: 53.092, longitude: -3.801 },
];

export const seedTours: Tour[] = [
  {
    id: 'triglav',
    title: 'Triglav national park',
    place: 'Julian Alps, Slovenia',
    date: '28 Sep 2026',
    distanceKm: 191,
    durationMin: 264,
    curves: 148,
    elevationM: 2840,
    author: 'Octavian',
    saved: true,
    completed: false,
    route: triglav,
  },
  {
    id: 'surrey-hills',
    title: 'Surrey Hills loop',
    place: 'Guildford, England',
    date: '21 Sep 2026',
    distanceKm: 162,
    durationMin: 198,
    curves: 121,
    elevationM: 1340,
    author: 'Octavian',
    saved: true,
    completed: false,
    route: surrey,
  },
  {
    id: 'wales-sweepers',
    title: 'Eryri mountain sweepers',
    place: 'Eryri National Park',
    date: 'Community tour',
    distanceKm: 246,
    durationMin: 305,
    curves: 189,
    elevationM: 2160,
    author: 'Maya R.',
    saved: false,
    completed: false,
    route: wales,
  },
];

export const defaultCenter: Coordinate = { latitude: 51.5074, longitude: -0.1278 };

export const nearbyPlaces: { id: PoiCategory; label: string; icon: 'speedometer-outline' | 'trail-sign-outline' | 'cafe-outline' | 'camera-outline' | 'leaf-outline' }[] = [
  { id: 'fuel', label: 'Fuel stations', icon: 'speedometer-outline' },
  { id: 'pass', label: 'Mountain passes', icon: 'trail-sign-outline' },
  { id: 'meet', label: 'Biker meets', icon: 'cafe-outline' },
  { id: 'sight', label: 'Highlights', icon: 'camera-outline' },
  { id: 'forest', label: 'Forests', icon: 'leaf-outline' },
];
