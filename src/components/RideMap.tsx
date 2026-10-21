import { useRoadMatchedTrack } from '@/hooks/useRoadMatchedTrack';
import { useRiderMotion } from '@/hooks/useRiderMotion';
import { projectToRoad, trailToRider } from '@/utils/riderMotion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, GestureResponderEvent, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Camera, CameraRef, GeoJSONSource, Layer, LngLat, LngLatBounds, Map, Marker, UserLocation, ViewStateChangeEvent } from '@maplibre/maplibre-react-native';
import { conePolygon, RoundTripArea } from '@/utils/roundTripArea';
import { prepareArrowRoute, routeArrowFeatures } from '@/utils/routeArrows';
import { routeColors, routeColorOrDefault } from '@/data/routeColors';
import { rideMapStyle } from '@/utils/mapStyle';
import { defaultCenter } from '@/data/seed';
import { Coordinate, RouteColor, NavigationManeuver, MotorcycleType, PointOfInterest, PoiCategory, RoutePointOfInterest, TripStop } from '@/types';
import { colors } from '@/theme';
import { MotorcycleGlyph } from '@/components/MotorcycleGlyph';
import { motorcycleTypeOrDefault, motorcycles } from '@/data/motorcycles';
import { distanceBetween, tripStopLabel } from '@/utils/routes';

type RideMapProps = {
  route?: Coordinate[];
  tripStops?: TripStop[];
  routeColor?: RouteColor;
  maneuvers?: NavigationManeuver[];
  routeIndex?: number;
  trace?: Coordinate[];
  trackSegments?: Coordinate[][];
  bottomInset?: number;
  interactive?: boolean;
  showUser?: boolean;
  compact?: boolean;
  pois?: PointOfInterest[];
  onPoiSelect?: (point: PointOfInterest) => void;
  roundTripPreview?: boolean;
  planningArea?: RoundTripArea;
  routePois?: RoutePointOfInterest[];
  selectedRoutePoiId?: string;
  onRoutePoiSelect?: (point: RoutePointOfInterest) => void;
  followLocation?: Coordinate;
  /** A fresh object requests a one-time recenter while browsing. */
  recenterTarget?: Coordinate;
  followHeading?: number;
  followSpeedKph?: number;
  gpsAccuracy?: number | null;
  motionPaused?: boolean;
  navigationMode?: boolean;
  motorcycleType?: MotorcycleType;
  following?: boolean;
  onFollowChange?: (following: boolean) => void;
  onRegionChange?: (region: Coordinate) => void;
  onLongPress?: (coordinate: Coordinate) => void;
};

const emptyCoordinates: Coordinate[] = [];
const lngLat = (point: Coordinate): LngLat => [point.longitude, point.latitude];

