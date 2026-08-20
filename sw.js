// v3 — network-first so code updates always reach the user.
// Cache is only a fallback for offline use.
const CACHE = 'my-song-app-v3';
const ASSETS = ['./', './index.html', './style.css', './app.js', './manifest.json', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;   // never touch YouTube / remote audio
  if (e.request.method !== 'GET') return;

  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      // Offline: serve the cached copy if we have one. If we don't, let the
      // request fail as a real network error instead of resolving to undefined.
      const cached = await caches.match(e.request);
      if (cached) return cached;
      throw err;
    }
  })());
});
