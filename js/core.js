// 掲示場巡回 PWA の計算部分（ブラウザと Node の両方で動く）。
// CSV の読み込み・列の自動割り当て・行の検査・巡回順の計算・Google マップの URL。

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 10000;
/** 取り込みに使える列数と、番号・掲示場名・設置場所の文字数の上限。 */
export const MAX_COLS = 200;
export const MAX_CELL = 2000;
export const PHOTO_KEEP_DISTANCE_M = 50;

export const FIELDS = [
  { key: "number", label: "番号", required: true,
    aliases: ["図面表示番号", "掲示場番号", "ポスター掲示場番号", "掲示板番号", "表示番号", "図面番号", "番号", "number", "id", "コード"],
    contains: ["番号"] },
  { key: "name", label: "掲示場名", required: true,
    aliases: ["掲示場名", "掲示場名称", "名称", "名前", "施設名", "場所名", "設置名", "name"],
    contains: ["名称", "名"] },
  { key: "latitude", label: "緯度", required: true,
    aliases: ["緯度", "lat", "latitude", "y座標", "y"], contains: ["緯度", "lat"] },
  { key: "longitude", label: "経度", required: true,
    aliases: ["経度", "lng", "lon", "long", "longitude", "x座標", "x"], contains: ["経度", "lng", "lon"] },
  { key: "address", label: "設置場所", required: false,
    aliases: ["設置場所", "所在地", "住所", "設置住所", "場所", "address"], contains: ["住所", "所在", "設置場所"] },
];

export class CSVImportError extends Error {}

/** UTF-8（BOMあり・なし）→ Shift_JIS（Windows-31J）の順に読む。 */
export function decode(buffer) {
  let bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
  } catch {
    try {
      return { text: new TextDecoder("shift_jis", { fatal: true }).decode(bytes), encoding: "Shift_JIS" };
    } catch {
      throw new CSVImportError("文字コードを読めませんでした。UTF-8 または Shift_JIS のCSVを選んでください。");
    }
  }
}

/**
 * カンマ区切り。引用符内のカンマ・改行・"" に対応。行番号はファイル上の行（見出し=1）。
 * 空の行（値がすべて空白の行）は返さない。201列目以降の空の値はためず、空でない値があれば止める。
 * 行数の上限と、改行をまたぐ長い引用符つきの値も、読みながら確かめる。
 */
export function parseRecords(text) {
  if (!/[^,\s]/.test(text)) return []; // カンマや空白だけなら、行ごとに分ける必要はない
  const records = [];
  let fields = [], col = 0, hasValue = false, line = 1, start = 1;
  let fieldStart = 0, quoteEnd = -1, escapedQuotes = 0, inQuotes = false, multiline = false;
  const tooManyColumns = () => {
    throw new CSVImportError(`${start}行目の列が多すぎます。${MAX_COLS}列までのCSVを選んでください。`);
  };
  const cut = (i, next) => {
    if (col < MAX_COLS) {
      let field;
      if (text[fieldStart] === '"') {
        field = text.slice(fieldStart + 1, quoteEnd < 0 ? i : quoteEnd);
        if (escapedQuotes) field = field.replace(/""/g, '"');
        if (quoteEnd >= 0 && quoteEnd + 1 < i) field += text.slice(quoteEnd + 1, i);
      } else field = text.slice(fieldStart, i);
      fields[col++] = field;
      if (!hasValue && field && /\S/.test(field)) hasValue = true;
    }
    fieldStart = next; quoteEnd = -1; escapedQuotes = 0; multiline = false;
  };
  const end = (i, next) => {
    cut(i, next);
    if (hasValue) {
      if (records.length > MAX_ROWS) throw new CSVImportError(`行が多すぎます。${MAX_ROWS.toLocaleString("ja-JP")}行までのCSVを選んでください。`);
      fields.length = col;
      records.push({ line: start, fields });
      fields = []; hasValue = false;
    }
    col = 0; // 空の行には配列を作り直さない
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] !== '"') { quoteEnd = i; inQuotes = false; continue; }
        escapedQuotes++; i++;
      } else if (c === "\r" || c === "\n") {
        multiline = true;
        if (c === "\n" || text[i + 1] !== "\n") line++;
      }
      if (col === MAX_COLS && /\S/.test(c)) tooManyColumns();
      if (multiline && i - fieldStart - escapedQuotes > MAX_CELL) {
        throw new CSVImportError(`${start}行目に長すぎる値があります（1つの値は${MAX_CELL.toLocaleString("ja-JP")}文字まで）。引用符（"）が閉じていない可能性があります。`);
      }
      continue;
    }
    if (c === '"' && i === fieldStart) inQuotes = true;
    else if (c === ",") cut(i, i + 1);
    else if (c === "\r" || c === "\n") {
      const endOfLine = i;
      if (c === "\r" && text[i + 1] === "\n") i++;
      end(endOfLine, i + 1); line++; start = line;
    } else if (col === MAX_COLS && /\S/.test(c)) tooManyColumns();
  }
  if (fieldStart < text.length || col) end(text.length, text.length);
  return records;
}

