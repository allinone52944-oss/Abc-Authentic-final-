/* ============================================================
   All In One (Abc Authentic) - Service Worker
   - Cache-first for static assets
   - Network-first for navigation, offline fallback page
   - API calls always go to network (never cached)
   ============================================================ */
'use strict';

const CACHE = 'abc-authentic-v1';

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
