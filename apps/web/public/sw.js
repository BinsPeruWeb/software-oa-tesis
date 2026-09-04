const SHELL = 'oa-shell-v1';
self.addEventListener('install', (event) => event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(['/']))));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key))))));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

