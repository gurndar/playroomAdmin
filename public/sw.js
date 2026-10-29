// Only used so the admin page can show notifications on mobile and focus itself when one is clicked.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const admin = all.find((c) => new URL(c.url).pathname.startsWith('/admin'));
    if (admin) return admin.focus();
    return self.clients.openWindow('/admin');
  })());
});
