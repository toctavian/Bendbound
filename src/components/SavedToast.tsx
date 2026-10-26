import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { colors, radii } from '@/theme';

/** Mounted with a new key for each save or removal; never intercepts touches or asks for input. */
export function SavedToast({ bottom, saved = true }: { bottom: number; saved?: boolean }) {
  const [opacity] = useState(() => new Animated.Value(0));
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    const animation = Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true, isInteraction: false }),
      Animated.delay(1200),
      Animated.timing(opacity, { toValue: 0, duration: 450, useNativeDriver: true, isInteraction: false }),
    ]);
    animation.start(({ finished }) => { if (finished) setFinished(true); });
    return () => animation.stop();
  }, [opacity]);
  if (finished) return null;
  return <View pointerEvents="none" style={[styles.position, { bottom }]}>
    <Animated.View accessibilityRole="text" accessibilityLiveRegion="polite" style={[styles.toast, { opacity }]}>
      <Ionicons name={saved ? 'checkmark-circle' : 'close-circle'} size={20} color={colors.actionGreen} />
      <Text style={styles.text}>{saved ? 'Saved' : 'Removed'}</Text>
    </Animated.View>
  </View>;
}
const styles = StyleSheet.create({
  position: { position: 'absolute', left: 20, right: 20, alignItems: 'center', zIndex: 50 },
  toast: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 18, paddingVertical: 12, borderRadius: radii.md, backgroundColor: '#292b2feb', borderWidth: 1, borderColor: colors.line },
  text: { color: colors.ink, fontSize: 15, fontWeight: '700' },
});
