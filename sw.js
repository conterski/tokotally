/**
 * Service worker: makes the app usable with no network at all.
 *
 * The whole app is a handful of static files, so they are precached on
 * install. Serving is network-first (see below), with that cache as the
 * offline fallback. Bumping CACHE drops the old one on activate.
 *
 * Note this only runs in a secure context (https, or localhost). Over a
 * plain-http LAN address the app still works; it just isn't cached.
 */

const CACHE = 'tokotally-v2';

// How long to wait for the network before falling back to the cache.
const NETWORK_TIMEOUT = 3000;

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
  'js/ui/numpad.js',
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

/** fetch() that gives up after NETWORK_TIMEOUT so a bad signal can't hang. */
function fromNetwork(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('network timeout')), NETWORK_TIMEOUT);
    fetch(request).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Everything is network-first, with the cache as the offline fallback.
 *
 * Stale-while-revalidate was faster but served the *previous* build on
 * the first load after every deploy — and because each file updates
 * independently, a reload could mix new markup with old CSS, which is
 * exactly how the number-pad toggle came out unstyled on a phone. Being
 * always-current matters more here than shaving a few ms off a launch
 * that is already local. Offline is unaffected: with no network the
 * timeout trips and the cached copy answers.
 */
async function networkFirst(request) {
  try {
    const response = await fromNetwork(request);
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  } catch {
    const hit = await caches.match(request);
    if (hit) return hit;
    // Offline and never cached: a navigation can still have the shell.
    if (request.mode === 'navigate') {
      const shell = await caches.match('index.html');
      if (shell) return shell;
    }
    throw new Error('offline and uncached');
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // Same-origin only: never interpose on anything else.
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(networkFirst(request));
});
