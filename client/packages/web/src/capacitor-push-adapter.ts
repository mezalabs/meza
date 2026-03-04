import { Capacitor } from '@capacitor/core';
import {
  PushNotifications,
  type Token,
  type ActionPerformed,
} from '@capacitor/push-notifications';
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

  private tapCallback?: (data: Record<string, string>) => void;

  async subscribe(): Promise<PushSubscriptionDetails | null> {
    let permStatus = await PushNotifications.checkPermissions();
    if (permStatus.receive === 'prompt') {
      permStatus = await PushNotifications.requestPermissions();
    }
    if (permStatus.receive !== 'granted') {
      console.info('Push notification permission denied');
      return null;
    }

    return new Promise((resolve, reject) => {
      // Listen for successful registration (FCM token).
      PushNotifications.addListener('registration', (token: Token) => {
        resolve({
          pushEndpoint: '',
          pushP256dh: '',
          pushAuth: '',
          pushToken: token.value,
        });
      });

      // Listen for registration errors.
      PushNotifications.addListener('registrationError', (error) => {
        console.error('Push registration error:', error);
        reject(new Error(`Push registration failed: ${error}`));
      });

      // Register with APNs/FCM.
      PushNotifications.register();
    });
  }

  async unsubscribe(): Promise<void> {
    await PushNotifications.removeAllListeners();
  }

  onNotificationTap(callback: (data: Record<string, string>) => void): void {
    this.tapCallback = callback;
    PushNotifications.addListener(
      'pushNotificationActionPerformed',
      (action: ActionPerformed) => {
        const data = action.notification.data as Record<string, string>;
        this.tapCallback?.(data);
      },
    );
  }
}
