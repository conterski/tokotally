/**
 * Service worker: makes the app usable with no network at all.
 *
 * The whole app is a handful of static files, so they are precached on
 * install and served cache-first. Bump CACHE when any of them changes —
 * the old cache is dropped on activate.
 *
 * Note this only runs in a secure context (https, or localhost). Over a
 * plain-http LAN address the app still works; it just isn't cached.
 */

const CACHE = 'tokotally-v1';

const ASSETS = [
  '.',
  'index.html',
  'manifest.webmanifest',
  'css/theme.css',
  'css/app.css',
  'js/app.js',
  'js/core.js',
  'js/db.js',
  'js/store.js',
  'js/ui/common.js',
  'js/ui/ledgerpane.js',
  'js/ui/salepane.js',
  'js/ui/settings.js',
  'js/ui/tween.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll rejects the whole install if one asset 404s; add them
      // individually so a missing optional icon can't brick the worker.
      .then((cache) =>
        Promise.all(ASSETS.map((url) => cache.add(url).catch(() => {})))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

/**
 * Navigations are network-first so a running browser picks up a new
 * version of the app as soon as it is online, and fall back to the
 * cached shell when it is not.
 */
function networkFirst(request) {
  return fetch(request)
    .then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    })
    .catch(() => caches.match(request).then((hit) => hit || caches.match('index.html')));
}

/**
 * Assets are stale-while-revalidate: the cached copy answers straight
 * away (so a cold, offline launch is instant), while a fresh copy is
 * fetched in the background for next time.
 *
 * Plain cache-first would be faster to write but pins every visitor to
 * whatever shipped first — a later bug fix would never reach them unless
 * CACHE happened to be bumped in the same change. This self-heals.
 */
function staleWhileRevalidate(request) {
  return caches.match(request).then((hit) => {
    const fresh = fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => hit);
    return hit || fresh;
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // Same-origin only: never interpose on anything else.
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    request.mode === 'navigate'
      ? networkFirst(request)
      : staleWhileRevalidate(request)
  );
});
