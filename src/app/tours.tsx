import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RideMap } from '@/components/RideMap';
import { ActionButton } from '@/components/ui';
import { useApp } from '@/state/AppProvider';
import { Tour } from '@/types';
import { colors, spacing } from '@/theme';
import { formatDuration } from '@/utils/routes';
import { formatRidingTime, toursForCollection } from '@/utils/recording';

function TourCard({ tour }: { tour: Tour }) {
  const legacyRide = tour.completed && !tour.recording;
  const hasTrack = !legacyRide && tour.route.length > 1;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={tour.title} onPress={() => router.push(`/tour/${tour.id}`)} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <View style={styles.mapPreview}>
        {hasTrack ? <RideMap compact interactive={false} route={tour.recording ? undefined : tour.route} trackSegments={tour.recording?.segments} showUser={false} /> : (
          <View style={styles.noTrack}><Ionicons color={colors.muted} name="map-outline" size={26} /><Text style={styles.place}>{legacyRide ? 'GPS track unavailable for this older ride' : 'No GPS track recorded'}</Text></View>
        )}
        <View style={styles.mapBadge}>
          <Ionicons color={colors.white} name={tour.completed ? 'checkmark' : 'bookmark'} size={13} />
          <Text style={styles.mapBadgeText}>{tour.completed ? 'RIDDEN' : 'SAVED'}</Text>
        </View>
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardMeta}>{tour.date.toUpperCase()}</Text>
        <Text style={styles.cardTitle} numberOfLines={2}>{tour.title}</Text>
        <Text style={styles.place}>{tour.place}</Text>
        {!legacyRide ? <View style={styles.metrics}>
          <View style={styles.metric}><Ionicons color={colors.muted} name="navigate-outline" size={16} /><Text style={styles.metricText}>{tour.distanceKm} km</Text></View>
          <View style={styles.metric}><Ionicons color={colors.muted} name="time-outline" size={16} /><Text style={styles.metricText}>{tour.recording ? formatRidingTime(tour.recording.durationSeconds) : formatDuration(tour.durationMin)}</Text></View>
          {!tour.completed ? <View style={styles.metric}><Ionicons color={colors.muted} name="analytics-outline" size={16} /><Text style={styles.metricText}>{tour.curves}</Text></View> : null}
        </View> : null}
      </View>
    </Pressable>
  );
}

export default function ToursScreen() {
  const insets = useSafeAreaInsets();
  const { tours, ready } = useApp();
  const [collection, setCollection] = useState<'rides' | 'saved'>('rides');
  const visibleTours = toursForCollection(tours, collection);

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}><Text style={styles.title}>Tours</Text></View>
      <View accessibilityRole="tablist" style={styles.tabs}>
        {([{ id: 'rides', label: 'My Tours' }, { id: 'saved', label: 'Saved' }] as const).map((tab) => (
          <Pressable key={tab.id} accessibilityRole="tab" accessibilityState={{ selected: collection === tab.id }} onPress={() => setCollection(tab.id)} style={[styles.tab, collection === tab.id && styles.tabActive]}>
            <Text style={[styles.tabText, collection === tab.id && styles.tabTextActive]}>{tab.label}</Text>
            <Text style={[styles.count, collection === tab.id && styles.tabTextActive]}>{toursForCollection(tours, tab.id).length}</Text>
          </Pressable>
        ))}
      </View>
      {!ready ? <ActivityIndicator style={styles.loading} color={colors.route} accessibilityLabel="Loading tours" /> : (
        <FlatList
          key={collection}
          data={visibleTours}
          keyExtractor={(tour) => tour.id}
          renderItem={({ item }) => <TourCard tour={item} />}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={<View style={styles.empty}>
            <Ionicons color={colors.muted} name={collection === 'rides' ? 'navigate-outline' : 'bookmark-outline'} size={36} />
            <Text style={styles.emptyTitle}>{collection === 'rides' ? 'No rides yet' : 'No saved tours yet'}</Text>
          </View>}
          ListFooterComponent={<ActionButton icon={collection === 'rides' ? 'navigate' : 'add'} label={collection === 'rides' ? 'Start a ride' : 'Plan a tour'} onPress={() => router.navigate('/ride')} variant="primary" />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.ink, fontSize: 27, fontWeight: '900' },
  header: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  tabs: { flexDirection: 'row', backgroundColor: colors.panelAlt, borderRadius: 6, padding: 3, marginHorizontal: spacing.md, marginBottom: spacing.md },
  tab: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 4 },
  tabActive: { backgroundColor: colors.route },
  tabText: { color: colors.muted, fontSize: 15, fontWeight: '800' },
  tabTextActive: { color: colors.white },
  count: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  card: { backgroundColor: colors.panel, borderRadius: 7, overflow: 'hidden' },
  cardBody: { padding: spacing.md },
  cardMeta: { color: colors.muted, fontSize: 10, fontWeight: '800', marginBottom: 5 },
  cardTitle: { color: colors.ink, fontSize: 21, fontWeight: '900', lineHeight: 25 },
  content: { gap: spacing.md, paddingHorizontal: spacing.md, paddingBottom: 24 },
  mapBadge: { alignItems: 'center', backgroundColor: 'rgba(20,21,23,0.9)', borderRadius: 4, flexDirection: 'row', gap: 4, left: 10, paddingHorizontal: 8, paddingVertical: 5, position: 'absolute', top: 10 },
  mapBadgeText: { color: colors.white, fontSize: 10, fontWeight: '900' },
  mapPreview: { height: 160 },
  noTrack: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, gap: 8 },
  metric: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  metricText: { color: colors.ink, fontSize: 12, fontWeight: '700' },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, marginTop: spacing.md },
  place: { color: colors.muted, fontSize: 13, marginTop: 4 },
  pressed: { opacity: 0.78 },
  screen: { backgroundColor: colors.canvas, flex: 1 },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 48 },
  emptyTitle: { color: colors.ink, fontSize: 18, fontWeight: '700' },
  loading: { marginTop: 48 },
});
