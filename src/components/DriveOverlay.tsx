import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconButton, IconName } from '@/components/ui';
import { useVoiceGuidance } from '@/hooks/useVoiceGuidance';
import { colors } from '@/theme';
import type { NavigationManeuver, SpeedUnit } from '@/types';
import { cardinalDirection, formatNavigationDistance } from '@/utils/navigation';
import { displaySpeed, speedUnitName } from '@/utils/speed';

type Props = {
  navigating: boolean;
  paused: boolean;
  gpsReady: boolean;
  gpsAccuracy: number | null;
  offRoute: boolean;
  maneuver?: NavigationManeuver;
  maneuverDistanceKm: number;
  remainingKm: number;
  arrival: string;
  elapsed: string;
  riddenKm: number;
  speedKph: number;
  speedUnit?: SpeedUnit;
  speedLimitKph: number | null;
  showSpeedLimit: boolean;
  heading: number;
  roadName: string | null;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
  onTogglePause: () => void;
  onFinish: () => void;
  following: boolean;
  onRecenter: () => void;
};

function turnIcon(maneuver?: NavigationManeuver): IconName {
  const instruction = maneuver?.instruction.toLowerCase() ?? '';
  if (instruction.includes('destination')) return 'flag';
  if (instruction.includes('roundabout')) return 'sync';
  if (instruction.includes('left')) return 'return-up-back';
  if (instruction.includes('right')) return 'return-up-forward';
  return 'arrow-up';
}

