// オフライン対応。アプリ本体は先に保存し、地図タイルは見た分だけ保存する。
const VERSION = "v3";
const SHELL = `shell-${VERSION}`;
const TILES = "tiles-v1";
const MAX_TILES = 3000;
const FILES = [
  "./", "index.html", "style.css", "manifest.webmanifest",
  "js/app.js", "js/core.js", "js/store.js",
  "data/sample.csv", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-180.png",
];
// 地図の部品（Leaflet 1.9.4、版を固定し改ざん検出つきで読み込む）
const LEAFLET = [
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/leaflet@1.9.4/dist/images/layers.png",
  "https://unpkg.com/leaflet@1.9.4/dist/images/layers-2x.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then(async (c) => {
    await c.addAll(FILES);
    await Promise.all(LEAFLET.map((u) => fetch(u, { mode: "cors" }).then((r) => r.ok && c.put(u, r)).catch(() => {})));
  }).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("shell-") && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.hostname === "cyberjapandata.gsi.go.jp") {
    e.respondWith(tile(e.request));
    return;
  }
  if (url.hostname === "unpkg.com" && url.pathname.startsWith("/leaflet@1.9.4/")) {
    // 版が固定なので、保存したものを優先する
    e.respondWith(caches.match(e.request, { ignoreVary: true }).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, copy));
      return res;
    })));
    return;
  }
  if (url.origin === location.origin) {
    // 本体: ネットにつながれば新しいものを、つながらなければ保存したものを使う
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone();
      if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});

async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === "opaque") {
      await cache.put(req, res.clone());
      const keys = await cache.keys();
      if (keys.length > MAX_TILES) for (const k of keys.slice(0, keys.length - MAX_TILES)) await cache.delete(k);
    }
    return res;
  } catch {
    return new Response("", { status: 504 });
  }
}
