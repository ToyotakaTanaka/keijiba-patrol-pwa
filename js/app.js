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
  $("#mapwrap").hidden = state.view !== "map";
  const v = $("#view");
  v.hidden = state.view === "map";
  v.scrollTop = 0;
  const ready = state.home && state.progress.route.length;
  if (!ready && ["route", "next", "saved", "done"].includes(state.view)) return renderEmpty(v);
  ({ route: renderRoute, next: renderNext, saved: renderSaved, done: renderDone, settings: renderSettings,
     picker: renderPicker, lists: renderLists, import: renderImport, map: renderMap, photo: renderPhoto })[state.view](v);
}

function renderEmpty(v) {
  setHeader("掲示場巡回", null, gear);
  v.innerHTML = `<div class="homebig grow"><div><span>🏠</span>自宅と担当の掲示場を<br>登録してください<p class="muted">見本で試すなら「見本を入れる」</p><p class="privacy">🔒 データはこの端末の中だけに保存され、<br>ほかの人からは見えません。</p></div></div>
    <div class="btns"><button class="btn" id="b1">設定を開く</button><button class="btn outline" id="b2">見本を入れる（架空の掲示場10か所）</button></div>`;
  $("#b1").onclick = () => go("settings");
  $("#b2").onclick = applySample;
}

function renderRoute(v) {
  setHeader("巡回順", { icon: "🗺", label: "地図で見る", onClick: () => go("map") }, gear);
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
    state.message = `${board.number} の写真を保存できませんでした。もう一度撮影してください。（${err.message || err}）`;
    render();
  }
});

/** 長い辺 1600px の JPEG にして保存量を抑える。位置情報などのメタデータは残らない。 */
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("画像を変換できません"))), "image/jpeg", 0.85));
  } catch {
    return file;
  }
}

// ---------- 地図 ----------
let map, layers;
function renderMap() {
  setHeader("地図で見る", { icon: "✕", label: "閉じる", onClick: () => go("route") }, null);
  document.documentElement.style.setProperty("--map-top", `${$("#header").offsetHeight}px`);
  if (!map) {
    map = L.map("map", { zoomControl: true });
    const pale = L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
      maxZoom: 18, attribution: '出典: <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>' });
    const std = L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", {
      maxZoom: 18, attribution: '出典: <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>' });
    pale.addTo(map);
    L.control.layers({ "淡色地図": pale, "標準地図": std }, null, { position: "topright" }).addTo(map);
    map.on("click", () => { state.mapPick = null; drawCard(); });
  }
  setTimeout(() => { map.invalidateSize(); state.mapPick = null; drawCard(); drawMarkers(true); }, 0);
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
    ${canShoot ? '<button class="btn outline" id="cs">この掲示場を次にする</button>' : ""}</div>`;
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
    <p class="small">端末の「ファイル」から CSV を選びます。</p><p class="privacy">🔒 取り込んだ一覧・出発地点・進捗・写真は、この端末の中だけに保存され、ほかの人からは見えません。サーバーには送りません。</p></div>
  <div class="section"><h2>自宅（出発・帰着地点）</h2><div class="group">
    <div class="item">${state.home ? `登録済み: ${state.home.lat.toFixed(6)}, ${state.home.lon.toFixed(6)}` : "未登録"}</div>
    <div class="item"><input type="text" id="s-home" inputmode="decimal" placeholder="緯度,経度（例 35.3159,139.6250）"></div>
    <button class="item link" id="s-homebtn">自宅を${state.home ? "変更" : "登録"}</button></div>
    <p class="err" id="s-homeerr"></p></div>
  <div class="section"><h2>担当の掲示場</h2><div class="group">
    <button class="item link" id="s-pick">担当を選ぶ（${state.progress.assigned.length}か所） ›</button>
    ${state.activeId === BUNDLED_ID ? '<button class="item link" id="s-sample">見本を入れる（架空の掲示場10か所）</button>' : ""}</div></div>
  <div class="section"><h2>記録</h2><div class="group">
    <div class="item">この一覧の写真<span class="v">${state.done.size}件</span></div>
    <button class="item danger" id="s-reset" ${state.done.size ? "" : "disabled"}>写真と進捗を消す</button></div>
    <p class="small">地図: 国土地理院（地理院タイル）。案内: Google マップアプリ。地図表示に Google の API は使っていません。</p></div>`;
  $("#s-lists").onclick = () => go("lists");
  $("#s-csv").onclick = () => { $("#csvfile").value = ""; $("#csvfile").click(); };
  $("#s-pick").onclick = () => { state.query = ""; go("picker"); };
  $("#s-sample")?.addEventListener("click", applySample);
  $("#s-homebtn").onclick = async () => {
    const c = C.parseLatLon($("#s-home").value);
    if (!c) { $("#s-homeerr").textContent = "「緯度,経度」の形で入力してください。緯度は-90〜90、経度は-180〜180です。"; return; }
    state.home = c; await S.kvSet("home", c);
    // 自宅は全一覧で共通なので、全一覧の巡回順を計算し直す
    for (const l2 of state.lists.values()) {
      const pg = await S.kvGet(`progress:${l2.id}`);
      if (pg) await S.kvSet(`progress:${l2.id}`, replan(pg, l2.boards));
    }
    await loadProgress(); toast("自宅を保存しました"); render();
  };
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
    alert(`CSVを読めませんでした。\n${err.message}`);
  }
});

