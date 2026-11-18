// Service worker: guarda la app en el dispositivo para que abra aunque no haya internet.
// Al publicar una versión nueva, cambia el número de VERSION.
const VERSION = 'pdc-v1.1.0';
const ARCHIVOS = [
  './', 'css/estilos.css', 'js/config.js', 'js/app.js', 'js/lib/supabase.js',
  'img/logo.svg', 'img/monograma.svg', 'img/icon-192.png',
  'img/rebanada.webp', 'img/tarta_entera.webp', 'img/tarta_chocolate.webp',
  'manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // la base de datos nunca pasa por aquí

  if (req.mode === 'navigate') {
    // Páginas: primero internet (para recibir actualizaciones); sin internet, la copia guardada
    e.respondWith(fetch(req).then((r) => {
      if (r.ok && url.pathname === '/') { const copia = r.clone(); caches.open(VERSION).then((c) => c.put('./', copia)); }
      return r;
    }).catch(() => caches.match(req).then((r) => r || caches.match('./'))));
    return;
  }
  // Archivos (estilos, código, imágenes, tipografías): copia guardada y se actualiza en segundo plano
  e.respondWith(caches.match(req).then((guardada) => {
    const red = fetch(req).then((r) => {
      if (r.ok) { const copia = r.clone(); caches.open(VERSION).then((c) => c.put(req, copia)); }
      return r;
    }).catch(() => guardada);
    return guardada || red;
  }));
});
