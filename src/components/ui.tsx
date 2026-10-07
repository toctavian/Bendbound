import Ionicons from '@expo/vector-icons/Ionicons';
import { ComponentProps, ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewProps } from 'react-native';
import { colors, radii, spacing } from '@/theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

type ButtonProps = {
  label: string;
  icon?: IconName;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
  compact?: boolean;
  variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'ghost';
};

export function ActionButton({
  label,
  icon,
  onPress,
  disabled,
  loading,
  compact,
  variant = 'secondary',
}: ButtonProps) {
  const strong = variant === 'primary' || variant === 'danger' || variant === 'success';
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        variant === 'primary' && styles.primary,
        variant === 'danger' && styles.danger,
        variant === 'success' && styles.success,
        variant === 'ghost' && styles.ghost,
        (disabled || loading) && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={strong ? colors.white : colors.ink} size="small" />
      ) : (
        <>
          {icon ? <Ionicons color={strong ? colors.white : colors.ink} name={icon} size={18} /> : null}
          <Text style={[styles.buttonText, strong && styles.buttonTextStrong]} numberOfLines={1}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

export function IconButton({
  icon,
  onPress,
  active,
  light,
  label,
}: {
  icon: IconName;
  onPress?: () => void;
  active?: boolean;
  light?: boolean;
  label: string;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, light && styles.iconButtonLight, active && styles.iconButtonActive, pressed && styles.pressed]}
    >
      <Ionicons color={light ? colors.charcoal : colors.white} name={icon} size={22} />
    </Pressable>
  );
}

export function Sheet({ children, style, showHandle = true, onLayout }: { children: ReactNode; style?: object; showHandle?: boolean; onLayout?: ViewProps['onLayout'] }) {
  return (
    <View style={[styles.sheet, style]} onLayout={onLayout}>
      {showHandle ? <View style={styles.handle} /> : null}
      {children}
    </View>
  );
}

export function Stat({ label, value, light }: { label: string; value: string; light?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, light && styles.statValueLight]}>{value}</Text>
      <Text style={[styles.statLabel, light && styles.statLabelLight]}>{label}</Text>
    </View>
  );
}

export function ToggleRow({
  icon,
  label,
  detail,
  value,
  onPress,
}: {
  icon: IconName;
  label: string;
  detail?: string;
  value: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.toggleRow}>
      <View style={styles.rowIcon}>
        <Ionicons color={colors.muted} name={icon} size={21} />
      </View>
      <View style={styles.toggleCopy}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {detail ? <Text style={styles.toggleDetail}>{detail}</Text> : null}
      </View>
      <View style={[styles.switchTrack, value && styles.switchTrackActive]}>
        <View style={[styles.switchThumb, value && styles.switchThumbActive]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: colors.panelAlt,
    borderRadius: radii.sm,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  buttonCompact: { minHeight: 38, paddingHorizontal: 12 },
  buttonText: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  buttonTextStrong: { color: colors.white },
  danger: { backgroundColor: colors.route },
  disabled: { opacity: 0.45 },
  ghost: { backgroundColor: 'transparent' },
  handle: { alignSelf: 'center', backgroundColor: '#666a70', borderRadius: 2, height: 4, marginBottom: 14, width: 54 },
  iconButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(24,25,28,0.94)',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  iconButtonActive: { backgroundColor: colors.route },
  iconButtonLight: { backgroundColor: colors.white },
  pressed: { opacity: 0.76, transform: [{ scale: 0.98 }] },
  primary: { backgroundColor: colors.action },
  rowIcon: { alignItems: 'center', width: 30 },
  sheet: {
    backgroundColor: colors.charcoal,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    bottom: 0,
    left: 0,
    padding: spacing.md,
    position: 'absolute',
    right: 0,
  },
  stat: { alignItems: 'center', flex: 1 },
  statLabel: { color: colors.muted, fontSize: 10, fontWeight: '800', marginTop: 3, textTransform: 'uppercase' },
  statLabelLight: { color: '#60646a' },
  statValue: { color: colors.white, fontSize: 17, fontWeight: '900' },
  statValueLight: { color: colors.charcoal },
  success: { backgroundColor: colors.actionGreen },
  switchThumb: { backgroundColor: colors.white, borderRadius: 10, height: 20, left: 3, position: 'absolute', top: 3, width: 20 },
  switchThumbActive: { left: 23 },
  switchTrack: { backgroundColor: '#51545a', borderRadius: 13, height: 26, width: 46 },
  switchTrackActive: { backgroundColor: colors.actionGreen },
  toggleCopy: { flex: 1 },
  toggleDetail: { color: colors.muted, fontSize: 12, marginTop: 3 },
  toggleLabel: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  toggleRow: { alignItems: 'center', borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, minHeight: 62 },
});
