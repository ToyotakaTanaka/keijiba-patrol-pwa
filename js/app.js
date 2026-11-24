// 掲示場巡回 PWA の画面。地図は Leaflet + 国土地理院タイル（Google の地図 API は使わない）。
// 案内は Google マップアプリに目的地を渡す（Maps URLs、API キー不要）。
import * as C from "./core.js";
import * as S from "./store.js";

// 同梱するのは架空の見本だけ。実際の掲示場の一覧は、各自治体の公開データなどを CSV で取り込む。
const BUNDLED_ID = "bundled-sample";
const BUNDLED_NAME = "見本（架空の掲示場）";
/** 見本の出発地点（架空。見本の掲示場の近くの目安の位置）。 */
const SAMPLE_HOME = { lat: 35.2785, lon: 139.6700 };

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtTime = (t) => new Date(t).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
const errorMessage = (err) => String((err && typeof err === "object" ? err.message || err.name : err) || "不明なエラー");

const state = {
  view: "route",        // route | next | saved | done | settings | picker | lists | import | photo
  lists: new Map(),     // id -> {id, name, boards, source, importedAt, builtin}
  activeId: BUNDLED_ID,
  home: null,           // {lat, lon}
  progress: { assigned: [], route: [] },
  done: new Map(),      // number -> {savedAt}
  focus: null,          // 地図で選んだ掲示場（次の掲示場として優先）
  savedNumber: null,
  message: "",
  query: "",
  importSession: null,
  showOthers: false,
  showLine: true,
};

// ---------- データ ----------
const list = () => state.lists.get(state.activeId) || state.lists.get(BUNDLED_ID);
const byNumber = () => new Map(list().boards.map((b) => [b.number, b]));
const routeBoards = () => { const m = byNumber(); return state.progress.route.map((n) => m.get(n)).filter(Boolean); };
const assignedBoards = () => { const m = byNumber(); return state.progress.assigned.map((n) => m.get(n)).filter(Boolean); };
const nextBoard = () => {
  const r = routeBoards();
  return r.find((b) => b.number === state.focus && !state.done.has(b.number)) || r.find((b) => !state.done.has(b.number));
};

async function loadAll() {
  const res = await fetch("data/sample.csv");
  const table = C.readTable(await res.arrayBuffer());
  const bundled = C.buildBoards(table, C.autoMapping(table.headers, table.rows)).boards;
  state.lists.set(BUNDLED_ID, { id: BUNDLED_ID, name: BUNDLED_NAME, boards: bundled, builtin: true, source: "同梱の見本", importedAt: 0 });
  for (const l of await S.listAll()) state.lists.set(l.id, l);
  state.home = (await S.kvGet("home")) || null;
  const active = await S.kvGet("activeListId");
  if (active && state.lists.has(active)) state.activeId = active;
  await loadProgress();
}

async function loadProgress() {
  state.progress = (await S.kvGet(`progress:${state.activeId}`)) || { assigned: [], route: [] };
  state.done = await S.photoIndex(state.activeId);
}

async function saveProgress() { await S.kvSet(`progress:${state.activeId}`, state.progress); }

function replan(progress = state.progress, boards = list().boards) {
  const set = new Set(progress.assigned);
  const picked = boards.filter((b) => set.has(b.number));
  progress.assigned = picked.map((b) => b.number);
  if (!state.home) { progress.route = [...progress.assigned]; return progress; }
  progress.route = C.planRoute(state.home, picked).map((i) => picked[i].number);
  return progress;
}

// ---------- 共通の部品 ----------
function setHeader(title, left, right) {
  $("#htitle").textContent = title;
  const slot = (el, b) => {
    el.innerHTML = "";
    if (!b) return;
    const btn = document.createElement("button");
    btn.innerHTML = b.icon; btn.setAttribute("aria-label", b.label); btn.onclick = b.onClick;
    el.appendChild(btn);
  };
  slot($("#hleft"), left); slot($("#hright"), right);
}
/** 地図ボタン（折りたたんだ地図の形＋「地図」）。絵文字は端末で見え方が変わるため使わない。 */
const MAP_ICON = `<span class="iconlabel"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="currentColor"><path d="M9 3 3 5.4v15.6l6-2.4 6 2.4 6-2.4V3l-6 2.4L9 3Zm1 2.3 4 1.6v12.8l-4-1.6V5.3ZM5 6.7l3-1.2v12.8l-3 1.2V6.7Zm11 .2 3-1.2v12.8l-3 1.2V6.9Z"/></svg><small>地図</small></span>`;
const gear = { icon: "⚙︎", label: "設定", onClick: () => go("settings") };
const backTo = (v) => ({ icon: "‹", label: "戻る", onClick: () => go(v) });

function progressBlock() {
  const r = routeBoards(), d = r.filter((b) => state.done.has(b.number)).length;
  const pct = r.length ? Math.round((d / r.length) * 100) : 0;
  return `<div class="pad progress"><b>完了 ${d} / ${r.length}</b>
    <div class="bar"><div class="track"><div class="fill" style="width:${pct}%"></div></div><span>${pct}%</span></div></div>`;
}

function toast(text) {
  const t = $("#toast"); t.textContent = text; t.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
}

function go(view) { state.view = view; render(); }

