// Push-only service worker: no fetch handler, no caching, so it can never
// serve stale assets. Its sole job is showing push notifications and opening
// the app when one is tapped. Payloads are built server-side in
// supabase/functions/fetch-dmi-data (see notifyPassable).

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    // Malformed payload — show the fallback title rather than nothing,
    // since the browser requires a visible notification per push anyway.
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Safe to Go? — Mandø', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'safe-to-go',
      data: { url: data.url || '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus()
      }
      return clients.openWindow(url)
    }),
  )
})
