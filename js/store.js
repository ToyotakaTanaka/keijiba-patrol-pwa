// 端末内の保存（IndexedDB）。サーバーには何も送らない。
const DB_NAME = "poster-patrol";
let dbPromise;

function toError(err, fallback) {
  if (err && typeof err.message === "string") return err;
  return new Error(typeof err === "string" && err ? err : fallback);
}

/** 要求のエラー、トランザクションのエラー、既定の文の順で Error を選ぶ。 */
const txError = (tx, e, fallback) => toError(e?.target?.error || tx?.error, fallback);

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("kv");
        db.createObjectStore("lists", { keyPath: "id" });
        db.createObjectStore("photos", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(txError(req, e, "保存先を開けませんでした"));
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const fallback = mode === "readonly" ? "読み込みに失敗しました" : "保存に失敗しました";
    let result;
    tx.oncomplete = () => resolve(result && "result" in result ? result.result : undefined);
    tx.onerror = (e) => reject(txError(tx, e, fallback));
    tx.onabort = (e) => reject(txError(tx, e, mode === "readonly" ? "読み込みを取り消しました" : "保存を取り消しました"));
    try {
      result = fn(tx.objectStore(store));
    } catch (err) {
      try { tx.abort(); } catch {}
      reject(toError(err, fallback));
    }
  });
}

export const kvGet = (key) => run("kv", "readonly", (s) => s.get(key));
export const kvSet = (key, value) => run("kv", "readwrite", (s) => s.put(value, key));
export const kvDel = (key) => run("kv", "readwrite", (s) => s.delete(key));

export const listAll = () => run("lists", "readonly", (s) => s.getAll());
export const listPut = (list) => run("lists", "readwrite", (s) => s.put(list));
export const listDel = (id) => run("lists", "readwrite", (s) => s.delete(id));

/** 一覧と担当・巡回順を保存してから写真を消す。途中で失敗したらまとめて取り消す。 */
export async function listReplace(list, progress, photoNumbers) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["lists", "kv", "photos"], "readwrite");
    const kv = tx.objectStore("kv");
    const photos = tx.objectStore("photos");
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(txError(tx, e, "保存に失敗しました"));
    tx.onabort = (e) => reject(txError(tx, e, "保存を取り消しました"));
    try {
      tx.objectStore("lists").put(list);
      kv.put(list.id, "activeListId");
      kv.put(progress, `progress:${list.id}`).onsuccess = () => {
        for (const number of photoNumbers) photos.delete(photoKey(list.id, number));
      };
    } catch (err) {
      try { tx.abort(); } catch {}
      reject(toError(err, "保存に失敗しました"));
    }
  });
}

export const photoKey = (listId, number) => `${listId}#${number}`;
/**
 * その一覧の写真のキーの範囲。"#" の次の文字 "$" の手前までを取るので、番号がどんな文字で始まっても入る
 * （上端を「一覧ID# + U+FFFF」にすると、U+FFFF で始まる番号の写真が目録にも削除にも入らない）。
 */
const photoRange = (listId) => IDBKeyRange.bound(`${listId}#`, `${listId}$`, false, true);
/** 番号・写真・日時を1回の書き込みで確定する。完了したら resolve。 */
export const photoPut = (rec) => run("photos", "readwrite", (s) => s.put(rec));
export const photoGet = (key) => run("photos", "readonly", (s) => s.get(key));
export const photoDel = (key) => run("photos", "readwrite", (s) => s.delete(key));

/** その一覧の写真の目録（画像本体は読まない）。 */
export async function photoIndex(listId) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const out = new Map();
    const tx = db.transaction("photos", "readonly");
    tx.oncomplete = () => resolve(out);
    tx.onerror = (e) => reject(txError(tx, e, "読み込みに失敗しました"));
    tx.onabort = (e) => reject(txError(tx, e, "読み込みを取り消しました"));
    try {
      tx.objectStore("photos").openCursor(photoRange(listId)).onsuccess = (e) => {
        const c = e.target.result;
        if (c) { out.set(c.value.number, { savedAt: c.value.savedAt }); c.continue(); }
      };
    } catch (err) {
      try { tx.abort(); } catch {}
      reject(toError(err, "読み込みに失敗しました"));
    }
  });
}

export async function photoDeleteList(listId) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("photos", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(txError(tx, e, "削除に失敗しました"));
    tx.onabort = (e) => reject(txError(tx, e, "削除を取り消しました"));
    try {
      tx.objectStore("photos").delete(photoRange(listId));
    } catch (err) {
      try { tx.abort(); } catch {}
      reject(toError(err, "削除に失敗しました"));
    }
  });
}

/** 保存データが消されにくいよう、ブラウザに永続化を頼む（任意）。 */
export async function requestPersist() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}
