import { useAccountSignOutRecovery } from '@/hooks/useAccountSignOutRecovery';
import { useActiveRideKeepAwake } from '@/hooks/useActiveRideKeepAwake';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { AppProvider } from '@/state/AppProvider';
import { colors, tabBarStyle } from '@/theme';

export default function RootLayout() {
  useActiveRideKeepAwake();
  useAccountSignOutRecovery();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppProvider>
        <StatusBar style="light" />
        <Tabs
          screenOptions={{
            headerShown: false,
            sceneStyle: { backgroundColor: colors.canvas },
            tabBarActiveTintColor: colors.route,
            tabBarInactiveTintColor: colors.muted,
            tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
            tabBarStyle,
          }}
        >
          <Tabs.Screen
            name="ride"
            options={{ title: 'Map', tabBarIcon: ({ color, size }) => <Ionicons color={color} name="map-outline" size={size} /> }}
          />
          <Tabs.Screen
            name="tours"
            options={{ title: 'Tours', tabBarIcon: ({ color, size }) => <Ionicons color={color} name="albums-outline" size={size} /> }}
          />
          <Tabs.Screen
            name="profile"
            options={{ title: 'Profile', tabBarIcon: ({ color, size }) => <Ionicons color={color} name="person-outline" size={size} /> }}
          />
          <Tabs.Screen name="tour/[id]" options={{ href: null }} />
          <Tabs.Screen name="index" options={{ href: null }} />
          <Tabs.Screen name="auth/callback" options={{ href: null }} />
          <Tabs.Screen name="bike" options={{ href: null }} />
          <Tabs.Screen name="group/[id]" options={{ href: null }} />
          <Tabs.Screen name="shared/[id]" options={{ href: null }} />
        </Tabs>
      </AppProvider>
    </GestureHandlerRootView>
  );
}
