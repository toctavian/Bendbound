import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, ReduceMotion, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { colors, radii, spacing } from '@/theme';

const spring = { duration: 300, dampingRatio: 0.8, overshootClamping: true, reduceMotion: ReduceMotion.System };

/** Keeps the map interactive above a route preview with two handle-controlled detents. */
export function RoutePreviewSheet({ title, maxHeight, onVisibleHeightChange, children }: {
  title: string;
  maxHeight: number;
  onVisibleHeightChange: (height: number) => void;
  children: ReactNode;
}) {
  const [height, setHeight] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const translateY = useSharedValue(0);
  const dragStart = useSharedValue(0);
  const targetCollapsed = useSharedValue(false);
  const travel = Math.max(0, height - headerHeight);

  useEffect(() => {
    // Remeasure on rotation, text scaling or changes to route content.
    cancelAnimation(translateY);
    translateY.set(targetCollapsed.get() ? travel : 0);
  }, [targetCollapsed, translateY, travel]);

  useEffect(() => {
    onVisibleHeightChange(collapsed ? headerHeight : height);
  }, [collapsed, headerHeight, height, onVisibleHeightChange]);

  const commit = useCallback((next: boolean) => setCollapsed(next), []);
  const pan = useMemo(() => Gesture.Pan()
    .activeOffsetY([-8, 8])
    .onStart(() => {
      cancelAnimation(translateY);
      dragStart.set(translateY.get());
    })
    .onUpdate((event) => {
      const next = dragStart.get() + event.translationY;
      // Resist movement beyond either detent without exposing the sheet's bottom.
      translateY.set(next < 0 ? next * 0.15 : Math.min(next, travel));
    })
    .onEnd((event) => {
      const projected = translateY.get() + ((event.velocityY / 1000) * 0.998) / (1 - 0.998);
      const next = travel > 0 && projected > travel / 2;
      targetCollapsed.set(next);
      translateY.set(withSpring(next ? travel : 0, { ...spring, velocity: event.velocityY }));
      scheduleOnRN(commit, next);
    })
    .onFinalize((_event, success) => {
      if (!success) translateY.set(withSpring(targetCollapsed.get() ? travel : 0, spring));
    }), [commit, dragStart, targetCollapsed, translateY, travel]);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.get() }] }));
  const toggle = () => {
    const next = !collapsed;
    targetCollapsed.set(next);
    translateY.set(withSpring(next ? travel : 0, spring));
    setCollapsed(next);
  };

  return (
    <View pointerEvents="box-none" style={styles.clip}>
      <Animated.View style={[styles.sheet, { maxHeight }, animatedStyle]}
        onLayout={(event) => setHeight(Math.ceil(event.nativeEvent.layout.height))}>
        <GestureDetector gesture={pan}>
          <View collapsable={false} onLayout={(event) => setHeaderHeight(Math.ceil(event.nativeEvent.layout.height))}>
            <Pressable accessibilityRole="button" accessibilityLabel="Route details"
              accessibilityHint={collapsed ? 'Tap or swipe up to expand' : 'Tap or swipe down to minimise and see more of the map'}
              accessibilityState={{ expanded: !collapsed }} onPress={toggle} style={styles.header}>
              <View style={styles.handle} />
              <Text style={styles.title} numberOfLines={1}>{title}</Text>
            </Pressable>
          </View>
        </GestureDetector>
        <ScrollView style={styles.body} contentContainerStyle={styles.content} scrollEnabled={!collapsed}
          accessibilityElementsHidden={collapsed} importantForAccessibility={collapsed ? 'no-hide-descendants' : 'auto'}>
          {children}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, overflow: 'hidden' },
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: colors.charcoal,
    borderTopLeftRadius: radii.lg, borderTopRightRadius: radii.lg, overflow: 'hidden' },
  header: { paddingHorizontal: spacing.lg, paddingTop: 16, paddingBottom: 14, minHeight: 72 },
  handle: { alignSelf: 'center', backgroundColor: '#666a70', borderRadius: 2, height: 4, width: 54, marginBottom: 14 },
  title: { color: colors.white, fontSize: 22, fontWeight: '600', letterSpacing: -0.4 },
  body: { flexShrink: 1 },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
});
