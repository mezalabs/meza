import { logout, useAuthStore, useGatewayStore } from '@meza/core';
import { Pressable, Text, View } from 'react-native';

export default function SettingsScreen() {
  const user = useAuthStore((s) => s.user);
  const gatewayStatus = useGatewayStore((s) => s.status);

  return (
    <View className="flex-1 bg-bg-base px-4 pt-16">
      <Text className="mb-6 text-xl font-bold text-text">Settings</Text>

      {/* User info */}
      <View className="mb-6 rounded-lg border border-border bg-bg-surface p-4">
        <Text className="text-sm font-medium text-text">
          {user?.displayName || user?.username || 'Unknown'}
        </Text>
        <Text className="mt-1 text-xs text-text-muted">
          @{user?.username}
        </Text>
      </View>

      {/* Gateway status */}
      <View className="mb-6 rounded-lg border border-border bg-bg-surface p-4">
        <Text className="text-xs text-text-muted">
          Gateway:{' '}
          <Text
            className={
              gatewayStatus === 'connected' ? 'text-success' : 'text-warning'
            }
          >
            {gatewayStatus}
          </Text>
        </Text>
      </View>

      {/* Logout */}
      <Pressable
        onPress={() => logout()}
        className="items-center rounded-lg border border-error py-3 active:bg-error/10"
      >
        <Text className="text-sm font-medium text-error">Sign Out</Text>
      </Pressable>

      <Text className="mt-8 text-center text-xs text-text-muted">
        More settings coming in Phase 7
      </Text>
    </View>
  );
}
