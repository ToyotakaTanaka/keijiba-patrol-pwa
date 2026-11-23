// 端末内の保存（IndexedDB）。サーバーには何も送らない。
const DB_NAME = "poster-patrol";
let dbPromise;

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
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(result && "result" in result ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("保存を取り消しました"));
  });
}

export const kvGet = (key) => run("kv", "readonly", (s) => s.get(key));
export const kvSet = (key, value) => run("kv", "readwrite", (s) => s.put(value, key));
export const kvDel = (key) => run("kv", "readwrite", (s) => s.delete(key));

export const listAll = () => run("lists", "readonly", (s) => s.getAll());
export const listPut = (list) => run("lists", "readwrite", (s) => s.put(list));
export const listDel = (id) => run("lists", "readwrite", (s) => s.delete(id));

export const photoKey = (listId, number) => `${listId}#${number}`;
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
    const range = IDBKeyRange.bound(`${listId}#`, `${listId}#￿`);
    tx.objectStore("photos").openCursor(range).onsuccess = (e) => {
      const c = e.target.result;
      if (c) { out.set(c.value.number, { savedAt: c.value.savedAt }); c.continue(); }
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
}

export async function photoDeleteList(listId) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("photos", "readwrite");
    tx.objectStore("photos").delete(IDBKeyRange.bound(`${listId}#`, `${listId}#￿`));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 保存データが消されにくいよう、ブラウザに永続化を頼む（任意）。 */
export async function requestPersist() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}
