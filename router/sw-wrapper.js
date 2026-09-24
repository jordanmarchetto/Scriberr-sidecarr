const SIDECARR_PATH = "/sidecarr";

// Scriberr's root-scoped service worker would otherwise serve its cached app
// for /sidecarr before the request reaches the gateway. Handle Sidecarr routes
// from the network, then preserve Scriberr's PWA behavior for every other path.
// /__scriberr_original_sw.js is a private Caddy route that rewrites the request
// to /sw.js and proxies it to the Scriberr container.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && (url.pathname === SIDECARR_PATH || url.pathname.startsWith(`${SIDECARR_PATH}/`))) {
    event.respondWith(fetch(event.request));
  }
});

try {
  importScripts("/__scriberr_original_sw.js");
} catch (error) {
  console.error("[Sidecarr gateway] Scriberr service worker could not be loaded; using network-only fallback", error);
}
