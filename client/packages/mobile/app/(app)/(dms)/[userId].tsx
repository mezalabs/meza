import { useLocalSearchParams } from 'expo-router';
import { View, Text } from 'react-native';

export default function DMScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();

  return (
    <View className="flex-1 items-center justify-center bg-bg-base">
      <Text className="text-xl font-bold text-text">DM: {userId}</Text>
      <Text className="mt-2 text-text-muted">Conversation — Phase 3</Text>
    </View>
  );
}
