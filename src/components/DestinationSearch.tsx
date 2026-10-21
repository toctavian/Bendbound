import Ionicons from '@expo/vector-icons/Ionicons';
import { ReactNode, useEffect, useRef } from 'react';
import { ActivityIndicator, BackHandler, Keyboard, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconButton, Sheet } from '@/components/ui';
import { usePlaceSuggestions } from '@/hooks/usePlaceSuggestions';
import { colors, radii } from '@/theme';
import type { Coordinate } from '@/types';
import type { PlaceSuggestion } from '@/utils/places';

type Props = {
  placeholder?: string;
  collapsedMaxHeight?: number;
  onLayout?: (event: LayoutChangeEvent) => void;
  query: string;
  onChangeQuery: (query: string) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  center: Coordinate;
  busy: boolean;
  onSelect: (place: PlaceSuggestion) => void;
  children: ReactNode;
};

export function DestinationSearch({ query, onChangeQuery, expanded, onExpandedChange, center, busy, onSelect, children, onLayout, collapsedMaxHeight, placeholder = 'Where do you want to ride?' }: Props) {
  const insets = useSafeAreaInsets();
  const input = useRef<TextInput>(null);
  const { places, loading, error, retry } = usePlaceSuggestions(query, center, expanded && !busy);
  const close = () => { if (!busy) { Keyboard.dismiss(); onExpandedChange(false); } };

  useEffect(() => {
    if (!expanded) return;
    input.current?.focus();
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!busy) { Keyboard.dismiss(); onExpandedChange(false); }
      return true;
    });
    return () => subscription.remove();
  }, [busy, expanded, onExpandedChange]);

  return (
    <KeyboardAvoidingView pointerEvents="box-none" style={[StyleSheet.absoluteFill, expanded && styles.expandedPanel, expanded && { top: insets.top + 56 }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined} enabled={expanded}>
      <View pointerEvents="box-none" style={styles.container}>
        <Sheet onLayout={onLayout} showHandle={false} style={expanded ? { position: 'relative', flex: 1, paddingBottom: Math.max(14, insets.bottom) } : { position: 'relative', maxHeight: collapsedMaxHeight }}>
          <View style={styles.searchRow}>
            {expanded ? <IconButton icon="chevron-back" label="Close place search" onPress={close} /> : <Ionicons color={colors.muted} name="search" size={21} />}
            <TextInput ref={input} accessibilityLabel="Search places" editable={!busy} maxLength={120} autoCorrect={false}
              onFocus={() => onExpandedChange(true)} onChangeText={onChangeQuery}
              onSubmitEditing={() => { onExpandedChange(true); if (error) retry(); }} submitBehavior="submit"
              placeholder={placeholder} placeholderTextColor={colors.muted} returnKeyType="search"
              style={styles.searchInput} value={query} />
            {query && !busy ? <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => { onChangeQuery(''); input.current?.focus(); }} style={styles.clear}>
              <Ionicons color={colors.muted} name="close-circle" size={20} />
            </Pressable> : null}
          </View>
          {expanded ? <>
            <ScrollView style={styles.results} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.resultContent}>
              {busy || loading ? <View style={styles.status} accessibilityLiveRegion="polite"><ActivityIndicator color={colors.action} /><Text style={styles.statusText}>{busy ? 'Planning route...' : 'Searching...'}</Text></View> : null}
              {error ? <View style={styles.status} accessibilityLiveRegion="polite"><Text style={styles.statusText}>Place search is unavailable</Text><IconButton icon="refresh" label="Retry place search" onPress={retry} /></View> : null}
              {!busy && !loading && !error && query.trim().length >= 2 && places.length === 0 ? <Text style={styles.empty} accessibilityLiveRegion="polite">No places found</Text> : null}
              {places.map((place) => <Pressable key={place.id} accessibilityRole="button" accessibilityLabel={[place.name, place.address].filter(Boolean).join(', ')} disabled={busy}
                onPress={() => { Keyboard.dismiss(); onSelect(place); }} style={({ pressed }) => [styles.result, pressed && styles.pressed]}>
                <Ionicons color={colors.action} name="location-outline" size={22} />
                <View style={styles.copy}><Text style={styles.name} numberOfLines={2}>{place.name}</Text>{place.address ? <Text style={styles.address} numberOfLines={2}>{place.address}</Text> : null}</View>
                <Ionicons color={colors.muted} name="chevron-forward" size={17} />
              </Pressable>)}
            </ScrollView>
            <Text accessibilityRole="link" onPress={() => { void Linking.openURL('https://www.openstreetmap.org/copyright').catch(() => undefined); }} style={styles.attribution}>Photon / OpenStreetMap contributors</Text>
          </> : children}
        </Sheet>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  // Paint the keyboard padding too, including the exposed rounded keyboard corners.
  expandedPanel: { backgroundColor: colors.charcoal, borderTopLeftRadius: radii.lg, borderTopRightRadius: radii.lg },
  container: { flex: 1, justifyContent: 'flex-end' },
  searchRow: { alignItems: 'center', backgroundColor: colors.panelAlt, borderRadius: radii.sm, flexDirection: 'row', gap: 10, marginBottom: 14, paddingHorizontal: 12, minHeight: 52 },
  searchInput: { color: colors.ink, flex: 1, minWidth: 0, fontSize: 16, minHeight: 52, paddingHorizontal: 4 },
  clear: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  results: { flex: 1 },
  resultContent: { paddingBottom: 12 },
  result: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 76, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  pressed: { backgroundColor: colors.panelAlt },
  copy: { flex: 1, minWidth: 0 },
  name: { color: colors.ink, fontSize: 16, fontWeight: '600', lineHeight: 21 },
  address: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 3 },
  status: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, minHeight: 76 },
  statusText: { color: colors.muted, fontSize: 14, flexShrink: 1 },
  empty: { color: colors.muted, fontSize: 14, textAlign: 'center', paddingVertical: 28 },
  attribution: { color: colors.muted, fontSize: 11, paddingTop: 8, textAlign: 'center' },
});
