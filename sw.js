/* JibJab Trading service worker.
 * App shell: stale-while-revalidate (instant loads, updates in the background).
 * Market data (Yahoo + CORS proxies): never intercepted — quotes must be live,
 * and the app already has its own retry/fallback chain.
 */

const CACHE = "jibjab-v1";

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./jj-bg-1.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "https://cdn.jsdelivr.net/npm/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js",
];

// Requests that must always hit the network (live market data).
const DATA_HOSTS = /finance\.yahoo\.com|corsproxy\.io|allorigins\.win|thingproxy\.freeboard\.io/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Tolerate individual failures (e.g. CDN offline at install time) so one
      // bad asset doesn't block the whole install.
      Promise.allSettled(SHELL.map((url) => cache.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!url.protocol.startsWith("http")) return;
  if (DATA_HOSTS.test(url.href)) return; // live quotes: straight to network

  event.respondWith(staleWhileRevalidate(req));
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
  const network = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    network.catch(() => {}); // refresh in background
    return cached;
  }
  const fresh = await network;
  if (fresh) return fresh;
  // Offline and uncached: fall back to the shell for navigations.
  if (req.mode === "navigate") {
    const shell = await cache.match("./index.html");
    if (shell) return shell;
  }
  return Response.error();
}
