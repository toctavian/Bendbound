import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useApp } from '@/state/AppProvider';
import { readRideState } from '@/services/rideStore';
import { loadRouteShare } from '@/utils/routeSharing';
import { ActionButton } from '@/components/ui';
import { colors } from '@/theme';

export default function SharedRouteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { ready, setActiveRoute, updateSettings } = useApp();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || loaded.current === id) return;
    let cancelled = false;
    (async () => {
      try {
        if (readRideState().active) throw new Error('Finish or save your current ride before opening a shared route.');
        const shared = await loadRouteShare(id);
        if (cancelled) return;
        // Recheck after fetching: an incoming link must never replace an active ride.
        if (readRideState().active) throw new Error('Finish or save your current ride before opening a shared route.');
        loaded.current = id;
        setActiveRoute(shared.route);
        updateSettings({ routingProfile: shared.route.profile, avoidMotorways: shared.avoidMotorways });
        router.replace({ pathname: '/ride', params: { imported: `${id}-${Date.now()}` } });
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'Could not open this route.');
      }
    })();
    return () => { cancelled = true; };
  }, [id, ready, setActiveRoute, updateSettings, attempt]);
  return <View style={styles.page}>
    <Text style={styles.title}>{error ? 'Could not open route' : 'Opening shared route…'}</Text>
    <Text style={styles.copy}>{error || 'Your route will open as a preview. Navigation will stay stopped.'}</Text>
    {error ? <ActionButton label="Try again" onPress={() => { setError(''); setAttempt(n => n + 1); }} /> : null}
    <ActionButton label="Back to map" onPress={() => router.replace('/ride')} />
  </View>;
}
const styles = StyleSheet.create({ page: { flex: 1, backgroundColor: colors.canvas, justifyContent: 'center', padding: 24, gap: 16 }, title: { fontSize: 24, fontWeight: '800', color: colors.ink }, copy: { color: colors.muted, fontSize: 16 } });
