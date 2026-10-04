import Ionicons from '@expo/vector-icons/Ionicons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { router, useLocalSearchParams } from 'expo-router';
import { Alert, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RideMap } from '@/components/RideMap';
import { ActionButton, IconButton } from '@/components/ui';
import { useApp } from '@/state/AppProvider';
import { colors, spacing } from '@/theme';
import { distanceBetween, formatDuration, toGpx } from '@/utils/routes';
import { formatRidingTime } from '@/utils/recording';
import { displaySpeed } from '@/utils/speed';

export default function TourDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { tours, toggleSaved, setActiveRoute, settings } = useApp();
  const tour = tours.find((item) => item.id === id);

  if (!tour) {
    return <View style={styles.empty}><Text style={styles.title}>Tour not found</Text><ActionButton label="Back to tours" onPress={() => router.back()} /></View>;
  }

  const legacyRide = tour.completed && !tour.recording;
  const hasTrack = !legacyRide && tour.route.length > 1;
  const averageSpeed = displaySpeed(tour.durationMin > 0 ? tour.distanceKm / (tour.durationMin / 60) : 0, settings.speedUnit);

  const exportGpx = async () => {
    try {
      if (!FileSystem.cacheDirectory) throw new Error('Temporary storage is not available.');
      const safeName = tour.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const uri = `${FileSystem.cacheDirectory}${safeName || 'bendbound-tour'}.gpx`;
      await FileSystem.writeAsStringAsync(uri, toGpx(tour));
      if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
      await Sharing.shareAsync(uri, { mimeType: 'application/gpx+xml', dialogTitle: `Export ${tour.title}` });
    } catch (error) {
      Alert.alert('Export failed', error instanceof Error ? error.message : 'The GPX file could not be shared.');
    }
  };

  const openOnMap = () => {
    setActiveRoute({
      title: tour.title,
      route: tour.route,
      distanceKm: tour.distanceKm,
      durationMin: tour.durationMin,
      curves: tour.curves,
      profile: 'winding',
      maneuvers: tour.maneuvers,
    });
    router.navigate('/ride');
  };

  const openInWaze = () => {
    const start = tour.route[0];
    const destination = tour.route[tour.route.length - 1];

    if (!start || !destination) {
      Alert.alert('Route unavailable', 'This tour does not have a destination to send to Waze.');
      return;
    }

    const isLoop = distanceBetween(start, destination) < 0.2;
    const detail = isLoop
      ? 'This is a loop, so its destination is also its start. Waze will navigate there directly and cannot preserve the loop. Export GPX to keep the complete route.'
      : 'Waze will navigate to the tour destination but will calculate its own route, so it may differ from the route shown in Bendbound.';

    Alert.alert('Open destination in Waze?', detail, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Open Waze',
        onPress: () => {
          const coordinates = encodeURIComponent(`${destination.latitude},${destination.longitude}`);
          void Linking.openURL(`https://waze.com/ul?ll=${coordinates}&navigate=yes&utm_source=bendbound`).catch(() => {
            Alert.alert('Could not open Waze', 'Install Waze or try again when you have a network connection.');
          });
        },
      },
    ]);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.map}>
        {hasTrack ? <RideMap interactive route={tour.recording ? undefined : tour.route} trackSegments={tour.recording?.segments} showUser={false} /> : (
          <View style={styles.empty}><Ionicons color={colors.muted} name="map-outline" size={32} /><Text style={styles.notice}>{legacyRide ? 'GPS track unavailable for this older ride' : 'No GPS track recorded'}</Text></View>
        )}
        <View style={[styles.topBar, { top: insets.top + 8 }]}>
          <IconButton icon="chevron-back" label="Back" onPress={() => router.back()} />
          <View style={styles.topSpacer} />
          {hasTrack ? <IconButton icon="share-outline" label="Export GPX" onPress={exportGpx} /> : null}
          <IconButton active={tour.saved} icon={tour.saved ? 'bookmark' : 'bookmark-outline'} label={tour.saved ? 'Remove from Saved' : 'Save for later'} onPress={() => toggleSaved(tour.id)} />
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.date}>{tour.date.toUpperCase()} / BY {tour.author.toUpperCase()}</Text>
        <Text style={styles.title}>{tour.title}</Text>
        <Text style={styles.place}><Ionicons color={colors.muted} name="location-outline" size={14} /> {tour.place}</Text>

        {!legacyRide ? <View style={styles.metrics}>
          <View style={styles.metric}><Text style={styles.metricValue}>{tour.distanceKm}</Text><Text style={styles.metricLabel}>KILOMETRES</Text></View>
          <View style={styles.metric}><Text style={styles.metricValue}>{tour.recording ? formatRidingTime(tour.recording.durationSeconds) : formatDuration(tour.durationMin)}</Text><Text style={styles.metricLabel}>{tour.recording ? 'RIDING TIME' : 'ESTIMATED TIME'}</Text></View>
          {!tour.completed ? <View style={styles.metric}><Text style={styles.metricValue}>{tour.curves}</Text><Text style={styles.metricLabel}>CURVES</Text></View> : null}
        </View> : null}

        <ActionButton disabled={!hasTrack} icon="navigate" label="View on map & navigate" onPress={openOnMap} variant="success" />
        <View style={styles.wazeAction}>
          <ActionButton disabled={!hasTrack} icon="car-sport-outline" label="Open destination in Waze" onPress={openInWaze} />
        </View>

        {!legacyRide ? <><Text style={styles.sectionTitle}>{tour.completed ? 'Ride analysis' : 'Route estimates'}</Text>
        <View style={styles.analysis}>
          {tour.recording ? <>
            <View style={styles.analysisRow}><Text style={styles.analysisLabel}>Started</Text><Text style={styles.analysisValue}>{new Date(tour.recording.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text></View>
            <View style={styles.analysisRow}><Text style={styles.analysisLabel}>Finished</Text><Text style={styles.analysisValue}>{new Date(tour.recording.endedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text></View>
          </> : <>
          <View style={styles.analysisRow}><Ionicons color={colors.action} name="trending-up" size={21} /><Text style={styles.analysisLabel}>Elevation gain</Text><Text style={styles.analysisValue}>{tour.elevationM.toLocaleString()} m</Text></View>
          <View style={styles.analysisRow}><Ionicons color={colors.route} name="git-branch-outline" size={21} /><Text style={styles.analysisLabel}>Curvy roads</Text><Text style={styles.analysisValue}>{tour.distanceKm > 0 ? Math.min(98, Math.round((tour.curves / tour.distanceKm) * 100)) : 0}%</Text></View>
          </>}
          <View style={styles.analysisRow}><Ionicons color={colors.warning} name="speedometer-outline" size={21} /><Text style={styles.analysisLabel}>Average speed</Text><Text style={styles.analysisValue}>{averageSpeed} {settings.speedUnit}</Text></View>
        </View></> : null}

        <View style={styles.actions}>
          <View style={styles.flex}><ActionButton disabled={!hasTrack} icon="download-outline" label="Export GPX" onPress={exportGpx} /></View>
          <View style={styles.flex}><ActionButton icon="people-outline" label="Group ride" onPress={() => Alert.alert('Group ride ready', 'Invite link created for this tour.')} /></View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  analysis: { backgroundColor: colors.panel, borderRadius: 7, paddingHorizontal: spacing.md },
  analysisLabel: { color: colors.muted, flex: 1, fontSize: 14, marginLeft: 10 },
  analysisRow: { alignItems: 'center', borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 54 },
  analysisValue: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  content: { padding: spacing.md, paddingBottom: 110 },
  date: { color: colors.muted, fontSize: 10, fontWeight: '800' },
  empty: { alignItems: 'center', backgroundColor: colors.canvas, flex: 1, gap: 20, justifyContent: 'center', padding: 30 },
  notice: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  flex: { flex: 1 },
  map: { height: 330 },
  metric: { flex: 1 },
  metricLabel: { color: colors.muted, fontSize: 9, fontWeight: '800', marginTop: 3 },
  metricValue: { color: colors.ink, fontSize: 18, fontWeight: '900' },
  metrics: { flexDirection: 'row', marginBottom: 22, marginTop: 22 },
  place: { color: colors.muted, fontSize: 13, marginTop: 6 },
  screen: { backgroundColor: colors.canvas, flex: 1 },
  sectionTitle: { color: colors.ink, fontSize: 20, fontWeight: '900', marginBottom: 10, marginTop: 24 },
  title: { color: colors.ink, fontSize: 31, fontWeight: '900', lineHeight: 35, marginTop: 5 },
  topBar: { flexDirection: 'row', gap: 8, left: 10, position: 'absolute', right: 10 },
  topSpacer: { flex: 1 },
  wazeAction: { marginTop: spacing.sm },
});
