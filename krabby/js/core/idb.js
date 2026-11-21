// IndexedDB wrapper. Every call resolves and never rejects. When indexedDB is unavailable (Node,
// private windows, blocked storage) every call resolves null and writes do nothing.
import { consent } from './consent.js';

export const DB_NAME = 'krabby-v2';
export const DB_VERSION = 1;
// Each store keeps its records under one inline key. A value without that field cannot be stored.
export const STORES = Object.freeze({
  journal: 'id', audit: 'seq', learning: 'id', proposals: 'id', candles: 'key', strategies: 'id', meta: 'key',
});

// indexedDB: the factory (tests inject a fake). allowWrites: optional () => bool, checked before put and putMany.
export function createIdb({ indexedDB, allowWrites } = {}) {
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        if (!indexedDB || typeof indexedDB.open !== 'function') { resolve(null); return; }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          try {
            const db = req.result;
            for (const [name, keyPath] of Object.entries(STORES)) {
              if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
            }
          } catch (_) { /* open will still resolve below */ }
        };
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
    return dbPromise;
  }

  // Runs fn(objectStore) in one transaction. Resolves the request result (reads) or true (writes), else null.
  async function run(store, mode, fn) {
    if (!Object.prototype.hasOwnProperty.call(STORES, store)) return null;
    const db = await open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(store, mode);
        let result = null;
        const req = fn(tx.objectStore(store));
        if (req) req.onsuccess = () => { result = req.result === undefined ? true : req.result; };
        tx.oncomplete = () => resolve(mode === 'readonly' ? result : (result === null ? true : result));
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  const writable = () => {
    try { return typeof allowWrites === 'function' ? Boolean(allowWrites()) : true; } catch (_) { return false; }
  };

  return {
    open,
    available: () => Boolean(indexedDB),
    async put(store, value) {
      if (!writable()) return null;
      return run(store, 'readwrite', (s) => s.put(value));
    },
    async putMany(store, values) {
      if (!writable() || !Array.isArray(values)) return null;
      return run(store, 'readwrite', (s) => { let last = null; for (const v of values) last = s.put(v); return last; });
    },
    // prefix: for a store with text keys, only the records whose key starts with it (the caller still checks what it gets).
    getAll(store, prefix = null) {
      return run(store, 'readonly', (s) => {
        if (typeof prefix === 'string' && prefix && typeof IDBKeyRange !== 'undefined') return s.getAll(IDBKeyRange.bound(prefix, `${prefix}￿`));
        return s.getAll();
      });
    },
    delete(store, key) { return run(store, 'readwrite', (s) => s.delete(key)); },
    clear(store) { return run(store, 'readwrite', (s) => s.clear()); },
    count(store) { return run(store, 'readonly', (s) => s.count()); },
  };
}

// The app instance: writes happen only while the storage consent is accepted.
export const idb = createIdb({
  indexedDB: (() => { try { return globalThis.indexedDB; } catch (_) { return undefined; } })(),
  allowWrites: () => consent.allowsStorage(),
});
