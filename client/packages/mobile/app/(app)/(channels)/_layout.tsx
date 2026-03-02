import { Stack } from 'expo-router';

export default function ChannelsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="[channelId]" />
    </Stack>
  );
}
