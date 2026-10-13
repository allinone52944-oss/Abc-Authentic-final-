/* ============================================================
   All In One (Abc Authentic) - Service Worker v6
   - NO caching (was causing refresh breakage)
   - Only handles Web Push notifications (admin sound alerts)
   - Browser HTTP cache handles static assets via Cache-Control
   ============================================================ */
'use strict';

const CACHE = 'abc-authentic-v6';

self.addEventListener('install', (event) => {
  // No pre-caching — skip immediately
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// No fetch handler — let the browser handle all requests normally.
// (Previous cache-first strategy caused corrupt/stale renders.)

// ---- Web Push notifications (admin sound alerts, screen-off safe) ----
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) { /* plain-text fallback below */ }
  const title = data.title || '🔔 Abc Authentic';
  const body = data.body || (event.data ? event.data.text() : '') || 'নতুন আপডেট এসেছে';
  const url = data.url || '/admin.html';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      vibrate: [200, 100, 200, 100, 200],
      tag: 'abc-admin-alert',
      renotify: true,
      requireInteraction: true,
      data: { url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/admin.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if (c.url.includes(url) && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
      return null;
    })
  );
});