// ---------- 画面 ----------
function render() {
  const onMap = state.view === "map" || state.view === "pickhome";
  $("#mapwrap").hidden = !onMap;
  $("#mapcard").classList.toggle("pickhome", state.view === "pickhome");
  const v = $("#view");
  v.hidden = onMap;
  v.scrollTop = 0;
  const ready = state.home && state.progress.route.length;
  if (!ready && ["route", "next", "saved", "done"].includes(state.view)) return renderEmpty(v);
  ({ route: renderRoute, next: renderNext, saved: renderSaved, done: renderDone, settings: renderSettings,
     picker: renderPicker, lists: renderLists, import: renderImport, map: renderMap, pickhome: renderPickHome, photo: renderPhoto })[state.view](v);
}

function renderEmpty(v) {
  setHeader("掲示場巡回", null, gear);
  v.innerHTML = `<div class="homebig grow"><div><span>🏠</span>自宅と担当の掲示場を<br>登録してください<p class="muted">見本で試すなら「見本を入れる」</p><p class="privacy">🔒 データはこの端末の中だけに保存され、<br>ほかの人からは見えません。</p></div></div>
    <div class="btns"><button class="btn" id="b1">設定を開く</button><button class="btn outline" id="b2">見本を入れる（架空の掲示場10か所）</button></div>`;
  $("#b1").onclick = () => go("settings");
  $("#b2").onclick = applySample;
}

function renderRoute(v) {
  setHeader("巡回順", { icon: MAP_ICON, label: "地図で見る", onClick: () => go("map") }, gear);
  const r = routeBoards(), a = assignedBoards();
  const csv = C.roundTrip(state.home, a), plan = C.roundTrip(state.home, r);
  const ok = state.progress.route.length === state.progress.assigned.length && new Set(state.progress.route).size === state.progress.route.length;
  const d = r.filter((b) => state.done.has(b.number)).length;
  const row = (dot, title, sub, checked, attrs = "") => `<div class="tl-row" ${attrs}>${dot}<div class="tl-text"><b>${esc(title)}</b>${sub ? `<span class="small">${esc(sub)}</span>` : ""}</div>${checked ? '<span class="check">✔︎</span>' : ""}</div>`;
  const dots = '<div class="dots"><i></i><i></i><i></i></div>';
  v.innerHTML = `<div class="pad summary"><div class="listname">▤ ${esc(list().name)}</div><h2>直線距離を使った目安</h2>
    <div>往復 ${C.formatKm(plan)}（CSV順 ${C.formatKm(csv)} より ${C.formatKm(csv - plan)} 短い）</div>
    <div class="small">担当${a.length}か所・${ok ? "漏れと重複なし" : "担当と巡回順が一致しません"}</div></div>
    <div class="timeline">${row('<div class="dot home">⌂</div>', "自宅から出発")}
    ${r.map((b) => dots + row(`<div class="dot">${esc(b.number)}</div>`, b.name, state.done.has(b.number) ? `撮影済み ${fmtTime(state.done.get(b.number).savedAt)}` : "", state.done.has(b.number), state.done.has(b.number) ? `data-photo="${esc(b.number)}" style="cursor:pointer"` : "")).join("")}
    ${dots}${row('<div class="dot home">⌂</div>', "自宅に戻る")}</div>
    <div class="grow"></div>
    <div class="btns"><button class="btn" id="go">${d === 0 ? "巡回を始める" : d === r.length ? "自宅へ戻る" : `巡回を続ける（${d}/${r.length}）`}</button></div>`;
  $("#go").onclick = () => go("next");
  v.querySelectorAll("[data-photo]").forEach((el) => el.onclick = () => { state.photoNumber = el.dataset.photo; go("photo"); });
}

function renderNext(v) {
  const b = nextBoard();
  if (!b) return go("done");
  setHeader("次の掲示場", { icon: "☰", label: "巡回順に戻る", onClick: () => { state.focus = null; go("route"); } }, gear);
  v.innerHTML = `${progressBlock()}
    <div class="card"><div class="bignum">${esc(b.number)}</div><h3>${esc(b.name)}</h3><div class="small">${esc(b.address)}</div>
      ${state.message ? `<div class="warn">${esc(state.message)}</div>` : ""}</div>
    <div class="btns">
      <a class="btn" href="${C.googleMapsNavUrl(b)}" target="_blank" rel="noopener">➤ Google マップで案内</a>
      <button class="btn outline" id="shoot">📷 着いたら写真を撮る</button>
      <div class="small" style="text-align:center">案内は Google マップアプリで開きます（現在地と目的地が Google に渡ります）。運転中は操作しないでください。</div>
    </div>`;
  $("#shoot").onclick = () => openCamera(b);
}

async function renderSaved(v) {
  const b = byNumber().get(state.savedNumber);
  const has = routeBoards().some((x) => !state.done.has(x.number));
  setHeader(`掲示場 ${state.savedNumber}`, { icon: "☰", label: "巡回順に戻る", onClick: () => go("route") }, gear);
  v.innerHTML = `<div class="banner"><span class="ok">✔︎</span>写真を保存しました</div>${progressBlock()}
    <div class="photo"><img id="pimg" alt="保存した写真"></div><div class="pad small" style="text-align:center">${esc(b?.name)}</div>
    <div class="btns"><button class="btn" id="nx">${has ? "次の掲示場へ" : "自宅へ戻る"}</button></div>`;
  $("#nx").onclick = () => go("next");
  showPhoto($("#pimg"), state.savedNumber);
}

