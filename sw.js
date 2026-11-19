const CACHE='namaz-svijet-v3-33';
const ASSETS=['./','./index.html','./styles.css?v=3.33','./app.js?v=3.33','./i18n.js?v=3.33','./al-badr-2026.js','./cci-2026.js','./mushaf-novi.html','./fonts/amiri-quran.woff','./assets/mushaf-corner.svg','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));self.skipWaiting()});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('namaz-svijet-')&&k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener('fetch',event=>{if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;event.respondWith(fetch(event.request).catch(()=>caches.match(event.request)))});
