// KellaMonitor PWA Service Worker for native Android WebAPK installation
const CACHE_NAME = 'kellamonitor-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Always fetch fresh from network for real-time dashboard data
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});
