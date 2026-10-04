import { useEffect, useState } from 'react';
import type { Coordinate } from '@/types';
import { fetchPlaceSuggestions, PlaceSuggestion } from '@/utils/places';

export function usePlaceSuggestions(query: string, center: Coordinate, enabled: boolean) {
  const normalized = query.trim();
  const latitude = Number(center.latitude.toFixed(2));
  const longitude = Number(center.longitude.toFixed(2));
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; places: PlaceSuggestion[]; error: boolean } | null>(null);
  const key = JSON.stringify([normalized, latitude, longitude, attempt]);
  const searchable = enabled && normalized.length >= 2;

  useEffect(() => {
    if (!searchable) return;
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => {
      void fetchPlaceSuggestions(normalized, { latitude, longitude }, controller.signal)
        .then((places) => { if (active) setResult({ key, places, error: false }); })
        .catch(() => { if (active) setResult({ key, places: [], error: true }); });
    }, 400);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [key, latitude, longitude, normalized, searchable]);

  const current = searchable && result?.key === key ? result : null;
  return {
    places: current?.places ?? [],
    loading: searchable && !current,
    error: current?.error ?? false,
    retry: () => setAttempt((value) => value + 1),
  };
}
