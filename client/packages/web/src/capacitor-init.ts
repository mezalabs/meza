/**
 * Capacitor initialization module.
 *
 * This file is dynamically imported by the web app when running inside
 * Capacitor (detected via isCapacitor()). It sets up mobile-specific
 * behavior: app lifecycle, push notifications, notification tap
 * navigation, and Android back button handling.
 *
 * Uses dynamic imports for all Capacitor plugins so they don't pollute
 * the web/desktop bundles — tree-shaking removes this entire module
 * when not imported.
 */
import {
  gatewayConnect,
  gatewayDisconnect,
  subscribeToPush,
  useAuthStore,
} from '@meza/core';
import { CapacitorPushAdapter } from './capacitor-push-adapter.ts';

const pushAdapter = new CapacitorPushAdapter();

export async function initCapacitor(): Promise<void> {
  const { App } = await import('@capacitor/app');

  setupAppLifecycle(App);
  setupPushNotifications();
  setupNotificationNavigation();
  setupBackButton(App);
}

function setupAppLifecycle(App: typeof import('@capacitor/app').App): void {
  App.addListener('appStateChange', ({ isActive }) => {
    const { isAuthenticated, accessToken } = useAuthStore.getState();
    if (!isAuthenticated || !accessToken) return;

    if (isActive) {
      gatewayConnect(accessToken);
    } else {
      gatewayDisconnect();
    }
  });
}

function setupPushNotifications(): void {
  const { isAuthenticated } = useAuthStore.getState();
  if (isAuthenticated) {
    subscribeToPush(pushAdapter).catch((err) =>
      console.error('Push subscription failed:', err),
    );
  }

  useAuthStore.subscribe((state, prevState) => {
    if (state.isAuthenticated && !prevState.isAuthenticated) {
      subscribeToPush(pushAdapter).catch((err) =>
        console.error('Push subscription failed:', err),
      );
    }
  });
}

function setupNotificationNavigation(): void {
  pushAdapter.onNotificationTap(async (data) => {
    const channelId = data.channel_id;
    if (!channelId) return;

    // Use the tiling store to navigate — works for both mobile and desktop layouts.
    const { useTilingStore } = await import('@meza/ui');
    const store = useTilingStore.getState();
    store.setPaneContent(store.focusedPaneId, {
      type: 'channel',
      channelId,
    });
  });
}

function setupBackButton(App: typeof import('@capacitor/app').App): void {
  App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack) {
      window.history.back();
    } else {
      App.minimizeApp();
    }
  });
}