export function readTable(buffer) {
  if (buffer.byteLength > MAX_BYTES) {
    throw new CSVImportError(`ファイルが大きすぎます（${Math.round(buffer.byteLength / 1024)}KB）。5MBまでのCSVを選んでください。`);
  }
  const { text, encoding } = decode(buffer);
  const records = parseRecords(text); // 空の行は入らない
  if (records.length < 2) throw new CSVImportError("見出しの行とデータの行が見つかりませんでした。");
  const rows = records.slice(1);
  const headers = records[0].fields.map((h) => h.replace(/[﻿​]/g, "").trim());
  return { headers, rows, encoding };
}

export function toHalfWidth(s) {
  return s.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ").replace(/−/g, "-");
}

export function normalizeHeader(s) {
  return toHalfWidth(s).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

export function parseNumber(s) {
  // 長すぎる値は数値として扱わない。正規表現は桁数に比例する時間で終わる形にしてある
  // （細工した CSV で画面が固まらないように）。
  const raw = String(s).trim();
  if (raw === "" || raw.length > 64) return null;
  const t = toHalfWidth(raw).trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** 列の自動割り当て。1) よく使われる見出し・別名 2) 含む語 3) 値から緯度・経度を推定。 */
export function autoMapping(headers, rows = []) {
  const m = {};
  const keys = headers.map(normalizeHeader);
  const used = () => new Set(Object.values(m));
  const assign = (field, idx) => {
    if (idx == null || idx < 0 || m[field] != null || used().has(idx)) return;
    m[field] = idx;
  };
  for (const f of FIELDS) for (const a of f.aliases) assign(f.key, keys.indexOf(normalizeHeader(a)));
  for (const f of FIELDS) for (const w of f.contains) {
    const nw = normalizeHeader(w);
    assign(f.key, keys.findIndex((k, i) => k.includes(nw) && !used().has(i)));
  }
  if (rows.length) {
    const sample = rows.slice(0, 50);
    const ratio = (col, lo, hi) => sample.filter((r) => {
      const v = parseNumber(r.fields[col] ?? "");
      return v != null && v >= lo && v <= hi;
    }).length / sample.length;
    if (m.latitude == null) assign("latitude", headers.findIndex((_, i) => !used().has(i) && ratio(i, 20, 46) >= 0.8));
    if (m.longitude == null) assign("longitude", headers.findIndex((_, i) => !used().has(i) && ratio(i, 122, 154) >= 0.8));
  }
  return m;
}

export function mappingProblems(m) {
  const missing = FIELDS.filter((f) => f.required && m[f.key] == null).map((f) => f.label);
  const counts = {};
  for (const v of Object.values(m)) if (v != null) counts[v] = (counts[v] || 0) + 1;
  const dup = FIELDS.filter((f) => m[f.key] != null && counts[m[f.key]] > 1).map((f) => f.label);
  return { missing, dup, ok: missing.length === 0 && dup.length === 0 };
}

