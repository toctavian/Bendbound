import Storage from 'expo-sqlite/kv-store';
import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { seedTours } from '@/data/seed';
import { AppSettings, DraftRoute, Tour } from '@/types';
import { snapDraftToRoads } from '@/utils/routes';
import { initialSettings, restoreSettings } from '@/utils/settings';
import { acknowledgeRecordedTours, pendingRecordedTours } from '@/services/rideStore';

type AppState = {
  ready: boolean;
  tours: Tour[];
  settings: AppSettings;
  activeRoute: DraftRoute | null;
  setActiveRoute: (route: DraftRoute | null) => void;
  saveTour: (tour: Tour) => void;
  toggleSaved: (id: string) => void;
  updateSettings: (next: Partial<AppSettings>) => void;
};

const AppContext = createContext<AppState | null>(null);
const STORE_KEY = 'bendbound-state-v2';
// Read only for migration; retain the original data as a recovery backup.
const LEGACY_STORE_KEY = 'roams-state-v2';
const ROUTING_VERSION = 7;
let persistence: Promise<unknown> = Promise.resolve();

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [tours, setTours] = useState<Tour[]>(seedTours);
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [activeRoute, setActiveRoute] = useState<DraftRoute | null>(null);

  useEffect(() => {
    Storage.getItem(STORE_KEY)
      .then((value) => value === null ? Storage.getItem(LEGACY_STORE_KEY) : value)
      .then(async (value) => {
        const stored = value === null ? null : JSON.parse(value) as { tours?: Tour[]; settings?: Partial<AppSettings>; routingVersion?: number };
        if (value !== null && (!stored || typeof stored !== 'object' || Array.isArray(stored)
          || (stored.tours !== undefined && !Array.isArray(stored.tours))
          || (stored.settings !== undefined && (!stored.settings || typeof stored.settings !== 'object' || Array.isArray(stored.settings))))) {
          throw new Error('Invalid saved app state');
        }
        const restoredTours = stored?.tours ?? seedTours;
        const seedIds = new Set(seedTours.map((tour) => tour.id));
        const roadSnapped = await Promise.all(restoredTours.map(async (tour) => {
          if (tour.place === 'Created in Roams') tour = { ...tour, place: 'Created in Bendbound' };
          if (tour.place === 'Recorded in Roams') tour = { ...tour, place: 'Recorded in Bendbound' };
          // Demo itineraries are not the rider's completed GPS recordings.
          if (seedIds.has(tour.id)) tour = { ...tour, completed: false };
          if (!seedIds.has(tour.id) || stored?.routingVersion === ROUTING_VERSION) return tour;
          const original = seedTours.find((seed) => seed.id === tour.id) ?? tour;
          try {
            const draft = await snapDraftToRoads({
              title: original.title,
              route: original.route,
              distanceKm: original.distanceKm,
              durationMin: original.durationMin,
              curves: original.curves,
              profile: 'winding',
            }, { avoidMotorways: true });
            return { ...tour, route: draft.route, maneuvers: draft.maneuvers, distanceKm: draft.distanceKm, durationMin: draft.durationMin };
          } catch {
            return tour;
          }
        }));
        const pending = pendingRecordedTours();
        const restoredIds = new Set(roadSnapped.map((tour) => tour.id));
        setTours([...pending.filter((tour) => !restoredIds.has(tour.id)), ...roadSnapped]);
        setSettings(restoreSettings(stored?.settings));
        setStorageLoaded(true);
      })
      .catch(() => console.warn('Saved app data could not be loaded; persistence is disabled to protect existing data.'))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!ready || !storageLoaded) return;
    // Keep completed rides in the journal until the tour collection is durably written.
    // Serialize writes so an older settings update cannot overwrite a saved ride.
    persistence = persistence.catch(() => undefined)
      .then(() => Storage.setItem(STORE_KEY, JSON.stringify({ tours, settings, routingVersion: ROUTING_VERSION })))
      .then(() => acknowledgeRecordedTours(tours))
      .catch(() => console.warn('App data could not be saved; completed recordings remain in the recovery journal.'));
  }, [ready, settings, storageLoaded, tours]);

  const value = useMemo<AppState>(
    () => ({
      ready,
      tours,
      settings,
      activeRoute,
      setActiveRoute,
      saveTour: (tour) => setTours((current) => [tour, ...current.filter((item) => item.id !== tour.id)]),
      toggleSaved: (id) =>
        setTours((current) => current.map((tour) => (tour.id === id ? { ...tour, saved: !tour.saved } : tour))),
      updateSettings: (next) => setSettings((current) => ({ ...current, ...next })),
    }),
    [activeRoute, ready, settings, tours],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside AppProvider');
  return context;
}
