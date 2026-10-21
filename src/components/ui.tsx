import Ionicons from '@expo/vector-icons/Ionicons';
import { ComponentProps, ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View, type ViewProps } from 'react-native';
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
  // Dark ink keeps the existing accent fills readable at body size.
  const foreground = variant === 'primary' || variant === 'success' || variant === 'danger' ? colors.canvas : colors.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
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
      {loading ? <ActivityIndicator color={foreground} size="small" /> :
        icon ? <Ionicons color={foreground} name={icon} size={18} /> : null}
      <Text style={[styles.buttonText, { color: foreground }]}>{label}</Text>
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
    <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityHint={detail} accessibilityState={{ checked: value }} onPress={onPress} style={({ pressed }) => [styles.toggleRow, pressed && styles.rowPressed]}>
      <View style={styles.rowIcon}>
        <Ionicons color={colors.muted} name={icon} size={21} />
      </View>
      <View style={styles.toggleCopy}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {detail ? <Text style={styles.toggleDetail}>{detail}</Text> : null}
      </View>
      <View pointerEvents="none" importantForAccessibility="no-hide-descendants">
        <Switch accessible={false} value={value} onValueChange={onPress} trackColor={{ false: colors.line, true: colors.actionGreen }} thumbColor={colors.white} ios_backgroundColor={colors.line} />
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
    minHeight: 50,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
  },
  buttonCompact: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10 },
  buttonText: { color: colors.ink, fontSize: 16, fontWeight: '600', flexShrink: 1, textAlign: 'center' },
  danger: { backgroundColor: colors.route },
  disabled: { opacity: 0.45 },
  ghost: { backgroundColor: 'transparent' },
  handle: { alignSelf: 'center', backgroundColor: '#666a70', borderRadius: 2, height: 4, marginBottom: 14, width: 54 },
  iconButton: {
    alignItems: 'center',
    backgroundColor: colors.charcoal,
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
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    bottom: 0,
    left: 0,
    padding: spacing.lg,
    position: 'absolute',
    right: 0,
  },
  stat: { alignItems: 'center', flex: 1 },
  statLabel: { color: colors.muted, fontSize: 13, fontWeight: '500', marginTop: 4 },
  statLabelLight: { color: '#60646a' },
  statValue: { color: colors.white, fontSize: 22, fontWeight: '600', fontVariant: ['tabular-nums'], letterSpacing: -0.4 },
  statValueLight: { color: colors.charcoal },
  success: { backgroundColor: colors.actionGreen },
  toggleCopy: { flex: 1, minWidth: 0 },
  toggleDetail: { color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 4 },
  toggleLabel: { color: colors.ink, fontSize: 16, fontWeight: '500' },
  toggleRow: { alignItems: 'center', borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, minHeight: 64, paddingVertical: 12 },
  rowPressed: { opacity: 0.72 },
});
