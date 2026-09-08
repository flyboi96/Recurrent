const CACHE = "recurrent-shell-v14";
const ASSETS = ["/", "/manifest.webmanifest", "/icon.svg"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => { if (event.request.method !== "GET") return; const isNavigation = event.request.mode === "navigate"; event.respondWith((isNavigation ? fetch(event.request) : caches.match(event.request)).then(response => { if (response) return response; return fetch(event.request); }).then(response => { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); return response; }).catch(() => caches.match(isNavigation ? "/" : event.request))); });
