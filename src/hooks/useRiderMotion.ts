import { useEffect, useRef, useState } from 'react';
import type { Coordinate } from '@/types';
import { distanceBetween } from '@/utils/routes';
import { movementPath, positionAlong, interpolateHeading } from '@/utils/riderMotion';

export function useRiderMotion(point: Coordinate | undefined, heading: number, road: Coordinate[], enabled: boolean) {
  const [frame, setFrame] = useState({ point, heading });
  const current = useRef(frame);
  const target = useRef({ point, heading });
  const previousFix = useRef(0);
  const motion = useRef<{ path: Coordinate[]; started: number; duration: number; heading: number } | null>(null);
  const latitude = point?.latitude, longitude = point?.longitude;
  useEffect(() => {
    const point = latitude === undefined || longitude === undefined ? undefined : { latitude, longitude };
    const now = Date.now();
    if (!previousFix.current) previousFix.current = now;
    let reset: ReturnType<typeof setTimeout> | undefined;
    const before = target.current.point;
    target.current = { point, heading };
    if (!enabled || !point || !current.current.point || distanceBetween(current.current.point, point) > 0.25 || now - previousFix.current > 10000) {
      motion.current = null;
      current.current = { point, heading };
      const value = current.current; reset = setTimeout(() => setFrame(value), 0);
    } else if (!before || before.latitude !== point.latitude || before.longitude !== point.longitude) {
      motion.current = { path: movementPath(current.current.point, point, road), started: now,
        duration: Math.max(250, Math.min(1000, now - previousFix.current)), heading: current.current.heading };
    }
    if (before?.latitude !== point?.latitude || before?.longitude !== point?.longitude) previousFix.current = now;
    return () => { if (reset !== undefined) clearTimeout(reset); };
  }, [latitude, longitude, heading, road, enabled]);
  useEffect(() => {
    if (!enabled) return;
    let id: number, last = 0;
    const tick = () => {
      const now = Date.now();
      if (now - last >= 33 && target.current.point) {
        last = now;
        const m = motion.current;
        const t = m ? Math.min(1, (now - m.started) / m.duration) : 1;
        const next = { point: m ? positionAlong(m.path, t) : target.current.point,
          heading: interpolateHeading(current.current.heading, target.current.heading, 0.2) };
        if (t >= 1) motion.current = null;
        if (!current.current.point || distanceBetween(current.current.point, next.point) > 0.0001 || Math.abs(((next.heading - current.current.heading + 540) % 360) - 180) > 0.1) {
          current.current = next; setFrame(next);
        }
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [enabled]);
  return enabled ? frame : { point, heading };
}
