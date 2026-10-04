import { useEffect, useMemo, useRef, useState } from 'react';
import { GestureResponderEvent, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import MapView, { Callout, LatLng, LongPressEvent, MapType, Marker, Polyline, Region } from 'react-native-maps';
import { defaultCenter } from '@/data/seed';
import { Coordinate, MotorcycleType, PointOfInterest, PoiCategory } from '@/types';
import { colors } from '@/theme';
import { MotorcycleGlyph } from '@/components/MotorcycleGlyph';
import { motorcycleTypeOrDefault, motorcycles } from '@/data/motorcycles';
import { distanceBetween } from '@/utils/routes';

type RideMapProps = {
  route?: Coordinate[];
  trace?: Coordinate[];
  trackSegments?: Coordinate[][];
  bottomInset?: number;
  interactive?: boolean;
  showUser?: boolean;
  compact?: boolean;
  mapType?: MapType;
  pois?: PointOfInterest[];
  followLocation?: Coordinate;
  followHeading?: number;
  followSpeedKph?: number;
  navigationMode?: boolean;
  motorcycleType?: MotorcycleType;
  following?: boolean;
  onFollowChange?: (following: boolean) => void;
  onRegionChange?: (region: Region) => void;
  onLongPress?: (coordinate: Coordinate) => void;
};

const emptyCoordinates: Coordinate[] = [];
// Keep explicit, nonzero limits: clearing this prop becomes a 0...0 range on iOS Fabric.
const cameraZoomRange = { minCenterCoordinateDistance: 100, maxCenterCoordinateDistance: 20000000 };

const mapStyle = [
  { elementType: 'geometry', stylers: [{ color: '#e8e9df' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#4b4e50' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#cbdcc3' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#f1b765' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#9dcddd' }] },
];

export function RideMap({
  route = emptyCoordinates,
  trace = emptyCoordinates,
  trackSegments,
  bottomInset = 0,
  interactive = true,
  showUser = true,
  compact,
  mapType = 'standard',
  pois = [],
  followLocation,
  followHeading = 0,
  followSpeedKph = 0,
  navigationMode = false,
  motorcycleType = 'adventure',
  following = true,
  onFollowChange,
  onRegionChange,
  onLongPress,
}: RideMapProps) {
  const ref = useRef<MapView>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapHeight, setMapHeight] = useState(800);
  const [mapHeading, setMapHeading] = useState(0);
  const headingRead = useRef({ at: 0, sequence: 0, mounted: true });
  const suspended = useRef(false);
  const touchOrigin = useRef<{ x: number; y: number } | null>(null);
  const wasNavigating = useRef(false);
  const lastLocation = useRef(followLocation);
  const recordedCoordinates = useMemo(() => trackSegments?.flat() ?? trace, [trace, trackSegments]);
  const coordinates = route.length > 1 ? route : recordedCoordinates;
  const bikeType = motorcycleTypeOrDefault(motorcycleType);
  const showMotorcycle = navigationMode && showUser && !compact && !!followLocation;
  const overlapsRider = (point: Coordinate) => showMotorcycle && followLocation && distanceBetween(point, followLocation) < 0.03;

  useEffect(() => {
    const read = headingRead.current;
    read.mounted = true;
    return () => { read.mounted = false; read.sequence++; };
  }, []);

  const readMapHeading = (force = false) => {
    if (!showMotorcycle || !ref.current) return;
    const read = headingRead.current;
    const now = Date.now();
    if (!force && now - read.at < 120) return;
    read.at = now;
    const sequence = ++read.sequence;
    // Apple Maps ignores Marker.rotation, so rotate the glyph relative to the camera.
    void ref.current.getCamera().then((camera) => {
      if (read.mounted && sequence === read.sequence && Number.isFinite(camera.heading)) setMapHeading(camera.heading);
    }).catch(() => undefined);
  };

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
    const timer = setTimeout(() => ref.current?.setCamera({
      center: lastLocation.current ?? defaultCenter,
      heading: 0,
      pitch: 0,
      altitude: 5000,
      zoom: 14,
    }), 250);
    return () => clearTimeout(timer);
  }, [mapReady, navigationMode]);

  useEffect(() => {
    if (!mapReady || navigationMode || coordinates.length < 2) return;
    const timer = setTimeout(() => {
      ref.current?.fitToCoordinates(coordinates as LatLng[], {
        animated: true,
        edgePadding: { top: compact ? 20 : 110, left: 42, right: 42, bottom: compact ? 20 : bottomInset + 34 },
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [bottomInset, compact, coordinates, mapReady, navigationMode]);

  useEffect(() => {
    if (!mapReady || !navigationMode || !following || suspended.current || !followLocation) return;
    // A geographic look-ahead offset can put the rider below the footer in 2D.
    // Center on the fix; keep the close zoom and repeat after the ride layout settles.
    const altitude = Math.min(1100, Math.max(480, 480 + followSpeedKph * 5));
    ref.current?.animateCamera({
      altitude,
      center: followLocation,
      heading: followHeading,
      pitch: 0,
      zoom: Math.max(16.4, 17.4 - followSpeedKph / 120),
    }, { duration: 600 });
  }, [bottomInset, followHeading, followLocation, followSpeedKph, following, mapHeight, mapReady, navigationMode]);

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

  const handleLongPress = (event: LongPressEvent) => onLongPress?.(event.nativeEvent.coordinate);

  return (
    <MapView
      ref={ref}
      cameraZoomRange={cameraZoomRange}
      customMapStyle={mapStyle}
      initialRegion={{ ...defaultCenter, latitudeDelta: 0.7, longitudeDelta: 0.7 }}
      liteMode={compact}
      mapType={mapType}
      mapPadding={{ top: 0, right: 0, bottom: bottomInset, left: 0 }}
      onLongPress={handleLongPress}
      onMapReady={() => setMapReady(true)}
      onLayout={(event) => setMapHeight(event.nativeEvent.layout.height)}
      onPanDrag={suspendFollow}
      onDoublePress={suspendFollow}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={() => { touchOrigin.current = null; }}
      onTouchCancel={() => { touchOrigin.current = null; }}
      onRegionChange={() => readMapHeading()}
      onRegionChangeComplete={(region, details) => {
        readMapHeading(true);
        if (details.isGesture) suspendFollow();
        onRegionChange?.(region);
      }}
      pitchEnabled={false}
      rotateEnabled={interactive && !compact}
      scrollEnabled={interactive && !compact}
      showsCompass={false}
      showsBuildings={false}
      showsMyLocationButton={false}
      showsPointsOfInterests
      showsTraffic={navigationMode}
      showsUserLocation={showUser && !compact && !showMotorcycle}
      style={styles.map}
      toolbarEnabled={false}
      userInterfaceStyle="light"
      zoomEnabled={interactive && !compact}
    >
      {showMotorcycle && followLocation ? (
        <Marker identifier="rider" coordinate={followLocation} anchor={{ x: 0.5, y: 0.5 }} centerOffset={{ x: 0, y: 0 }} zIndex={1000} title="Your location" description={motorcycles[bikeType].label} tracksViewChanges>
          <View collapsable={false} accessibilityLabel={`Your location, ${motorcycles[bikeType].label} motorcycle`} style={styles.riderMarker}>
            <View style={[styles.riderGlyph, { transform: [{ rotate: `${((followHeading - mapHeading) % 360 + 360) % 360}deg` }] }]}>
              <MotorcycleGlyph type={bikeType} size={42} />
            </View>
          </View>
        </Marker>
      ) : null}
      {route.length > 1 ? (
        <>
          <Polyline coordinates={route} strokeColor="#ffffff" strokeWidth={9} />
          <Polyline coordinates={route} lineCap="round" lineJoin="round" strokeColor={colors.route} strokeWidth={6} />
          {!overlapsRider(route[0]) ? <Marker identifier="route-start" coordinate={route[0]}>
            <View style={styles.markerStart}><Text style={styles.markerText}>1</Text></View>
          </Marker> : null}
          {!overlapsRider(route[route.length - 1]) ? <Marker identifier="route-end" coordinate={route[route.length - 1]}>
            <View style={styles.markerEnd}><Text style={styles.markerText}>2</Text></View>
          </Marker> : null}
        </>
      ) : null}
      {(trackSegments ?? [trace]).map((segment, index) => segment.length > 1
        ? <Polyline key={`track-${index}`} coordinates={segment} strokeColor={colors.routeAlt} strokeWidth={6} /> : null)}
      {!navigationMode && trackSegments && recordedCoordinates.length > 0 ? (
        <>
          <Marker coordinate={recordedCoordinates[0]} title="Ride start" pinColor={colors.actionGreen} />
          <Marker coordinate={recordedCoordinates[recordedCoordinates.length - 1]} title="Ride finish" pinColor={colors.route} />
        </>
      ) : null}
      {pois.map((poi) => (
        <Marker key={poi.id} coordinate={poi}>
          <View style={styles.poiMarker}>
            <Ionicons color={colors.white} name={poiIcons[poi.category]} size={16} />
          </View>
          <Callout>
            <View style={styles.callout}>
              <Text style={styles.calloutTitle}>{poi.name}</Text>
              <Text style={styles.calloutDetail}>{poi.detail.replaceAll('_', ' ')}</Text>
            </View>
          </Callout>
        </Marker>
      ))}
    </MapView>
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
  riderMarker: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  riderGlyph: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  callout: { minWidth: 150, padding: 6 },
  calloutDetail: { color: '#62666c', fontSize: 12, marginTop: 3, textTransform: 'capitalize' },
  calloutTitle: { color: '#17181b', fontSize: 14, fontWeight: '800' },
  map: { flex: 1 },
  markerEnd: { alignItems: 'center', backgroundColor: colors.route, borderColor: colors.white, borderRadius: 14, borderWidth: 3, height: 28, justifyContent: 'center', width: 28 },
  markerStart: { alignItems: 'center', backgroundColor: colors.charcoal, borderColor: colors.white, borderRadius: 14, borderWidth: 3, height: 28, justifyContent: 'center', width: 28 },
  markerText: { color: colors.white, fontSize: 11, fontWeight: '900' },
  poiMarker: { alignItems: 'center', backgroundColor: colors.action, borderColor: colors.white, borderRadius: 17, borderWidth: 3, height: 34, justifyContent: 'center', width: 34 },
});
