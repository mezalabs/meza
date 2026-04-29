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

// Buffer for taps that arrive before the dispatcher is wired. iOS does not
// reliably replay the launch-tap action (capacitor-plugins#1488), so the
// listener must register at module load — before any `await` in
// initCapacitor — to give the Capacitor plugin a sink as early as possible.
const pendingTaps: Record<string, string>[] = [];
let dispatchReady = false;

function dispatchTap(data: Record<string, string>): void {
  // Server emits `type` ("dm" | "message" | "mention"); decode to client-side
  // `kind` here so navigateFromPush sees a single name. See navigate.ts.
  navigateFromPush({
    kind: data.type,
    channel_id: data.channel_id,
    user_id: data.user_id,
  });
}

// Register the tap handler at module load. navigateFromPush itself drops
// any tap whose user_id does not match the current session, so a tap that
// fires before bootstrap is safely no-ops; a tap that fires during bootstrap
// is buffered and drained once auth is hydrated.
pushAdapter.onNotificationTap((data) => {
  if (dispatchReady) {
    dispatchTap(data);
  } else {
    pendingTaps.push(data);
  }
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

  // Mark the dispatcher ready and drain any taps captured during bootstrap.
  dispatchReady = true;
  for (const data of pendingTaps.splice(0)) dispatchTap(data);
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
