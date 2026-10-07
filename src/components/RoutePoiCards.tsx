import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { RoutePointOfInterest } from '@/types';
import { colors } from '@/theme';

type Props = {
  points: RoutePointOfInterest[];
  selectedId?: string;
  tint: string;
  loading: boolean;
  error: boolean;
  onSelect: (point: RoutePointOfInterest) => void;
  onRetry: () => void;
};

export function RoutePoiCards({ points, selectedId, tint, loading, error, onSelect, onRetry }: Props) {
  const scroll = useRef<ScrollView>(null);
  const [cardWidth, setCardWidth] = useState(280);
  useEffect(() => {
    const index = points.findIndex((point) => point.id === selectedId);
    if (index >= 0) scroll.current?.scrollTo({ x: index * (cardWidth + 10), animated: true });
  }, [cardWidth, points, selectedId]);

  return (
    <View style={styles.section} onLayout={(event) => setCardWidth(Math.min(300, Math.max(180, event.nativeEvent.layout.width - 24)))}>
      <View style={styles.heading}>
        <Text style={styles.title}>Along your route{points.length ? ` · ${points.length}` : ''}</Text>
        {points.length > 1 ? <Text style={styles.hint}>Swipe to explore</Text> : null}
      </View>
      {loading ? <View style={styles.status}><ActivityIndicator color={tint} /><Text style={styles.meta}>Finding points of interest…</Text></View>
        : error ? <View style={styles.status}><Text style={[styles.meta, styles.flex]}>Couldn’t load places along this route.</Text><Pressable accessibilityRole="button" onPress={onRetry} style={styles.retry}><Text style={styles.retryText}>Retry</Text></Pressable></View>
          : !points.length ? <Text style={styles.empty}>No mapped points of interest found near this route.</Text>
            : <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast"
              snapToInterval={cardWidth + 10} contentContainerStyle={styles.cards}
              onMomentumScrollEnd={(event) => {
                const index = Math.max(0, Math.min(points.length - 1, Math.round(event.nativeEvent.contentOffset.x / (cardWidth + 10))));
                if (points[index].id !== selectedId) onSelect(points[index]);
              }}>
              {points.map((point) => (
                <Pressable key={point.id} accessibilityRole="button" accessibilityState={{ selected: selectedId === point.id }}
                  accessibilityLabel={`Point ${point.number}, ${point.name}, ${point.distanceAlongKm.toFixed(1)} kilometres into the ride. ${point.detail}. Show on map.`}
                  onPress={() => onSelect(point)} style={[styles.card, { width: cardWidth, borderColor: selectedId === point.id ? tint : colors.line }]}>
                  <View style={styles.heading}>
                    <View style={[styles.number, { backgroundColor: tint }]}><Text style={styles.numberText}>{point.number}</Text></View>
                    <Text style={styles.name} numberOfLines={2}>{point.name}</Text>
                  </View>
                  <Text style={styles.detail} numberOfLines={2}>{point.detail}</Text>
                  <Text style={styles.meta}>{point.distanceAlongKm.toFixed(1)} km into ride · {point.distanceFromRouteKm < 0.02 ? 'By the road' : `${Math.round(point.distanceFromRouteKm * 1000)} m from route`}</Text>
                </Pressable>
              ))}
            </ScrollView>}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 14 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { color: colors.ink, fontSize: 13, fontWeight: '800', flex: 1 },
  hint: { color: colors.muted, fontSize: 11 },
  cards: { gap: 10, paddingTop: 10, paddingRight: 24 },
  card: { backgroundColor: colors.panelAlt, borderRadius: 10, borderWidth: 2, padding: 12, gap: 8 },
  number: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  numberText: { color: colors.white, fontSize: 14, fontWeight: '900' },
  name: { color: colors.ink, fontSize: 15, fontWeight: '800', flex: 1 },
  detail: { color: colors.ink, fontSize: 12, textTransform: 'capitalize' },
  meta: { color: colors.muted, fontSize: 11 },
  flex: { flex: 1 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 58 },
  empty: { color: colors.muted, fontSize: 12, paddingVertical: 16 },
  retry: { padding: 12, minHeight: 44, justifyContent: 'center' },
  retryText: { color: colors.ink, fontWeight: '800' },
});
