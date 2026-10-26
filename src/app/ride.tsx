import { SavedToast } from '@/components/SavedToast';
import { findSavedRoute } from '@/utils/savedRoutes';
import { GroupRidePanel } from '@/components/GroupRidePanel';
import Ionicons from '@expo/vector-icons/Ionicons';
import Slider from '@react-native-community/slider';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { Tabs, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Keyboard, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { coneBufferKm, coneRadiusKm } from '@/utils/roundTripArea';
import { PoiDetails } from '@/components/PoiDetails';
import { RideMap } from '@/components/RideMap';
import { RoutePoiCards } from '@/components/RoutePoiCards';
import { useRoutePois } from '@/hooks/useRoutePois';
import { routeColors, routeColorOrDefault } from '@/data/routeColors';
import { DriveOverlay } from '@/components/DriveOverlay';
import { DestinationSearch } from '@/components/DestinationSearch';
import { StandardTripPlanner } from '@/components/StandardTripPlanner';
import { RoutePreviewSheet } from '@/components/RoutePreviewSheet';
import { ActionButton, IconButton, Stat, ToggleRow } from '@/components/ui';
import { defaultCenter, nearbyPlaces } from '@/data/seed';
import { useApp } from '@/state/AppProvider';
import { Coordinate, PointOfInterest, PoiCategory, RoutePointOfInterest, RoutingProfile, TrackPoint, TripStop } from '@/types';
import { colors, spacing, tabBarStyle } from '@/theme';
import { upcomingManeuver } from '@/utils/guidance';
import { bearingBetween, closestRoutePoint, cumulativeRouteDistances, fetchRoadContext, RoadContext, routeHeadingAtLocation } from '@/utils/navigation';
import { buildPointToPoint, buildStandardTrip, calculateRoundTrip, distanceBetween, formatDuration, snapDraftToRoads, tourFromDraft } from '@/utils/routes';
import { formatRidingTime, recordedDistance, recordingSeconds, RecordingSession } from '@/utils/recording';
import { endRide, ensureBackgroundLocation, pauseRide, recoverRide, resumeRide, recordForegroundFix, startRide, subscribeToRide } from '@/services/rideTracking';
import type { ActiveRide } from '@/services/rideStore';
import { fetchNearbyPois } from '@/utils/pois';
import type { PlaceSuggestion } from '@/utils/places';
import { createRouteShare } from '@/utils/routeSharing';

type Mode = 'home' | 'standard' | 'round' | 'preview' | 'navigation' | 'recording';
const directions = [
  { label: 'N', value: 0 },
  { label: 'E', value: 90 },
  { label: 'S', value: 180 },
  { label: 'W', value: 270 },
];

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { activeRoute, setActiveRoute, saveTour, toggleSaved, tours = [], settings, updateSettings } = useApp();
  const savedRoute = useMemo(() => findSavedRoute(activeRoute, tours), [activeRoute, tours]);
  const { imported } = useLocalSearchParams<{ imported?: string }>();
  const [mode, setMode] = useState<Mode>(activeRoute ? 'preview' : 'home');
  const [savedNotice, setSavedNotice] = useState<{ sequence: number; saved: boolean } | null>(null);
  const [location, setLocation] = useState<Coordinate>(defaultCenter);
  const [search, setSearch] = useState('');
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [tripStops, setTripStops] = useState<TripStop[]>([]);
  const [tripStart, setTripStart] = useState<Coordinate | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const shareInProgress = useRef(false);
  const planningSearch = useRef(false);
  const profile = settings.routingProfile ?? 'winding';
  const setProfile = (routingProfile: RoutingProfile) => updateSettings({ routingProfile });
  const [roundDistance, setRoundDistance] = useState(160);
  const [coneAngle, setConeAngle] = useState(120);
  const roundRadius = coneRadiusKm(roundDistance);
  const [roundStart, setRoundStart] = useState<(Coordinate & { name: string }) | null>(null);
  const [startSearch, setStartSearch] = useState(false);
  const [startQuery, setStartQuery] = useState('');
  const [roundSheetHeight, setRoundSheetHeight] = useState(450);
  const [direction, setDirection] = useState(0);
  const [busy, setBusy] = useState(false);
  const [trackSegments, setTrackSegments] = useState<TrackPoint[][]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [clockTime, setClockTime] = useState(0);
  const [paused, setPaused] = useState(false);
  const [selectedPoi, setSelectedPoi] = useState<PoiCategory | null>(null);
  const [openPoi, setOpenPoi] = useState<PointOfInterest | null>(null);
  const [poiError, setPoiError] = useState(false);
  const [pois, setPois] = useState<PointOfInterest[]>([]);
  const [poiLoading, setPoiLoading] = useState(false);
  const [recenterTarget, setRecenterTarget] = useState<Coordinate>();
  const [previewHeight, setPreviewHeight] = useState(205);
  const [selectedRoutePoi, setSelectedRoutePoi] = useState<RoutePointOfInterest>();
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
  const recordingRef = useRef<RecordingSession | null>(null);
  const restoredRide = useRef(false);
  const startingRide = useRef(false);
  const progressRef = useRef(-1);
  const headingRef = useRef(0);
  const lastPositionRef = useRef<Coordinate | null>(null);
  useEffect(() => {
    if (!imported) return;
    // A warm app may still be displaying a planner from before this link.
    const timer = setTimeout(() => { setMode('preview'); setSearchExpanded(false); }, 0);
    return () => clearTimeout(timer);
  }, [imported]);
  const roadLookupRef = useRef<{ at: number; location: Coordinate | null; busy: boolean }>({ at: 0, location: null, busy: false });
  const visibleMode: Mode = activeRoute && mode === 'home' ? 'preview' : mode;
  const planningArea = useMemo(() => visibleMode === 'round' ? {
    center: roundStart ?? location, direction, radiusKm: roundRadius, coneAngleDegrees: coneAngle,
  } : undefined, [visibleMode, roundStart, location, direction, roundRadius, coneAngle]);
  const driving = visibleMode === 'navigation' || visibleMode === 'recording';
  const roundPreview = visibleMode === 'preview' && activeRoute?.roundTrip === true;
  const routePois = useRoutePois(roundPreview ? activeRoute?.route : undefined);
  const selectedRoutePoiId = routePois.points.find((point) => point === selectedRoutePoi)?.id;
  const selectRoutePoi = (point: RoutePointOfInterest) => {
    setSelectedRoutePoi(point);
    setRecenterTarget({ ...point.routePoint });
  };
  const routeHeading = useMemo(() => visibleMode === 'navigation'
    ? routeHeadingAtLocation(activeRoute?.route ?? [], location, routeIndex)
    : null, [activeRoute?.route, location, routeIndex, visibleMode]);
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
    let mounted = true;
    let lastError: string | undefined;
    const applyRide = (ride: ActiveRide | null) => {
      if (!mounted) return;
      recordingRef.current = ride?.session ?? null;
      if (!ride) return;
      setMode(ride.mode);
      setTrackSegments(ride.session.segments);
      setElapsed(recordingSeconds(ride.session, Date.now()));
      setClockTime(Date.now());
      setPaused(ride.session.activeSince === null);
      if (ride.error && ride.error !== lastError) Alert.alert('Ride recording paused', ride.error);
      lastError = ride.error;
    };
    const unsubscribe = subscribeToRide(applyRide);
    const restore = () => {
      recoverRide().then((ride) => {
        if (!mounted) return;
        if (ride) {
          setActiveRoute(ride.route);
          if (ride.lastFix) setLocation({ latitude: ride.lastFix.coords.latitude, longitude: ride.lastFix.coords.longitude });
        }
      }).catch((error) => {
        if (mounted) Alert.alert('Could not restore recording', error instanceof Error ? error.message : 'Please reopen Bendbound.');
      }).finally(() => { restoredRide.current = true; });
    };
    restore();
    const appState = AppState.addEventListener('change', (state) => { if (state === 'active') restore(); });
    Location.getLastKnownPositionAsync({ maxAge: 300000 })
      .then((last) => { if (mounted && last && !recordingRef.current) setLocation({ latitude: last.coords.latitude, longitude: last.coords.longitude }); })
      .catch(() => undefined);
    // The task owns the recording. Leaving this screen must not stop it.
    return () => { mounted = false; unsubscribe(); appState.remove(); };
  }, [setActiveRoute]);

  useEffect(() => {
    if (!selectedPoi) return;
    let cancelled = false;
    const controller = new AbortController();
    const [latitude, longitude] = poiRegionKey.split(',').map(Number);
    const timer = setTimeout(() => {
      setPois([]);
      setPoiError(false);
      setPoiLoading(true);
      fetchNearbyPois(selectedPoi, { latitude, longitude }, undefined, controller.signal)
        .then((results) => { if (!cancelled) setPois(results); })
        .catch(() => { if (!cancelled) { setPois([]); setPoiError(true); } })
        .finally(() => { if (!cancelled) setPoiLoading(false); });
    }, 450);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [poiRegionKey, selectedPoi]);

  const refreshRoadContext = useCallback((point: Coordinate, heading: number, force = false) => {
    const lookup = roadLookupRef.current;
    const now = Date.now();
    const movedKm = lookup.location ? distanceBetween(lookup.location, point) : Number.POSITIVE_INFINITY;
    if (lookup.busy || (!force && (now - lookup.at < 8000 || movedKm < 0.04))) return;
    roadLookupRef.current = { at: now, location: point, busy: true };
    fetchRoadContext(point, heading)
      .then(setRoadContext)
      .catch(() => undefined)
      .finally(() => { roadLookupRef.current.busy = false; });
  }, []);

  const handleTrackedPosition = useCallback((next: Location.LocationObject, trackingMode: 'navigation' | 'recording') => {
    if (!recordingRef.current || recordingRef.current.activeSince == null) return;
    if (!Number.isFinite(next.coords.latitude) || !Number.isFinite(next.coords.longitude)
      || next.coords.accuracy == null || next.coords.accuracy < 0 || next.coords.accuracy > 50
      || Date.now() - next.timestamp > 10000) return;
    // Both deliveries use the same serialized writer, so duplicate native
    // background fixes are ignored without losing a live foreground fix.
    void recordForegroundFix(next).catch(() => undefined);
    const point = { latitude: next.coords.latitude, longitude: next.coords.longitude };
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
  }, [activeRoute, refreshRoadContext]);

  useEffect(() => {
    if (!driving || paused) return;
    let cancelled = false;
    let positionWatch: Location.LocationSubscription | undefined;
    let headingWatch: Location.LocationSubscription | undefined;
    // Foreground and background deliveries share one durable, deduplicating writer.
    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 3, timeInterval: 1000 },
      (next) => { if (!cancelled) handleTrackedPosition(next, activeRoute ? 'navigation' : 'recording'); },
    ).then((subscription) => {
      if (cancelled) subscription.remove();
      else positionWatch = subscription;
    }).catch(() => { if (!cancelled) setGpsAccuracy(null); });
    Location.watchHeadingAsync((next) => {
      if (cancelled) return;
      const heading = next.trueHeading >= 0 ? next.trueHeading : next.magHeading;
      headingRef.current = heading;
      setLiveHeading(heading);
    }).then((subscription) => {
      if (cancelled) subscription.remove();
      else headingWatch = subscription;
    }).catch(() => undefined);
    return () => { cancelled = true; positionWatch?.remove(); headingWatch?.remove(); };
  }, [activeRoute, driving, handleTrackedPosition, paused]);

  useEffect(() => {
    if (!driving || paused) return;
    const timer = setInterval(() => {
      const now = Date.now();
      if (recordingRef.current) setElapsed(recordingSeconds(recordingRef.current, now));
      setClockTime(now);
    }, 1000);
    return () => clearInterval(timer);
  }, [driving, paused]);

  const requestRecordingPermission = () => ensureBackgroundLocation(() => new Promise<boolean>((resolve) => {
    Alert.alert('Record with the screen locked', 'Bendbound uses background location only during an active ride. Choose Always / Allow all the time on the next permission screen. Pause or finish to stop recording.', [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Continue', onPress: () => resolve(true) },
    ], { cancelable: false });
  }));

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
    if (busy) return;
    try {
      setBusy(true);
      const point = await getCurrentLocation();
      if (visibleMode === 'round') setRoundStart(null);
      else setRecenterTarget(point);
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
        { ...buildPointToPoint(start, destination, profile, place.name), stops: [{ ...place }] },
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

  const createStandardTrip = async (shareAfterPlanning = false) => {
    if (planningSearch.current) return;
    planningSearch.current = true;
    setBusy(true);
    try {
      const start = tripStart ?? await getCurrentLocation().catch(() => location);
      const draft = await snapDraftToRoads(buildStandardTrip(start, tripStops, profile), {
        avoidMotorways: settings.avoidMotorways,
      });
      setActiveRoute(tripStart && activeRoute?.roundTrip && distanceBetween(tripStart, tripStops[tripStops.length - 1]) < 0.05 ? { ...draft, roundTrip: true } : draft);
      setSearchExpanded(false);
      setMode('preview');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (shareAfterPlanning) await shareRoute(draft);
    } catch (error) {
      Alert.alert('Could not create route', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      planningSearch.current = false;
      setBusy(false);
    }
  };

  const shareRoute = async (route = activeRoute) => {
    if (!route || shareInProgress.current) return;
    shareInProgress.current = true; setSharing(true);
    try {
      const url = await createRouteShare(route, settings.avoidMotorways);
      await Share.share({ title: route.title, message: `${route.title} — ${route.distanceKm} km\n${url}` });
    } catch (error) {
      Alert.alert('Could not share route', error instanceof Error ? error.message : 'Please try again.');
    } finally { shareInProgress.current = false; setSharing(false); }
  };

  const createRoundTrip = async () => {
    if (busy || !planningArea) return;
    setBusy(true);
    try {
      const start = planningArea.center;
      // POIs are matched to the completed route by useRoutePois. Forcing them
      // into the search can introduce dead-end detours and delays route creation.
      const routed = await calculateRoundTrip(start, roundDistance, direction, profile, [], {
        avoidMotorways: settings.avoidMotorways,
        coneAngleDegrees: coneAngle,
      });
      setActiveRoute(routed);
      setMode('preview');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert('Could not create round trip', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const planFromMap = async (destination: Coordinate) => {
    if (busy) return;
    if (visibleMode === 'round' && !startSearch) {
      Alert.alert('Start from here?', `${destination.latitude.toFixed(5)}, ${destination.longitude.toFixed(5)}`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start from here', onPress: () => setRoundStart({ ...destination, name: 'Dropped pin' }) },
      ]);
      return;
    }
    if (visibleMode !== 'home' || searchExpanded) return;
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
    if (startingRide.current || recordingRef.current || !restoredRide.current) return;
    startingRide.current = true;
    try {
      await requestRecordingPermission();
      const start = await getCurrentLocation();
      await startRide(nextMode, nextMode === 'navigation' ? activeRoute : null);
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
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (error) {
      Alert.alert('Ride could not start', error instanceof Error ? error.message : 'Check location services.');
    } finally {
      startingRide.current = false;
    }
  };

  const togglePause = async () => {
    const session = recordingRef.current;
    if (!session || startingRide.current) return;
    startingRide.current = true;
    try {
      if (session.activeSince !== null) {
        await pauseRide();
      } else {
        await requestRecordingPermission();
        await resumeRide();
      }
    } catch (error) {
      Alert.alert('Could not update recording', error instanceof Error ? error.message : 'Check location services.');
    } finally {
      startingRide.current = false;
    }
  };

  const finishRide = async (discard: boolean) => {
    if (!recordingRef.current || startingRide.current) return;
    startingRide.current = true;
    try {
      const tour = await endRide(discard);
      if (tour) saveTour(tour);
      recordingRef.current = null;
      setActiveRoute(null);
      setTrackSegments([]);
      setTripStops([]);
      setMode('home');
      if (tour) Alert.alert('Ride saved', `${tour.title} is now in My Tours.${tour.route.length < 2 ? ' No usable GPS track was recorded.' : ''}`);
    } catch (error) {
      Alert.alert('Could not finish ride', error instanceof Error ? error.message : 'Your recording is still available. Please try again.');
    } finally {
      startingRide.current = false;
    }
  };

  const reset = () => {
    if (recordingRef.current) return;
    setActiveRoute(null);
    setTripStops([]);
    setTrackSegments([]);
    setStartSearch(false);
    setMode('home');
  };

  const editStops = () => {
    if (!activeRoute) return [];
    if (activeRoute.stops?.length) return activeRoute.stops.map((stop) => ({ ...stop }));
    // Imported and generated loops have no stop metadata. Retain intermediate
    // anchors when opening the editor so the destination alone doesn't collapse a loop.
    const route = activeRoute.route;
    if (!route.length) return [];
    const count = activeRoute.roundTrip ? 6 : 1;
    return Array.from({ length: count }, (_, i) => ({ ...route[Math.round((i + 1) * (route.length - 1) / count)],
      id: `route-anchor-${i}`, name: i === count - 1 ? activeRoute.roundTrip ? 'Return to start' : activeRoute.title : `Route anchor ${i + 1}` }));
  };
  const addPoiStop = (point: PointOfInterest) => {
    if (busy) return;
    const stops = visibleMode === 'standard' ? tripStops : editStops();
    if (stops.some((stop) => stop.id === point.id)) { setOpenPoi(null); return; }
    const updated = [...stops];
    updated.splice(Math.max(0, updated.length - 1), 0, { id: point.id, name: point.name, latitude: point.latitude, longitude: point.longitude });
    setTripStops(updated);
    if (visibleMode !== 'standard') setTripStart(activeRoute?.route[0] ?? null);
    setOpenPoi(null); setMode('standard');
  };
  const poiFilters = <View>
          <ScrollView contentContainerStyle={styles.poiRow} horizontal showsHorizontalScrollIndicator={false}>
            {nearbyPlaces.map((place) => (
              <Pressable
                disabled={busy}
                accessibilityRole="button"
                accessibilityState={{ selected: selectedPoi === place.id }}
                key={place.id}
                onPress={() => {
                  const next = selectedPoi === place.id ? null : place.id;
                  setPois([]);
                  setPoiLoading(!!next);
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
    {poiError ? <Text style={styles.hint}>Couldn’t load places. Toggle the category to retry.</Text>
      : selectedPoi && !poiLoading && !pois.length ? <Text style={styles.hint}>No matching places nearby. Move the map to search another area.</Text> : null}
  </View>;

  const elapsedLabel = formatRidingTime(elapsed);

  const updateMapCenter = (region: Coordinate) => {
    setMapCenter({ latitude: region.latitude, longitude: region.longitude });
  };

  return (
    <View style={styles.screen}>
      <PoiDetails key={openPoi?.id ?? 'closed'} point={openPoi} busy={busy} onClose={() => setOpenPoi(null)} onAdd={addPoiStop}
        onRide={(point) => { setOpenPoi(null); void planSearch({ ...point, address: point.detail }); }} />
      <Tabs.Screen options={{ tabBarStyle: driving || startSearch || visibleMode === 'standard' || (visibleMode === 'home' && searchExpanded) ? { display: 'none' } : tabBarStyle }} />
      <RideMap
        bottomInset={driving ? 82 + insets.bottom : visibleMode === 'home' || visibleMode === 'standard' ? 390 : visibleMode === 'round' ? roundSheetHeight + insets.bottom + 55 : previewHeight}
        followHeading={routeHeading ?? cameraHeading}
        followLocation={driving ? location : undefined}
        followSpeedKph={liveSpeedKph}
        gpsAccuracy={gpsAccuracy}
        motionPaused={paused || !gpsReady}
        recenterTarget={recenterTarget}
        motorcycleType={settings.motorcycleType}
        navigationMode={driving}
        following={mapFollowing}
        onFollowChange={setMapFollowing}
        onLongPress={planFromMap}
        onRegionChange={updateMapCenter}
        pois={!driving ? pois : []}
        onPoiSelect={setOpenPoi}
        planningArea={planningArea}
        roundTripPreview={roundPreview}
        routePois={routePois.points}
        selectedRoutePoiId={selectedRoutePoiId}
        onRoutePoiSelect={(point) => { selectRoutePoi(point); setOpenPoi(point); }}
        routeColor={settings.routeColor}
        route={activeRoute?.route}
        tripStops={visibleMode === 'standard' ? tripStops : activeRoute?.stops}
        maneuvers={activeRoute?.maneuvers}
        routeIndex={routeIndex}
        trackSegments={trackSegments}
      />
      <View pointerEvents="none" style={[styles.statusBarGround, { height: insets.top }]} />

      {((visibleMode === 'home' && !searchExpanded) || visibleMode === 'round' || visibleMode === 'preview') ? (
        <View style={[styles.mapControls, { top: insets.top + 10 }]}>
          {visibleMode !== 'home' ? <IconButton icon="close" label="Close route" onPress={() => { if (!busy) reset(); }} /> : null}
          <View style={styles.controlSpacer} />
          <IconButton icon="locate" label="Use my location" onPress={locate} />
        </View>
      ) : null}

      {visibleMode === 'home' ? (
        <DestinationSearch collapsedMaxHeight={Math.max(240, windowHeight - insets.top - 160)} query={search} onChangeQuery={setSearch} expanded={searchExpanded} onExpandedChange={setSearchExpanded}
          center={mapCenter} busy={busy} onSelect={planSearch}>
          <ScrollView style={styles.homeControls} showsVerticalScrollIndicator={false}>
          {poiFilters}
          <ToggleRow icon="trail-sign-outline" label="Avoid motorways" value={settings.avoidMotorways} onPress={() => updateSettings({ avoidMotorways: !settings.avoidMotorways })} />
          <View style={styles.actionRow}>
            <View style={styles.flex}><ActionButton icon="git-compare-outline" label="New route" loading={busy} onPress={() => { setTripStops([]); setTripStart(null); setMode('standard'); }} variant="primary" /></View>
            <View style={styles.flex}><ActionButton icon="sync-outline" label="Round trip" onPress={() => { setStartSearch(false); setMode('round'); }} /></View>
          </View>
          <View style={styles.recordRow}>
            <View style={styles.recordCopy}>
              <Text style={styles.recordTitle}>Just ride</Text>
              <Text style={styles.recordMeta}>Track distance, time and your GPS trail</Text>
            </View>
            <IconButton icon="radio-button-on" label="Record a ride" onPress={() => beginTracking('recording')} active />
          </View>
          <Text style={styles.hint}>Tip: long-press anywhere on the map to set a destination.</Text>
          </ScrollView>
        </DestinationSearch>
      ) : null}

      {visibleMode === 'standard' ? <StandardTripPlanner stops={tripStops} center={mapCenter} busy={busy || sharing}
        start={tripStart} onUseCurrentStart={() => setTripStart(null)}
        avoidMotorways={settings.avoidMotorways} onChange={setTripStops}
        onAvoidMotorwaysChange={() => updateSettings({ avoidMotorways: !settings.avoidMotorways })}
        onPlan={() => createStandardTrip()} onShare={() => createStandardTrip(true)} onCancel={() => setMode(activeRoute ? 'preview' : 'home')}>{poiFilters}</StandardTripPlanner> : null}

      {visibleMode === 'round' ? (
        <DestinationSearch collapsedMaxHeight={Math.max(250, windowHeight - insets.top - insets.bottom - 280)} placeholder="Start address or place" query={startSearch ? startQuery : roundStart?.name ?? 'Current location'}
          onChangeQuery={setStartQuery} expanded={startSearch}
          onExpandedChange={(expanded) => { if (!busy) { if (expanded && !startSearch) setStartQuery(''); setStartSearch(expanded); } }}
          center={planningArea?.center ?? location} busy={busy}
          onLayout={(event) => { if (!startSearch) setRoundSheetHeight(Math.ceil(event.nativeEvent.layout.height)); }}
          onSelect={(place) => { setRoundStart(place); setStartSearch(false); }}>
          <ScrollView style={{ flexShrink: 1 }} pointerEvents={busy ? 'none' : 'auto'}>
            {poiFilters}
            <Text accessibilityRole="header" style={styles.sheetTitle}>Round trip</Text>
            <Text style={styles.formLabel}>Total riding distance</Text>
            <Text style={styles.distance}>{Math.round(roundDistance)} km</Text>
            <Slider
              maximumTrackTintColor={colors.panelAlt}
              maximumValue={400}
              minimumTrackTintColor={colors.route}
              minimumValue={10}
              accessibilityLabel="Total riding distance in kilometres"
              onValueChange={setRoundDistance}
              step={10}
              thumbTintColor={colors.white}
              value={roundDistance}
            />
            <View style={styles.formRow}>
              <Text style={styles.formLabel}>Cone angle</Text><Text style={styles.directionText}>{coneAngle}°</Text>
            </View>
            <Slider accessibilityLabel="Cone opening angle in degrees" minimumValue={10} maximumValue={180} step={10}
              value={coneAngle} onValueChange={setConeAngle} minimumTrackTintColor="#38bdf8"
              maximumTrackTintColor={colors.panelAlt} thumbTintColor={colors.white} />
            <Text style={styles.hint}>Reach {roundRadius} km{roundDistance > 200 ? ' (pilot limit)' : ''} + {coneBufferKm(roundRadius).toFixed(1)} km road-access margin. Hold the map to change the start.</Text>
            <View style={styles.formRow}>
              <Text style={styles.formLabel}>Route</Text>
              <View style={styles.segmented}>
                {(['fast', 'winding', 'twisty'] as RoutingProfile[]).map((item) => (
                  <Pressable key={item} onPress={() => setProfile(item)} accessibilityRole="radio" accessibilityState={{ checked: profile === item }} style={[styles.segment, profile === item && styles.segmentActive]}>
                    <Text style={[styles.segmentText, profile === item && styles.segmentTextActive]}>{item}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={styles.formRow}>
              <Text style={styles.formLabel}>Heading</Text>
              <View style={styles.directionRow}>
                {directions.map((item) => (
                  <Pressable key={item.label} accessibilityRole="button" accessibilityLabel={`Heading ${item.label}`} accessibilityState={{ selected: direction === item.value }} onPress={() => setDirection(item.value)} style={[styles.direction, direction === item.value && styles.directionActive]}>
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
          </ScrollView>
        </DestinationSearch>
      ) : null}

      {visibleMode === 'preview' && activeRoute ? (
        <RoutePreviewSheet title={activeRoute.title} maxHeight={windowHeight - insets.top - 100}
          onVisibleHeightChange={setPreviewHeight}>
          {poiFilters}
          <View style={styles.statsRow}>
            <Stat label="Distance" value={`${activeRoute.distanceKm} km`} />
            <Stat label="Time" value={formatDuration(activeRoute.durationMin)} />
            <Stat label="Curves" value={`${activeRoute.curves}`} />
          </View>
          {roundPreview ? <RoutePoiCards points={routePois.points} selectedId={selectedRoutePoiId}
            tint={routeColors[routeColorOrDefault(settings.routeColor)].value} loading={routePois.loading} error={routePois.error}
            onSelect={selectRoutePoi} onOpen={setOpenPoi} onRetry={routePois.retry} /> : null}
          <View style={{ marginTop: spacing.md }}>
            <ActionButton icon="list-outline" label={`Add / edit stops (${activeRoute.stops?.length ?? 0} places)`}
              onPress={() => { setTripStops(editStops()); setTripStart(activeRoute.route[0]); setMode('standard'); }} />
          </View>
          <View style={{ marginTop: spacing.md }}><ActionButton icon="share-outline" label="Share route" loading={sharing} onPress={() => shareRoute()} /></View>
          <View style={{ marginTop: spacing.md }}><ActionButton icon="people-outline" label="Group ride" onPress={() => setGroupOpen(true)} /></View>
          <Text style={{ color: colors.muted, fontSize: 11, marginTop: 6 }}>Link includes the route and stops · available for 90 days</Text>
          <View style={styles.actionRow}>
            <IconButton active={savedRoute?.saved} icon={savedRoute?.saved ? 'bookmark' : 'bookmark-outline'} label={savedRoute?.saved ? 'Remove from saves' : 'Save tour'} onPress={() => {
              const saved = !savedRoute?.saved;
              if (savedRoute) toggleSaved(savedRoute.id);
              else saveTour(tourFromDraft(activeRoute));
              setSavedNotice(value => ({ sequence: (value?.sequence ?? 0) + 1, saved }));
            }} />
            <View style={styles.flex}><ActionButton icon="navigate" label="Start navigation" onPress={() => beginTracking('navigation')} variant="success" /></View>
          </View>
        </RoutePreviewSheet>
      ) : null}

      {savedNotice ? <SavedToast key={savedNotice.sequence} saved={savedNotice.saved} bottom={insets.bottom + 86} /> : null}

      <Modal visible={groupOpen} animationType="slide" onRequestClose={() => setGroupOpen(false)}>
        <ScrollView contentContainerStyle={{ padding: spacing.md, paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.md, gap: spacing.md }} style={{ flex: 1, backgroundColor: colors.canvas }}>
          <ActionButton label="Back to route" icon="arrow-back-outline" onPress={() => setGroupOpen(false)} />
          {groupOpen ? <GroupRidePanel route={activeRoute ?? undefined} avoidMotorways={settings.avoidMotorways} motorcycleType={settings.motorcycleType} /> : null}
        </ScrollView>
      </Modal>

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
          onFinish={() => Alert.alert('Finish ride?', 'Save your recording to My Tours, or discard it. Discarding cannot be undone.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Finish & discard', style: 'destructive', onPress: () => finishRide(true) },
            { text: 'Finish & save', onPress: () => finishRide(false) },
          ])}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  actionRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  controlSpacer: { flex: 1 },
  direction: { alignItems: 'center', backgroundColor: colors.panelAlt, borderRadius: 22, height: 44, justifyContent: 'center', width: 44 },
  directionActive: { backgroundColor: colors.line },
  directionRow: { flexDirection: 'row', gap: 7 },
  directionText: { color: colors.white, fontSize: 14, fontWeight: '600' },
  distance: { color: colors.white, fontSize: 32, fontWeight: '600', fontVariant: ['tabular-nums'], letterSpacing: -0.6, marginTop: 4 },
  flex: { flex: 1 },
  formLabel: { color: colors.muted, fontSize: 14, fontWeight: '500' },
  formRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between', marginTop: spacing.md },
  homeControls: { flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: spacing.sm },
  mapControls: { flexDirection: 'row', gap: 8, left: 10, position: 'absolute', right: 10 },
  poiChip: { alignItems: 'center', backgroundColor: colors.panelAlt, borderRadius: 8, flexDirection: 'row', gap: 6, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10 },
  poiChipActive: { backgroundColor: colors.line },
  poiRow: { gap: 8, paddingRight: 16 },
  poiText: { color: colors.ink, fontSize: 13, fontWeight: '500' },
  recordMeta: { color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 4 },
  recordCopy: { flex: 1, minWidth: 0 },
  recordRow: { alignItems: 'center', borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', gap: 12, marginTop: 18, paddingTop: 18 },
  recordTitle: { color: colors.ink, fontSize: 17, fontWeight: '600' },
  screen: { backgroundColor: '#dfe4d9', flex: 1 },
  segment: { alignItems: 'center', justifyContent: 'center', borderRadius: 6, minHeight: 44, paddingHorizontal: 10, paddingVertical: 8 },
  segmentActive: { backgroundColor: colors.line },
  segmentText: { color: colors.muted, fontSize: 13, fontWeight: '600', textTransform: 'capitalize' },
  segmentTextActive: { color: colors.white },
  segmented: { backgroundColor: colors.panelAlt, borderRadius: 8, flexDirection: 'row', padding: 3 },
  sheetTitle: { color: colors.ink, fontSize: 22, fontWeight: '600', letterSpacing: -0.4, marginTop: 16, marginBottom: 16 },
  statusBarGround: { backgroundColor: colors.charcoal, left: 0, right: 0, top: 0, position: 'absolute' },
  statsRow: { flexDirection: 'row', marginBottom: 4 },
});
