// Service worker volutamente minimale: serve solo a soddisfare il requisito
// di installabilità (serve un fetch handler registrato), senza mettere in
// cache nulla. L'app cambia spesso: mettere in cache l'HTML o i file JS
// rischierebbe di mostrare una versione vecchia dopo un redeploy su Render.
// Ogni richiesta va sempre in rete, esattamente come senza service worker.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
