// Service worker: guarda la app en el dispositivo para que abra aunque no haya internet.
// Al publicar una versión nueva, cambia el número de VERSION.
const VERSION = 'pdc-v1.3.2';
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

  const esPagina = req.mode === 'navigate';
  const esCodigo = esPagina || /\.(js|css|webmanifest|html)$/.test(url.pathname) || url.pathname === '/';

  if (esCodigo) {
    // Páginas y código: primero internet (para recibir actualizaciones); sin internet, la copia guardada.
    // Si internet tarda más de 6 segundos y hay copia guardada, se usa la copia para no dejar la pantalla cargando.
    const clave = esPagina ? new URL(url.pathname, self.location.origin).href : req.url;  // cada página con su propia copia
    const red = fetch(esPagina ? req : new Request(req.url, { cache: 'no-cache' })).then((r) => {
      if (r.ok && !r.redirected) { const copia = r.clone(); caches.open(VERSION).then((c) => c.put(clave, copia)).catch(() => {}); }
      return r;
    });
    const respaldo = () => caches.match(clave).then((r) => r || caches.match(req));
    const conLimite = new Promise((resolve) => {
      const t = setTimeout(() => respaldo().then((r) => { if (r) resolve(r); }), 6000);
      red.then((r) => { clearTimeout(t); resolve(r); })
         .catch(() => { clearTimeout(t); respaldo().then((r) => resolve(r || Response.error())); });
    });
    e.respondWith(conLimite);
    return;
  }

  // Imágenes: copia guardada y se actualiza en segundo plano
  e.respondWith(caches.match(req).then((guardada) => {
    const red = fetch(req).then((r) => {
      if (r.ok) { const copia = r.clone(); caches.open(VERSION).then((c) => c.put(req, copia)).catch(() => {}); }
      return r;
    }).catch(() => guardada || Response.error());
    return guardada || red;
  }));
});
