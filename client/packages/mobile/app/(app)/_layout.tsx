import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useInitialData } from '@/hooks/useInitialData';

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return (
    <Text className={focused ? 'text-accent text-xs' : 'text-text-muted text-xs'}>
      {label}
    </Text>
  );
}

export default function AppLayout() {
  // Fetch servers, channels, DMs on mount and gateway reconnect
  useInitialData();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: 'oklch(0.18 0 0)',
          borderTopColor: 'oklch(0.3 0 0)',
        },
        tabBarActiveTintColor: 'oklch(0.9 0.17 157)',
        tabBarInactiveTintColor: 'oklch(0.65 0 0)',
      }}
    >
      <Tabs.Screen
        name="(channels)"
        options={{
          title: 'Channels',
          tabBarIcon: ({ focused }) => <TabIcon label="💬" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="(dms)"
        options={{
          title: 'Messages',
          tabBarIcon: ({ focused }) => <TabIcon label="✉️" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ focused }) => <TabIcon label="⚙️" focused={focused} />,
        }}
      />
    </Tabs>
  );
}
