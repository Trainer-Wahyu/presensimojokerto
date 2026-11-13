const CACHE_NAME = 'presensi-kiosk-v11;

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './js/app.js?v=10',
  './js/supabase-client.js',
  './js/pwa-gate.js',
  './js/device-id.js',
  './js/geo-guard.js',
  './js/camera-liveness.js',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

// Instal & langsung aktifkan Service Worker baru tanpa menunggu tab ditutup
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
});

// Hapus seluruh cache versi lama (v1..v9) dan ambil alih kendali halaman segera
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((oldKey) => caches.delete(oldKey))
      )
    ).then(() => self.clients.claim())
  );
});

// Strategi Network-First untuk aplikasi lokal agar pembaruan kode selalu langsung aktif
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Jangan pernah cache permintaan API Supabase
  if (url.hostname.includes('supabase.co')) {
    return;
  }

  // Untuk file aplikasi sendiri (same-origin): utamakan jaringan terbaru, fallback ke cache
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const copy = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return networkRes;
        })
        .catch(() => caches.match(req))
    );
  }
});
