import { useEffect, useState } from 'react';
import { Alert, AppState, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Linking from 'expo-linking';
import type { PointOfInterest } from '@/types';
import { colors } from '@/theme';
import { ActionButton } from '@/components/ui';
import { fuelDiscrepancyUrl, fuelLicenceUrl, fuelPriceSnapshot, fuelRefreshMs, highlightPhoto } from '@/utils/poiDetails';

type Props = { point: PointOfInterest | null; busy: boolean; onClose: () => void; onRide: (point: PointOfInterest) => void; onAdd: (point: PointOfInterest) => void };
export function PoiDetails({ point, busy, onClose, onRide, onAdd }: Props) {
  const [photo, setPhoto] = useState<string | undefined>(point?.imageUrl);
  const [prices, setPrices] = useState('Loading prices…');
  useEffect(() => {
    if (!point) return;
    let active = true;
    let controller: AbortController | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      controller?.abort();
      clearTimeout(timeout); clearTimeout(expiry);
      controller = new AbortController();
      const request = controller;
      timeout = setTimeout(() => request.abort(), 8000);
      try {
        if (point.category === 'sight') {
          const url = await highlightPhoto(point, request.signal);
          if (active && request === controller) setPhoto(url);
        }
        if (point.category === 'fuel') {
          setPrices('Loading prices…');
          const snapshot = await fuelPriceSnapshot(point, request.signal);
          if (active && request === controller) {
            const remaining = (snapshot?.expiresAt ?? 0) - Date.now();
            setPrices(snapshot && remaining > 0 ? snapshot.description : 'Live prices unavailable');
            if (snapshot && remaining > 0) expiry = setTimeout(() => setPrices('Live prices unavailable'), remaining);
          }
        }
      } catch {
        if (active && request === controller && point.category === 'fuel') setPrices('Live prices unavailable');
      } finally {
        if (request === controller) clearTimeout(timeout);
      }
    };
    void refresh();
    const interval = point.category === 'fuel' ? setInterval(() => { void refresh(); }, fuelRefreshMs) : undefined;
    const subscription = point.category === 'fuel' ? AppState.addEventListener('change', (state) => { if (state === 'active') void refresh(); }) : undefined;
    return () => { active = false; controller?.abort(); clearTimeout(timeout); clearTimeout(expiry); clearInterval(interval); subscription?.remove(); };
  }, [point]);
  return <Modal visible={!!point} transparent animationType="slide" onRequestClose={onClose}>
    <View style={styles.backdrop}><ScrollView style={styles.card} contentContainerStyle={styles.content}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close place" disabled={busy} onPress={onClose} style={styles.close}><Text style={styles.text}>Close</Text></Pressable>
      <Text style={styles.title}>{point?.name}</Text>
      {point?.category === 'sight' ? photo ? <Image source={{ uri: photo }} style={styles.photo} accessibilityLabel={point.name} onError={() => setPhoto(undefined)} />
        : <View style={styles.placeholder}><Text style={styles.text}>Photo unavailable</Text></View>
        : <Text style={styles.text}>{point?.detail}</Text>}
      {point?.category === 'fuel' ? <View style={{ gap: 8 }}>
        <Text style={styles.text}>{prices}</Text>
        <ActionButton label="Report a price discrepancy" onPress={() => { void Linking.openURL(fuelDiscrepancyUrl).catch(() => Alert.alert('Could not open report', 'Please try again.')); }} />
        <Text style={styles.text}>Fuel price data: Fuel Finder. Contains public sector information licensed under the Open Government Licence v3.0.</Text>
        <Pressable accessibilityRole="link" accessibilityLabel="Open Government Licence v3.0" onPress={() => { void Linking.openURL(fuelLicenceUrl).catch(() => Alert.alert('Could not open licence', 'Please try again.')); }} style={styles.close}>
          <Text style={styles.text}>View licence</Text>
        </Pressable>
      </View> : null}
      {point?.moreUrl ? <ActionButton label="See more" onPress={() => { void Linking.openURL(point.moreUrl!).catch(() => Alert.alert('Could not open page', 'Please try again.')); }} /> : null}
      <ActionButton label="Ride here" icon="navigate-outline" disabled={busy} onPress={() => { if (point) onRide(point); }} />
      <ActionButton label="Add as a stop" icon="add" disabled={busy} onPress={() => { if (point) onAdd(point); }} />
    </ScrollView></View>
  </Modal>;
}
const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', backgroundColor: '#0009', padding: 20 },
  card: { backgroundColor: colors.panel, borderRadius: 16, maxHeight: '90%', flexGrow: 0 },
  content: { padding: 18, gap: 12 },
  close: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: 10 },
  title: { color: colors.ink, fontSize: 21, fontWeight: '800' },
  text: { color: colors.ink, fontSize: 13 },
  photo: { height: 150, width: '100%', borderRadius: 10 },
  placeholder: { height: 100, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.panelAlt, borderRadius: 10 },
});
