const SIDECARR_PATH = "/sidecarr";

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
