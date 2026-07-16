// Service Worker mínimo — por ahora solo habilita que la PWA sea instalable.
// Más adelante se puede ampliar para que funcione offline (cachear archivos).

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

// Por ahora dejamos que todos los pedidos vayan directo a internet,
// sin interceptar ni cachear nada (versión mínima).
self.addEventListener('fetch', (event) => {
  // Sin lógica todavía — el navegador maneja el pedido normalmente.
});
