// Service Worker：讓 App 可安裝、可離線開啟「畫面」。
// 資料一律走網路（Supabase），不快取；同網域的程式檔採「網路優先、失敗用快取」，確保有網路時一定拿到最新版。
const CACHE = 'ipwa-shell-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/main.js', 'js/db.js', 'js/app-config.js',
  'js/ui/common.js', 'js/ui/login.js', 'js/ui/inspect.js', 'js/ui/office.js', 'js/ui/report.js', 'js/ui/admin.js',
  'js/core/util.js', 'js/core/config.js', 'js/core/validate.js', 'js/core/hz.js', 'js/core/match.js', 'js/core/report.js', 'js/core/exporter.js',
]; // 主檔 JSON 不預快取（正式部署時可刪除，資料改由資料庫提供）
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Supabase 等外部請求不處理
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
  );
});
