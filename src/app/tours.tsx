import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RideMap } from '@/components/RideMap';
import { ActionButton } from '@/components/ui';
import { useApp } from '@/state/AppProvider';
import { RouteColor, Tour } from '@/types';
import { colors, radii, spacing, typography } from '@/theme';
import { formatDuration } from '@/utils/routes';
import { formatRidingTime, toursForCollection } from '@/utils/recording';

function TourCard({ tour, routeColor }: { tour: Tour; routeColor?: RouteColor }) {
  const legacyRide = tour.completed && !tour.recording;
  const hasTrack = !legacyRide && tour.route.length > 1;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={tour.title} onPress={() => router.push(`/tour/${tour.id}`)} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <View style={styles.mapPreview}>
        {hasTrack ? <RideMap routeColor={routeColor} compact interactive={false} route={tour.recording ? undefined : tour.route} trackSegments={tour.recording?.segments} showUser={false} /> : (
          <View style={styles.noTrack}><Ionicons color={colors.muted} name="map-outline" size={26} /><Text style={styles.place}>{legacyRide ? 'GPS track unavailable for this older ride' : 'No GPS track recorded'}</Text></View>
        )}
        <View style={styles.mapBadge}>
          <Ionicons color={colors.white} name={tour.completed ? 'checkmark' : 'bookmark'} size={13} />
          <Text style={styles.mapBadgeText}>{tour.completed ? 'Ridden' : 'Saved'}</Text>
        </View>
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardMeta}>{tour.date}</Text>
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
  const { fontScale } = useWindowDimensions();
  const { tours, ready, settings } = useApp();
  const [collection, setCollection] = useState<'rides' | 'saved'>('rides');
  const visibleTours = toursForCollection(tours, collection);

  return (
    <View key={fontScale} style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <View style={styles.headerCopy}><Text accessibilityRole="header" style={styles.title}>Tours</Text><Text style={styles.subtitle}>Your roads, saved and ridden.</Text></View>
        <ActionButton compact icon="add" label="Plan a tour" onPress={() => router.navigate('/ride')} variant="primary" />
      </View>
      <View accessibilityRole="tablist" style={styles.tabs}>
        {([{ id: 'rides', label: 'My tours' }, { id: 'saved', label: 'Saved' }] as const).map((tab) => (
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
          renderItem={({ item }) => <TourCard tour={item} routeColor={settings.routeColor} />}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={<View style={styles.empty}>
            <Text style={styles.emptyTitle}>{collection === 'rides' ? 'Your next ride starts here' : 'Keep a route for later'}</Text>
            <Text style={styles.emptyCopy}>{collection === 'rides' ? 'Record a ride from the map. Your GPS trail, distance and riding time will be here when you finish.' : 'Plan a route, then tap the bookmark to add it to your saved tours.'}</Text>
          </View>}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.ink, ...typography.title },
  header: { paddingHorizontal: spacing.lg, paddingTop: 8, paddingBottom: spacing.lg, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 16 },
  headerCopy: { flex: 1, minWidth: 160 },
  subtitle: { color: colors.muted, ...typography.caption, marginTop: 5 },
  tabs: { flexDirection: 'row', backgroundColor: colors.panel, borderRadius: radii.sm, padding: 4, marginHorizontal: spacing.lg, marginBottom: spacing.lg },
  tab: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 7 },
  tabActive: { backgroundColor: colors.panelAlt },
  tabText: { color: colors.muted, fontSize: 15, fontWeight: '600' },
  tabTextActive: { color: colors.white },
  count: { color: colors.muted, fontSize: 14, fontWeight: '500', fontVariant: ['tabular-nums'] },
  card: { backgroundColor: colors.panel, borderRadius: radii.md, overflow: 'hidden' },
  cardBody: { padding: spacing.lg },
  cardMeta: { color: colors.muted, fontSize: 13, fontWeight: '400', marginBottom: 7 },
  cardTitle: { color: colors.ink, fontSize: 21, fontWeight: '600', lineHeight: 27, letterSpacing: -0.3 },
  content: { gap: spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: 24 },
  mapBadge: { alignItems: 'center', backgroundColor: 'rgba(20,21,23,0.9)', borderRadius: 4, flexDirection: 'row', gap: 4, left: 10, paddingHorizontal: 8, paddingVertical: 5, position: 'absolute', top: 10 },
  mapBadgeText: { color: colors.white, fontSize: 12, fontWeight: '600' },
  mapPreview: { height: 150 },
  noTrack: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, gap: 8 },
  metric: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  metricText: { color: colors.ink, fontSize: 14, fontWeight: '500', fontVariant: ['tabular-nums'] },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, marginTop: spacing.md },
  place: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 5 },
  pressed: { opacity: 0.8, transform: [{ scale: 0.99 }] },
  screen: { backgroundColor: colors.canvas, flex: 1 },
  empty: { gap: 12, paddingVertical: 40 },
  emptyCopy: { color: colors.muted, ...typography.body, maxWidth: 360 },
  emptyTitle: { color: colors.ink, fontSize: 18, fontWeight: '700' },
  loading: { marginTop: 48 },
});
