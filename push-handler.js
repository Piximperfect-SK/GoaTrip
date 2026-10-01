// push-handler.js — pulled into your existing /sw.js with one line:
//     importScripts('/push-handler.js');
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) {}
  event.waitUntil(self.registration.showNotification(d.title || 'GoaTrip', {
    body: d.body || '',
    tag: d.tag || 'goatrip',
    icon: '/pictures/logo-icon.png',
    badge: '/pictures/logo-icon.png',
    data: { url: d.url || '/goa-wallet.html' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/goa-wallet.html';
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('goa-wallet') && 'focus' in c) return c.focus();
    }
    return clients.openWindow(url);
  })());
});
