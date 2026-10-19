// sw.js — Nigeria CEWS Workbox Service Worker
importScripts('https://storage.googleapis.com/workbox-cdn/releases/7.1.0/workbox-sw.js');

const { BackgroundSyncPlugin } = workbox.backgroundSync;
const { NetworkFirst, CacheFirst, StaleWhileRevalidate } = workbox.strategies;
const { registerRoute, setDefaultHandler, setCatchHandler } = workbox.routing;
const { ExpirationPlugin } = workbox.expiration;
const { CacheableResponsePlugin } = workbox.cacheableResponse;
const { precacheAndRoute, matchPrecache } = workbox.precaching;

workbox.setConfig({ debug: false });

// ─── Precache (injected by next-pwa / workbox-cli at build time) ─────────────
precacheAndRoute(self.__WB_MANIFEST || []);

// ─── BackgroundSync for ingest POSTs ─────────────────────────────────────────
const bgSyncPlugin = new BackgroundSyncPlugin('cews-ingest-queue', {
  maxRetentionTime: 72 * 60, // 72 hours in minutes
  onSync: async ({ queue }) => {
    let entry;
    while ((entry = await queue.shiftRequest())) {
      try {
        await fetch(entry.request.clone());
        console.log('[CEWS SW] Replayed request:', entry.request.url);
      } catch (err) {
        console.error('[CEWS SW] Replay failed, re-queuing:', err);
        await queue.unshiftRequest(entry);
        throw err;
      }
    }
  },
});

// Intercept all POST /api/v1/ingest/* requests
registerRoute(
  ({ url, request }) =>
    url.pathname.startsWith('/api/v1/ingest/') && request.method === 'POST',
  new NetworkFirst({
    cacheName: 'cews-ingest-cache',
    plugins: [
      bgSyncPlugin,
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
    networkTimeoutSeconds: 10,
  }),
  'POST'
);

// ─── API GET requests — NetworkFirst ─────────────────────────────────────────
registerRoute(
  ({ url, request }) =>
    url.pathname.startsWith('/api/v1/') &&
    request.method === 'GET' &&
    !url.pathname.startsWith('/api/v1/analytics/zone-scores'),
  new NetworkFirst({
    cacheName: 'cews-api-cache',
    networkTimeoutSeconds: 8,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 5 * 60 }),
    ],
  })
);

// ─── Zone scores — StaleWhileRevalidate ──────────────────────────────────────
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/v1/analytics/zone-scores'),
  new StaleWhileRevalidate({
    cacheName: 'cews-zone-scores-cache',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 10 * 60 }),
    ],
  })
);

// ─── Static assets — CacheFirst ──────────────────────────────────────────────
registerRoute(
  ({ request }) =>
    request.destination === 'image' ||
    request.destination === 'font' ||
    request.destination === 'style' ||
    request.destination === 'script',
  new CacheFirst({
    cacheName: 'cews-static-assets',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({
        maxEntries: 200,
        maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
        purgeOnQuotaError: true,
      }),
    ],
  })
);

// ─── Navigation — NetworkFirst with offline fallback ─────────────────────────
registerRoute(
  ({ request }) => request.mode === 'navigate',
  new NetworkFirst({
    cacheName: 'cews-pages-cache',
    networkTimeoutSeconds: 6,
    plugins: [new CacheableResponsePlugin({ statuses: [0, 200] })],
  })
);

// ─── Default handler ─────────────────────────────────────────────────────────
setDefaultHandler(
  new StaleWhileRevalidate({ cacheName: 'cews-default-cache' })
);

// ─── Offline fallback ─────────────────────────────────────────────────────────
setCatchHandler(async ({ event }) => {
  if (event.request.destination === 'document') {
    const offlinePage = await matchPrecache('/offline.html');
    return offlinePage || Response.error();
  }
  if (event.request.destination === 'image') {
    return new Response(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
        <rect width="200" height="200" fill="#1f2937"/>
        <text x="50%" y="50%" fill="#9ca3af" text-anchor="middle" font-size="14">Offline</text>
      </svg>`,
      { headers: { 'Content-Type': 'image/svg+xml' } }
    );
  }
  return Response.error();
});

// ─── Push Notifications — Emergency CEWS Alerts ──────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'CEWS Alert', body: event.data.text(), urgency: 'normal' };
  }

  const {
    title = 'Nigeria CEWS Alert',
    body = 'New conflict event reported.',
    urgency = 'normal',
    zone,
    alert_type,
    lga,
    state,
    url = '/',
    icon = '/icons/icon-192x192.png',
    badge = '/icons/badge-72x72.png',
  } = payload;

  const isEmergency = urgency === 'emergency' || alert_type === 'mass_atrocity';

  const notificationOptions = {
    body: lga && state ? `${body}\n📍 ${lga}, ${state}${zone ? ` (${zone})` : ''}` : body,
    icon,
    badge,
    tag: `cews-alert-${Date.now()}`,
    renotify: isEmergency,
    requireInteraction: isEmergency,
    silent: !isEmergency,
    vibrate: isEmergency ? [200, 100, 200, 100, 400] : [100, 50, 100],
    data: { url, zone, alert_type, urgency, timestamp: Date.now() },
    actions: [
      { action: 'view', title: '📋 View Report' },
      { action: 'dismiss', title: '✕ Dismiss' },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, notificationOptions));
});

// ─── Notification click handler ───────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (client.url === targetUrl && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
  );
});

// ─── Message handler (skip waiting, claim clients) ────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CLIENTS_CLAIM') {
    self.clients.claim();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      const validCaches = [
        'cews-ingest-cache',
        'cews-api-cache',
        'cews-zone-scores-cache',
        'cews-static-assets',
        'cews-pages-cache',
        'cews-default-cache',
      ];
      return Promise.all(
        cacheNames
          .filter((name) => !validCaches.includes(name))
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});
