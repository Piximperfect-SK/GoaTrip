// Minimal service worker — its only real job is to exist with a fetch
// handler, which is what Chrome/Android require before it'll ever show
// the "Install app" prompt. Deliberately NOT a full offline-cache
// strategy: it never caches HTML pages or /.netlify/functions/* calls,
// only a small set of truly static assets (icons, shared.css/js). We
// just spent a whole session chasing a stale-HTML-cache bug — the last
// thing this app needs is a service worker making that worse by caching
// pages on top of it.
const CACHE_NAME = 'goatrip-static-v2';
const STATIC_ASSETS = [
  '/shared.css',
  '/shared.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept anything but same-origin GET requests — API calls,
  // POSTs, and cross-origin CDN scripts all pass straight through.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Never cache HTML navigations or Netlify function calls — those must
  // always hit the network so auth/session/data state is always fresh.
  if (event.request.mode === 'navigate' || url.pathname.startsWith('/.netlify/functions/')) return;

  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});

// ---------- Web Push: admin approval alerts ----------
// Payload is sent by netlify/functions/lib/notify.js:
//   { title, body, tag, url }
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(d.title || 'GoaTrip', {
      body: d.body || '',
      tag: d.tag || 'goatrip',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: d.url || '/goa-wallet.html' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/goa-wallet.html';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('goa-wallet') && 'focus' in c) return c.focus();
    }
    return self.clients.openWindow(url);
  })());
});
