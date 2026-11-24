// node test/core.test.mjs で実行する。データはすべて架空のもの。
import { readFileSync } from "node:fs";
import * as C from "../js/core.js";

let failures = 0;
const check = (ok, name) => { console.log(ok ? "PASS" : "FAIL", name); if (!ok) failures++; };
const root = new URL("../", import.meta.url);
const buf = (p) => { const b = readFileSync(new URL(p, root)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const table = (text) => C.readTable(new TextEncoder().encode(text).buffer);

// 同梱の見本（架空）
const st = C.readTable(buf("data/sample.csv"));
const sm = C.autoMapping(st.headers, st.rows);
const sample = C.buildBoards(st, sm);
check(C.mappingProblems(sm).ok && sample.boards.length === 10 && sample.issues.length === 0, "見本10件を列選択なしで読める");

// 自治体のオープンデータでよく使われる見出しの形（値は架空）
const y = table("No.,図面表示番号,設置場所,掲示場名,緯度,経度\n1,1-1,架空市1丁目,見本A,35.31,139.62\n2,1-10,架空市2丁目,見本B,35.32,139.63\n");
const ym = C.autoMapping(y.headers, y.rows);
check(ym.number === 1 && ym.address === 2 && ym.name === 3, "No. ではなく図面表示番号を番号として使う");
check(C.buildBoards(y, ym).boards[1].number === "1-10", "番号は文字列のまま（1-10）");

const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("図面表示番号,掲示場名,緯度,経度\r\nA,a,35,139\r\n")]);
const bt = C.readTable(bom.buffer);
check(bt.encoding === "UTF-8" && C.buildBoards(bt, C.autoMapping(bt.headers)).boards.length === 1, "BOM付きUTF-8・CRLF");

const q = table('番号,名前,lat,lng,住所\nA-1,"駅前, 北口",35.1,139.1,"架空市\n1丁目"\nA-2,"「""引用""」",35.2,139.2,\n');
const qm = C.autoMapping(q.headers, q.rows);
const qb = C.buildBoards(q, qm).boards;
check(C.mappingProblems(qm).ok && qb.length === 2, "別名の見出しを自動で割り当てる");
check(qb[0].name === "駅前, 北口" && qb[0].address === "架空市\n1丁目" && qb[1].name === '「"引用"」', "引用符内のカンマ・改行・\"\"");

const e = table("図面表示番号,掲示場名,緯度,経度\n1,a,35,139\n2,,35,139\n3,c,北,139\n4,d,95,139\n1,e,35,139\n\n6,f,３５．５,１３９．５\n7,g,35.3,35.3\n");
const eb = C.buildBoards(e, C.autoMapping(e.headers));
check(eb.boards.map((b) => b.number).join() === "1,6,7", "通る行だけ取り込む");
check(JSON.stringify(eb.issues.map((i) => i.line)) === "[3,4,5,6]" && eb.issues[3].reason.includes("重複"), "行番号と理由");
check(eb.boards[1].lat === 35.5 && eb.outsideJapan === 1, "全角数字・日本の範囲外の注意");

const v = table("col1,col2,col3,col4\nA,駅前,139.6,35.2\n");
const vm = C.autoMapping(v.headers, v.rows);
check(vm.latitude === 3 && vm.longitude === 2, "見出しが手がかりにならなくても緯度経度は値で推定");

let threw = false;
try { C.readTable(new ArrayBuffer(C.MAX_BYTES + 1)); } catch (err) { threw = err instanceof C.CSVImportError; }
check(threw, "5MBを超えると読まない");

