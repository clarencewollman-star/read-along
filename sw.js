/* Keeps a copy of the app so it opens quickly and still works with a weak connection.
   The app's own files: always ask the website for the newest copy first (skipping the
   browser's own cache), and only use the saved copy when there is no connection.
   The reader library from the CDN: use the saved copy (it never changes for a version). */
const CACHE = 'read-along-v8';
const APP_FILES = ['./', 'index.html', 'styles.css?v=8', 'app.js?v=8', 'manifest.json', 'icons/icon-180.png', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(APP_FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // A page load can't be re-made with options, so fetch it by its address instead.
    const fresh = req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache' }) : fetch(req, { cache: 'no-cache' });
    e.respondWith(
      fresh
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match(req, { ignoreSearch: true })))
    );
    return;
  }

  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
  }
});
