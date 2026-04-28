/// <reference lib="webworker" />

/**
 * Push notification service worker for Meza.
 *
 * Receives push events from the server (containing only metadata, no
 * message content — E2EE compatible), displays a notification, and
 * handles click-to-navigate.
 */

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    return;
  }

  const title = data.title || 'Meza';
  const options = {
    body: data.body || 'You have a new notification',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    tag: data.tag || 'meza-default',
    data: {
      channelId: data.channel_id,
      // Server "type" doubles as the navigation kind ("dm" routes to a DM
      // pane; anything else falls through to the channel pane).
      kind: data.type,
      // Carried so notificationclick can drop the tap if the recipient does
      // not match the currently signed-in user (cross-account leak filter).
      userId: data.user_id,
    },
    // Renotify so the user sees updated notifications for the same tag.
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const { channelId, kind, userId } = event.notification.data || {};

  // Focus an existing Meza window or open a new one.
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Try to focus an existing window.
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            client.focus();
            // Post a message so the app can navigate to the channel/DM.
            if (channelId) {
              client.postMessage({
                type: 'PUSH_NAVIGATE',
                channelId,
                kind,
                userId,
              });
            }
            return;
          }
        }
        // No existing window — open a new one. Encode the navigation intent
        // in the URL so the cold-loaded app can pick it up after bootstrap.
        if (self.clients.openWindow) {
          const params = new URLSearchParams();
          if (channelId) params.set('channel_id', channelId);
          if (kind) params.set('kind', kind);
          if (userId) params.set('user_id', userId);
          const qs = params.toString();
          self.clients.openWindow(qs ? `/?${qs}` : '/');
        }
      }),
  );
});
