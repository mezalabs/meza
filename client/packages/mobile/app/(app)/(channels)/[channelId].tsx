import { useLocalSearchParams } from 'expo-router';
import { View, Text } from 'react-native';

export default function ChannelScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();

  return (
    <View className="flex-1 items-center justify-center bg-bg-base">
      <Text className="text-xl font-bold text-text">Channel: {channelId}</Text>
      <Text className="mt-2 text-text-muted">Message view — Phase 3</Text>
    </View>
  );
}
