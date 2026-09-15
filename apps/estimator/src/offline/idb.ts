import { accountDatabaseName, assertAccount, captureAccount, type AccountScope } from './account';

// The legacy pec-estimator database is quarantined in place: never open it for
// normal data access, migrate it to a guessed user, clear it, or replay its ops.
// All new catalog, template, estimate and outbox data is isolated by auth UID.
const DB_VERSION = 1;
export type StoreName = 'catalog' | 'outbox' | 'estimates';
const databases = new Map<string, Promise<IDBDatabase>>();
function openDB(scope: AccountScope): Promise<IDBDatabase> {
  assertAccount(scope);
  const name = accountDatabaseName(scope.ownerId);
  let pending = databases.get(name);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('catalog')) db.createObjectStore('catalog');
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'opId' });
        if (!db.objectStoreNames.contains('estimates')) db.createObjectStore('estimates', { keyPath: 'id' });
      };
      req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); databases.delete(name); }; resolve(req.result); };
      req.onerror = () => { databases.delete(name); reject(req.error); };
    });
    databases.set(name, pending);
  }
  return pending;
}
function tx<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest, scope: AccountScope): Promise<T> {
  return openDB(scope).then(db => new Promise<T>((resolve, reject) => {
    assertAccount(scope);
    const t = db.transaction(store, mode);
    const abort = () => { try { t.abort(); } catch { /* already finished */ } };
    scope.signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => scope.signal.removeEventListener('abort', abort);
    let result: T;
    const req = run(t.objectStore(store));
    req.onsuccess = () => { result = req.result as T; };
    t.oncomplete = () => {
      cleanup();
      try { assertAccount(scope); resolve(result); } catch (error) { reject(error); }
    };
    t.onabort = t.onerror = () => { cleanup(); reject(t.error || new Error('Offline operation paused. Your saved work has been kept.')); };
  }));
}
export const idbGet = <T>(store: StoreName, key: IDBValidKey, scope = captureAccount()) =>
  tx<T | undefined>(store, 'readonly', s => s.get(key), scope);
export const idbGetAll = <T>(store: StoreName, scope = captureAccount()) => tx<T[]>(store, 'readonly', s => s.getAll(), scope);
export const idbPut = (store: StoreName, value: unknown, key?: IDBValidKey, scope = captureAccount()) =>
  tx<IDBValidKey>(store, 'readwrite', s => key === undefined ? s.put(value) : s.put(value, key), scope);
export const idbDelete = (store: StoreName, key: IDBValidKey, scope = captureAccount()) =>
  tx<undefined>(store, 'readwrite', s => s.delete(key), scope);
export const idbAvailable = () => typeof indexedDB !== 'undefined';

// Metadata only. No legacy customer content is read or shown. Browsers lacking
// databases() skip the notice rather than creating/opening a legacy database.
export async function hasLegacyOfflineWork(): Promise<boolean> {
  if (!idbAvailable() || typeof indexedDB.databases !== 'function') return false;
  const entries = await indexedDB.databases();
  if (!entries.some(entry => entry.name === 'pec-estimator')) return false;
  return new Promise(resolve => {
    const req = indexedDB.open('pec-estimator');
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onerror = () => resolve(false);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('outbox')) { db.close(); resolve(false); return; }
      const t = db.transaction('outbox', 'readonly');
      const count = t.objectStore('outbox').count();
      count.onsuccess = () => { resolve(count.result > 0); db.close(); };
      count.onerror = () => { resolve(false); db.close(); };
    };
  });
}

// Replace a complete estimate snapshot and its queue in one commit. Aborting
// during an account switch leaves the previous draft/queue intact.
export async function replaceEstimateQueue(estimate: Record<string, unknown>, ops: unknown[], removeIds: string[], scope: AccountScope): Promise<void> {
  const db = await openDB(scope);
  assertAccount(scope);
  return new Promise((resolve, reject) => {
    const t = db.transaction(['estimates', 'outbox'], 'readwrite');
    const abort = () => { try { t.abort(); } catch { /* already finished */ } };
    scope.signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => scope.signal.removeEventListener('abort', abort);
    t.objectStore('estimates').put(estimate);
    const outbox = t.objectStore('outbox');
    for (const id of removeIds) outbox.delete(id);
    for (const op of ops) outbox.put(op);
    t.oncomplete = () => { cleanup(); try { assertAccount(scope); resolve(); } catch (error) { reject(error); } };
    t.onabort = t.onerror = () => { cleanup(); reject(t.error || new Error('Offline save paused. The previous draft has been kept.')); };
  });
}
