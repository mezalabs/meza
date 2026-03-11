import {
  getVAPIDPublicKey,
  type PushAdapter,
  type PushSubscriptionDetails,
} from '@meza/core';

export class WebPushAdapter implements PushAdapter {
  platform = 'web' as const;

  async subscribe(): Promise<PushSubscriptionDetails | null> {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.warn('Push notifications not supported');
      return null;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.info('Notification permission denied');
      return null;
    }

    const vapidKey = await getVAPIDPublicKey();
    if (!vapidKey) {
      console.warn('VAPID key not configured on server');
      return null;
    }

    const registration = await navigator.serviceWorker.register('/sw-push.js', {
      scope: '/',
    });
    await navigator.serviceWorker.ready;

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey)
          .buffer as ArrayBuffer,
      });
    }

    const subJSON = subscription.toJSON();
    return {
      pushEndpoint: subscription.endpoint,
      pushP256dh: subJSON.keys?.p256dh ?? '',
      pushAuth: subJSON.keys?.auth ?? '',
      pushToken: '',
    };
  }

  async unsubscribe(): Promise<void> {
    if (!('serviceWorker' in navigator)) return;

    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return;

    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await subscription.unsubscribe();
    }
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
