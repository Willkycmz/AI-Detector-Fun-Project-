/**
 * sw.js - VisionX Service Worker for PWA
 * Lightweight, safe caching for static assets with zero interference for API & SSE.
 */

const CACHE_NAME = 'visionx-cache-v2';
const STATIC_ASSETS = [
  './',
  './index.html',
  './favicon.svg',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Cache prefetch non-fatal warning:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Jangan sentuh request API gateway, SSE stream, external calls, atau dev localhost
  if (url.pathname.startsWith('/api') || url.origin !== self.location.origin || url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return;
  }

  // Network-first dengan fallback ke cache untuk navigasi dan file statis lokal
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            // Jangan simpan file besar atau dinamis secara agresif
            if (!url.pathname.endsWith('.wasm') && !url.pathname.endsWith('.onnx')) {
              cache.put(event.request, responseToCache).catch(() => {});
            }
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
      })
  );
});
