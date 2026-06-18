// Guitar Tracker service worker — static asset caching only.
// Business data (Supabase, API routes, page HTML) is never cached.
// Bump CACHE_NAME when a forced cache flush is needed across all clients.

const CACHE_NAME = 'gt-v1';

function isStaticAsset(url) {
  const u = new URL(url);
  // Next.js content-hashed bundles — safe to cache indefinitely
  if (u.pathname.startsWith('/_next/static/')) return true;
  // Public static files (icons, fonts, splash images)
  if (/\.(png|ico|svg|webp|jpg|jpeg|woff2?|ttf|otf)$/.test(u.pathname)) return true;
  // Google Fonts
  if (u.hostname === 'fonts.googleapis.com') return true;
  if (u.hostname === 'fonts.gstatic.com') return true;
  return false;
}

// Install — do not skip waiting here; wait for explicit user confirmation
self.addEventListener('install', () => {
  // Intentionally empty — no pre-caching
});

// Activate — delete stale caches from previous versions, then claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

// Message — client sends SKIP_WAITING after user confirms refresh
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Fetch — cache-first for static assets, passthrough for everything else
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept Supabase (auth tokens, realtime, database)
  if (url.hostname.includes('supabase.co')) return;
  // Never intercept Next.js API routes
  if (url.pathname.startsWith('/api/')) return;
  // Never intercept page navigations — always want fresh HTML
  if (request.mode === 'navigate') return;
  // Only handle confirmed static assets
  if (!isStaticAsset(request.url)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
        }
        return response;
      });
    })
  );
});
