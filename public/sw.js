/**
 * SATHI SERVICE WORKER — Offline PWA Support
 * Caches: app shell, map tiles, safety scores
 * Strategy: Cache-First for assets, Network-First for API
 */

const CACHE_VERSION  = 'sathi-v1';
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const TILES_CACHE     = `${CACHE_VERSION}-tiles`;
const SCORES_CACHE    = `${CACHE_VERSION}-scores`;

const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles/main.css',
  '/js/app.js',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Outfit:wght@400;600;700;800&display=swap',
];

// ─── Install ─────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then(cache => cache.addAll(APP_SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate ─────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('sathi-') && key !== APP_SHELL_CACHE && key !== TILES_CACHE && key !== SCORES_CACHE)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch Strategy ────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Map tiles: Cache-First (tiles rarely change)
  if (url.hostname.includes('tile.openstreetmap.org') || url.pathname.includes('/tiles/')) {
    event.respondWith(cacheFirst(event.request, TILES_CACHE));
    return;
  }

  // Safety scores API: Network-First, fall back to cache
  if (url.pathname.startsWith('/api/routes') || url.pathname.startsWith('/api/reviews')) {
    event.respondWith(networkFirst(event.request, SCORES_CACHE));
    return;
  }

  // App shell assets: Cache-First
  if (APP_SHELL_ASSETS.some(asset => url.pathname === asset || url.href === asset)) {
    event.respondWith(cacheFirst(event.request, APP_SHELL_CACHE));
    return;
  }

  // Everything else: Network with cache fallback
  event.respondWith(networkFirst(event.request, APP_SHELL_CACHE));
});

// ─── Cache strategies ─────────────────────────────────────────────────
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline — resource not cached', { status: 503 });
  }
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'Offline', offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ─── Background Sync (review queue flush) ────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-reviews') {
    event.waitUntil(flushReviewQueue());
  }
});

async function flushReviewQueue() {
  // Read from IndexedDB, POST to /api/reviews/batch
  // Implementation uses client postMessage in full version
  console.log('[SW] Flushing offline review queue…');
}
