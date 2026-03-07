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
  pushAdapter.onNotificationTap((data) => {
    console.info('[push] notification tapped:', JSON.stringify(data));
    const channelId = data.channel_id;
    if (!channelId) {
      console.warn('[push] notification tap missing channel_id');
      return;
    }
    const isDM = data.is_dm === 'true';
    navigateToChannel(channelId, isDM);
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
