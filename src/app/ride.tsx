import Ionicons from '@expo/vector-icons/Ionicons';
import Slider from '@react-native-community/slider';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { Tabs } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Keyboard, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MapType, Region } from 'react-native-maps';
import { RideMap } from '@/components/RideMap';
import { DriveOverlay } from '@/components/DriveOverlay';
import { DestinationSearch } from '@/components/DestinationSearch';
import { ActionButton, IconButton, Sheet, Stat, ToggleRow } from '@/components/ui';
import { defaultCenter, nearbyPlaces } from '@/data/seed';
import { useApp } from '@/state/AppProvider';
import { Coordinate, DraftRoute, PointOfInterest, PoiCategory, RoutingProfile, TrackPoint } from '@/types';
import { colors, spacing, tabBarStyle } from '@/theme';
import { upcomingManeuver } from '@/utils/guidance';
import { bearingBetween, closestRoutePoint, cumulativeRouteDistances, fetchRoadContext, RoadContext } from '@/utils/navigation';
import { buildPointToPoint, buildRoundTrip, distanceBetween, formatDuration, pointAtBearing, repeatedRoadRatio, snapDraftToRoads, tourFromDraft } from '@/utils/routes';
import { appendRecordingFix, formatRidingTime, pauseRecording, recordedDistance, recordingSeconds, RecordingSession, resumeRecording, startRecording, tourFromRecording } from '@/utils/recording';
import { fetchNearbyPois, fetchScenicPois } from '@/utils/pois';
import type { PlaceSuggestion } from '@/utils/places';

