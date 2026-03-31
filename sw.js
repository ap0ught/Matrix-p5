// Wake up, Neo... The service worker is here to cache the Matrix.
const CACHE_NAME = "matrix-v1";

// All assets required for the app to function offline.
const PRECACHE_ASSETS = [
  "./",
  "./index.html",
  "./sketch.js",
  "./spotify.js",
  "./manifest.json",
  "./lib/p5.min.js",
  "./fonts/NotoSansJP-Regular.ttf",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg",
];

// Pre-cache all assets when the service worker is installed.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Remove old caches when a new service worker takes control.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Serve cached assets first; fall back to the network for anything else
// (e.g. the Spotify API, which must always be fresh).
self.addEventListener("fetch", (event) => {
  // Only intercept same-origin and pre-cached third-party requests.
  // Let Spotify API calls pass straight through to the network.
  // Use URL hostname matching (not substring) to avoid false positives.
  let requestHostname;
  try {
    requestHostname = new URL(event.request.url).hostname;
  } catch {
    return; // Malformed URL — skip.
  }

  if (requestHostname === "api.spotify.com" ||
      requestHostname === "accounts.spotify.com") {
    // Let the browser handle Spotify requests directly — no cache, always fresh.
    return;
  }

  // For navigation requests (e.g. the Spotify ?code= callback or PWA launch),
  // match the cached app shell ignoring the query string so the page loads
  // offline even when query params are present.
  if (event.request.mode === "navigate") {
    event.respondWith(
      caches.match("./index.html").then(
        (cached) => cached || fetch(event.request)
      )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(
      (cached) => cached || fetch(event.request)
    )
  );
});