// CSV の上限と、上限に数えない空の値・行。
{
  const fails = (text, word) => { try { table(text); return false; } catch (err) { return err instanceof C.CSVImportError && err.message.includes(word); } };
  const head = "番号,名前,緯度,経度\n";
  const many = (n, gap = "") => head + Array.from({ length: n }, (_, i) => `${i + 1},n${i + 1},35,139\n${gap}`).join("");
  check(table(many(C.MAX_ROWS)).rows.length === C.MAX_ROWS && fails(many(C.MAX_ROWS + 1), "行が多すぎます"), "10,000行は読み、10,001行は読まない");
  const g = table(many(C.MAX_ROWS, "\n \n,,\n"));
  check(g.rows.length === C.MAX_ROWS && g.rows[0].line === 2 && g.rows[1].line === 6, "空の行は行数に数えない（行番号はファイルのまま）");
  const wide = (n, tail = "") => `${Array.from({ length: n }, (_, i) => `c${i}`).join(",")}${tail}\n${Array(n).fill("1").join(",")}${tail}\n`;
  check(table(wide(C.MAX_COLS)).headers.length === C.MAX_COLS && fails(wide(C.MAX_COLS + 1), "列が多すぎます"), "200列は読み、201列目に値があると止める");
  const trailing = table(wide(C.MAX_COLS, ","));
  const blanks = table(wide(C.MAX_COLS, ',,　," \t",'));
  check([trailing, blanks].every((t) => t.headers.length === C.MAX_COLS && t.rows[0].fields.length === C.MAX_COLS)
    && fails(wide(C.MAX_COLS, ',,　,"x"'), "列が多すぎます"), "見出しとデータの末尾の空列は200列を超えても捨てる");
  check(fails(`a,b\n${Array(60000).fill("x").join(",")}\n`, "2行目の列が多すぎます"), "空でない値が60,000列ある行は止める");
  const blankLines = table(`${head}${" ".repeat(C.MAX_CELL + 1)}\n${",".repeat(C.MAX_COLS)}\r\n${",".repeat(60000)}\n1,見本,35,139`);
  check(blankLines.rows.length === 1 && blankLines.rows[0].line === 5, "長い空白行とカンマだけの長い行を読み飛ばす");

  const max = "あ".repeat(C.MAX_CELL), long = max + "あ";
  const unused = table(`${head.trimEnd()},設置場所,備考\n1,見本,35,139,,${long}\n2,見本,35,139,,"${long}"\n`);
  check(C.buildBoards(unused, C.autoMapping(unused.headers)).boards.length === 2
    && unused.rows.every((r) => r.fields[5] === long), "使わない列の2,001文字は取り込める");
  const mapped = table(`${head.trimEnd()},設置場所\n  ${max} ," ${max} ",35,139,　${max}　\n${long},見本,35,139,\n3,"${long}",35,139,\n4,見本,35,139,${long}\n5,見本,${long},139,\n6,見本,35,139,\n`);
  const mb = C.buildBoards(mapped, C.autoMapping(mapped.headers));
  check(mb.boards.length === 2 && mb.boards[0].number === max && mb.boards[0].name === max && mb.boards[0].address === max && mb.boards[1].number === "6"
    && JSON.stringify(mb.issues.map((i) => i.line)) === "[3,4,5,6]"
    && ["番号", "掲示場名", "設置場所"].every((label, i) => mb.issues[i].reason === `${label}が長すぎます（2,000文字まで）`)
    && mb.issues[3].reason === "緯度・経度を数値として読めません", "使う文字列の列は前後の空白を除いて2,000文字まで取り込む");

  const quoteWarning = '引用符（"）が閉じていない可能性があります';
  check(fails(`${head}1,"閉じていない${",35,139\n".repeat(1000)}`, quoteWarning), "閉じていない引用符が改行をまたいで長くなったら止める");
  const multiline = `${max.slice(3)}""\r\n`;
  const short = table(`${head}1,"${multiline}",35,139\n2,見本,35,139`);
  check(short.rows[0].fields[1].length === C.MAX_CELL && short.rows[1].line === 4
    && fails(`${head}1,"${multiline}あ",35,139`, quoteWarning)
    && fails(`${head}1,"${long}\n",35,139`, quoteWarning), "改行をまたぐ引用符つきの値は2,000文字まで読む");
  const t0 = performance.now();
  let msg = "";
  try { C.readTable(new Uint8Array(C.MAX_BYTES).fill(10).buffer); } catch (err) { msg = err instanceof C.CSVImportError ? err.message : String(err); }
  check(msg.includes("見出しの行とデータの行") && performance.now() - t0 < 2000, "改行だけの5MBでもメモリを使い切らずにやめる");
  for (const [part, label] of [[",", "カンマ"], [" ", "空白"], [",\n", "カンマと改行の繰り返し"]]) {
    const text = part.repeat(C.MAX_BYTES / part.length);
    const t0 = performance.now();
    check(fails(text, "見出しの行とデータの行が見つかりませんでした。") && performance.now() - t0 < 2000, `${label}だけの5MBでもメモリを使い切らずにやめる`);
  }
}

