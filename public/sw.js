// Service Worker — handles background push notifications

self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || '📋 My Scheduler', {
      body: data.body || '',
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: data.tag || 'reminder',
      requireInteraction: false,
      data: { url: data.url || self.location.origin },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || self.location.origin;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
      const existing = wins.find(w => w.url.startsWith(self.location.origin));
      return existing ? existing.focus() : clients.openWindow(url);
    })
  );
});
