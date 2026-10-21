import { useEffect, useMemo, useRef, useState } from 'react';
import type { Coordinate } from '@/types';
import { matchRoadChunk, recordingChunks } from '@/utils/roadMatching';
const empty: Coordinate[][] = [];
const emptyRoad: Coordinate[] = [];
type Matched = { owner: Coordinate[][]; lines: Coordinate[][]; road: Coordinate[] };
const initialMatched: Matched = { owner: empty, lines: empty, road: emptyRoad };
const sameRide = (a: Coordinate[][], b: Coordinate[][]) => a.some(s => s.length) && b.some(s => s.length)
  && JSON.stringify(a.find(s => s.length)?.[0]) === JSON.stringify(b.find(s => s.length)?.[0]);

export function useRoadMatchedTrack(segments: Coordinate[][] | undefined, live: boolean) {
  const source = segments ?? empty;
  const latest = useRef(source), refresh = useRef<(() => void) | null>(null);
  const confirmed = useRef<Matched>(initialMatched);
  const [matched, setMatched] = useState<Matched>(initialMatched);
  const segmentCount = source.length;
  useEffect(() => { latest.current = source; }, [source]);
  useEffect(() => {
    if (live || !source.length) return;
    const controller = new AbortController();
    const chunks = recordingChunks(source), lines = [...chunks];
    (async () => {
      for (let i = 0; i < chunks.length && !controller.signal.aborted; i++) {
        lines[i] = await matchRoadChunk(chunks[i], controller.signal);
        if (!controller.signal.aborted) setMatched({ owner: source, lines: [...lines], road: lines[i] });
      }
    })();
    return () => controller.abort();
  }, [live, source]);
  useEffect(() => {
    if (!live || !segmentCount) return;
    const controller = new AbortController();
    const history = sameRide(confirmed.current.owner, latest.current) ? [...confirmed.current.lines] : [];
    let anchor: Coordinate[] = [], anchorStart = 0;
    let busy = false, previous = '';
    const update = async () => {
      if (busy || controller.signal.aborted) return;
      const snapshot = latest.current, last = snapshot[snapshot.length - 1] ?? [];
      const start = Math.max(0, last.length - 64), window = last.slice(start), key = JSON.stringify(window);
      if (key === previous || window.length < 2) return;
      busy = true; previous = key;
      let success = false;
      try {
        const road = await matchRoadChunk(window, controller.signal);
        if (!controller.signal.aborted && road !== window) {
          // Retain confirmed overlapping windows rather than replacing old road
          // geometry with raw GPS as the 64-point matching window advances.
          if (!anchor.length || start === anchorStart) { anchor = road; anchorStart = start; }
          else if (start - anchorStart >= 32) { history.push(anchor); anchor = road; anchorStart = start; }
          const next = { owner: snapshot, lines: [...history, ...(start > anchorStart ? [anchor] : []), road], road };
          confirmed.current = next; setMatched(next); success = true;
        }
      } catch {
        // Retain the last confirmed road if matching fails unexpectedly.
      } finally {
        busy = false;
        if (!success) previous = '';
        else if (!controller.signal.aborted && latest.current !== snapshot) void update();
      }
    };
    refresh.current = () => { void update(); };
    void update(); const timer = setInterval(() => { void update(); }, 2500);
    return () => { refresh.current = null; controller.abort(); clearInterval(timer); };
  }, [live, segmentCount]);
  useEffect(() => { refresh.current?.(); }, [source]);
  return useMemo(() => {
    if (live) {
      // New GPS fixes remain buffered until matched. A raw connector at the
      // endpoint would cut across the road on every successive update.
      return sameRide(matched.owner, source) ? { lines: matched.lines, road: matched.road } : { lines: empty, road: emptyRoad };
    }
    return { lines: matched.owner === source ? matched.lines : source, road: matched.owner === source ? matched.road : emptyRoad };
  }, [live, matched, source]);
}