export function RideMap({
  route = emptyCoordinates,
  tripStops = [],
  routeColor = 'red',
  maneuvers,
  routeIndex = 0,
  trace = emptyCoordinates,
  trackSegments,
  bottomInset = 0,
  interactive = true,
  showUser = true,
  compact,
  pois = [],
  onPoiSelect,
  roundTripPreview = false,
  planningArea,
  routePois = [],
  selectedRoutePoiId,
  onRoutePoiSelect,
  followLocation,
  recenterTarget,
  followHeading = 0,
  followSpeedKph = 0,
  gpsAccuracy,
  motionPaused = false,
  navigationMode = false,
  motorcycleType = 'adventure',
  following = true,
  onFollowChange,
  onRegionChange,
  onLongPress,
}: RideMapProps) {
  const ref = useRef<CameraRef>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapHeight, setMapHeight] = useState(800);
  const [mapZoom, setMapZoom] = useState(9);
  const [mapHeading, setMapHeading] = useState(0);
  const suspended = useRef(false);
  const touchOrigin = useRef<{ x: number; y: number } | null>(null);
  const wasNavigating = useRef(false);
  const handledRecenter = useRef<Coordinate | undefined>(undefined);
  const cameraRevision = useRef(0);
  const lastLocation = useRef(followLocation);
  const matchedTrack = useRoadMatchedTrack(trackSegments, navigationMode);
  const road = route.length > 1 ? route : matchedTrack.road;
  const snapped = useMemo(() => followLocation ? projectToRoad(road, followLocation, route.length > 1 ? routeIndex : -1,
    followSpeedKph > 7 ? followHeading : undefined) : undefined, [road, route.length, followLocation, routeIndex, followHeading, followSpeedKph]);
  const limitKm = Math.min(50, Math.max(20, (gpsAccuracy ?? 20) * 1.5)) / 1000;
  const liveTrack = navigationMode && !!trackSegments;
  const matchedEndpoint = matchedTrack.road[matchedTrack.road.length - 1];
  const target = liveTrack && matchedEndpoint ? matchedEndpoint : snapped && snapped.distanceKm <= limitKm ? snapped.point : followLocation;
  const motion = useRiderMotion(target, followHeading, road, navigationMode && !motionPaused);
  const liveTrail = useMemo(() => liveTrack ? trailToRider(matchedTrack.lines, motion.point) : undefined, [liveTrack, matchedTrack.lines, motion.point]);
  const riderLocation = liveTrail?.point ?? motion.point;
  const displaySegments = trackSegments ? liveTrail?.lines ?? matchedTrack.lines : undefined;
  const riderHeading = motion.heading;
  const recordedCoordinates = useMemo(() => displaySegments?.flat() ?? trace, [trace, displaySegments]);
  const recordedBounds = useMemo(() => trackSegments?.flat() ?? trace, [trackSegments, trace]);
  const coordinates = route.length > 1 ? route : recordedBounds;
  const routeTint = routeColors[routeColorOrDefault(routeColor)].value;
  const bikeType = motorcycleTypeOrDefault(motorcycleType);
  const cone = useMemo(() => planningArea ? conePolygon(planningArea) : [], [planningArea]);
  const bufferedCone = useMemo(() => planningArea ? conePolygon(planningArea, true) : [], [planningArea]);
  const polygonData = (points: Coordinate[]) => ({ type: 'Feature' as const, properties: {},
    geometry: { type: 'Polygon' as const, coordinates: [points.map(lngLat)] } });
  const routeData = useMemo(() => ({ type: 'Feature' as const, properties: {},
    geometry: { type: 'LineString' as const, coordinates: route.map(lngLat) } }), [route]);
  const trackData = useMemo(() => ({ type: 'Feature' as const, properties: {},
    geometry: { type: 'MultiLineString' as const, coordinates: (displaySegments ?? [trace]).filter((segment) => segment.length > 1).map((segment) => segment.map(lngLat)) } }), [trace, displaySegments]);
  const arrowRoute = useMemo(() => prepareArrowRoute(route, maneuvers), [route, maneuvers]);
  const arrowData = useMemo(() => routeArrowFeatures(arrowRoute, mapZoom, navigationMode ? routeIndex : 0), [arrowRoute, mapZoom, navigationMode, routeIndex]);
  const showMotorcycle = navigationMode && showUser && !compact && !!followLocation;
  const overlapsRider = (point: Coordinate) => showMotorcycle && followLocation && distanceBetween(point, followLocation) < 0.03;

  useEffect(() => {
    if (followLocation) lastLocation.current = followLocation;
  }, [followLocation]);

  useEffect(() => {
    suspended.current = !following;
    touchOrigin.current = null;
  }, [following, navigationMode]);

  useEffect(() => {
    if (!mapReady) return;
    if (navigationMode) {
      wasNavigating.current = true;
      return;
    }
    if (!wasNavigating.current) return;
    wasNavigating.current = false;
    // Let the restored tabs and home sheet settle before resetting the native camera.
    const revision = cameraRevision.current;
    const timer = setTimeout(() => {
      if (revision !== cameraRevision.current) return;
      ref.current?.jumpTo({
        center: lngLat(lastLocation.current ?? defaultCenter),
        bearing: 0,
        pitch: 0,
        zoom: 14,
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [mapReady, navigationMode]);

  useEffect(() => {
    if (!mapReady || navigationMode || coordinates.length < 2) return;
    const revision = cameraRevision.current;
    const timer = setTimeout(() => {
      if (revision !== cameraRevision.current) return;
      const bounds = coordinates.reduce<LngLatBounds>((box, point) => [
        Math.min(box[0], point.longitude), Math.min(box[1], point.latitude),
        Math.max(box[2], point.longitude), Math.max(box[3], point.latitude),
      ], [Infinity, Infinity, -Infinity, -Infinity]);
      ref.current?.fitBounds(bounds, {
        duration: 500, bearing: 0, pitch: 0,
        padding: { top: compact ? 20 : 110, left: 42, right: 42, bottom: compact ? 20 : bottomInset + 34 },
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [bottomInset, compact, coordinates, mapReady, navigationMode]);

  useEffect(() => {
    if (!mapReady || !bufferedCone.length || navigationMode) return;
    const bounds = bufferedCone.reduce<LngLatBounds>((box, p) => [
      Math.min(box[0], p.longitude), Math.min(box[1], p.latitude),
      Math.max(box[2], p.longitude), Math.max(box[3], p.latitude),
    ], [Infinity, Infinity, -Infinity, -Infinity]);
    ref.current?.fitBounds(bounds, { duration: 180, bearing: 0, pitch: 0,
      padding: { top: 110, left: 35, right: 35, bottom: bottomInset + 30 } });
  }, [bufferedCone, bottomInset, mapReady, navigationMode]);

  useEffect(() => {
    if (!recenterTarget || handledRecenter.current === recenterTarget) return;
    if (navigationMode || compact) {
      handledRecenter.current = recenterTarget;
      return;
    }
    if (!mapReady) return;
    handledRecenter.current = recenterTarget;
    // A button press wins over any pending preview fit or end-of-ride reset.
    cameraRevision.current++;
    ref.current?.easeTo({
      center: lngLat(recenterTarget),
      bearing: 0,
      pitch: 0,
      zoom: 15,
      padding: { top: 0, right: 0, bottom: bottomInset, left: 0 },
      duration: 600,
    });
  }, [bottomInset, compact, mapReady, navigationMode, recenterTarget]);

  useEffect(() => {
    if (!mapReady || !navigationMode || !following || suspended.current || !riderLocation) return;
    // Tilt the flat map toward travel while keeping the rider centered above the footer.
    // Repeat after the ride layout settles so the camera uses the current map padding.
    ref.current?.easeTo({
      center: lngLat(riderLocation),
      bearing: riderHeading,
      pitch: 45,
      zoom: Math.max(16.4, 17.4 - followSpeedKph / 120),
      padding: { top: 0, right: 0, bottom: bottomInset, left: 0 },
      duration: 100,
    });
  }, [bottomInset, riderHeading, riderLocation, followSpeedKph, following, mapHeight, mapReady, navigationMode]);

  const suspendFollow = () => {
    if (!navigationMode || !interactive || compact || suspended.current) return;
    suspended.current = true;
    onFollowChange?.(false);
  };

  const handleTouchStart = ({ nativeEvent }: GestureResponderEvent) => {
    touchOrigin.current = { x: nativeEvent.pageX, y: nativeEvent.pageY };
    if (nativeEvent.touches.length > 1) suspendFollow();
  };

  const handleTouchMove = ({ nativeEvent }: GestureResponderEvent) => {
    const origin = touchOrigin.current;
    if (nativeEvent.touches.length > 1 || (origin && Math.hypot(nativeEvent.pageX - origin.x, nativeEvent.pageY - origin.y) > 6)) {
      suspendFollow();
    }
  };

  const handleCameraChange = (event: { nativeEvent: ViewStateChangeEvent }) => {
    const { bearing, zoom, userInteraction } = event.nativeEvent;
    if (Number.isFinite(bearing)) setMapHeading(bearing);
    if (Number.isFinite(zoom)) setMapZoom(Math.round(zoom * 4) / 4);
    if (userInteraction) suspendFollow();
  };
  const gestures = interactive && !compact;

  return (
    <View style={styles.map} onLayout={(event) => setMapHeight(event.nativeEvent.layout.height)}
      onTouchStart={handleTouchStart} onTouchMove={handleTouchMove}
      onTouchEnd={() => { touchOrigin.current = null; }} onTouchCancel={() => { touchOrigin.current = null; }}>
      <Map
        mapStyle={rideMapStyle}
        onLongPress={(event) => onLongPress?.({ longitude: event.nativeEvent.lngLat[0], latitude: event.nativeEvent.lngLat[1] })}
        onDidFinishLoadingStyle={() => setMapReady(true)}
        onRegionWillChange={handleCameraChange}
        onRegionIsChanging={handleCameraChange}
        onRegionDidChange={(event) => {
          handleCameraChange(event);
          const [longitude, latitude] = event.nativeEvent.center;
          onRegionChange?.({ latitude, longitude });
        }}
        dragPan={gestures} touchZoom={gestures} doubleTapZoom={gestures}
        doubleTapHoldZoom={gestures} touchRotate={gestures} touchPitch={navigationMode && gestures}
        compass={false} logo={false} attribution
        attributionPosition={{ bottom: bottomInset + 8, left: 8 }}
        style={styles.map}
      >
        <Camera ref={ref} minZoom={2} maxZoom={19} initialViewState={{ center: lngLat(defaultCenter), zoom: 9, bearing: 0, pitch: 0 }} />
        {showUser && !compact && !showMotorcycle ? <UserLocation /> : null}
        {planningArea ? <>
          <GeoJSONSource id="planning-margin" data={polygonData(bufferedCone)}>
            <Layer id="planning-margin-fill" type="fill" paint={{ 'fill-color': '#38bdf8', 'fill-opacity': 0.08 }} />
            <Layer id="planning-margin-line" type="line" paint={{ 'line-color': '#38bdf8', 'line-width': 1, 'line-dasharray': [3, 3] }} />
          </GeoJSONSource>
          <GeoJSONSource id="planning-cone" data={polygonData(cone)}>
            <Layer id="planning-cone-fill" type="fill" paint={{ 'fill-color': '#38bdf8', 'fill-opacity': 0.17 }} />
            <Layer id="planning-cone-line" type="line" paint={{ 'line-color': '#38bdf8', 'line-width': 2 }} />
          </GeoJSONSource>
          <Marker id="planning-start" lngLat={lngLat(planningArea.center)}>
            <View accessibilityLabel="Selected round trip start" style={styles.markerStart}><Ionicons name="flag" color={colors.white} size={14} /></View>
          </Marker>
        </> : null}
        {route.length > 1 ? <GeoJSONSource id="route" data={routeData} tolerance={0}>
          <Layer id="route-outline" type="line" layout={{ 'line-cap': 'round', 'line-join': 'round' }} paint={{ 'line-color': '#ffffff', 'line-width': 9 }} />
          <Layer id="route-line" type="line" afterId="route-outline" layout={{ 'line-cap': 'round', 'line-join': 'round' }} paint={{ 'line-color': routeTint, 'line-width': 6 }} />
        </GeoJSONSource> : null}
        {trackData.geometry.coordinates.length > 0 ? <GeoJSONSource id="track" data={trackData}>
          <Layer id="track-line" type="line" layout={{ 'line-cap': 'round', 'line-join': 'round' }} paint={{ 'line-color': colors.routeAlt, 'line-width': 6 }} />
        </GeoJSONSource> : null}
        {!compact && arrowData.features.length > 0 ? <GeoJSONSource id="turn-arrows" data={arrowData} tolerance={0}>
          <Layer id="turn-shaft-outline" type="line" filter={['==', 'part', 'shaft']} layout={{ 'line-cap': 'round', 'line-join': 'round' }} paint={{ 'line-color': routeTint, 'line-width': 10.2 }} />
          <Layer id="turn-head-outline" type="fill" afterId="turn-shaft-outline" filter={['==', 'part', 'head-outline']} paint={{ 'fill-color': routeTint }} />
          <Layer id="turn-shaft" type="line" afterId="turn-head-outline" filter={['==', 'part', 'shaft']} layout={{ 'line-cap': 'round', 'line-join': 'round' }} paint={{ 'line-color': '#ffffff', 'line-width': 7.2 }} />
          <Layer id="turn-head" type="fill" afterId="turn-shaft" filter={['==', 'part', 'head']} paint={{ 'fill-color': '#ffffff' }} />
        </GeoJSONSource> : null}
        {showMotorcycle && riderLocation ? (
          <Marker id="rider" lngLat={lngLat(riderLocation)} anchor="center">
            <View collapsable={false} accessibilityLabel={`Your location, ${motorcycles[bikeType].label} motorcycle`} style={styles.riderMarker}>
              <View style={[styles.riderGlyph, { transform: [{ rotate: `${((riderHeading - mapHeading) % 360 + 360) % 360}deg` }] }]}>
                <MotorcycleGlyph type={bikeType} size={63} />
              </View>
            </View>
          </Marker>
        ) : null}
        {route.length > 1 ? (
          <>
            {!overlapsRider(route[0]) ? <Marker id="route-start" lngLat={lngLat(route[0])}>
              <View accessibilityLabel={roundTripPreview ? 'Round trip start and finish' : 'Route start'} style={styles.markerStart}>{roundTripPreview || tripStops.length ? <Ionicons name="flag" color={colors.white} size={14} /> : <Text maxFontSizeMultiplier={1.2} style={styles.markerText}>1</Text>}</View>
            </Marker> : null}
            {!roundTripPreview && !tripStops.length && !overlapsRider(route[route.length - 1]) ? <Marker id="route-end" lngLat={lngLat(route[route.length - 1])}>
              <View style={[styles.markerEnd, { backgroundColor: routeTint }]}><Text maxFontSizeMultiplier={1.2} style={styles.markerText}>2</Text></View>
            </Marker> : null}
          </>
        ) : null}
        {!navigationMode && trackSegments && recordedCoordinates.length > 0 ? (
          <>
            <Marker id="track-start" lngLat={lngLat(recordedCoordinates[0])}><View accessibilityLabel="Ride start" style={styles.markerStart}><Text maxFontSizeMultiplier={1.2} style={styles.markerText}>1</Text></View></Marker>
            <Marker id="track-end" lngLat={lngLat(recordedCoordinates[recordedCoordinates.length - 1])}><View accessibilityLabel="Ride finish" style={[styles.markerEnd, { backgroundColor: routeTint }]}><Text maxFontSizeMultiplier={1.2} style={styles.markerText}>2</Text></View></Marker>
          </>
        ) : null}
        {pois.map((poi) => (
          <Marker key={poi.id} id={`poi-${poi.id}`} lngLat={lngLat(poi)} onPress={() => onPoiSelect?.(poi)}>
            <View style={styles.poiMarker}>
              <Ionicons color={colors.white} name={poiIcons[poi.category]} size={16} />
            </View>
          </Marker>
        ))}
        {!compact ? tripStops.map((stop, index) => !overlapsRider(stop) ? (
          <Marker key={`${stop.id}-${index}`} id={`trip-stop-${index}`} lngLat={lngLat(stop)}
            onPress={() => Alert.alert(`${tripStopLabel(index)}. ${stop.name}`, stop.address ?? (index === tripStops.length - 1 ? 'Destination' : 'Planned stop'))}>
            <View collapsable={false} accessibilityLabel={`${index === tripStops.length - 1 ? 'Destination' : 'Stop'} ${tripStopLabel(index)}: ${stop.name}`}
              style={[styles.routePoiMarker, { backgroundColor: routeTint }]}><Text maxFontSizeMultiplier={1.2} adjustsFontSizeToFit numberOfLines={1} style={styles.routePoiNumber}>{tripStopLabel(index)}</Text></View>
          </Marker>
        ) : null) : null}
        {roundTripPreview && !navigationMode ? routePois.map((poi) => (
          <Marker key={poi.id} id={`route-poi-${poi.id}`} lngLat={lngLat(poi.routePoint)} onPress={() => onRoutePoiSelect?.(poi)}>
            <View collapsable={false} accessibilityRole="button" accessibilityLabel={`Point ${poi.number}: ${poi.name}`}
              accessibilityState={{ selected: selectedRoutePoiId === poi.id }}
              style={[styles.routePoiMarker, { backgroundColor: routeTint }, selectedRoutePoiId === poi.id && styles.selectedRoutePoi]}>
              <Text maxFontSizeMultiplier={1.2} style={styles.routePoiNumber}>{poi.number}</Text>
            </View>
          </Marker>
        )) : null}
      </Map>
    </View>
  );
}

const poiIcons: Record<PoiCategory, 'speedometer-outline' | 'trail-sign-outline' | 'cafe-outline' | 'camera-outline' | 'leaf-outline'> = {
  fuel: 'speedometer-outline',
  pass: 'trail-sign-outline',
  meet: 'cafe-outline',
  sight: 'camera-outline',
  forest: 'leaf-outline',
};

const styles = StyleSheet.create({
  riderMarker: { width: 78, height: 78, alignItems: 'center', justifyContent: 'center' },
  riderGlyph: { width: 66, height: 66, alignItems: 'center', justifyContent: 'center' },
  map: { flex: 1 },
  markerEnd: { alignItems: 'center', backgroundColor: colors.route, borderColor: colors.white, borderRadius: 14, borderWidth: 3, height: 28, justifyContent: 'center', width: 28 },
  markerStart: { alignItems: 'center', backgroundColor: colors.charcoal, borderColor: colors.white, borderRadius: 14, borderWidth: 3, height: 28, justifyContent: 'center', width: 28 },
  markerText: { color: colors.white, fontSize: 11, fontWeight: '900' },
  poiMarker: { alignItems: 'center', backgroundColor: colors.action, borderColor: colors.white, borderRadius: 17, borderWidth: 3, height: 34, justifyContent: 'center', width: 34 },
  routePoiMarker: { alignItems: 'center', borderColor: colors.white, borderRadius: 22, borderWidth: 3, height: 44, justifyContent: 'center', width: 44 },
  selectedRoutePoi: { borderColor: colors.charcoal, borderWidth: 4 },
  routePoiNumber: { color: colors.white, fontSize: 16, fontWeight: '900' },
});
