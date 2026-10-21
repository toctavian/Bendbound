import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useNavigationKeepAwake } from './useNavigationKeepAwake';
import { readRideState, recordTrackingDiagnostic } from '@/services/rideStore';
import { subscribeToRide } from '@/services/rideTracking';

function activeRide() {
  try { return readRideState().active?.session.activeSince != null; }
  catch { return false; } // Recording recovery reports malformed storage separately.
}
// The ride owns the lock, so changing tabs or opening in-app feedback cannot
// release it. iOS still controls other apps and an explicitly locked screen.
export function useActiveRideKeepAwake() {
  const [active, setActive] = useState(activeRide);
  useEffect(() => {
    let mounted = true;
    const unsubscribe = subscribeToRide(ride => setActive(ride?.session.activeSince != null));
    const subscription = AppState.addEventListener('change', state => {
      if (activeRide()) recordTrackingDiagnostic('app.state', { state });
    });
    queueMicrotask(() => { if (mounted) setActive(activeRide()); });
    return () => { mounted = false; unsubscribe(); subscription.remove(); };
  }, []);
  useNavigationKeepAwake(active);
}
