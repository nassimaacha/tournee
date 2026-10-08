// Tournée service worker: makes the site installable and shows the last loaded page when offline.
// Everything else always comes from the network, so updates are never stuck in a cache.
const CACHE = "tournee-v1";
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.add("/")).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || req.mode !== "navigate") return; // only page loads; API calls and files go straight to the network
  e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put("/", copy)).catch(() => {}); return res; })
    .catch(() => caches.match("/")));
});
