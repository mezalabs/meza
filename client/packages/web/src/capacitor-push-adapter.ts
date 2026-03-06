import { Capacitor } from '@capacitor/core';
import {
  PushNotifications,
  type Token,
  type ActionPerformed,
} from '@capacitor/push-notifications';
import type { PluginListenerHandle } from '@capacitor/core';
import type { PushAdapter, PushSubscriptionDetails } from '@meza/core';

/**
 * Push adapter for Capacitor (iOS + Android).
 * Uses @capacitor/push-notifications to register with FCM (both platforms).
 */
export class CapacitorPushAdapter implements PushAdapter {
  get platform(): string {
    return Capacitor.getPlatform(); // 'android' | 'ios'
  }

  get deviceName(): string {
    const p = Capacitor.getPlatform();
    return p === 'ios' ? 'Meza iOS' : 'Meza Android';
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
    let permStatus;
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

    return new Promise<PushSubscriptionDetails>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          console.warn('Push registration timed out (Firebase may not be configured)');
          resolve(null as unknown as PushSubscriptionDetails);
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

      // Listen for successful registration (FCM token).
      PushNotifications.addListener('registration', async (token: Token) => {
        await cleanup();
        resolve({
          pushEndpoint: '',
          pushP256dh: '',
          pushAuth: '',
          pushToken: token.value,
        });
      }).then((handle) => {
        this.registrationHandle = handle;
      });

      // Listen for registration errors.
      PushNotifications.addListener('registrationError', async (error) => {
        await cleanup();
        console.error('Push registration error:', error);
        reject(new Error(`Push registration failed: ${error}`));
      }).then((handle) => {
        this.registrationErrorHandle = handle;
      });

      // Register with APNs/FCM.
      try {
        PushNotifications.register();
      } catch (e) {
        cleanup();
        console.error('Push register() failed:', e);
        resolve(null as unknown as PushSubscriptionDetails);
      }
    });
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
    ).then((handle) => {
      this.tapHandle = handle;
    });
  }
}
