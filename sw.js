// オフライン対応。アプリ本体は先に保存し、地図タイルは見た分だけ保存する。
const VERSION = "v6";
const SHELL = `shell-${VERSION}`;
// v2: 中身を確かめられる形（CORS）で取得した地図だけを保存する。
// v1 は中身を確かめられない応答（opaque）を保存していて、ブラウザが1枚を数MBとして数えるため容量を圧迫していた。
const TILES = "tiles-v2";
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
  // 古い本体と、古い形式の地図の保存（tiles-v1 など）を消す
  const old = (k) => (k.startsWith("shell-") && k !== SHELL) || (k.startsWith("tiles-") && k !== TILES);
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter(old).map((k) => caches.delete(k))))
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
  let cache = null;
  try {
    cache = await caches.open(TILES);
    // ignoreVary: 地理院タイルは Vary: Origin 付きで返る。地図の中身は取得元で変わらないので、見出しの違いでは区別しない
    // （区別すると、保存したものが要求の形の違いで見つからず、オフラインで出ないことがある）。
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
  } catch { /* 保存を読めなくても、ネットから取得して表示する */ }
  let res;
  try { res = await fetch(req); } catch { return new Response("", { status: 504 }); }
  // 保存するのは、中身を確かめられる成功の応答だけ（エラーや中身不明の応答は保存しない）
  if (cache && res.ok) {
    const copy = res.clone();
    try {
      await cache.put(req, copy);
      const keys = await cache.keys();
      if (keys.length > MAX_TILES) for (const k of keys.slice(0, keys.length - MAX_TILES)) await cache.delete(k);
    } catch { /* 容量がいっぱいで保存できなくても、取得した地図はそのまま表示する */ }
  }
  return res;
}