function renderDone(v) {
  setHeader("巡回完了", { icon: "☰", label: "巡回順に戻る", onClick: () => go("route") }, gear);
  const n = routeBoards().length;
  v.innerHTML = `<div class="banner"><span class="ok">✔︎</span>全${n}か所の撮影が完了しました</div>${progressBlock()}
    <div class="homebig"><div><span>⌂</span>自宅へ戻ります</div></div>
    <div class="btns"><a class="btn" href="${C.googleMapsNavUrl(state.home)}" target="_blank" rel="noopener">➤ Google マップで自宅へ</a>
    <div class="small" style="text-align:center">帰宅案内では、目的地として自宅の位置が Google マップに渡ります。</div></div>`;
}

async function renderPhoto(v) {
  const b = byNumber().get(state.photoNumber);
  setHeader(`掲示場 ${state.photoNumber}`, backTo("route"), null);
  const rec = state.done.get(state.photoNumber);
  v.innerHTML = `<div class="photo" style="flex:none;height:60vh"><img id="pimg" alt="保存した写真"></div>
    <div class="pad"><b>${esc(b?.name)}</b><div class="small">${esc(b?.address)}</div><div class="small">保存日時: ${rec ? new Date(rec.savedAt).toLocaleString("ja-JP") : ""}</div></div>`;
  showPhoto($("#pimg"), state.photoNumber);
}

async function showPhoto(img, number) {
  const rec = await S.photoGet(S.photoKey(state.activeId, number));
  if (rec?.blob) img.src = URL.createObjectURL(rec.blob);
}

// ---------- 撮影 ----------
let cameraTarget = null;
function openCamera(board) {
  cameraTarget = board;
  state.message = "";
  const input = $("#camera");
  input.value = "";
  input.click();
}

$("#camera").addEventListener("cancel", () => {
  if (!cameraTarget) return;
  state.message = `${cameraTarget.number} は撮影を取り消したため未完了のままです。`;
  cameraTarget = null;
  render();
});

$("#camera").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  const board = cameraTarget;
  cameraTarget = null;
  if (!board) return;
  if (!file) { state.message = `${board.number} は撮影を取り消したため未完了のままです。`; return render(); }
  try {
    const blob = await shrink(file);
    const savedAt = Date.now();
    // 番号・写真・日時を1回の書き込みで確定。成功してから完了にする。
    await S.photoPut({ key: S.photoKey(state.activeId, board.number), listId: state.activeId, number: board.number, blob, savedAt });
    state.done.set(board.number, { savedAt });
    state.savedNumber = board.number;
    state.focus = null;
    state.message = "";
    go("saved");
  } catch (err) {
    state.message = `${board.number} の写真を保存できませんでした。もう一度撮影してください。（${errorMessage(err)}）`;
    render();
  }
});

/**
 * 長い辺 1600px の JPEG にして保存量を抑える。描き直すので、位置情報などのメタデータは残らない。
 * 描き直せなかったときは、元のファイル（位置情報が入っていることがある）を保存せずに失敗にする。
 */
async function shrink(file) {
  let src, w, h, release = () => {};
  try {
    src = await createImageBitmap(file); w = src.width; h = src.height;
    release = () => src.close?.();
  } catch {
    // createImageBitmap で読めない端末・形式は、画像として読み込んでから描き直す
    const url = URL.createObjectURL(file);
    release = () => URL.revokeObjectURL(url);
    try {
      src = new Image(); src.src = url; await src.decode();
      w = src.naturalWidth; h = src.naturalHeight;
    } catch { release(); throw new Error("この写真の形式は読めません"); }
  }
  try {
    if (!w || !h) throw new Error("この写真の形式は読めません");
    const scale = Math.min(1, 1600 / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("画像を変換できません"))), "image/jpeg", 0.85));
  } finally { release(); }
}

// ---------- 地図 ----------
let map, layers;
function ensureMap() {
  document.documentElement.style.setProperty("--map-top", `${$("#header").offsetHeight}px`);
  if (!map) {
    map = L.map("map", { zoomControl: true });
    // crossOrigin: 地図画像を中身を確かめられる形（CORS）で取得する。こうしないと、オフライン用の保存で
    // ブラウザが1枚を数MBとして数え、端末の空き容量を圧迫する（sw.js の tile() を参照）。
    const tileOpts = { maxZoom: 18, crossOrigin: true,
      attribution: '出典: <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>' };
    const pale = L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", tileOpts);
    const std = L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", tileOpts);
    pale.addTo(map);
    L.control.layers({ "淡色地図": pale, "標準地図": std }, null, { position: "topright" }).addTo(map);
    map.on("click", (e) => {
      if (state.view === "pickhome") { state.homeDraft = { lat: e.latlng.lat, lon: e.latlng.lng }; drawPickHome(false); return; }
      state.mapPick = null; drawCard();
    });
    map.on("resize", () => {
      if (state.view === "pickhome" && $("#ph-gps") && map.getZoom() != null) ensureDraftVisible();
    });
  }
}

function renderMap() {
  setHeader("地図で見る", { icon: "✕", label: "閉じる", onClick: () => go("route") }, null);
  ensureMap();
  setTimeout(() => { map.invalidateSize(); state.mapPick = null; drawCard(); drawMarkers(true); }, 0);
}

// ---------- 自宅を地図で選ぶ ----------
function renderPickHome() {
  setHeader("自宅を地図で選ぶ", { icon: "✕", label: "やめる", onClick: () => { state.homeDraft = null; go("settings"); } }, null);
  ensureMap();
  state.homeDraft = state.homeDraft || (state.home ? { ...state.home } : null);
  setTimeout(() => { map.invalidateSize(); drawPickHome(true); }, 0);
}

