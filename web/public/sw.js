// Helm's service worker: phone notifications only (server/notify.ts sends them).
//
// It has no fetch handler on purpose: every request goes to the network exactly as without it, so the content-hashed
// asset caching and the reload-once guard in index.html are untouched. It caches no responses: its only storage is
// one Cache API entry holding the target of the last notification tap, which the page reads and deletes.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const ICON = '/icon-192.png';

function setBadge(n) {
  try {
    if (typeof n !== 'number') return;
    if (n > 0 && self.navigator.setAppBadge) return self.navigator.setAppBadge(n).catch(() => {});
    if (n === 0 && self.navigator.clearAppBadge) return self.navigator.clearAppBadge().catch(() => {});
  } catch (_) {}
}

/** A route ("#/p/…") or path made absolute on this worker's own origin: the one the subscription was made on. */
function absolute(url) {
  const route = typeof url === 'string' && url.startsWith('#') ? '/' + url : url || '/';
  return new URL(route, self.location.origin).href;
}

// Safari (iOS and macOS) revokes the subscription of a site that receives pushes without showing a notification,
// so only other browsers may skip one; they do when a focused window already shows the item.
const MAY_SKIP = /Chrome\/|Firefox\//.test(self.navigator.userAgent);

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: 'Helm', body: event.data ? event.data.text() : '' };
  }
  const url = absolute(data.url);
  event.waitUntil(
    (async () => {
      await setBadge(data.badge);
      if (MAY_SKIP && data.url && data.url !== '#/') {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (windows.some((c) => c.focused && c.visibilityState === 'visible' && c.url.startsWith(url))) return;
      }
      await self.registration.showNotification(data.title || 'Helm', {
        body: data.body || '',
        tag: data.tag || undefined,
        // A replacement of a burst ("3 tasks finished") alerts again only when something urgent is in it.
        renotify: !!(data.tag && data.urgent),
        requireInteraction: !!data.urgent,
        icon: ICON,
        badge: ICON,
        timestamp: data.ts || Date.now(),
        data: { url },
      });
    })(),
  );
});

/**
 * Where a tap should land, written down for the page (web/src/notify.tsx consumePendingOpen; same cache name, key
 * and shape there). An iOS Home Screen app cannot be relied on to be found by matchAll, to open at openWindow's URL
 * (it may open at start_url, or drop the fragment) or to follow WindowClient.navigate, so the target is stored first
 * and the page takes it whenever it wakes: startup, this worker's message, becoming visible, pageshow, focus.
 */
const PENDING_CACHE = 'helm-pending-open';
const PENDING_KEY = '/__helm/pending-open';

/** The in-app route of a notification URL ("#/p/…"): origin-relative, so a LAN and a public origin both work. */
function routeOf(url) {
  try {
    const hash = new URL(url, self.location.origin).hash;
    return hash.startsWith('#/') ? hash : '#/';
  } catch (_) {
    return '#/';
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || absolute('/');
  const route = routeOf(url);
  const pending = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), route, ts: Date.now() };
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(PENDING_CACHE);
        await cache.put(PENDING_KEY, new Response(JSON.stringify(pending), { headers: { 'content-type': 'application/json' } }));
      } catch (_) {}
      const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter((c) => {
        try {
          return new URL(c.url).origin === self.location.origin;
        } catch (_) {
          return false;
        }
      });
      // Every live page hears it; the first to act deletes the entry and the rest find it gone. No navigate(): the
      // page routes itself, through its own router. `url` is for pages from before this worker (location.href = url).
      for (const c of windows) {
        try {
          c.postMessage({ type: 'open', id: pending.id, route, url });
        } catch (_) {}
      }
      if (windows.length) {
        const win = windows.find((c) => c.visibilityState === 'visible') || windows[0];
        try {
          await win.focus();
          return;
        } catch (_) {}
      }
      // No window, or it would not come forward: open one. If it opens at start_url instead, the page still finds
      // the stored target.
      if (self.clients.openWindow) {
        try {
          await self.clients.openWindow(url);
        } catch (_) {}
      }
    })(),
  );
});

// The push service replaced the subscription (keys rotated, or it expired): subscribe again with the same server
// key and tell Helm, which moves the device's row (name and switch kept) to the new endpoint.
function fromB64u(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      let key = old && old.options && old.options.applicationServerKey;
      if (!key) {
        const r = await fetch('/api/push', { credentials: 'same-origin' });
        if (!r.ok) return;
        key = fromB64u((await r.json()).publicKey);
      }
      const sub = event.newSubscription || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      await fetch('/api/push/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), origin: self.location.origin, replaces: old ? old.endpoint : undefined }),
      });
    })(),
  );
});
