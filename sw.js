// ═══════════════════════════════════════════════════════════════════════════
// sw.js — service worker, for push notifications only.
// Deliberately caches NOTHING: a fantasy site that shows yesterday's draft
// because of a stale cache is worse than one that needs a connection.
// ═══════════════════════════════════════════════════════════════════════════
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'LEC Fantasy', {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.tag || 'lf',
    renotify: true,
    vibrate: [120, 60, 120],
    data: { url: data.url || './#/' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data.url || './#/', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) { await w.focus(); return w.navigate(target); }
    }
    return self.clients.openWindow(target);
  })());
});
