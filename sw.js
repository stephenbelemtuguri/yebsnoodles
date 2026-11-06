// YEBS Noodles Service Worker for Progressive Web App (PWA) Offline Performance
const CACHE_NAME = 'yebs-noodles-v14';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './driver.html',
  './admin.html',
  './shared.js',
  './recovery.js',
  './nav.js',
  './mobile.css',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './logo.png',
  './food_photo.png',
  './img_food_1.jpg',
  './img_food_2.jpg',
  './img_food_3.jpg',
  './img_food_4.jpg',
  './ghana_spag_chicken.jpg',
  './assets/admin-background.jpg',
  './assets/delivery-background.jpg',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch(err => console.warn("PWA pre-cache error", err));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Live operational data and API calls must never be served from cache.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Network first with cache fallback (keeps portals fresh while online).
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (error) {
    console.warn('Could not parse push notification payload:', error);
  }
  const title = String(payload.title || 'YEBS Noodles update');
  const options = {
    body: String(payload.body || 'There is a new update for you.'),
    icon: '/logo.png',
    badge: '/logo.png',
    tag: String(payload.id || `yebs-${Date.now()}`),
    data: { url: String(payload.url || '/'), id: payload.id || null },
    requireInteraction: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data && event.notification.data.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find(client => client.url === targetUrl);
      if (existing && 'focus' in existing) return existing.focus();
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      return undefined;
    })
  );
});
