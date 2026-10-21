import type { DraftRoute, Tour } from '@/types';

/** Match the actual itinerary so edits become unsaved and repeated taps reuse it. */
export function findSavedRoute(draft: DraftRoute | null, tours: Tour[]): Tour | undefined {
  if (!draft) return undefined;
  return tours.find(tour => !tour.recording && tour.title === draft.title
    && !!tour.roundTrip === !!draft.roundTrip && tour.route.length === draft.route.length
    && tour.route.every((p, i) => p.latitude === draft.route[i].latitude && p.longitude === draft.route[i].longitude)
    && (tour.stops?.length ?? 0) === (draft.stops?.length ?? 0)
    && (tour.stops ?? []).every((p, i) => {
      const stop = draft.stops![i];
      return p.latitude === stop.latitude && p.longitude === stop.longitude && p.name === stop.name && p.address === stop.address;
    }));
}
