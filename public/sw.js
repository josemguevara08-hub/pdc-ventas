// Service worker: guarda la app en el dispositivo para que abra aunque no haya internet.
// Al publicar una versión nueva, cambia el número de VERSION.
const VERSION = 'pdc-v1.2.1';
const ARCHIVOS = [
  './', 'css/estilos.css', 'js/config.js', 'js/app.js', 'js/lib/supabase.js',
  'img/logo.svg', 'img/monograma.svg', 'img/icon-192.png',
  'img/rebanada.webp', 'img/tarta_entera.webp', 'img/nutella_chica.webp',
  'img/clasica_grande.webp', 'img/lotus_grande.webp',
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

  // Páginas y código (HTML, JS, CSS, manifest): primero internet, para que los cambios lleguen de inmediato.
  // Sin internet, se usa la copia guardada.
  const esCodigo = req.mode === 'navigate' || /\.(js|css|webmanifest|html)$/.test(url.pathname) || url.pathname === '/';
  if (esCodigo) {
    e.respondWith(fetch(req, { cache: 'no-store' }).then((r) => {
      if (r.ok && !r.redirected) { const copia = r.clone(); caches.open(VERSION).then((c) => c.put(req.mode === 'navigate' ? './' : req, copia)); }
      return r;
    }).catch(() => caches.match(req).then((r) => r || (req.mode === 'navigate' ? caches.match('./') : undefined))));
    return;
  }
  // Imágenes y tipografías: copia guardada y se actualiza en segundo plano
  e.respondWith(caches.match(req).then((guardada) => {
    const red = fetch(req).then((r) => {
      if (r.ok) { const copia = r.clone(); caches.open(VERSION).then((c) => c.put(req, copia)); }
      return r;
    }).catch(() => guardada);
    return guardada || red;
  }));
});
