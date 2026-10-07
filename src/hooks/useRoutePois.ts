import { useEffect, useState } from 'react';
import type { Coordinate, RoutePointOfInterest } from '@/types';
import { fetchRoutePois } from '@/utils/routePois';

export function useRoutePois(route: Coordinate[] | undefined) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ route: Coordinate[]; attempt: number; points: RoutePointOfInterest[]; error: boolean } | null>(null);
  useEffect(() => {
    if (!route) return;
    const controller = new AbortController();
    let active = true;
    void fetchRoutePois(route, controller.signal)
      .then((points) => { if (active) setResult({ route, attempt, points, error: false }); })
      .catch(() => { if (active) setResult({ route, attempt, points: [], error: true }); });
    return () => { active = false; controller.abort(); };
  }, [route, attempt]);
  const current = route && result?.route === route && result.attempt === attempt ? result : null;
  return {
    points: current?.points ?? [],
    loading: !!route && !current,
    error: current?.error ?? false,
    retry: () => setAttempt((value) => value + 1),
  };
}
