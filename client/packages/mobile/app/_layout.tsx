// Platform polyfills MUST load before any @meza/core imports
import '@/platform/storage-polyfill';
import '@/platform/crypto-polyfill';
import '@/platform/base-url';
import '../global.css';

import { useAuthStore } from '@meza/core';
import { initSessionLifecycle } from '@/lib/session';
import { Redirect, Stack } from 'expo-router';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';

// Initialize session lifecycle once at module load
initSessionLifecycle();

export default function RootLayout() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" redirect={isAuthenticated} />
        <Stack.Screen name="(app)" redirect={!isAuthenticated} />
      </Stack>
      {/* Redirect based on auth state */}
      {isAuthenticated ? (
        <Redirect href="/(app)/(channels)" />
      ) : (
        <Redirect href="/(auth)/login" />
      )}
    </>
  );
}