function drawPickHome(fit) {
  if (layers) layers.remove();
  layers = L.layerGroup().addTo(map);
  // 目安として担当の掲示場を薄く出す
  for (const b of routeBoards()) {
    L.marker([b.lat, b.lon], { interactive: false, icon: L.divIcon({ className: "", html: '<div class="pin other"></div>', iconSize: [12, 12] }) }).addTo(layers);
  }
  const d = state.homeDraft;
  if (d) {
    L.marker([d.lat, d.lon], { draggable: true, zIndexOffset: 1000, icon: L.divIcon({ className: "", html: '<div class="pin home">⌂</div>', iconSize: [34, 34] }) })
      .on("dragend", (e) => { const p = e.target.getLatLng(); state.homeDraft = { lat: p.lat, lon: p.lng }; drawPickHome(false); })
      .addTo(layers);
  }
  const card = $("#mapcard");
  card.innerHTML = `<div class="mcard">
    <b>${d ? "この位置を自宅にしますか？" : "地図を押して、自宅の位置を選んでください"}</b>
    <div class="small">${d ? `${d.lat.toFixed(6)}, ${d.lon.toFixed(6)}（印は指で動かせます）` : "拡大してから押すと、細かく選べます。"}</div>
    <button class="btn" id="ph-ok" ${d ? "" : "disabled"}>ここを自宅にする</button>
    <button class="btn outline" id="ph-gps">現在地を使う</button>
    <div class="privacy" style="text-align:left;max-width:none;margin:0">🔒 自宅の位置はこの端末の中だけに保存され、ほかの人からは見えません。</div>
    <div class="small">地図を表示するため、見ている範囲の地図画像を国土地理院から取得します。自宅の位置そのものは送りませんが、拡大して見ている範囲は国土地理院に伝わるので、おおよその場所は分かります。</div></div>`;
  card.scrollTop = 0;
  // 位置合わせは、下のカードを出してから（カードの高さが分かってから）行う
  if (fit) fitPickHome();
  $("#ph-ok").onclick = async () => { await setHome(state.homeDraft); state.homeDraft = null; go("settings"); };
  $("#ph-gps").onclick = () => {
    if (!navigator.geolocation) { toast("この端末では現在地を使えません"); return; }
    toast("現在地を確かめています…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (state.view !== "pickhome") return;
        state.homeDraft = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        drawPickHome(false); fitPickHome(17);
      },
      () => toast("現在地を取れませんでした。地図を押して選んでください"),
      { enableHighAccuracy: true, timeout: 15000 });
  };
}

// カードそのものの高さに加え、カードから地図の下端までの空きも含める。
function visibleMapHeight() {
  return $("#mapcard").getBoundingClientRect().top - map.getContainer().getBoundingClientRect().top;
}

function fitPickHome(zoom = 16) {
  const d = state.homeDraft;
  if (d) { showAboveCard(d.lat, d.lon, zoom); return; }
  const assigned = routeBoards();
  const pts = (assigned.length ? assigned : list().boards).map((b) => [b.lat, b.lon]);
  if (!pts.length) { map.setView([35.68, 139.76], 10); return; }
  const size = map.getSize(), visible = visibleMapHeight();
  const x = Math.min(30, size.x / 4), y = Math.min(30, visible / 4);
  map.fitBounds(pts, { paddingTopLeft: [x, y], paddingBottomRight: [x, size.y - visible + y], maxZoom: 15 });
}

/** 印が下のカードに隠れないよう、地図の見えている部分（カードより上）の中央に位置を合わせる。 */
function showAboveCard(lat, lon, zoom) {
  map.setView([lat, lon], zoom, { animate: false });
  map.panBy([0, (map.getSize().y - visibleMapHeight()) / 2], { animate: false });
}

/** 画面の大きさが変わったとき、印がカードより上の見えている部分から外れていれば、今の縮尺のまま見える位置へ動かす。 */
function ensureDraftVisible() {
  const d = state.homeDraft;
  if (!d) return;
  const size = map.getSize(), visible = visibleMapHeight();
  if (size.x <= 0 || visible <= 0) return;
  const pt = map.latLngToContainerPoint([d.lat, d.lon]);
  const mx = Math.min(17, size.x / 2), my = Math.min(17, visible / 2);
  const dx = pt.x < mx || pt.x > size.x - mx ? pt.x - size.x / 2 : 0;
  const dy = pt.y < my || pt.y > visible - my ? pt.y - visible / 2 : 0;
  if (dx || dy) map.panBy([dx, dy], { animate: false });
}

/** 自宅を保存し、自宅は全一覧で共通なので全一覧の巡回順を計算し直す。 */
async function setHome(c) {
  state.home = { lat: c.lat, lon: c.lon }; await S.kvSet("home", state.home);
  for (const l2 of state.lists.values()) {
    const pg = await S.kvGet(`progress:${l2.id}`);
    if (pg) await S.kvSet(`progress:${l2.id}`, replan(pg, l2.boards));
  }
  await loadProgress(); toast("自宅を保存しました");
}