function renderImport(v) {
  const s = state.importSession;
  if (s.editing) return renderMapping(v, s);
  const p = C.buildBoards(s.table, s.mapping);
  const nameT = s.name.trim();
  const existing = [...state.lists.values()].find((l) => !l.builtin && l.name === nameT);
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
      <p class="small" style="text-align:center">取り込むと、この一覧に切り替わります。今の一覧の担当と写真は残ります。</p></div>`;
  $("#nm").onchange = (e) => { s.name = e.target.value; renderImport(v); };
  v.querySelectorAll('[name="md"]').forEach((r) => r.onchange = () => { s.mode = r.value; });
  $("#remap").onclick = () => { s.editing = true; renderImport(v); };
  $("#imp").onclick = async () => {
    let id, notes = [];
    if (s.mode === "replace" && existing) {
      id = existing.id;
      const numbers = new Set(p.boards.map((b) => b.number));
      const pg = (await S.kvGet(`progress:${id}`)) || { assigned: [], route: [] };
      const removed = pg.assigned.filter((n) => !numbers.has(n));
      pg.assigned = pg.assigned.filter((n) => numbers.has(n));
      Object.assign(existing, { boards: p.boards, source: s.fileName, importedAt: Date.now() });
      await S.listPut(existing);
      await S.kvSet(`progress:${id}`, replan(pg, p.boards));
      if (removed.length) notes.push(`新しい一覧にない担当${removed.length}か所を外しました。`);
    } else {
      let name = nameT, i = 2;
      const names = new Set([...state.lists.values()].map((l) => l.name));
      while (names.has(name)) name = `${nameT}（${i++}）`;
      id = `list-${Date.now()}`;
      const l = { id, name, boards: p.boards, source: s.fileName, importedAt: Date.now() };
      await S.listPut(l); state.lists.set(id, l);
    }
    state.activeId = id; await S.kvSet("activeListId", id); await loadProgress();
    state.importSession = null;
    alert([`${p.boards.length}件で取り込み、この一覧に切り替えました。`, ...notes, "担当は「担当を選ぶ」で選んでください。"].join("\n"));
    go("settings");
  };
}

function renderMapping(v, s) {
  setHeader("列を選ぶ", { icon: "✕", label: "やめる", onClick: () => go("settings") }, null);
  const first = s.table.rows[0]?.fields || [];
  const prob = C.mappingProblems(s.mapping);
  v.innerHTML = `<div class="pad small">どの列を使うかを選んでください。見出しや値から分かった列は、最初から選んであります。<br>${esc(s.fileName)}・${s.table.encoding}・${s.table.headers.length}列・${s.table.rows.length}行</div>
    ${C.FIELDS.map((f) => `<div class="section"><h2>${f.label}${f.required ? "（必須）" : ""}</h2><div class="group"><div class="item"><select data-f="${f.key}">
      <option value="">${f.required ? "未選択" : "使わない"}</option>
      ${s.table.headers.map((h, i) => `<option value="${i}" ${s.mapping[f.key] === i ? "selected" : ""}>${i + 1}列目: ${esc(h || "（見出しなし）")}</option>`).join("")}
    </select></div>${s.mapping[f.key] != null ? `<div class="item small">例: ${esc(first[s.mapping[f.key]] ?? "")}</div>` : ""}</div></div>`).join("")}
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
  try {
    await loadAll();
    S.requestPersist();
  } catch (err) {
    $("#view").innerHTML = `<p class="pad err">読み込みに失敗しました: ${esc(err.message)}</p>`;
    return;
  }
  render();
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
