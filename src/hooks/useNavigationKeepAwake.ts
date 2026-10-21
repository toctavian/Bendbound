import { useEffect } from 'react';
import { AppState } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

let sequence = 0;
export function useNavigationKeepAwake(active: boolean) {
  useEffect(() => {
    if (!active) return;
    // A distinct tag prevents a late native activation/cleanup from releasing
    // the lock for a newer navigation session.
    const tag = `bendbound-navigation-${++sequence}`;
    let released = false;
    const release = () => { void deactivateKeepAwake(tag).catch(() => undefined); };
    const activate = () => {
      void activateKeepAwakeAsync(tag).then(() => {
        if (released) release();
      }).catch(() => { if (!released) console.warn('Ride screen wake lock could not be enabled.'); });
    };
    activate();
    // Returning from feedback/another app need not change router focus.
    const subscription = AppState.addEventListener('change', state => { if (state === 'active' && !released) activate(); });
    return () => { released = true; subscription.remove(); release(); };
  }, [active]);
}