function drawMarkers(fit) {
  if (layers) layers.remove();
  layers = L.layerGroup().addTo(map);
  const r = routeBoards();
  const assigned = new Set(r.map((b) => b.number));
  if (state.showOthers) {
    for (const b of list().boards) if (!assigned.has(b.number)) {
      L.marker([b.lat, b.lon], { icon: L.divIcon({ className: "", html: '<div class="pin other"></div>', iconSize: [12, 12] }) })
        .on("click", () => pick({ board: b })).addTo(layers);
    }
  }
  if (state.showLine && r.length && state.home) {
    const pts = [[state.home.lat, state.home.lon], ...r.map((b) => [b.lat, b.lon]), [state.home.lat, state.home.lon]];
    L.polyline(pts, { color: "#0B5A45", weight: 3, opacity: 0.7 }).addTo(layers);
  }
  r.forEach((b, i) => {
    const cls = state.done.has(b.number) ? "done" : "todo";
    L.marker([b.lat, b.lon], { icon: L.divIcon({ className: "", html: `<div class="pin ${cls}">${i + 1}</div>`, iconSize: [30, 30] }), zIndexOffset: 500 })
      .on("click", () => pick({ board: b, index: i })).addTo(layers);
  });
  if (state.home) {
    L.marker([state.home.lat, state.home.lon], { icon: L.divIcon({ className: "", html: '<div class="pin home">⌂</div>', iconSize: [34, 34] }), zIndexOffset: 1000 })
      .on("click", () => pick({ home: true })).addTo(layers);
  }
  if (fit) {
    const pts = r.map((b) => [b.lat, b.lon]);
    if (state.home) pts.push([state.home.lat, state.home.lon]);
    if (!pts.length) list().boards.forEach((b) => pts.push([b.lat, b.lon]));
    const cardH = $("#mapcard").offsetHeight || 200;
    if (pts.length) map.fitBounds(pts, { paddingTopLeft: [30, 30], paddingBottomRight: [30, cardH + 30], maxZoom: 16 });
  }
}

function pick(p) {
  state.mapPick = p;
  drawCard();
}

function drawCard() {
  const el = $("#mapcard");
  const p = state.mapPick;
  const r = routeBoards();
  if (!p) {
    const d = r.filter((b) => state.done.has(b.number)).length;
    el.innerHTML = `<div class="mcard"><b>${esc(list().name)}　担当 ${r.length}か所（完了 ${d}）</b>
      <div class="legend"><span><i style="background:#0B5A45"></i>撮影済み</span><span><i style="background:#E8892B"></i>未完了</span><span><i style="background:#2F6FDB"></i>自宅</span>${state.showOthers ? '<span><i style="background:#8A938F"></i>担当外</span>' : ""}</div>
      <label class="toggle"><input type="checkbox" id="tg1" ${state.showOthers ? "checked" : ""}> 担当外の掲示場も表示（${list().boards.length - r.length}か所）</label>
      <label class="toggle"><input type="checkbox" id="tg2" ${state.showLine ? "checked" : ""}> 巡回順の線（直線）</label>
      <div class="small">掲示場の印を押すと、Google マップで案内できます。</div></div>`;
    $("#tg1").onchange = (e) => { state.showOthers = e.target.checked; drawMarkers(false); drawCard(); };
    $("#tg2").onchange = (e) => { state.showLine = e.target.checked; drawMarkers(false); };
    return;
  }
  let title, sub, status, target, canShoot = false;
  if (p.home) { title = "自宅"; sub = "出発・帰着地点"; status = "帰宅の案内"; target = state.home; }
  else {
    const b = p.board; target = b; sub = b.name;
    if (p.index != null) {
      const done = state.done.has(b.number);
      title = `${p.index + 1}. ${b.number}`; status = done ? "撮影済み" : `未完了（巡回順 ${p.index + 1} 番目）`; canShoot = !done;
    } else { title = b.number; status = "担当外"; }
  }
  el.innerHTML = `<div class="mcard"><div class="row"><div><b>${esc(title)}</b><div>${esc(sub)}</div><div class="warn" style="color:${status === "撮影済み" ? "#0B5A45" : ""}">${esc(status)}</div></div>
    <button class="x" id="cx" aria-label="選択を外す">✕</button></div>
    <a class="btn" href="${C.googleMapsNavUrl(target)}" target="_blank" rel="noopener">➤ Google マップで案内</a>
    ${canShoot ? '<button class="btn outline" id="cs">この掲示場を次にする</button>' : ""}
    <div class="small">${p.home ? "帰宅案内では、目的地として自宅の位置が Google マップに渡ります。" : "案内は Google マップアプリで開きます（現在地と目的地が Google に渡ります）。"}</div></div>`;
  $("#cx").onclick = (e) => { e.stopPropagation(); state.mapPick = null; drawCard(); };
  if (canShoot) $("#cs").onclick = () => { state.focus = p.board.number; state.mapPick = null; go("next"); };
}

