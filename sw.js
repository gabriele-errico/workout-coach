// Service Worker per Workout Coach: rende l'app utilizzabile offline.
// I dati sono salvati nel localStorage dalla pagina, qui si mettono in cache solo i file dell'app.
const CACHE_NAME = 'workout-coach-v3';

const APP_FILES = [
  './workout-coach.html',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

// Elimina le cache lasciate dalle versioni precedenti (solo quelle di questa app)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(name => name.startsWith('workout') && name !== CACHE_NAME)
          .map(name => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// Network-first: online si ricevono sempre gli aggiornamenti, offline si usa la cache
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })
        .then(cached => cached ||
          (request.mode === 'navigate' ? caches.match('./workout-coach.html') : Response.error())))
  );
});
