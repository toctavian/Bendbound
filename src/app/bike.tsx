import { RouteColorPicker } from '@/components/RouteColorPicker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconButton, ToggleRow } from '@/components/ui';
import { MotorcycleGlyph } from '@/components/MotorcycleGlyph';
import { motorcycles } from '@/data/motorcycles';
import { useApp } from '@/state/AppProvider';
import { colors, spacing } from '@/theme';
import type { MotorcycleType } from '@/types';

export default function BikeScreen() {
  const insets = useSafeAreaInsets();
  const { settings, updateSettings, ready } = useApp();
  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <IconButton icon="chevron-back" label="Back to profile" onPress={() => router.navigate('/profile')} />
        <Text style={styles.title}>Routes & bike</Text>
      </View>
      {!ready ? <ActivityIndicator color={colors.route} style={styles.loading} /> : <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.sectionTitle}>My motorcycle</Text>
        <Text style={styles.label}>Make and model</Text>
        <TextInput accessibilityLabel="Motorcycle make and model" maxLength={60} placeholder="Make and model (optional)" placeholderTextColor={colors.muted} value={settings.motorcycleName} onChangeText={(motorcycleName) => updateSettings({ motorcycleName })} style={styles.input} returnKeyType="done" />
        <Text style={styles.sectionTitle}>Motorcycle marker</Text>
        <View accessibilityRole="radiogroup">
          {(Object.keys(motorcycles) as MotorcycleType[]).map((type) => {
            const selected = settings.motorcycleType === type;
            return <Pressable key={type} accessibilityRole="radio" accessibilityLabel={motorcycles[type].label} accessibilityState={{ checked: selected }} onPress={() => updateSettings({ motorcycleType: type })} style={[styles.bikeRow, selected && styles.selected]}>
              <MotorcycleGlyph type={type} size={81} />
              <View style={styles.bikeCopy}>
                <Text style={styles.bikeLabel}>{motorcycles[type].label}</Text>
                <Text style={styles.bikeModel}>{motorcycles[type].model}</Text>
              </View>
              <Ionicons name={selected ? 'radio-button-on' : 'radio-button-off'} color={selected ? colors.route : colors.muted} size={24} />
            </Pressable>;
          })}
        </View>
        <RouteColorPicker value={settings.routeColor} onChange={(routeColor) => updateSettings({ routeColor })} />
        <Text style={styles.sectionTitle}>Route preferences</Text>
        <View accessibilityRole="radiogroup" style={styles.profiles}>
          {(['fast', 'winding', 'twisty'] as const).map((routingProfile) => <Pressable key={routingProfile} accessibilityRole="radio" accessibilityLabel={`${routingProfile} routes`} accessibilityState={{ checked: settings.routingProfile === routingProfile }} onPress={() => updateSettings({ routingProfile })} style={[styles.profile, settings.routingProfile === routingProfile && styles.profileActive]}>
            <Text style={styles.profileText}>{routingProfile}</Text>
          </Pressable>)}
        </View>
        <ToggleRow icon="trail-sign-outline" label="Avoid motorways" value={settings.avoidMotorways} onPress={() => updateSettings({ avoidMotorways: !settings.avoidMotorways })} />
      </ScrollView>}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: spacing.md },
  title: { color: colors.ink, fontSize: 23, fontWeight: '900', flex: 1 },
  content: { padding: spacing.md, paddingBottom: 28 },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: '800', marginTop: 20, marginBottom: 12 },
  label: { color: colors.muted, fontSize: 12, marginBottom: 8 },
  input: { color: colors.ink, backgroundColor: colors.panelAlt, borderRadius: 6, paddingHorizontal: 12, minHeight: 48, fontSize: 16 },
  bikeRow: { minHeight: 105, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  selected: { backgroundColor: colors.panelAlt },
  bikeCopy: { flex: 1, minWidth: 0 },
  bikeLabel: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  bikeModel: { color: colors.muted, fontSize: 12, lineHeight: 16, marginTop: 3 },
  profiles: { backgroundColor: colors.panelAlt, borderRadius: 6, padding: 3, flexDirection: 'row', marginBottom: 8 },
  profile: { flex: 1, minHeight: 44, borderRadius: 4, justifyContent: 'center', alignItems: 'center' },
  profileActive: { backgroundColor: colors.route },
  profileText: { color: colors.white, fontSize: 14, fontWeight: '700', textTransform: 'capitalize' },
  loading: { marginTop: 40 },
});