// ---------- 設定 ----------
function renderSettings(v) {
  setHeader("設定", backTo("route"), null);
  const l = list();
  v.innerHTML = `
  <div class="section"><h2>掲示場の一覧</h2><div class="group">
    <div class="item">使う一覧<span class="v">${esc(l.name)}</span></div>
    <div class="item">掲示場<span class="v">${l.boards.length}件</span></div>
    <button class="item link" id="s-lists">一覧を切り替える・削除する ›</button>
    <button class="item link" id="s-csv">⤓ CSVを取り込む</button></div>
    <p class="small">端末の「ファイル」から CSV を選びます。</p><p class="privacy">🔒 取り込んだ一覧・出発地点・進捗・写真は、この端末の中だけに保存され、ほかの人からは見えません。このアプリには、それらを集めるサーバーがありません。このうち外に伝わるのは、案内を押したときの目的地（Google マップへ）と、地図で見た範囲（国土地理院へ）です。</p></div>
  <div class="section"><h2>自宅（出発・帰着地点）</h2><div class="group">
    <div class="item">${state.home ? `登録済み: ${state.home.lat.toFixed(6)}, ${state.home.lon.toFixed(6)}` : "未登録"}</div>
    <div class="item"><input type="text" id="s-home" inputmode="decimal" placeholder="緯度,経度（例 35.3159,139.6250）"></div>
    <button class="item link" id="s-homemap">地図で選ぶ・現在地を使う ›</button>
    <button class="item link" id="s-homebtn">入力した緯度,経度で${state.home ? "変更" : "登録"}</button></div>
    <p class="err" id="s-homeerr"></p></div>
  <div class="section"><h2>担当の掲示場</h2><div class="group">
    <button class="item link" id="s-pick">担当を選ぶ（${state.progress.assigned.length}か所） ›</button>
    ${state.activeId === BUNDLED_ID ? '<button class="item link" id="s-sample">見本を入れる（架空の掲示場10か所）</button>' : ""}</div></div>
  <div class="section"><h2>記録</h2><div class="group">
    <div class="item">この一覧の写真<span class="v">${state.done.size}件</span></div>
    <button class="item danger" id="s-reset" ${state.done.size ? "" : "disabled"}>写真と進捗を消す</button></div>
    <p class="small">地図: 国土地理院（地理院タイル）。表示した範囲は国土地理院のサーバーに伝わります。案内: Google マップアプリ。地図表示に Google の API は使っていません。地図の部品（Leaflet）は unpkg から取得します。</p></div>`;
  $("#s-lists").onclick = () => go("lists");
  $("#s-csv").onclick = () => { $("#csvfile").value = ""; $("#csvfile").click(); };
  $("#s-pick").onclick = () => { state.query = ""; go("picker"); };
  $("#s-sample")?.addEventListener("click", applySample);
  $("#s-homebtn").onclick = async () => {
    const c = C.parseLatLon($("#s-home").value);
    if (!c) { $("#s-homeerr").textContent = "「緯度,経度」の形で入力してください。緯度は-90〜90、経度は-180〜180です。"; return; }
    await setHome(c); render();
  };
  $("#s-homemap").onclick = () => { state.homeDraft = null; go("pickhome"); };
  $("#s-reset").onclick = async () => {
    if (!confirm(`「${l.name}」の写真${state.done.size}件を消します。元に戻せません。`)) return;
    await S.photoDeleteList(state.activeId); state.done = new Map(); toast("写真を消しました"); render();
  };
}

async function applySample() {
  state.home = { ...SAMPLE_HOME }; await S.kvSet("home", state.home);
  state.activeId = BUNDLED_ID; await S.kvSet("activeListId", BUNDLED_ID);
  await loadProgress();
  state.progress.assigned = state.lists.get(BUNDLED_ID).boards.map((b) => b.number); replan(); await saveProgress();
  toast("見本を入れました"); go("route");
}

function renderPicker(v) {
  setHeader("担当を選ぶ", backTo("settings"), null);
  const sel = new Set(state.progress.assigned);
  const q = state.query.trim();
  const shown = q ? list().boards.filter((b) => b.number.startsWith(q) || b.name.includes(q)) : list().boards;
  v.innerHTML = `<div class="search"><input type="search" id="q" placeholder="番号（例 2-）または名前" value="${esc(q)}"></div>
    <div class="section"><div class="group"><button class="item link" id="all" ${shown.length > 100 ? "disabled" : ""}>表示中の${shown.length}件をすべて選ぶ</button>
    <button class="item danger" id="none">選択をすべて外す</button></div>
    <p class="small">選択中 ${sel.size}か所 ／ 表示 ${shown.length}件</p>
    <div class="group">${shown.slice(0, 300).map((b) => `<button class="item" data-n="${esc(b.number)}"><div><b>${esc(b.number)}</b><div class="small">${esc(b.name)}</div></div><span class="chk ${sel.has(b.number) ? "on" : ""}">✓</span></button>`).join("")}</div>
    ${shown.length > 300 ? '<p class="small">300件まで表示しています。番号で絞り込んでください。</p>' : ""}</div>`;
  const qEl = $("#q");
  qEl.oninput = () => { state.query = qEl.value; const pos = qEl.selectionStart; renderPicker(v); const n = $("#q"); n.focus(); n.setSelectionRange(pos, pos); };
  const commit = async () => { replan(); await saveProgress(); renderPicker(v); };
  $("#all").onclick = () => { state.progress.assigned = [...new Set([...sel, ...shown.map((b) => b.number)])]; commit(); };
  $("#none").onclick = () => { state.progress.assigned = []; commit(); };
  v.querySelectorAll("[data-n]").forEach((el) => el.onclick = () => {
    const n = el.dataset.n;
    state.progress.assigned = sel.has(n) ? state.progress.assigned.filter((x) => x !== n) : [...state.progress.assigned, n];
    commit();
  });
}

