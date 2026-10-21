import * as Linking from 'expo-linking';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GroupRidePanel } from '@/components/GroupRidePanel';
import { ActionButton } from '@/components/ui';
import { parseGroupInvite } from '@/services/groups/client';
import { useApp } from '@/state/AppProvider';
import { readRideState } from '@/services/rideStore';
import { colors } from '@/theme';
export default function GroupInviteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const url = Linking.useURL();
  const invite = useMemo(() => parseGroupInvite(url, id), [url, id]);
  const { settings, setActiveRoute, updateSettings } = useApp();
  const insets = useSafeAreaInsets();
  return <ScrollView contentContainerStyle={{ padding: 22, paddingTop: insets.top + 20, gap: 20 }} style={{ flex: 1, backgroundColor: colors.canvas }}>
    {invite ? <GroupRidePanel motorcycleType={settings.motorcycleType} avoidMotorways={settings.avoidMotorways} invite={{ roomId: id, ...invite }} onOpenRoute={(route, avoidMotorways) => {
      if (readRideState().active) throw new Error('Finish your current ride before opening the invited route.');
      setActiveRoute(route); updateSettings({ avoidMotorways, routingProfile: route.profile });
      router.replace({ pathname: '/ride', params: { imported: `group-${Date.now()}` } });
    }} /> : <Text style={{ color: colors.ink }}>Open the complete group invitation from the host, including its invite code.</Text>}
    <ActionButton label="Back to map" onPress={() => router.replace('/ride')} />
  </ScrollView>;
}
