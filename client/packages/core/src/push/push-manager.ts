import { createClient } from '@connectrpc/connect';
import { AuthService } from '@meza/gen/meza/v1/auth_pb.ts';
import { transport } from '../api/client.ts';
import { getVAPIDPublicKey } from '../api/notification.ts';
import { isElectron } from '../utils/platform.ts';

const authClient = createClient(AuthService, transport);

/**
 * Registers the service worker and subscribes to Web Push notifications.
 * In Electron, registers the device with platform 'electron' and skips
 * service worker / Web Push setup (native notifications used via IPC).
 */
export async function subscribeToPush(): Promise<void> {
  if (isElectron()) {
    // Electron: register device as 'electron' platform, skip Web Push
    await authClient.registerDevice({
      devicePublicKey: new Uint8Array(0),
      deviceSignature: new Uint8Array(0),
      deviceName: 'Meza Desktop',
      platform: 'electron',
      pushEndpoint: '',
      pushP256dh: '',
      pushAuth: '',
    });
    return;
  }

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('Push notifications not supported');
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    console.info('Notification permission denied');
    return;
  }

  // Get VAPID public key from server.
  const vapidKey = await getVAPIDPublicKey();
  if (!vapidKey) {
    console.warn('VAPID key not configured on server');
    return;
  }

  // Register the service worker.
  const registration = await navigator.serviceWorker.register('/sw-push.js', {
    scope: '/',
  });

  // Wait for the service worker to be ready.
  await navigator.serviceWorker.ready;

  // Subscribe to push (or retrieve existing subscription).
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey)
        .buffer as ArrayBuffer,
    });
  }

  // Extract subscription details and register with the server.
  const subJSON = subscription.toJSON();
  await authClient.registerDevice({
    devicePublicKey: new Uint8Array(0),
    deviceSignature: new Uint8Array(0),
    deviceName: getBrowserName(),
    platform: 'web',
    pushEndpoint: subscription.endpoint,
    pushP256dh: subJSON.keys?.p256dh ?? '',
    pushAuth: subJSON.keys?.auth ?? '',
  });
}

/**
 * Show a native notification. In Electron, uses the IPC bridge.
 * In the browser, uses the Notification API directly.
 */
export function showNotification(
  title: string,
  body: string,
  data?: { channelId?: string },
): void {
  if (isElectron()) {
    window.electronAPI?.notifications.show(title, body, data);
    return;
  }
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

/**
 * Unsubscribes from push notifications and revokes the device on the server.
 */
export async function unsubscribeFromPush(): Promise<void> {
  if (isElectron()) return;
  if (!('serviceWorker' in navigator)) return;

  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;

  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await subscription.unsubscribe();
  }
}

function getBrowserName(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) return 'Firefox';
  if (ua.includes('Edg')) return 'Edge';
  if (ua.includes('Chrome')) return 'Chrome';
  if (ua.includes('Safari')) return 'Safari';
  return 'Browser';
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
