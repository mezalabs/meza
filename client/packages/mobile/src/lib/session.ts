/**
 * Mobile session lifecycle.
 *
 * Mirrors the web's main.tsx initialization pattern:
 * - On auth → connect gateway + bootstrap E2EE session
 * - On logout → disconnect gateway + teardown session
 * - On app foreground → reconnect if needed
 */

import {
  bootstrapSession,
  gatewayConnect,
  gatewayDisconnect,
  teardownSession,
  useAuthStore,
} from '@meza/core';
import { AppState, type AppStateStatus } from 'react-native';
import {
  registerForPushNotifications,
  setupNotificationResponseHandler,
  setupTokenRefreshHandler,
} from './push';

let initialized = false;

/**
 * Initialize the session lifecycle.
 * Call once from the root layout after polyfills are loaded.
 */
export function initSessionLifecycle() {
  if (initialized) return;
  initialized = true;

  const state = useAuthStore.getState();

  // If already authenticated on startup (persisted session), bootstrap
  if (state.isAuthenticated && state.accessToken) {
    gatewayConnect(state.accessToken);
    bootstrapSession().catch((err) => {
      console.warn('[Mobile] bootstrapSession failed on startup:', err);
    });
    registerForPushNotifications().catch((err) => {
      console.warn('[Mobile] push registration failed on startup:', err);
    });
  }

  // Set up push notification handlers
  setupNotificationResponseHandler();
  setupTokenRefreshHandler();

  // Subscribe to auth state changes
  let wasAuthenticated = state.isAuthenticated;
  useAuthStore.subscribe((next) => {
    if (next.isAuthenticated && next.accessToken && !wasAuthenticated) {
      // Logged in
      gatewayConnect(next.accessToken);
      bootstrapSession().catch((err) => {
        console.warn('[Mobile] bootstrapSession failed:', err);
      });
      // Register push token after login
      registerForPushNotifications().catch((err) => {
        console.warn('[Mobile] push registration failed:', err);
      });
    } else if (!next.isAuthenticated && wasAuthenticated) {
      // Logged out
      gatewayDisconnect();
      teardownSession().catch(() => {});
    }
    wasAuthenticated = next.isAuthenticated;
  });

  // Handle app state changes (foreground/background)
  AppState.addEventListener('change', handleAppStateChange);
}

function handleAppStateChange(nextState: AppStateStatus) {
  const { isAuthenticated, accessToken } = useAuthStore.getState();

  if (nextState === 'active' && isAuthenticated && accessToken) {
    // App came to foreground — reconnect gateway if needed
    gatewayConnect(accessToken);
  }
}
