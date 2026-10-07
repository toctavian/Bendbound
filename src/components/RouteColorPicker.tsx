import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { routeColors, routeColorOrDefault } from '@/data/routeColors';
import { colors } from '@/theme';
import type { RouteColor } from '@/types';

type Props = { value: RouteColor; onChange: (color: RouteColor) => void };

export function RouteColorPicker({ value, onChange }: Props) {
  const selected = routeColorOrDefault(value);
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Route & arrow colour</Text>
      <Text style={styles.detail}>One colour for your route and turn arrows.</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Route and arrow colour" style={styles.options}>
        {(Object.keys(routeColors) as RouteColor[]).map((color) => (
          <Pressable key={color} accessibilityRole="radio" accessibilityLabel={`${routeColors[color].label} route and arrows`}
            accessibilityState={{ checked: selected === color }} onPress={() => onChange(color)} style={styles.option}>
            <View style={[styles.swatch, { backgroundColor: routeColors[color].value }, selected === color && styles.selected]}>
              {selected === color ? <Ionicons name="checkmark" size={20} color={colors.white} /> : null}
            </View>
            <Text style={styles.label}>{routeColors[color].label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  title: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  detail: { color: colors.muted, fontSize: 12, marginTop: 4 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  option: { minWidth: 44, minHeight: 62, alignItems: 'center', justifyContent: 'center', gap: 6 },
  swatch: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  selected: { borderColor: colors.white },
  label: { color: colors.ink, fontSize: 11 },
});