type Mode = 'home' | 'round' | 'preview' | 'navigation' | 'recording';
const directions = [
  { label: 'N', value: 0 },
  { label: 'E', value: 90 },
  { label: 'S', value: 180 },
  { label: 'W', value: 270 },
];

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const { activeRoute, setActiveRoute, saveTour, settings, updateSettings } = useApp();
  const [mode, setMode] = useState<Mode>(activeRoute ? 'preview' : 'home');
  const [location, setLocation] = useState<Coordinate>(defaultCenter);
  const [search, setSearch] = useState('');
  const [searchExpanded, setSearchExpanded] = useState(false);
  const planningSearch = useRef(false);
  const profile = settings.routingProfile ?? 'winding';
  const setProfile = (routingProfile: RoutingProfile) => updateSettings({ routingProfile });
  const [roundDistance, setRoundDistance] = useState(160);
  const [direction, setDirection] = useState(0);
  const [busy, setBusy] = useState(false);
  const [trackSegments, setTrackSegments] = useState<TrackPoint[][]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [clockTime, setClockTime] = useState(0);
  const [paused, setPaused] = useState(false);
  const [mapType, setMapType] = useState<MapType>('standard');
  const [selectedPoi, setSelectedPoi] = useState<PoiCategory | null>(null);
  const [pois, setPois] = useState<PointOfInterest[]>([]);
  const [poiLoading, setPoiLoading] = useState(false);
  const [mapCenter, setMapCenter] = useState<Coordinate>(defaultCenter);
  const [liveSpeedKph, setLiveSpeedKph] = useState(0);
  const [liveHeading, setLiveHeading] = useState(0);
  const [cameraHeading, setCameraHeading] = useState(0);
  const [mapFollowing, setMapFollowing] = useState(true);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [lastFixAt, setLastFixAt] = useState(0);
  const [routeIndex, setRouteIndex] = useState(0);
  const [distanceFromRouteKm, setDistanceFromRouteKm] = useState(0);
  const [roadContext, setRoadContext] = useState<RoadContext>({ name: null, speedLimitKph: null, roadClass: null });
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const headingWatchRef = useRef<Location.LocationSubscription | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingRef = useRef<RecordingSession | null>(null);
  const sensorGeneration = useRef(0);
  const startingRide = useRef(false);
  const progressRef = useRef(-1);
  const headingRef = useRef(0);
  const lastPositionRef = useRef<Coordinate | null>(null);
  const roadLookupRef = useRef<{ at: number; location: Coordinate | null; busy: boolean }>({ at: 0, location: null, busy: false });
  const visibleMode: Mode = activeRoute && mode === 'home' ? 'preview' : mode;
  const driving = visibleMode === 'navigation' || visibleMode === 'recording';
  const poiRegionKey = `${mapCenter.latitude.toFixed(2)},${mapCenter.longitude.toFixed(2)}`;
  const routeDistances = useMemo(() => cumulativeRouteDistances(activeRoute?.route ?? []), [activeRoute?.route]);
  const totalRouteKm = routeDistances[routeDistances.length - 1] ?? 0;
  const travelledRouteKm = routeDistances[Math.min(routeIndex, Math.max(0, routeDistances.length - 1))] ?? 0;
  const remainingRouteKm = Math.max(0, totalRouteKm - travelledRouteKm);
  const nextManeuver = upcomingManeuver(activeRoute?.maneuvers ?? [], routeIndex);
  const maneuverTargetIndex = Math.min(nextManeuver?.beginShapeIndex ?? routeIndex, Math.max(0, routeDistances.length - 1));
  const maneuverDistanceKm = Math.max(0, (routeDistances[maneuverTargetIndex] ?? travelledRouteKm) - travelledRouteKm);
  const remainingMinutes = totalRouteKm > 0 ? Math.round((activeRoute?.durationMin ?? 0) * remainingRouteKm / totalRouteKm) : 0;
  const arrivalAt = new Date(clockTime + remainingMinutes * 60000);
  const offRoute = visibleMode === 'navigation' && distanceFromRouteKm > 0.15;
  const displayedSpeedLimit = settings.speedLimits ? roadContext.speedLimitKph : null;
  const gpsReady = lastFixAt > 0 && clockTime - lastFixAt < 10000 && gpsAccuracy != null && gpsAccuracy >= 0 && gpsAccuracy <= 50;

  useEffect(() => {
    const generation = sensorGeneration;
    Location.getLastKnownPositionAsync({ maxAge: 300000 })
      .then((last) => last && setLocation({ latitude: last.coords.latitude, longitude: last.coords.longitude }))
      .catch(() => undefined);
    return () => {
      generation.current++;
      recordingRef.current = null;
      watchRef.current?.remove();
      headingWatchRef.current?.remove();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!selectedPoi) return;
    let cancelled = false;
    const [latitude, longitude] = poiRegionKey.split(',').map(Number);
    const timer = setTimeout(() => {
      setPoiLoading(true);
      fetchNearbyPois(selectedPoi, { latitude, longitude })
        .then((results) => { if (!cancelled) setPois(results); })
        .catch(() => { if (!cancelled) setPois([]); })
        .finally(() => { if (!cancelled) setPoiLoading(false); });
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [poiRegionKey, selectedPoi]);

  const stopTracking = () => {
    sensorGeneration.current++;
    watchRef.current?.remove();
    watchRef.current = null;
    headingWatchRef.current?.remove();
    headingWatchRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const refreshRoadContext = (point: Coordinate, heading: number, force = false) => {
    const lookup = roadLookupRef.current;
    const now = Date.now();
    const movedKm = lookup.location ? distanceBetween(lookup.location, point) : Number.POSITIVE_INFINITY;
    if (lookup.busy || (!force && (now - lookup.at < 8000 || movedKm < 0.04))) return;
    roadLookupRef.current = { at: now, location: point, busy: true };
    fetchRoadContext(point, heading)
      .then(setRoadContext)
      .catch(() => undefined)
      .finally(() => { roadLookupRef.current.busy = false; });
  };

  const handleTrackedPosition = (next: Location.LocationObject, trackingMode: 'navigation' | 'recording') => {
    if (!recordingRef.current || recordingRef.current.activeSince == null) return;
    const point = { latitude: next.coords.latitude, longitude: next.coords.longitude };
    const updated = appendRecordingFix(recordingRef.current, { ...point, timestamp: next.timestamp, accuracy: next.coords.accuracy ?? -1 }, Date.now());
    if (updated !== recordingRef.current) {
      recordingRef.current = updated;
      setTrackSegments(updated.segments);
    }
    const gpsHeading = next.coords.heading != null && next.coords.heading >= 0 ? next.coords.heading : null;
    const movedEnough = lastPositionRef.current && distanceBetween(lastPositionRef.current, point) > 0.005;
    const calculatedHeading = movedEnough && lastPositionRef.current ? bearingBetween(lastPositionRef.current, point) : headingRef.current;
    const nextHeading = gpsHeading ?? calculatedHeading;
    headingRef.current = nextHeading;
    lastPositionRef.current = point;
    setLocation(point);
    setLiveHeading(nextHeading);
    setCameraHeading(nextHeading);
    setLiveSpeedKph(Math.max(0, Math.round((next.coords.speed ?? 0) * 3.6)));
    setGpsAccuracy(next.coords.accuracy);
    setLastFixAt(next.timestamp);

    if (trackingMode === 'navigation' && activeRoute?.route.length) {
      const match = closestRoutePoint(activeRoute.route, point, progressRef.current);
      progressRef.current = Math.max(progressRef.current, match.index);
      setRouteIndex(progressRef.current);
      setDistanceFromRouteKm(match.distanceKm);
    }
    refreshRoadContext(point, nextHeading);
  };

  const startSensors = async (trackingMode: 'navigation' | 'recording') => {
    const generation = ++sensorGeneration.current;
    const subscription = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 3, timeInterval: 1000 },
      (next) => { if (generation === sensorGeneration.current) handleTrackedPosition(next, trackingMode); },
    );
    if (generation !== sensorGeneration.current) { subscription.remove(); return; }
    watchRef.current = subscription;
    Location.watchHeadingAsync((next) => {
      if (generation !== sensorGeneration.current) return;
      const heading = next.trueHeading >= 0 ? next.trueHeading : next.magHeading;
      headingRef.current = heading;
      setLiveHeading(heading);
    }).then((headingSubscription) => {
      if (generation !== sensorGeneration.current) headingSubscription.remove();
      else headingWatchRef.current = headingSubscription;
    }).catch(() => undefined);
  };

  const startClock = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const now = Date.now();
      if (recordingRef.current) setElapsed(recordingSeconds(recordingRef.current, now));
      setClockTime(now);
    }, 1000);
  };

  const getCurrentLocation = async () => {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) throw new Error('Location permission is needed to plan from your position.');
    const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    const point = { latitude: current.coords.latitude, longitude: current.coords.longitude };
    setLocation(point);
    setMapCenter(point);
    return point;
  };

  const locate = async () => {
    try {
      setBusy(true);
      await getCurrentLocation();
      await Haptics.selectionAsync();
    } catch (error) {
      Alert.alert('Location unavailable', error instanceof Error ? error.message : 'Check location services and try again.');
    } finally {
      setBusy(false);
    }
  };

  const planSearch = async (place: PlaceSuggestion) => {
    if (planningSearch.current) return;
    planningSearch.current = true;
    Keyboard.dismiss();
    setBusy(true);
    try {
      const start = await getCurrentLocation().catch(() => location);
      const destination = { latitude: place.latitude, longitude: place.longitude };
      const draft = await snapDraftToRoads(
        buildPointToPoint(start, destination, profile, place.name),
        { avoidMotorways: settings.avoidMotorways },
      );
      setActiveRoute(draft);
      setSearch(place.name);
      setSearchExpanded(false);
      setMode('preview');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert('Could not create route', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      planningSearch.current = false;
      setBusy(false);
    }
  };

  const createRoundTrip = async () => {
    setBusy(true);
    try {
      const start = await getCurrentLocation().catch(() => location);
      const searchCenter = pointAtBearing(start, roundDistance / 6, direction);
      const scenicPois = await fetchScenicPois(searchCenter, Math.min(35, Math.max(10, roundDistance / 4))).catch(() => []);
      const draft = buildRoundTrip(start, roundDistance, direction, profile, scenicPois);
      const routingOptions = { avoidMotorways: settings.avoidMotorways, heading: direction };
      let routed = await snapDraftToRoads(draft, routingOptions);
      if (repeatedRoadRatio(routed.route) > 0.04) {
        try {
          const alternative = await snapDraftToRoads(buildRoundTrip(start, roundDistance, direction, profile, scenicPois, 1), routingOptions);
          const score = (candidate: DraftRoute) => repeatedRoadRatio(candidate.route) * 5 + Math.abs(candidate.distanceKm - roundDistance) / roundDistance;
          if (score(alternative) < score(routed)) routed = alternative;
        } catch {
          // The first route is still valid if the wider alternative cannot be calculated.
        }
      }
      setActiveRoute({ ...routed, title: `${routed.distanceKm} km round trip` });
      setMode('preview');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert('Could not create round trip', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const planFromMap = async (destination: Coordinate) => {
    if (visibleMode !== 'home' || searchExpanded || busy) return;
    setBusy(true);
    try {
      setActiveRoute(await snapDraftToRoads(
        buildPointToPoint(location, destination, profile, 'Dropped pin'),
        { avoidMotorways: settings.avoidMotorways },
      ));
      setMode('preview');
      await Haptics.selectionAsync();
    } catch (error) {
      Alert.alert('Could not create route', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const beginTracking = async (nextMode: 'navigation' | 'recording') => {
    if (startingRide.current || recordingRef.current) return;
    startingRide.current = true;
    try {
      const start = await getCurrentLocation();
      recordingRef.current = startRecording(Date.now());
      setTrackSegments([]);
      setElapsed(0);
      setClockTime(Date.now());
      setPaused(false);
      setLiveSpeedKph(0);
      setGpsAccuracy(null);
      setLastFixAt(0);
      setRouteIndex(0);
      setDistanceFromRouteKm(0);
      setRoadContext({ name: null, speedLimitKph: null, roadClass: null });
      progressRef.current = -1;
      lastPositionRef.current = start;
      roadLookupRef.current = { at: 0, location: null, busy: false };
      const initialHeading = activeRoute?.route[1] ? bearingBetween(start, activeRoute.route[1]) : headingRef.current;
      headingRef.current = initialHeading;
      setLiveHeading(initialHeading);
      setCameraHeading(initialHeading);
      setMapFollowing(true);
      setMode(nextMode);
      refreshRoadContext(start, initialHeading, true);
      await startSensors(nextMode);
      if (recordingRef.current?.activeSince != null) startClock();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (error) {
      stopTracking();
      recordingRef.current = null;
      setMode('home');
      Alert.alert('Ride could not start', error instanceof Error ? error.message : 'Check location services.');
    } finally {
      startingRide.current = false;
    }
  };

  const togglePause = async () => {
    const session = recordingRef.current;
    if (!session) return;
    if (session.activeSince != null) {
      recordingRef.current = pauseRecording(session, Date.now());
      setElapsed(recordingSeconds(recordingRef.current, Date.now()));
      setPaused(true);
      stopTracking();
    } else {
      recordingRef.current = resumeRecording(session, Date.now());
      setPaused(false);
      try {
        await startSensors(mode === 'navigation' ? 'navigation' : 'recording');
        if (recordingRef.current?.activeSince != null) startClock();
      } catch (error) {
        stopTracking();
        if (recordingRef.current) recordingRef.current = pauseRecording(recordingRef.current, Date.now());
        setPaused(true);
        Alert.alert('Could not resume ride', error instanceof Error ? error.message : 'Check location services.');
      }
    }
  };

  const finishRide = () => {
    const session = recordingRef.current;
    if (!session) return;
    stopTracking();
    const tour = tourFromRecording(session, Date.now(), mode === 'navigation' ? activeRoute?.title : undefined);
    saveTour(tour);
    recordingRef.current = null;
    setActiveRoute(null);
    setTrackSegments([]);
    setMode('home');
    Alert.alert('Ride saved', `${tour.title} is now in My Tours.${tour.route.length < 2 ? ' No usable GPS track was recorded.' : ''}`);
  };

  const reset = () => {
    stopTracking();
    recordingRef.current = null;
    setActiveRoute(null);
    setTrackSegments([]);
    setMode('home');
  };

  const elapsedLabel = formatRidingTime(elapsed);

  const updateMapCenter = (region: Region) => {
    setMapCenter({ latitude: region.latitude, longitude: region.longitude });
  };

  return (
    <View style={styles.screen}>
      <Tabs.Screen options={{ tabBarStyle: driving || (visibleMode === 'home' && searchExpanded) ? { display: 'none' } : tabBarStyle }} />
      <RideMap
        bottomInset={driving ? 82 + insets.bottom : visibleMode === 'home' ? 390 : visibleMode === 'round' ? 420 : 205}
        followHeading={cameraHeading}
        followLocation={driving ? location : undefined}
        followSpeedKph={liveSpeedKph}
        mapType={mapType}
        motorcycleType={settings.motorcycleType}
        navigationMode={driving}
        following={mapFollowing}
        onFollowChange={setMapFollowing}
        onLongPress={planFromMap}
        onRegionChange={updateMapCenter}
        pois={pois}
        route={activeRoute?.route}
        trackSegments={trackSegments}
      />

      {((visibleMode === 'home' && !searchExpanded) || visibleMode === 'round' || visibleMode === 'preview') ? (
        <View style={[styles.mapControls, { top: insets.top + 10 }]}>
          {visibleMode !== 'home' ? <IconButton icon="close" label="Close route" onPress={reset} /> : null}
          <View style={styles.controlSpacer} />
          <IconButton icon="locate" label="Use my location" onPress={locate} />
          <IconButton active={mapType !== 'standard'} icon="layers-outline" label="Map layers" onPress={() => setMapType((value) => value === 'standard' ? 'hybrid' : 'standard')} />
        </View>
      ) : null}

      {visibleMode === 'home' ? (
        <DestinationSearch query={search} onChangeQuery={setSearch} expanded={searchExpanded} onExpandedChange={setSearchExpanded}
          center={mapCenter} busy={busy} onSelect={planSearch}>
          <ScrollView contentContainerStyle={styles.poiRow} horizontal showsHorizontalScrollIndicator={false}>
            {nearbyPlaces.map((place) => (
              <Pressable
                key={place.id}
                onPress={() => {
                  const next = selectedPoi === place.id ? null : place.id;
                  setSelectedPoi(next);
                  if (!next) setPois([]);
                }}
                style={[styles.poiChip, selectedPoi === place.id && styles.poiChipActive]}
              >
                <Ionicons color={colors.ink} name={place.icon} size={17} />
                <Text style={styles.poiText}>{place.label} {selectedPoi === place.id ? poiLoading ? '...' : `(${pois.length})` : ''}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <ToggleRow icon="trail-sign-outline" label="Avoid motorways" value={settings.avoidMotorways} onPress={() => updateSettings({ avoidMotorways: !settings.avoidMotorways })} />
          <View style={styles.actionRow}>
            <View style={styles.flex}><ActionButton icon="git-compare-outline" label="New route" loading={busy} onPress={() => setSearchExpanded(true)} variant="primary" /></View>
            <View style={styles.flex}><ActionButton icon="sync-outline" label="Round trip" onPress={() => setMode('round')} variant="primary" /></View>
          </View>
          <View style={styles.recordRow}>
            <View>
              <Text style={styles.recordTitle}>Just ride</Text>
              <Text style={styles.recordMeta}>Track distance, time and your GPS trail</Text>
            </View>
            <IconButton icon="radio-button-on" label="Record a ride" onPress={() => beginTracking('recording')} active />
          </View>
          <Text style={styles.hint}>Tip: long-press anywhere on the map to set a destination.</Text>
        </DestinationSearch>
      ) : null}

      {visibleMode === 'round' ? (
        <Sheet>
          <Text style={styles.sheetEyebrow}>CREATE A ROUND TRIP</Text>
          <Text style={styles.distance}>{Math.round(roundDistance)} km</Text>
          <Slider
            maximumTrackTintColor={colors.panelAlt}
            maximumValue={400}
            minimumTrackTintColor={colors.route}
            minimumValue={40}
            onValueChange={setRoundDistance}
            step={10}
            thumbTintColor={colors.white}
            value={roundDistance}
          />
          <View style={styles.formRow}>
            <Text style={styles.formLabel}>Route</Text>
            <View style={styles.segmented}>
              {(['fast', 'winding', 'twisty'] as RoutingProfile[]).map((item) => (
                <Pressable key={item} onPress={() => setProfile(item)} style={[styles.segment, profile === item && styles.segmentActive]}>
                  <Text style={[styles.segmentText, profile === item && styles.segmentTextActive]}>{item}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={styles.formRow}>
            <Text style={styles.formLabel}>Heading</Text>
            <View style={styles.directionRow}>
              {directions.map((item) => (
                <Pressable key={item.label} onPress={() => setDirection(item.value)} style={[styles.direction, direction === item.value && styles.directionActive]}>
                  <Text style={styles.directionText}>{item.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <ToggleRow icon="trail-sign-outline" label="Avoid motorways" value={settings.avoidMotorways} onPress={() => updateSettings({ avoidMotorways: !settings.avoidMotorways })} />
          <View style={styles.actionRow}>
            <View style={styles.flex}><ActionButton label="Cancel" onPress={() => setMode('home')} /></View>
            <View style={styles.flex}><ActionButton icon="sparkles-outline" label="Create route" loading={busy} onPress={createRoundTrip} variant="danger" /></View>
          </View>
        </Sheet>
      ) : null}

      {visibleMode === 'preview' && activeRoute ? (
        <Sheet>
          <Text style={styles.routeTitle} numberOfLines={1}>{activeRoute.title}</Text>
          <View style={styles.statsRow}>
            <Stat label="Distance" value={`${activeRoute.distanceKm} km`} />
            <Stat label="Time" value={formatDuration(activeRoute.durationMin)} />
            <Stat label="Curves" value={`${activeRoute.curves}`} />
          </View>
          <View style={styles.actionRow}>
            <IconButton icon="bookmark-outline" label="Save tour" onPress={() => { saveTour(tourFromDraft(activeRoute)); Alert.alert('Saved', 'The route was added to Saved.'); }} />
            <View style={styles.flex}><ActionButton icon="navigate" label="Start navigation" onPress={() => beginTracking('navigation')} variant="success" /></View>
          </View>
        </Sheet>
      ) : null}

      {driving ? (
        <DriveOverlay
          following={mapFollowing}
          onRecenter={() => setMapFollowing(true)}
          navigating={visibleMode === 'navigation'}
          paused={paused}
          gpsReady={gpsReady}
          gpsAccuracy={gpsAccuracy}
          offRoute={offRoute}
          maneuver={nextManeuver}
          maneuverDistanceKm={maneuverDistanceKm}
          remainingKm={remainingRouteKm}
          arrival={arrivalAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          elapsed={elapsedLabel}
          riddenKm={recordedDistance(trackSegments)}
          speedKph={liveSpeedKph}
          speedUnit={settings.speedUnit}
          speedLimitKph={gpsReady && !paused ? displayedSpeedLimit : null}
          showSpeedLimit={settings.speedLimits}
          heading={liveHeading}
          roadName={roadContext.name}
          voiceEnabled={settings.voiceGuidance}
          onToggleVoice={() => updateSettings({ voiceGuidance: !settings.voiceGuidance })}
          onTogglePause={togglePause}
          onFinish={() => Alert.alert('Finish ride?', 'Save this ride to My tours.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Finish & save', onPress: finishRide },
          ])}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  actionRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  controlSpacer: { flex: 1 },
  direction: { alignItems: 'center', backgroundColor: colors.panelAlt, borderRadius: 19, height: 38, justifyContent: 'center', width: 38 },
  directionActive: { backgroundColor: colors.route },
  directionRow: { flexDirection: 'row', gap: 7 },
  directionText: { color: colors.white, fontSize: 13, fontWeight: '900' },
  distance: { color: colors.white, fontSize: 42, fontWeight: '900', textAlign: 'center' },
  flex: { flex: 1 },
  formLabel: { color: colors.muted, fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  formRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.md },
  hint: { color: '#777b81', fontSize: 11, marginTop: spacing.sm, textAlign: 'center' },
  mapControls: { flexDirection: 'row', gap: 8, left: 10, position: 'absolute', right: 10 },
  poiChip: { alignItems: 'center', backgroundColor: colors.panelAlt, borderRadius: 5, flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingVertical: 9 },
  poiChipActive: { backgroundColor: '#3e4147' },
  poiRow: { gap: 8, paddingRight: 16 },
  poiText: { color: colors.ink, fontSize: 12, fontWeight: '700' },
  recordMeta: { color: colors.muted, fontSize: 11, marginTop: 2 },
  recordRow: { alignItems: 'center', borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', marginTop: 14, paddingTop: 12 },
  recordTitle: { color: colors.ink, fontSize: 16, fontWeight: '900' },
  routeTitle: { color: colors.white, fontSize: 22, fontWeight: '900', marginBottom: 14 },
  screen: { backgroundColor: '#dfe4d9', flex: 1 },
  segment: { borderRadius: 4, paddingHorizontal: 10, paddingVertical: 8 },
  segmentActive: { backgroundColor: colors.route },
  segmentText: { color: colors.muted, fontSize: 12, fontWeight: '800', textTransform: 'capitalize' },
  segmentTextActive: { color: colors.white },
  segmented: { backgroundColor: colors.panelAlt, borderRadius: 5, flexDirection: 'row', padding: 3 },
  sheetEyebrow: { color: colors.muted, fontSize: 11, fontWeight: '900', textAlign: 'center' },
  statsRow: { flexDirection: 'row', marginBottom: 4 },
});
