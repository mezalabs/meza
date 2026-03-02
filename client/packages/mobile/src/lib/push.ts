/**
 * Push notification setup for mobile.
 *
 * Registers FCM/APNs token with the server, handles notification
 * permissions, foreground notification display, and notification tap
 * deep linking.
 *
 * Server-side FCM/APNs dispatch is Phase 4 server work — this module
 * handles the client-side token registration and notification handling.
 */

import { getBaseUrl, useAuthStore } from '@meza/core';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { AuthService } from '@meza/gen/meza/v1/auth_pb.ts';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { router } from 'expo-router';
import { Platform } from 'react-native';

// Create a transport matching core's client.ts pattern
function getTransport() {
  return createConnectTransport({
    baseUrl: getBaseUrl(),
    interceptors: [
      (next) => async (req) => {
        const { accessToken } = useAuthStore.getState();
        if (accessToken) {
          req.header.set('Authorization', `Bearer ${accessToken}`);
        }
        return next(req);
      },
    ],
  });
}

// Configure how notifications are shown when the app is in the foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function callRegisterDevice(pushToken: string): Promise<void> {
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const client = createClient(AuthService, getTransport());
  await client.registerDevice({
    devicePublicKey: new Uint8Array(0),
    deviceSignature: new Uint8Array(0),
    deviceName: `${Platform.OS} ${Device.modelName ?? 'Mobile'}`,
    platform,
    pushToken,
  });
}

/**
 * Request push notification permissions and register the device token
 * with the server.
 */
export async function registerForPushNotifications(): Promise<void> {
  if (!Device.isDevice) {
    console.warn('[push] Push notifications require a physical device');
    return;
  }

  const { status: existingStatus } =
    await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.info('[push] Notification permission denied');
    return;
  }

  // Get the native push token (FCM for Android, APNs for iOS)
  const tokenData = await Notifications.getDevicePushTokenAsync();

  try {
    await callRegisterDevice(tokenData.data);
  } catch (err) {
    console.error('[push] registerDevice failed:', err);
  }

  // Set up Android notification channels
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('messages', {
      name: 'Messages',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      sound: 'default',
    });
    await Notifications.setNotificationChannelAsync('calls', {
      name: 'Calls',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 500, 500, 500],
      sound: 'default',
    });
  }
}

/**
 * Handle notification tap — deep link to the correct channel.
 */
export function setupNotificationResponseHandler(): Notifications.Subscription {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;
    const channelId = data?.channel_id as string | undefined;

    if (channelId) {
      router.push(`/(app)/(channels)/${channelId}`);
    }
  });
}

/**
 * Handle push token rotation — re-register with the server.
 */
export function setupTokenRefreshHandler(): Notifications.Subscription {
  return Notifications.addPushTokenListener(async (tokenData) => {
    try {
      await callRegisterDevice(tokenData.data);
    } catch (err) {
      console.error('[push] token refresh registerDevice failed:', err);
    }
  });
}
