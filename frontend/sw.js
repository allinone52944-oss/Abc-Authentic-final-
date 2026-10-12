/* ============================================================
   All In One (Abc Authentic) - Service Worker
   - Cache-first for static assets
   - Network-first for navigation, offline fallback page
   - API calls always go to network (never cached)
   - Web Push: admin sound alerts (works with screen off)
   ============================================================ */
'use strict';

const CACHE = 'abc-authentic-v2';

const APP_SHELL = [
  '/',
  '/index.html',
  '/login.html',
  '/dashboard.html',
  '/services.html',
  '/service-detail.html',
  '/order-create.html',
  '/order-status.html',
  '/orders.html',
  '/order-detail.html',
  '/wallet.html',
  '/profile.html',
  '/admin.html',
  '/forgot-password.html',
  '/reset-password.html',
  '/verify-email.html',
  '/offline.html',
  '/manifest.json',
  '/css/coffee.css',
  '/js/app.js',
  '/js/admin.js',
  '/banners/render.js',
  '/banners/catalog.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API: always network (never cache auth/payment data)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  // Navigation: network first, offline page fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match('/offline.html'))
    );
    return;
  }

  // Static assets: cache first, then network (and refresh cache)
  event.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || net;
    })
  );
});

/* ============================================================
   Web Push notifications (admin sound alerts, screen-off safe)
   - push event: show notification with sound + vibration
   - notificationclick: open/focus the target URL
   ============================================================ */
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
