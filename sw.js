// Service worker: makes the app work offline. Everything it needs is in this folder (fonts included).
// Strategy: network first, so a deployed update is always picked up while online; the cache answers when the network fails.
// Bump CACHE when the list below changes, so old entries are dropped.
const CACHE = 'resonance-v5';
const PRECACHE = [
  './', 'index.html', 'manifest.webmanifest',
  'css/style.css', 'css/fonts.css',
  'fonts/Inter.woff2', 'fonts/JetBrainsMono.woff2', 'fonts/CormorantGaramond.woff2',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'js/main.js', 'js/params.js', 'js/pad.js', 'js/engine.worklet.js', 'js/instrument.js', 'js/generator.js', 'js/synth.js', 'js/varpad.js',
  'js/analyzer.js', 'js/analyzer.worker.js', 'js/studio.js', 'js/importaudio.js', 'js/leveltrim.js', 'js/trim.worker.js', 'js/trimcore.js', 'js/midifile.js',
  'data/measured/iowa_grand.json', 'data/measured/salamander_grand.json',
];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || r.headers.has('range')) return;
  e.respondWith(fetch(r).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); } return res; })
    .catch(() => caches.match(r, { ignoreSearch: true }).then(hit => hit || caches.match('index.html'))));
});
