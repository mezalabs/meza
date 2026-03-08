/**
 * Platform-specific push notification adapter.
 * Each platform (web, Electron, Capacitor) provides its own implementation.
 */
export interface PushAdapter {
  /** Platform identifier for device registration (e.g. 'web', 'android', 'ios'). */
  platform: string;

  /**
   * Subscribe to push notifications.
   * Returns push subscription details for server registration, or null if unavailable.
   */
  subscribe(): Promise<PushSubscriptionDetails | null>;

  /** Unsubscribe from push notifications. */
  unsubscribe(): Promise<void>;

  /**
   * Register a callback for notification tap events.
   * Called with the notification data payload when the user taps a notification.
   */
  onNotificationTap?(
    callback: (data: Record<string, string>) => void,
  ): void;
}

/** Details returned by a push adapter after subscribing. */
export interface PushSubscriptionDetails {
  /** Push endpoint URL (Web Push) or empty for FCM token-based platforms. */
  pushEndpoint: string;
  /** P256DH key (Web Push only). */
  pushP256dh: string;
  /** Auth secret (Web Push only). */
  pushAuth: string;
  /** FCM/APNs push token (mobile only). */
  pushToken: string;
}
