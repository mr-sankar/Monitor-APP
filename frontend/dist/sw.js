// KellaMonitor PWA Service Worker (Pass-Through)
// Fulfills Chromium PWA WebAPK installability without intercepting any network requests
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Empty fetch handler satisfies PWA install criteria while allowing 100% of network traffic
// (including login, APIs, and live telemetry) to be processed natively by the browser.
self.addEventListener('fetch', () => {});
