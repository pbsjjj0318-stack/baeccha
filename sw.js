/* 대진여객 배차 — 오프라인에서도 열리도록 최소 캐시만 둡니다. (네트워크 우선) */
var CACHE = 'dj-baeccha-v92';
var ASSETS = ['./', 'index.html', 'app.css?v=87', 'app.js?v=98', 'manifest.json',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(ASSETS.map(function (u) {
      return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
    }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req, { cache: 'no-store' }).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') {
          return caches.match('index.html').then(function (idx) {
            if (idx) return idx;
            return new Response('오프라인입니다. 인터넷에 연결한 뒤 다시 열어 주세요.',
              { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
          });
        }
        return new Response('', { status: 504 });
      });
    })
  );
});