function renderLists(v) {
  setHeader("掲示場の一覧", backTo("settings"), null);
  const rows = [...state.lists.values()].sort((a, b) => (a.builtin ? -1 : b.builtin ? 1 : b.importedAt - a.importedAt));
  v.innerHTML = `<div class="section"><div class="group">${rows.map((l) => `
    <div class="item"><button class="item" style="padding:0" data-use="${esc(l.id)}"><div><b>${esc(l.name)}</b><div class="small">${l.boards.length}件・${l.builtin ? "同梱" : `${new Date(l.importedAt).toLocaleString("ja-JP")}・${esc(l.source)}`}</div></div></button>
    ${l.id === state.activeId ? '<span class="chk on">✓</span>' : ""}${l.builtin ? "" : `<button class="x item danger" style="width:auto;padding:6px 10px" data-del="${esc(l.id)}">削除</button>`}</div>`).join("")}</div>
    <p class="small">同梱の一覧は削除できません。</p></div>`;
  v.querySelectorAll("[data-use]").forEach((el) => el.onclick = async () => {
    const id = el.dataset.use;
    if (id === state.activeId) return;
    const left = state.progress.assigned.some((n) => !state.done.has(n));
    if (left && !confirm("巡回の途中です。切り替えても今の一覧の進捗は残り、戻せば続きから再開できます。")) return;
    state.activeId = id; await S.kvSet("activeListId", id); await loadProgress(); state.focus = null; renderLists(v);
  });
  v.querySelectorAll("[data-del]").forEach((el) => el.onclick = async () => {
    const l = state.lists.get(el.dataset.del);
    const n = (await S.photoIndex(l.id)).size;
    if (!confirm(`「${l.name}」を削除します。掲示場${l.boards.length}件と、この一覧の写真${n}件が消えます。元に戻せません。`)) return;
    await S.photoDeleteList(l.id); await S.kvDel(`progress:${l.id}`); await S.listDel(l.id); state.lists.delete(l.id);
    if (state.activeId === l.id) { state.activeId = BUNDLED_ID; await S.kvSet("activeListId", BUNDLED_ID); await loadProgress(); }
    renderLists(v);
  });
}

// ---------- CSV取り込み ----------
$("#csvfile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > C.MAX_BYTES) throw new C.CSVImportError("ファイルが大きすぎます。5MBまでのCSVを選んでください。");
    const table = C.readTable(await file.arrayBuffer());
    const mapping = C.autoMapping(table.headers, table.rows);
    const name = file.name.replace(/\.[^.]+$/, "");
    state.importSession = { table, mapping, fileName: file.name, name, editing: !C.mappingProblems(mapping).ok, mode: "add" };
    go("import");
  } catch (err) {
    alert(`CSVを読めませんでした。\n${errorMessage(err)}`);
  }
});

function renderImport(v) {
  const s = state.importSession;
  if (s.editing) return renderMapping(v, s);
  const p = C.buildBoards(s.table, s.mapping);
  const findExisting = (name) => {
    const t = name.trim();
    return t ? [...state.lists.values()].find((l) => !l.builtin && l.name === t) : undefined;
  };
  const nameT = s.name.trim();
  const existing = findExisting(s.name);
  const replacing = () => existing && s.mode === "replace";
  const nameErr = !nameT ? "名前を入れてください。" : nameT === BUNDLED_NAME ? "同梱の一覧と同じ名前は使えません。" : "";
  setHeader("取り込みの確認", { icon: "✕", label: "やめる", onClick: () => go("settings") }, null);
  v.innerHTML = `<div class="section"><h2>一覧の名前</h2><div class="group"><div class="item"><input type="text" id="nm" value="${esc(s.name)}"></div></div>
    ${nameErr ? `<p class="err">${nameErr}</p>` : ""}
    ${existing ? `<p class="small">同じ名前の一覧があります：<label><input type="radio" name="md" value="add" ${s.mode === "add" ? "checked" : ""}> 別の一覧として追加</label>　<label><input type="radio" name="md" value="replace" ${s.mode === "replace" ? "checked" : ""}> 置き換える</label></p>` : ""}</div>
    <div class="section"><h2>読み込み結果</h2><div class="group">
      <div class="item">読めた掲示場<span class="v">${p.boards.length}件</span></div>
      <div class="item">読めなかった行<span class="v">${p.issues.length}行</span></div>
      <div class="item">文字コード<span class="v">${s.table.encoding}</span></div></div>
      ${p.outsideJapan ? `<p class="warn">日本の範囲外の座標が${p.outsideJapan}件あります。緯度と経度の列が入れ違っていないか確認してください。</p>` : ""}</div>
    ${p.issues.length ? `<div class="section"><h2>読めなかった行（取り込みません）</h2><div class="group">${p.issues.slice(0, 20).map((i) => `<div class="item small">${i.line}行目: ${esc(i.reason)}</div>`).join("")}</div>${p.issues.length > 20 ? `<p class="small">ほか ${p.issues.length - 20}行</p>` : ""}</div>` : ""}
    ${p.boards.length ? `<div class="section"><h2>先頭の${Math.min(5, p.boards.length)}件</h2><table class="preview">${p.boards.slice(0, 5).map((b) => `<tr><td><b>${esc(b.number)}</b></td><td>${esc(b.name)}</td><td class="small">${b.lat}, ${b.lon}</td></tr>`).join("")}</table></div>` : '<p class="pad err">取り込める行がありません。列の選び方を確認してください。</p>'}
    <div class="btns"><button class="btn" id="imp" ${!p.boards.length || nameErr ? "disabled" : ""}>取り込む</button>
      <button class="btn plain" id="remap">列を選び直す</button>
      <p class="small" style="text-align:center" id="imp-note"></p></div>`;
  const updateNote = () => {
    $("#imp-note").textContent = replacing()
      ? "取り込むと、同じ名前の一覧を置き換えて切り替えます。新しい一覧にある番号の担当は残ります。場所が変わった掲示場と、新しい一覧にない掲示場の写真は消します。"
      : "取り込むと、この一覧に切り替わります。今の一覧の担当と写真は残ります。";
  };
  updateNote();
  const nm = $("#nm");
  const applyNameChange = (nextName) => {
    // 同じ名前の一覧が変わった・なくなった・新しく見つかったときは、別の一覧を誤って置き換えないよう追加へ戻す。
    const nextExisting = findExisting(nextName);
    if (!nextExisting || existing?.id !== nextExisting.id) s.mode = "add";
    s.name = nextName;
    renderImport(v);
  };
  nm.onchange = (e) => { if (nm.isConnected) applyNameChange(e.target.value); };
  v.querySelectorAll('[name="md"]').forEach((r) => r.onchange = () => { s.mode = r.value; updateNote(); });
  $("#remap").onclick = () => { s.editing = true; renderImport(v); };
  $("#imp").onclick = async (e) => {
    const button = e.currentTarget;
    if (nm.value !== s.name) { applyNameChange(nm.value); return; }
    button.disabled = true;
    try {
      let id;
      const notes = [];
      if (replacing()) {
        id = existing.id;
        const [saved, photos] = await Promise.all([S.kvGet(`progress:${id}`), S.photoIndex(id)]);
        if (!button.isConnected || state.view !== "import" || nm.value !== s.name || !replacing()) return;
        const { moved, missing } = C.classifyReplacementPhotos(existing.boards, p.boards, photos.keys());
        const discard = moved.concat(missing);
        if (discard.length && !confirm(`「${existing.name}」を置き換えると、写真 ${photos.size}件のうち ${discard.length}件を消します（場所が変わった ${moved.length}件・新しい一覧にない ${missing.length}件）。元に戻せません。消したくないときは、キャンセルして「別の一覧として追加」を選んでください。`)) return;
        const pg = saved || { assigned: [], route: [] };
        const progress = replan({ ...pg }, p.boards);
        const removed = pg.assigned.length - progress.assigned.length;
        const l = { ...existing, boards: p.boards, source: s.fileName, importedAt: Date.now() };
        await S.listReplace(l, progress, discard);
        state.lists.set(id, l);
        if (removed > 0) notes.push(`新しい一覧にない担当${removed}か所を外しました。`);
      } else {
        let name = nameT, i = 2;
        const names = new Set([...state.lists.values()].map((l) => l.name));
        while (names.has(name)) name = `${nameT}（${i++}）`;
        id = `list-${Date.now()}`;
        const l = { id, name, boards: p.boards, source: s.fileName, importedAt: Date.now() };
        await S.listPut(l); state.lists.set(id, l);
        await S.kvSet("activeListId", id);
      }
      state.activeId = id; await loadProgress();
      state.importSession = null;
      alert([`${p.boards.length}件で取り込み、この一覧に切り替えました。`, ...notes, "担当は「担当を選ぶ」で選んでください。"].join("\n"));
      go("settings");
    } catch (err) {
      alert(`取り込みに失敗しました。\n${errorMessage(err)}`);
    } finally {
      button.disabled = false;
    }
  };
}

