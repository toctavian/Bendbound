import { RouteColorPicker } from '@/components/RouteColorPicker';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActionButton, IconName, ToggleRow } from '@/components/ui';
import { useApp } from '@/state/AppProvider';
import { colors, spacing } from '@/theme';
import { fromGpx, routeDistance, tourFromDraft } from '@/utils/routes';
import { motorcycles, motorcycleTypeOrDefault } from '@/data/motorcycles';

const chart = [30, 52, 44, 82, 68, 101, 73, 118, 95, 62, 88, 47, 71, 39, 56];

function MenuRow({ icon, label, detail, onPress }: { icon: IconName; label: string; detail?: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.menuRow}>
      <Ionicons color={colors.muted} name={icon} size={22} />
      <View style={styles.menuCopy}>
        <Text style={styles.menuLabel}>{label}</Text>
        {detail ? <Text style={styles.menuDetail}>{detail}</Text> : null}
      </View>
      <Ionicons color="#666a70" name="chevron-forward" size={18} />
    </Pressable>
  );
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const { tours, settings, updateSettings, saveTour } = useApp();
  const completed = tours.filter((tour) => tour.completed && tour.recording);
  const totalKm = completed.reduce((total, tour) => total + tour.distanceKm, 0);
  const totalMinutes = completed.reduce((total, tour) => total + tour.durationMin, 0);
  const bikeType = motorcycleTypeOrDefault(settings.motorcycleType);
  const openBikeSettings = () => router.push('/bike');
  const offlineUnavailable = () => Alert.alert('Offline maps unavailable', 'No offline map regions have been downloaded. Map tiles and route planning currently require an internet connection.');

  const importGpx = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, type: ['application/gpx+xml', 'text/xml', 'application/xml', '*/*'] });
      if (result.canceled) return;
      const contents = await FileSystem.readAsStringAsync(result.assets[0].uri);
      const route = fromGpx(contents);
      if (route.length < 2) throw new Error('This file does not contain a GPX track or route.');
      const distanceKm = Math.round(routeDistance(route));
      saveTour(tourFromDraft({
        title: result.assets[0].name.replace(/\.gpx$/i, ''),
        route,
        distanceKm,
        durationMin: Math.max(1, Math.round((distanceKm / 52) * 60)),
        curves: Math.round(distanceKm * 0.65),
        profile: 'winding',
      }));
      Alert.alert('GPX imported', 'The route is ready in Saved.');
    } catch (error) {
      Alert.alert('Import failed', error instanceof Error ? error.message : 'The selected file could not be read.');
    }
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.avatar}><Text style={styles.avatarText}>O</Text></View>
          <View style={styles.headerCopy}>
            <Text style={styles.name}>Octavian</Text>
            <Text style={styles.handle}>@octavian / Bendbound member</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Routes and bike settings" onPress={openBikeSettings} style={styles.settingsButton}><Ionicons color={colors.ink} name="settings-outline" size={22} /></Pressable>
        </View>

        <View style={styles.statsPanel}>
          <View style={styles.summaryRow}>
            <View><Text style={styles.summaryValue}>{totalKm.toLocaleString()} km</Text><Text style={styles.summaryLabel}>TOTAL DISTANCE</Text></View>
            <View><Text style={styles.summaryValue}>{Math.round(totalMinutes / 60)} h</Text><Text style={styles.summaryLabel}>RIDING TIME</Text></View>
            <View><Text style={styles.summaryValue}>{completed.length}</Text><Text style={styles.summaryLabel}>TOURS</Text></View>
          </View>
          <Text style={styles.chartTitle}>Your riding activity</Text>
          <View style={styles.chart}>
            {chart.map((height, index) => <View key={index} style={[styles.bar, { height }]} />)}
          </View>
          <View style={styles.chartAxis}><Text style={styles.axisText}>JAN</Text><Text style={styles.axisText}>NOW</Text></View>
        </View>

        <Text style={styles.sectionTitle}>Navigation</Text>
        <View style={styles.group}>
          <View style={styles.unitRow}>
            <View style={styles.unitLabel}>
              <Ionicons color={colors.muted} name="speedometer-outline" size={22} />
              <Text style={styles.menuLabel}>Speed units</Text>
            </View>
            <View accessibilityRole="radiogroup" accessibilityLabel="Speed units" style={styles.unitOptions}>
              {(['km/h', 'mph'] as const).map((speedUnit) => <Pressable key={speedUnit} accessibilityRole="radio" accessibilityLabel={speedUnit} accessibilityState={{ checked: settings.speedUnit === speedUnit }} onPress={() => updateSettings({ speedUnit })} style={[styles.unitOption, settings.speedUnit === speedUnit && styles.unitActive]}>
                <Text style={styles.unitText}>{speedUnit}</Text>
              </Pressable>)}
            </View>
          </View>
          <RouteColorPicker value={settings.routeColor} onChange={(routeColor) => updateSettings({ routeColor })} />
          <ToggleRow icon="trail-sign-outline" label="Avoid motorways" detail="Prefer enjoyable motorcycle roads" value={settings.avoidMotorways} onPress={() => updateSettings({ avoidMotorways: !settings.avoidMotorways })} />
          <MenuRow icon="cloud-offline-outline" label="Offline maps" detail="Not available" onPress={offlineUnavailable} />
          <ToggleRow icon="volume-high-outline" label="Voice instructions" value={settings.voiceGuidance} onPress={() => updateSettings({ voiceGuidance: !settings.voiceGuidance })} />
          <ToggleRow icon="warning-outline" label="Hazard warnings" value={settings.hazards} onPress={() => updateSettings({ hazards: !settings.hazards })} />
          <ToggleRow icon="speedometer-outline" label="Speed limits" value={settings.speedLimits} onPress={() => updateSettings({ speedLimits: !settings.speedLimits })} />
        </View>

        <Text style={styles.sectionTitle}>Routes & bike</Text>
        <View style={styles.group}>
          <MenuRow icon="speedometer-outline" label="My motorcycle" detail={settings.motorcycleName?.trim() || motorcycles[bikeType].label} onPress={openBikeSettings} />
          <MenuRow icon="trail-sign-outline" label="Route preferences" detail={settings.routingProfile ?? 'winding'} onPress={openBikeSettings} />
          <MenuRow icon="bookmark-outline" label="My tours & saved routes" onPress={() => router.navigate('/tours')} />
          <MenuRow icon="download-outline" label="Offline map regions" detail="Not available" onPress={offlineUnavailable} />
          <MenuRow icon="people-outline" label="Group rides" detail="Live sharing not available" onPress={() => Alert.alert('Live group rides unavailable', 'Live group location sharing is not connected in this build.', [
            { text: 'Close', style: 'cancel' },
            { text: 'Open tours', onPress: () => router.navigate('/tours') },
          ])} />
          <ToggleRow icon="lock-closed-outline" label="Private profile" value={settings.privateProfile} onPress={() => updateSettings({ privateProfile: !settings.privateProfile })} />
        </View>

        <Text style={styles.sectionTitle}>GPX exchange</Text>
        <View style={styles.importPanel}>
          <View style={styles.importIcon}><Ionicons color={colors.action} name="document-text-outline" size={28} /></View>
          <View style={styles.importCopy}><Text style={styles.importTitle}>Bring your routes to Bendbound</Text><Text style={styles.importMeta}>Import GPX tracks from another planner or navigation device.</Text></View>
          <ActionButton compact icon="add" label="Import" onPress={importGpx} variant="primary" />
        </View>

        <View style={styles.brandFooter}>
          <Image accessibilityLabel="Bendbound" source={require('../../assets/bendbound-logo.png')} resizeMode="contain" style={styles.brandLogo} />
          <Text style={styles.version}>Bendbound 1.0.0</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  brandFooter: { alignItems: 'center', backgroundColor: '#000000', marginTop: 30, marginHorizontal: -spacing.md, paddingVertical: 20 },
  brandLogo: { width: 160, height: 160 },
  unitRow: { minHeight: 64, paddingVertical: 10, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  unitLabel: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  unitOptions: { flexDirection: 'row', backgroundColor: colors.panelAlt, borderRadius: 6, padding: 3 },
  unitOption: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
  unitActive: { backgroundColor: colors.route },
  unitText: { color: colors.white, fontSize: 14, fontWeight: '700' },
  avatar: { alignItems: 'center', backgroundColor: colors.route, borderRadius: 29, height: 58, justifyContent: 'center', width: 58 },
  avatarText: { color: colors.white, fontSize: 23, fontWeight: '900' },
  axisText: { color: colors.muted, fontSize: 10, fontWeight: '800' },
  bar: { backgroundColor: '#62666d', borderTopLeftRadius: 2, borderTopRightRadius: 2, flex: 1 },
  chart: { alignItems: 'flex-end', borderBottomColor: colors.line, borderBottomWidth: 1, flexDirection: 'row', gap: 4, height: 125, marginTop: 14 },
  chartAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
  chartTitle: { color: colors.ink, fontSize: 14, fontWeight: '800', marginTop: 22 },
  content: { padding: spacing.md, paddingBottom: 110 },
  group: { backgroundColor: colors.panel, borderRadius: 7, paddingHorizontal: spacing.md },
  header: { alignItems: 'center', flexDirection: 'row' },
  headerCopy: { flex: 1, marginLeft: 12 },
  importCopy: { flex: 1 },
  importIcon: { alignItems: 'center', backgroundColor: colors.panelAlt, borderRadius: 25, height: 50, justifyContent: 'center', width: 50 },
  importMeta: { color: colors.muted, fontSize: 12, lineHeight: 16, marginTop: 3 },
  importPanel: { alignItems: 'center', backgroundColor: colors.panel, borderRadius: 7, flexDirection: 'row', gap: 12, padding: spacing.md },
  importTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  menuCopy: { flex: 1 },
  menuDetail: { color: colors.muted, fontSize: 12, marginTop: 3 },
  menuLabel: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  menuRow: { alignItems: 'center', borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 12, minHeight: 64 },
  name: { color: colors.ink, fontSize: 24, fontWeight: '900' },
  handle: { color: colors.muted, fontSize: 12, marginTop: 3 },
  screen: { backgroundColor: colors.canvas, flex: 1 },
  sectionTitle: { color: colors.ink, fontSize: 20, fontWeight: '900', marginBottom: 9, marginTop: 24 },
  settingsButton: { alignItems: 'center', backgroundColor: colors.panelAlt, borderRadius: 21, height: 42, justifyContent: 'center', width: 42 },
  statsPanel: { backgroundColor: colors.panel, borderRadius: 7, marginTop: spacing.md, padding: spacing.md },
  summaryLabel: { color: colors.muted, fontSize: 9, fontWeight: '800', marginTop: 3 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between' },
  summaryValue: { color: colors.ink, fontSize: 18, fontWeight: '900' },
  version: { color: '#64676c', fontSize: 11, marginTop: 8, textAlign: 'center' },
});
