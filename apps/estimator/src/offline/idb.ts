// Minimal promise wrapper over IndexedDB. No dependency. Three stores:
//   catalog   - one cached Catalog blob under key 'catalog' (offline reads)
//   outbox    - queued mutations, keyPath 'opId' (durable write queue)
//   estimates - local copy of saved estimates, keyPath 'id' (offline reads)
const DB_NAME = 'pec-estimator';
const DB_VERSION = 1;

export type StoreName = 'catalog' | 'outbox' | 'estimates';

let _dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('catalog')) db.createObjectStore('catalog');
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'opId' });
      if (!db.objectStoreNames.contains('estimates')) db.createObjectStore('estimates', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const idbGet = <T>(store: StoreName, key: IDBValidKey) =>
  tx<T | undefined>(store, 'readonly', (s) => s.get(key));
export const idbGetAll = <T>(store: StoreName) => tx<T[]>(store, 'readonly', (s) => s.getAll());
export const idbPut = (store: StoreName, value: unknown, key?: IDBValidKey) =>
  tx<IDBValidKey>(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)));
export const idbDelete = (store: StoreName, key: IDBValidKey) =>
  tx<undefined>(store, 'readwrite', (s) => s.delete(key));

// IndexedDB can be unavailable (private mode, locked profile). Callers treat a
// rejection as "no offline storage" and degrade to online-only.
export const idbAvailable = () => typeof indexedDB !== 'undefined';
