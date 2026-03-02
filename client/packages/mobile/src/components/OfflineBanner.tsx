import { useGatewayStore } from '@meza/core';
import { Text, View } from 'react-native';

export function OfflineBanner() {
  const status = useGatewayStore((s) => s.status);

  if (status === 'connected') return null;

  const label =
    status === 'connecting'
      ? 'Connecting...'
      : status === 'reconnecting'
        ? 'Reconnecting...'
        : 'Disconnected';

  return (
    <View className="bg-warning/90 px-4 py-1.5">
      <Text className="text-center text-xs font-medium text-black">
        {label}
      </Text>
    </View>
  );
}
