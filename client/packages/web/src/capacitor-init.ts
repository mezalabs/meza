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
  applyDeepLinkInvite,
  bootstrapSession,
  gatewayConnect,
  gatewayDisconnect,
  isSessionReady,
  parseDeepLink,
  subscribeToPush,
  useAuthStore,
} from '@meza/core';
import { CapacitorPushAdapter } from './capacitor-push-adapter.ts';
import { navigateFromPush } from './navigate.ts';

const pushAdapter = new CapacitorPushAdapter();

// Register the tap handler at module load so it attaches before any await
// in initCapacitor. iOS does not reliably replay the launch-tap action
// (capacitor-plugins#1488), so the listener must be present as early as
// possible to give the Capacitor plugin a sink. navigateFromPush itself
// buffers via setPendingPushNav when the session is not yet ready, so
// taps that arrive during bootstrap are drained in main.tsx.
pushAdapter.onNotificationTap((data) => {
  // Server emits `type` ("dm" | "message" | "mention"); decode to client-side
  // `kind` here so navigateFromPush sees a single name. See navigate.ts.
  navigateFromPush({
    kind: data.type,
    channel_id: data.channel_id,
    user_id: data.user_id,
  });
});

export async function initCapacitor(): Promise<void> {
  const { App } = await import('@capacitor/app');

  // Dismiss keyboard if the WebView auto-focused an input on launch.
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  setupStatusBar();
  setupAppLifecycle(App);
  setupDeepLinkHandler(App);
  setupPushNotifications();
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

async function setupDeepLinkHandler(
  App: typeof import('@capacitor/app').App,
): Promise<void> {
  // Check for a cold-start deep link that arrived before this module loaded.
  const launchUrl = await App.getLaunchUrl();
  if (launchUrl?.url) {
    const invite = parseDeepLink(launchUrl.url);
    if (invite) {
      applyDeepLinkInvite(invite);
    }
  }

  // Listen for warm deep links while the app is running.
  App.addListener('appUrlOpen', ({ url }) => {
    const invite = parseDeepLink(url);
    if (!invite) return;
    applyDeepLinkInvite(invite);
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
