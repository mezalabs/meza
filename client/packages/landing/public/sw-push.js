// Unregister stale service worker from when the SPA was served at meza.chat.
// Now that meza.chat is a static landing page and the SPA lives at app.meza.chat,
// returning visitors may still have the old SW cached. This file replaces it and
// immediately unregisters so no SW remains on the landing page origin.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => {
  self.registration.unregister();
});
