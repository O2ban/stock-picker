/* Service Worker：只做离线外壳缓存。
 * 策略：
 *  - 导航请求（HTML）network-first，失败回退缓存，保证始终能拿到最新外壳，断网也能开。
 *  - 静态资源（js/css/png/svg/manifest）network-first，改版立刻生效，离线回退缓存。
 *  - /api/ 一律不走缓存，实时行情与选股结果必须联网。
 */
// 版本号：前端有改动时递增，install 会重新预缓存、activate 清理旧缓存，
// 从而让设备从旧版（曾 cache-first）平滑升级到新版（network-first）。
const VERSION = 'sp-v15';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './chart.css',
  './spark.js',
  './chart.js',
  './rv.js',
  './rv-data.js',
  './app.js',
  './vendor/echarts.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // API 不缓存
  if (url.pathname.includes('/api/')) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // 静态资源：network-first（改版后立刻生效），离线时回退缓存。
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone())).catch(() => {});
        return res;
      })
      // 离线回退：忽略 ?v= 版本查询串，只要路径命中即可
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