/** 行を検査して掲示場にする。通らない行は理由つきで返す。 */
export function buildBoards(table, m) {
  const boards = [], issues = [], seen = new Set();
  const textFields = FIELDS.filter((f) => f.key === "number" || f.key === "name" || f.key === "address");
  let outsideJapan = 0;
  for (const row of table.rows) {
    const v = (k) => (m[k] == null ? "" : String(row.fields[m[k]] ?? "").trim());
    const number = v("number"), name = v("name");
    const long = textFields.filter((f) => v(f.key).length > MAX_CELL).map((f) => f.label);
    if (long.length) { issues.push({ line: row.line, reason: `${long.join("・")}が長すぎます（${MAX_CELL.toLocaleString("ja-JP")}文字まで）` }); continue; }
    const empty = FIELDS.filter((f) => f.required && v(f.key) === "").map((f) => f.label);
    if (empty.length) { issues.push({ line: row.line, reason: `${empty.join("・")}が空です` }); continue; }
    const lat = parseNumber(v("latitude")), lon = parseNumber(v("longitude"));
    if (lat == null || lon == null) { issues.push({ line: row.line, reason: "緯度・経度を数値として読めません" }); continue; }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) { issues.push({ line: row.line, reason: "緯度・経度が範囲外です" }); continue; }
    if (seen.has(number)) { issues.push({ line: row.line, reason: `番号「${number}」が重複しています` }); continue; }
    seen.add(number);
    if (!(lat >= 20 && lat <= 46 && lon >= 122 && lon <= 154)) outsideJapan++;
    boards.push({ number, name, address: v("address"), lat, lon });
  }
  return { boards, issues, outsideJapan };
}

export function parseLatLon(text) {
  const parts = toHalfWidth(text).replace(/、/g, ",").split(",").map((s) => s.trim());
  if (parts.length !== 2) return null;
  const lat = parseNumber(parts[0]), lon = parseNumber(parts[1]);
  if (lat == null || lon == null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

export function distance(a, b) {
  const r = 6371000, rad = Math.PI / 180;
  const p1 = a.lat * rad, p2 = b.lat * rad, dp = p2 - p1, dl = (b.lon - a.lon) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 置き換える一覧で、写真を残せる掲示場の番号と、消す理由ごとの番号を返す。 */
export function classifyReplacementPhotos(oldBoards, newBoards, photoNumbers) {
  const oldByNumber = new Map(oldBoards.map((b) => [b.number, b]));
  const newByNumber = new Map(newBoards.map((b) => [b.number, b]));
  const keep = [], moved = [], missing = [];
  for (const number of photoNumbers) {
    const oldBoard = oldByNumber.get(number), newBoard = newByNumber.get(number);
    if (!newBoard) missing.push(number);
    else if (oldBoard && distance(oldBoard, newBoard) <= PHOTO_KEEP_DISTANCE_M) keep.push(number);
    else moved.push(number);
  }
  return { keep, moved, missing };
}

export function roundTrip(home, stops) {
  if (!stops.length) return 0;
  let t = distance(home, stops[0]);
  for (let i = 1; i < stops.length; i++) t += distance(stops[i - 1], stops[i]);
  return t + distance(stops[stops.length - 1], home);
}

/** 自宅発着。最近傍法で並べてから 2-opt で縮める。stops の添字の並びを返す。 */
export function planRoute(home, stops) {
  const n = stops.length;
  if (n < 2) return [...Array(n).keys()];
  const order = [];
  const remaining = new Set(stops.keys());
  let cur = home;
  while (remaining.size) {
    let best = -1, bestD = Infinity;
    for (const i of remaining) {
      const d = distance(cur, stops[i]);
      if (d < bestD || (d === bestD && i < best)) { best = i; bestD = d; }
    }
    order.push(best); remaining.delete(best); cur = stops[best];
  }
  const pt = (i) => (i < 0 || i >= n ? home : stops[order[i]]);
  let improved = true, guard = 0;
  while (improved && guard++ < 1000) {
    improved = false;
    for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
      const before = distance(pt(i - 1), pt(i)) + distance(pt(j), pt(j + 1));
      const after = distance(pt(i - 1), pt(j)) + distance(pt(i), pt(j + 1));
      if (after + 1e-9 < before) {
        const seg = order.slice(i, j + 1).reverse();
        order.splice(i, seg.length, ...seg);
        improved = true;
      }
    }
  }
  return order;
}

/** Google マップアプリ（なければブラウザ）に車の案内を渡す URL。API キー不要。 */
export function googleMapsNavUrl(p) {
  const q = new URLSearchParams({ api: "1", destination: `${p.lat},${p.lon}`, travelmode: "driving", dir_action: "navigate" });
  return `https://www.google.com/maps/dir/?${q}`;
}

export function formatKm(m) { return `${(m / 1000).toFixed(2)} km`; }