function renderMapping(v, s) {
  setHeader("列を選ぶ", { icon: "✕", label: "やめる", onClick: () => go("settings") }, null);
  const first = s.table.rows[0]?.fields || [];
  const prob = C.mappingProblems(s.mapping);
  const excerpt = (s) => {
    let end = 0, chars = 0;
    for (const c of s) {
      if (chars === 60) return esc(`${s.slice(0, end)}…`);
      chars++; end += c.length;
    }
    return esc(s);
  };
  v.innerHTML = `<div class="pad small">どの列を使うかを選んでください。見出しや値から分かった列は、最初から選んであります。<br>${esc(s.fileName)}・${s.table.encoding}・${s.table.headers.length}列・${s.table.rows.length}行</div>
    ${C.FIELDS.map((f) => `<div class="section"><h2>${f.label}${f.required ? "（必須）" : ""}</h2><div class="group"><div class="item"><select data-f="${f.key}">
      <option value="">${f.required ? "未選択" : "使わない"}</option>
      ${s.table.headers.map((h, i) => `<option value="${i}" ${s.mapping[f.key] === i ? "selected" : ""}>${i + 1}列目: ${excerpt(h || "（見出しなし）")}</option>`).join("")}
    </select></div>${s.mapping[f.key] != null ? `<div class="item small">例: ${excerpt(first[s.mapping[f.key]] ?? "")}</div>` : ""}</div></div>`).join("")}
    <div class="pad">${prob.missing.length ? `<p class="warn">未選択: ${prob.missing.join("・")}</p>` : ""}${prob.dup.length ? `<p class="err">同じ列を選んでいます: ${prob.dup.join("・")}</p>` : ""}</div>
    <div class="btns"><button class="btn" id="nx" ${prob.ok ? "" : "disabled"}>次へ（確認画面）</button></div>`;
  v.querySelectorAll("select[data-f]").forEach((el) => el.onchange = () => {
    s.mapping[el.dataset.f] = el.value === "" ? undefined : Number(el.value);
    if (el.value === "") delete s.mapping[el.dataset.f];
    renderMapping(v, s);
  });
  $("#nx").onclick = () => { s.editing = false; renderImport(v); };
}

// ---------- 起動 ----------
(async () => {
  // 古い形式の地図の保存（tiles-v1）を消す。中身を確かめられない応答で、いまの取得の形（crossOrigin）には使えず、
  // 残っていると保存済みの範囲の地図が出ない。sw.js も切り替え時に消すが、sw.js の更新が遅れても地図が出るよう、画面の側でも先に消す。
  if (window.caches) caches.delete("tiles-v1").catch(() => {});
  try {
    await loadAll();
    S.requestPersist();
  } catch (err) {
    $("#view").innerHTML = `<p class="pad err">読み込みに失敗しました: ${esc(errorMessage(err))}</p>`;
    return;
  }
  render();
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
