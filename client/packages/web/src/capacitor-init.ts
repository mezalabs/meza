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
  bootstrapSession,
  gatewayConnect,
  gatewayDisconnect,
  isSessionReady,
  subscribeToPush,
  useAuthStore,
} from '@meza/core';
import { CapacitorPushAdapter } from './capacitor-push-adapter.ts';
import { navigateToChannel } from './navigate.ts';

const pushAdapter = new CapacitorPushAdapter();

export async function initCapacitor(): Promise<void> {
  const { App } = await import('@capacitor/app');

  // Dismiss keyboard if the WebView auto-focused an input on launch.
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  setupStatusBar();
  setupAppLifecycle(App);
  setupPushNotifications();
  setupNotificationNavigation();
  setupBackButton(App);
}

async function setupStatusBar(): Promise<void> {
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#121212' });
  } catch {
    // Status bar plugin not available (e.g. web)
  }
}

function setupAppLifecycle(App: typeof import('@capacitor/app').App): void {
  App.addListener('appStateChange', async ({ isActive }) => {
    const { isAuthenticated, accessToken } = useAuthStore.getState();
    if (!isAuthenticated || !accessToken) return;

    if (!isActive) {
      gatewayDisconnect();
      return;
    }

    // Verify E2EE session is still intact before reconnecting.
    // Android may clear storage under memory pressure while backgrounded.
    if (!isSessionReady()) {
      const ok = await bootstrapSession().catch(() => false as const);
      if (!ok) {
        useAuthStore.getState().clearAuth();
        return;
      }
    }
    gatewayConnect(accessToken);
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
  pushAdapter.onNotificationTap((data) => {
    const channelId = data.channel_id;
    if (!channelId) return;
    navigateToChannel(channelId);
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
