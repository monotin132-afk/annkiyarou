// window.storage (Claudeアーティファクト専用API) と同じインターフェースを持つ
// 永続化レイヤー。保存先は IndexedDB（ブラウザ標準機能）。
// これにより、元のコンポーネントロジックをほぼそのまま使い回せる。
//
// IndexedDB を選んだ理由:
// - localStorage は同期APIで、かつブラウザ全体で5〜10MB程度しか使えず、
//   写真を多数保存する用途では容量不足になりやすい
// - IndexedDB は非同期APIで、ブラウザによっては数百MB〜GB単位まで扱える

const DB_NAME = "math-flashcards-db";
const DB_VERSION = 1;
const STORE_NAME = "kv";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, callback) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const result = callback(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// shared は元のAPIとの互換のために残しているが、このスタンドアロン版では
// 全データが常にこのブラウザ専用（個人用）として扱われる。
export const storage = {
  async get(key) {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const record = await requestToPromise(store.get(key));
    if (!record) {
      throw new Error(`key not found: ${key}`);
    }
    return { key, value: record.value, shared: false };
  },

  async set(key, value) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("Invalid key");
    }
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    await requestToPromise(store.put({ key, value }));
    return { key, value, shared: false };
  },

  async delete(key) {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    await requestToPromise(store.delete(key));
    return { key, deleted: true, shared: false };
  },

  async list(prefix = "") {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const allKeys = await requestToPromise(store.getAllKeys());
    const keys = allKeys.filter((k) => k.startsWith(prefix));
    return { keys, prefix, shared: false };
  },
};
