export type Coordinate = {
  latitude: number;
  longitude: number;
};

export type PoiCategory = 'fuel' | 'pass' | 'meet' | 'sight' | 'forest';

export type PointOfInterest = Coordinate & {
  id: string;
  name: string;
  category: PoiCategory;
  detail: string;
};

export type RoutingProfile = 'fast' | 'winding' | 'twisty';
export type MotorcycleType = 'sports' | 'adventure' | 'cruiser' | 'motocross' | 'funventure' | 'scooter' | 'bogdan' | 'radu' | 'petre' | 'foca';
export type SpeedUnit = 'km/h' | 'mph';

export type NavigationManeuver = {
  type: number;
  instruction: string;
  spokenInstruction?: string;
  streetName?: string;
  beginShapeIndex: number;
  endShapeIndex: number;
  bearingAfter?: number;
};

export type Tour = {
  id: string;
  title: string;
  place: string;
  date: string;
  distanceKm: number;
  durationMin: number;
  curves: number;
  elevationM: number;
  author: string;
  saved: boolean;
  completed: boolean;
  route: Coordinate[];
  maneuvers?: NavigationManeuver[];
  recording?: {
    startedAt: number;
    endedAt: number;
    durationSeconds: number;
    segments: TrackPoint[][];
  };
};

export type TrackPoint = Coordinate & {
  timestamp: number;
  accuracy: number;
};

export type AppSettings = {
  motorcycleType: MotorcycleType;
  motorcycleName: string;
  routingProfile: RoutingProfile;
  avoidMotorways: boolean;
  offlineMaps: boolean;
  voiceGuidance: boolean;
  hazards: boolean;
  speedLimits: boolean;
  speedUnit: SpeedUnit;
  privateProfile: boolean;
};

export type DraftRoute = {
  title: string;
  route: Coordinate[];
  distanceKm: number;
  durationMin: number;
  curves: number;
  profile: RoutingProfile;
  maneuvers?: NavigationManeuver[];
};