const sj = C.readTable(buf("test/fixtures/sjis_other_headers.csv"));
const sjb = C.buildBoards(sj, C.autoMapping(sj.headers, sj.rows));
check(sj.encoding === "Shift_JIS" && sjb.boards.length === 30 && sjb.issues.length === 3, "Shift_JIS（㈱を含む）を読み、誤り3行を分ける");
check(sjb.boards[0].name === "見本掲示場1（㈱テスト前）", "Shift_JIS が文字化けしない");

// 巡回順: 架空の点を無作為に20個作って確かめる
const rnd = (() => { let s = 42; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
const home = { lat: 35.28, lon: 139.67 };
for (let k = 0; k < 20; k++) {
  const pts = Array.from({ length: 20 }, () => ({ lat: 35.24 + rnd() * 0.08, lon: 139.60 + rnd() * 0.1 }));
  const order = C.planRoute(home, pts);
  const okSet = order.length === 20 && new Set(order).size === 20;
  const ok = C.roundTrip(home, order.map((i) => pts[i])) <= C.roundTrip(home, pts) + 1e-6;
  if (!(okSet && ok)) check(false, `無作為20点 #${k}`);
}
check(true, "無作為20点×20回: 漏れ・重複なし、提案順 ≤ 一覧の順");
check(Math.abs(C.distance({ lat: 35, lon: 139 }, { lat: 36, lon: 139 }) - 111195) < 100, "直線距離（緯度1度 ≒ 111.2km）");
{
  const numbers = ["同じ", "内側", "境目", "外側", "なくなった"];
  const old = numbers.map((number) => ({ number, lat: 0, lon: 0 }));
  const lat = (m) => m / 6371000 / (Math.PI / 180);
  const next = [...numbers.slice(0, 4), "古い一覧にない"].map((number, i) => ({ number, lat: lat([0, 49, 50, 51, 0][i]), lon: 0 }));
  const photos = new Map([...numbers, "古い一覧にない", "両方の一覧にない"].map((n) => [n, {}]));
  const result = C.classifyReplacementPhotos(old, next, photos.keys());
  check(C.PHOTO_KEEP_DISTANCE_M === 50 && result.keep.join() === "同じ,内側,境目", "置き換えで同じ番号かつ50m以内の写真を残す");
  check(result.moved.join() === "外側,古い一覧にない", "50mを超えた写真と古い一覧に対応する番号がない写真を場所が変わったものに分ける");
  check(result.missing.join() === "なくなった,両方の一覧にない", "新しい一覧に番号がない写真をなくなったものに分ける");
}
check(C.parseLatLon("35.3,139.6") && !C.parseLatLon("91,139") && C.parseLatLon(" 35.3 ， 139.6 "), "出発地点の緯度,経度の検証");
check(C.parseNumber("35") === 35 && C.parseNumber("35.") === 35 && C.parseNumber(".5") === 0.5 && C.parseNumber("-1.5e2") === -150 && C.parseNumber("＋３５．５") === 35.5
  && C.parseNumber("1.2.3") === null && C.parseNumber("1e") === null && C.parseNumber(".") === null && C.parseNumber("") === null && C.parseNumber("35x") === null, "数値の判定");
{
  const t0 = performance.now();
  const r1 = C.parseNumber("1".repeat(2_000_000) + "x"), r2 = C.parseNumber("１".repeat(2_000_000) + "x"), r3 = C.parseNumber("1".repeat(100));
  check(r1 === null && r2 === null && r3 === null && performance.now() - t0 < 1000, "長い数字列でも固まらない（細工したCSV対策）");
  check(C.parseNumber("35.5" + " ".repeat(61) + "x") === null && C.parseNumber("35.5" + "　".repeat(61) + "x") === null
    && C.parseNumber("　35.5　") === 35.5 && C.parseNumber("1".repeat(64)) !== null && C.parseNumber("1".repeat(65)) === null, "長い値の後ろにゴミがあれば数値にしない");
}
const url = C.googleMapsNavUrl({ lat: 35.3, lon: 139.6 });
check(url.includes("api=1") && url.includes("destination=35.3%2C139.6") && url.includes("travelmode=driving") && url.includes("dir_action=navigate"), "Google マップの案内URL");

console.log(failures ? `FAILURES: ${failures}` : "ALL PASS");
process.exit(failures ? 1 : 0);
