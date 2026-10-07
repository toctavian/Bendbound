import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DestinationSearch } from '@/components/DestinationSearch';
import { ActionButton, Sheet, ToggleRow } from '@/components/ui';
import { colors } from '@/theme';
import type { Coordinate, TripStop } from '@/types';
import { tripStopLabel } from '@/utils/routes';

type Props = {
  stops: TripStop[];
  center: Coordinate;
  busy: boolean;
  avoidMotorways: boolean;
  onChange: (stops: TripStop[]) => void;
  onAvoidMotorwaysChange: () => void;
  onPlan: () => void;
  onCancel: () => void;
};

export function StandardTripPlanner({ stops, center, busy, avoidMotorways, onChange, onAvoidMotorwaysChange, onPlan, onCancel }: Props) {
  const insets = useSafeAreaInsets();
  const [searching, setSearching] = useState<{ index: number; replace: boolean } | null>(null);
  const [query, setQuery] = useState('');
  const search = (index: number, replace: boolean) => {
    if (busy) return;
    setQuery('');
    setSearching({ index, replace });
  };
  const move = (index: number, offset: number) => {
    const reordered = [...stops];
    [reordered[index], reordered[index + offset]] = [reordered[index + offset], reordered[index]];
    onChange(reordered);
  };
  if (searching) return <DestinationSearch query={query} onChangeQuery={setQuery} expanded
    onExpandedChange={(expanded) => { if (!expanded) setSearching(null); }} center={center} busy={busy}
    placeholder={searching.replace && searching.index === stops.length - 1 || !stops.length ? 'Search destination' : 'Search for a stop'}
    onSelect={(place) => {
      const updated = [...stops];
      updated.splice(searching.index, searching.replace ? 1 : 0, place);
      onChange(updated);
      setSearching(null);
    }}>{null}</DestinationSearch>;

  return <Sheet style={{ paddingBottom: Math.max(14, insets.bottom) }}>
    <Text style={styles.title}>Plan your trip</Text>
    <View style={styles.origin}><Ionicons name="locate" color={colors.action} size={18} /><Text style={styles.originText}>Start from your current location</Text></View>
    <FlatList data={stops} extraData={busy} keyExtractor={(stop, index) => `${stop.id}-${index}`}
      style={styles.list} contentContainerStyle={styles.listContent}
      renderItem={({ item: stop, index }) => <View style={styles.stop}>
        <View style={styles.number}><Text style={styles.numberText}>{tripStopLabel(index)}</Text></View>
        <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel={`Change ${index === stops.length - 1 ? 'destination' : `stop ${tripStopLabel(index)}`}: ${stop.name}`}
          onPress={() => search(index, true)} style={styles.copy}>
          <Text style={styles.label}>{index === stops.length - 1 ? 'Destination' : `Stop ${tripStopLabel(index)}`}</Text>
          <Text style={styles.name} numberOfLines={2}>{stop.name}</Text>
        </Pressable>
        <View>
          <Pressable accessibilityRole="button" accessibilityLabel={`Move stop ${tripStopLabel(index)} up`} disabled={busy || index === 0} onPress={() => move(index, -1)} style={styles.control}>
            <Ionicons name="chevron-up" color={index === 0 || busy ? colors.line : colors.ink} size={20} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Move stop ${tripStopLabel(index)} down`} disabled={busy || index === stops.length - 1} onPress={() => move(index, 1)} style={styles.control}>
            <Ionicons name="chevron-down" color={index === stops.length - 1 || busy ? colors.line : colors.ink} size={20} />
          </Pressable>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove stop ${tripStopLabel(index)}: ${stop.name}`} disabled={busy} onPress={() => onChange(stops.filter((_, i) => i !== index))} style={styles.control}>
          <Ionicons name="close" color={colors.muted} size={21} />
        </Pressable>
      </View>} />
    <ActionButton icon="add" label={stops.length ? 'Add stop' : 'Add destination'} disabled={busy} onPress={() => search(Math.max(0, stops.length - 1), false)} />
    <ToggleRow icon="trail-sign-outline" label="Avoid motorways" value={avoidMotorways} onPress={() => { if (!busy) onAvoidMotorwaysChange(); }} />
    <View style={styles.actions}>
      <View style={styles.flex}><ActionButton label="Cancel" disabled={busy} onPress={onCancel} /></View>
      <View style={styles.flex}><ActionButton label="Create route" icon="navigate-outline" loading={busy} disabled={!stops.length} variant="danger" onPress={onPlan} /></View>
    </View>
  </Sheet>;
}

const styles = StyleSheet.create({
  title: { color: colors.ink, fontSize: 22, fontWeight: '900', marginBottom: 12 },
  origin: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  originText: { color: colors.muted, fontSize: 12 },
  list: { maxHeight: 220, flexGrow: 0 },
  listContent: { gap: 8, paddingBottom: 10 },
  stop: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.panelAlt, borderRadius: 8, paddingLeft: 10 },
  number: { minWidth: 30, paddingHorizontal: 4, height: 26, borderRadius: 13, backgroundColor: colors.action, alignItems: 'center', justifyContent: 'center' },
  numberText: { color: colors.white, fontWeight: '900' },
  copy: { flex: 1, paddingVertical: 12, minHeight: 44 },
  label: { color: colors.muted, fontSize: 10, marginBottom: 3 },
  name: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  control: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  flex: { flex: 1 },
});
