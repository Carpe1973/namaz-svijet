const CACHE='namaz-svijet-v3-39';
const ASSETS=['./','./index.html','./styles.css?v=3.37','./app.js?v=3.39','./i18n.js?v=3.39','./prayer-times.mjs','./prayer-reminders.mjs?v=3.39','./al-badr-2026.js','./cci-2026.js','./mushaf-pdf-tedzvid.html','./fonts/amiri-quran.woff','./assets/mushaf-corner.svg','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));self.skipWaiting()});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('namaz-svijet-')&&k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener('fetch',event=>{
  const url = new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.includes('/api/prayer-alerts/'))return;
  event.respondWith(fetch(event.request).catch(() =>
    caches.match(event.request, {ignoreSearch: event.request.mode === 'navigate'})));
});
self.addEventListener('push', event => {
  if (!event.data) return;
  const alert = event.data.json();
  event.waitUntil(self.registration.showNotification(alert.title, {
    body: alert.body, icon: './icons/icon-192.png', tag: alert.tag
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const home = new URL('./?tab=times', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(async clients => {
    const app = clients.find(client => client.url.startsWith(self.registration.scope) &&
      /^(\/|\/index\.html)$/.test(new URL(client.url).pathname));
    if (!app) return self.clients.openWindow(home);
    const windowClient = await app.navigate(home);
    return (windowClient || app).focus();
  }));
});
