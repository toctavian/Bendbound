import { useEffect, useRef, useState } from 'react';
import * as Speech from 'expo-speech';
import type { NavigationManeuver } from '@/types';
import { voiceCue } from '@/utils/guidance';

export function useVoiceGuidance({ enabled, paused, gpsReady, offRoute, maneuver, distanceKm, speedKph }: {
  enabled: boolean;
  paused: boolean;
  gpsReady: boolean;
  offRoute: boolean;
  maneuver?: NavigationManeuver;
  distanceKm: number;
  speedKph: number;
}) {
  const announced = useRef(new Map<string, number>());
  const warnedOffRoute = useRef(false);
  const revision = useRef(0);
  const queue = useRef(Promise.resolve());
  const [failed, setFailed] = useState(false);
  const active = enabled && !paused && gpsReady;
  const cue = voiceCue(maneuver, distanceKm, speedKph);
  const key = cue?.key;
  const stage = cue?.stage;
  const text = cue?.text;

  useEffect(() => {
    if (!active) void Speech.stop().catch(() => undefined);
    return () => {
      revision.current += 1;
      void Speech.stop().catch(() => undefined);
    };
  }, [active, offRoute]);

  useEffect(() => {
    if (!offRoute) warnedOffRoute.current = false;
    if (!active) return;
    let message: string;
    if (offRoute) {
      if (warnedOffRoute.current) return;
      warnedOffRoute.current = true;
      message = 'You are off route. Return to the highlighted route when it is safe.';
    } else {
      if (!key || !stage || !text || (announced.current.get(key) ?? 0) >= stage) return;
      announced.current.set(key, stage);
      message = text;
    }
    const currentRevision = ++revision.current;
    // Serialize stop/speak so a delayed native stop cannot silence a newer turn.
    queue.current = queue.current.then(async () => {
      await Speech.stop();
      if (currentRevision !== revision.current) return;
      Speech.speak(message, {
        language: 'en-GB',
        rate: 1,
        useApplicationAudioSession: false,
        onStart: () => setFailed(false),
        onError: () => setFailed(true),
      });
    }).catch(() => { if (currentRevision === revision.current) setFailed(true); });
  }, [active, key, offRoute, stage, text]);

  return failed;
}
