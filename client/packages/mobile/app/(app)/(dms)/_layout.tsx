import { Stack } from 'expo-router';

export default function DMsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="[userId]" />
    </Stack>
  );
}