export function DriveOverlay(props: Props) {
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState(false);
  const voiceFailed = useVoiceGuidance({
    enabled: props.navigating && props.voiceEnabled,
    paused: props.paused,
    gpsReady: props.gpsReady,
    offRoute: props.offRoute,
    maneuver: props.maneuver,
    distanceKm: props.maneuverDistanceKm,
    speedKph: props.speedKph,
  });
  const footerHeight = 72 + insets.bottom + (expanded ? 62 : 0);
  const overspeed = props.speedLimitKph != null && props.speedKph > props.speedLimitKph + 3;
  const speedUnit = props.speedUnit ?? 'km/h';
  const speed = displaySpeed(props.speedKph, speedUnit);
  const speedLimit = props.speedLimitKph == null ? null : displaySpeed(props.speedLimitKph, speedUnit);
  const speedAvailable = props.gpsReady && !props.paused;
  const instruction = props.paused ? 'Ride paused' : props.offRoute ? 'Return to the highlighted route'
    : props.maneuver?.instruction ?? 'Follow the highlighted route';

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {props.navigating ? (
        <View style={[styles.banner, props.offRoute && styles.offRoute, { top: insets.top + 6 }]}>
          <Ionicons color={colors.white} name={props.offRoute ? 'warning' : turnIcon(props.maneuver)} size={32} />
          <View style={styles.turnCopy}>
            <Text style={styles.turnDistance}>{props.offRoute ? 'Off route' : props.maneuver ? formatNavigationDistance(props.maneuverDistanceKm) : 'On route'}</Text>
            <Text style={styles.instruction} numberOfLines={2}>{instruction}</Text>
          </View>
          <IconButton icon={props.voiceEnabled ? 'volume-high-outline' : 'volume-mute-outline'} label={props.voiceEnabled ? 'Mute directions' : 'Unmute directions'} onPress={props.onToggleVoice} />
        </View>
      ) : null}

      {!props.following ? (
        <View style={[styles.recenter, { bottom: footerHeight + 80 }]}>
          <IconButton icon="locate" label="Recenter on my location" onPress={props.onRecenter} />
        </View>
      ) : null}

      <View style={[styles.instruments, { bottom: footerHeight + 10 }]}>
        <View style={[styles.speed, overspeed && styles.speedOver]} accessibilityLabel={speedAvailable ? `Speed ${speed} ${speedUnitName(speedUnit)}` : 'Speed unavailable'}>
          <Text style={styles.speedValue}>{speedAvailable ? speed : '--'}</Text>
          <Text style={styles.unit}>{speedUnit}</Text>
        </View>
        {props.showSpeedLimit ? (
          <View style={styles.limit} accessibilityLabel={speedLimit == null ? 'Speed limit unavailable' : `Speed limit ${speedLimit} ${speedUnitName(speedUnit)}`}>
            <Text style={styles.limitValue}>{speedLimit ?? '--'}</Text>
          </View>
        ) : null}
        <View style={styles.heading}><Ionicons name="compass-outline" color={colors.white} size={16} /><Text style={styles.meta}>{cardinalDirection(props.heading)}</Text></View>
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom }]}>
        {expanded ? (
          <View style={styles.details}>
            <Text style={styles.meta} numberOfLines={1}>{props.roadName ?? 'Road name unavailable'}</Text>
            <View style={styles.detailRow}>
              <Text style={styles.meta}>Riding {props.elapsed}</Text>
              <Text style={styles.meta}>{props.gpsReady ? `GPS ±${Math.round(props.gpsAccuracy ?? 0)} m` : 'Waiting for GPS'}</Text>
            </View>
          </View>
        ) : null}
        <View style={styles.footerRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="Ride details" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={styles.summary}>
            <View style={styles.summaryTitle}>
              <Text style={styles.eta} numberOfLines={1}>{props.navigating ? props.arrival : props.elapsed}</Text>
              <Ionicons name={expanded ? 'chevron-down' : 'chevron-up'} size={14} color={colors.muted} />
            </View>
            <Text style={styles.meta} numberOfLines={1}>{props.paused ? 'Paused' : props.navigating ? `${formatNavigationDistance(props.remainingKm)} remaining` : `${props.riddenKm.toFixed(1)} km recorded`}</Text>
            {voiceFailed ? <Text style={styles.warning}>Voice unavailable</Text> : null}
          </Pressable>
          <IconButton icon={props.paused ? 'play' : 'pause'} label={props.paused ? 'Resume ride' : 'Pause ride'} onPress={props.onTogglePause} />
          <IconButton icon="stop" label="Finish ride" active onPress={props.onFinish} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { position: 'absolute', alignItems: 'center', backgroundColor: colors.charcoal, borderRadius: 8, flexDirection: 'row', gap: 10, left: 8, right: 8, padding: 10 },
  offRoute: { backgroundColor: '#992c37' },
  turnCopy: { flex: 1, minWidth: 0 },
  turnDistance: { color: colors.white, fontSize: 22, fontWeight: '900', lineHeight: 26 },
  instruction: { color: colors.white, fontSize: 13, lineHeight: 17, marginTop: 2 },
  instruments: { position: 'absolute', right: 10, alignItems: 'center', flexDirection: 'row', gap: 8 },
  recenter: { position: 'absolute', left: 10 },
  speed: { backgroundColor: colors.charcoal, borderRadius: 30, height: 60, width: 60, alignItems: 'center', justifyContent: 'center' },
  speedOver: { backgroundColor: colors.route },
  speedValue: { color: colors.white, fontSize: 25, fontWeight: '900', lineHeight: 29 },
  unit: { color: colors.white, fontSize: 10 },
  limit: { backgroundColor: colors.white, borderColor: colors.route, borderWidth: 4, borderRadius: 24, width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  limitValue: { color: colors.charcoal, fontSize: 19, fontWeight: '900' },
  heading: { backgroundColor: colors.charcoal, borderRadius: 6, flexDirection: 'row', alignItems: 'center', gap: 4, padding: 7 },
  footer: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: colors.charcoal },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 72 },
  summary: { flex: 1, minWidth: 0, paddingVertical: 8 },
  summaryTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  eta: { color: colors.white, fontSize: 20, fontWeight: '800', flexShrink: 1 },
  meta: { color: colors.ink, fontSize: 12, lineHeight: 18 },
  details: { minHeight: 62, paddingHorizontal: 14, justifyContent: 'center', gap: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  warning: { color: colors.warning, fontSize: 11 },
});
