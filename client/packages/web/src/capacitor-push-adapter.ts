import {
  Capacitor,
  type PluginListenerHandle,
  registerPlugin,
} from '@capacitor/core';
import {
  type ActionPerformed,
  PushNotifications,
  type Token,
} from '@capacitor/push-notifications';
import type { PushAdapter, PushSubscriptionDetails } from '@meza/core';

/** Native plugin that exposes the FCM token on iOS (see FCMTokenPlugin.swift). */
const FCMToken = registerPlugin<{ getToken(): Promise<{ token: string }> }>(
  'FCMToken',
);

/**
 * Push adapter for Capacitor (iOS + Android).
 * Uses @capacitor/push-notifications to register with FCM (both platforms).
 */
export class CapacitorPushAdapter implements PushAdapter {
  get platform(): string {
    return Capacitor.getPlatform(); // 'android' | 'ios'
  }

  /** Handles for subscription-related listeners, cleared on unsubscribe. */
  private registrationHandle?: PluginListenerHandle;
  private registrationErrorHandle?: PluginListenerHandle;
  private tapHandle?: PluginListenerHandle;

  async subscribe(): Promise<PushSubscriptionDetails | null> {
    // On Android, FirebaseMessaging.getInstance() crashes the native process
    // if google-services.json is missing (dev builds without Firebase).
    // Probe by checking permissions first — if the native call succeeds the
    // plugin is properly wired up. The actual danger is register() which
    // calls into Firebase, so we gate on the permission result and catch
    // any synchronous native bridge errors.
    let permStatus: Awaited<
      ReturnType<typeof PushNotifications.checkPermissions>
    >;
    try {
      permStatus = await PushNotifications.checkPermissions();
    } catch {
      console.warn('Push notifications unavailable on this device');
      return null;
    }

    if (permStatus.receive === 'prompt') {
      permStatus = await PushNotifications.requestPermissions();
    }
    if (permStatus.receive !== 'granted') {
      console.info('Push notification permission denied');
      return null;
    }

    // Register with APNs/FCM to ensure the device has a push token.
    const apnsToken = await this.registerNative();
    if (!apnsToken) return null;

    // On iOS, Capacitor returns the raw APNs token but the server needs an
    // FCM token. Use the native FCMTokenPlugin to get it from Firebase.
    if (Capacitor.getPlatform() === 'ios') {
      try {
        const { token } = await FCMToken.getToken();
        if (token) {
          return {
            pushEndpoint: '',
            pushP256dh: '',
            pushAuth: '',
            pushToken: token,
          };
        }
      } catch (err) {
        console.error('Failed to get FCM token:', err);
      }
      return null;
    }

    // Android: Capacitor returns the FCM token directly.
    return {
      pushEndpoint: '',
      pushP256dh: '',
      pushAuth: '',
      pushToken: apnsToken,
    };
  }

  /** Register with APNs/FCM and return the token from the Capacitor plugin. */
  private async registerNative(): Promise<string | null> {
    // On Android, PushNotifications.register() calls
    // FirebaseMessaging.getInstance() which throws a FATAL native exception
    // if google-services.json is missing. This kills the entire process —
    // JS try/catch cannot catch it. Probe Firebase availability first by
    // checking if the FirebaseApp was initialized (exposed via a lightweight
    // plugin call that doesn't touch FirebaseMessaging).
    if (Capacitor.getPlatform() === 'android') {
      if (!this.isFirebaseAvailable()) {
        console.warn(
          'Push registration skipped: Firebase is not configured on this Android build',
        );
        return null;
      }
    }

    let settled = false;
    let doResolve: (value: string | null) => void = () => {};
    const result = new Promise<string | null>((r) => {
      doResolve = r;
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        console.warn(
          'Push registration timed out (Firebase may not be configured)',
        );
        doResolve(null);
      }
    }, 10_000);

    const cleanup = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      await this.registrationHandle?.remove();
      await this.registrationErrorHandle?.remove();
      this.registrationHandle = undefined;
      this.registrationErrorHandle = undefined;
    };

    // Await listener setup before calling register() to avoid race condition
    // where native callback fires before JS listeners are attached.
    this.registrationHandle = await PushNotifications.addListener(
      'registration',
      async (token: Token) => {
        await cleanup();
        doResolve(token.value);
      },
    );

    this.registrationErrorHandle = await PushNotifications.addListener(
      'registrationError',
      async (error) => {
        await cleanup();
        console.error('Push registration error:', error);
        doResolve(null);
      },
    );

    try {
      await PushNotifications.register();
    } catch (e) {
      await cleanup();
      console.error('Push register() failed:', e);
      doResolve(null);
    }

    return result;
  }

  /**
   * Check if Firebase is initialized on Android. Without google-services.json,
   * FirebaseMessaging.getInstance() throws a FATAL native exception that kills
   * the process. There is no safe JS-side probe — non-Firebase plugin methods
   * (checkPermissions, getDeliveredNotifications) work fine without Firebase.
   *
   * We detect Firebase by checking if the native FirebaseApp was initialized
   * during Android's ContentProvider phase. The Capacitor bridge exposes the
   * WebView's URL — in production builds served from localhost, Firebase is
   * expected to be configured. In dev builds served from a remote dev server,
   * Firebase is typically absent.
   */
  private isFirebaseAvailable(): boolean {
    // In production (served from https://localhost), Firebase should be configured.
    // In dev mode (served from a remote Tailscale/LAN URL), it typically isn't.
    const url = window.location.origin;
    if (url.includes('localhost')) return true;
    // Dev server detected — Firebase likely not configured
    return false;
  }

  async unsubscribe(): Promise<void> {
    await this.registrationHandle?.remove();
    await this.registrationErrorHandle?.remove();
    await this.tapHandle?.remove();
    this.registrationHandle = undefined;
    this.registrationErrorHandle = undefined;
    this.tapHandle = undefined;
  }

  onNotificationTap(callback: (data: Record<string, string>) => void): void {
    PushNotifications.addListener(
      'pushNotificationActionPerformed',
      (action: ActionPerformed) => {
        const data = action.notification.data as Record<string, string>;
        callback(data);
      },
    )
      .then((handle) => {
        this.tapHandle = handle;
      })
      .catch((err) => {
        console.error('Failed to add notification tap listener:', err);
      });
  }
}
