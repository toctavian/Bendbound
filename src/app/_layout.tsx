import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppProvider } from '@/state/AppProvider';
import { colors, tabBarStyle } from '@/theme';

export default function RootLayout() {
  return (
    <AppProvider>
      <StatusBar style="light" />
      <Tabs
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: colors.canvas },
          tabBarActiveTintColor: colors.route,
          tabBarInactiveTintColor: '#85888e',
          tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
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
        <Tabs.Screen name="bike" options={{ href: null }} />
      </Tabs>
    </AppProvider>
  );
}
