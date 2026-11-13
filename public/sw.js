const CACHE_VERSION = 'the-floor-v1.0.7';
const STATIC_CACHE = `static-${CACHE_VERSION}`;
const IMAGE_CACHE = 'the-floor-images-lru';
const MAX_IMAGE_CACHE_ENTRIES = 200;

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './logo.svg',
  './banner.svg',
  './manifest.webmanifest'
];

// Funzione LRU: limita la cache delle foto a massimo 200 elementi per non saturare la memoria del telefono
async function trimCache(cacheName, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxEntries) {
      await cache.delete(keys[0]);
      await trimCache(cacheName, maxEntries);
    }
  } catch {
    // Ignora errori di storage
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch(() => {});
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== STATIC_CACHE && key !== IMAGE_CACHE) {
            return caches.delete(key);
          }
          return Promise.resolve();
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Strategia per Immagini (LRU Cache-First per garantire avvio e rendering offline rapido)
  const isImage =
    req.destination === 'image' ||
    url.pathname.match(/\.(png|jpg|jpeg|webp|svg|gif)$/i) ||
    url.hostname.includes('wikimedia.org') ||
    url.hostname.includes('unsplash.com') ||
    url.hostname.includes('wsrv.nl') ||
    url.hostname.includes('tmdb.org') ||
    url.hostname.includes('fandom.com') ||
    url.hostname.includes('wp.com');

  if (isImage) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(async (cache) => {
        const cachedResponse = await cache.match(req);
        if (cachedResponse) {
          return cachedResponse;
        }

        try {
          const networkResponse = await fetch(req);
          if (networkResponse && networkResponse.status === 200) {
            cache.put(req, networkResponse.clone());
            trimCache(IMAGE_CACHE, MAX_IMAGE_CACHE_ENTRIES);
          }
          return networkResponse;
        } catch {
          return cachedResponse || Response.error();
        }
      })
    );
    return;
  }

  // Strategia Stale-While-Revalidate per asset statici e navigazione
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      const fetchPromise = fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && url.origin === self.location.origin) {
            caches.open(STATIC_CACHE).then((cache) => {
              cache.put(req, networkResponse.clone());
            });
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
