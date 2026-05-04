// Service worker — Phase A.1 minimal for PWA install eligibility (2026-05-03).
// Does NOT cache aggressively — avoids breaking existing dynamic deal data.
// Future Phase A.2: add proper offline-cache strategy + sync queue.

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  // Pass-through — no caching yet. PWA install eligibility just requires
  // a registered SW to exist, not active caching.
  return;
});