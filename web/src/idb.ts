// The app's IndexedDB database. Stores:
//   models  models kept in this browser only (localModels.ts), by sha256
//   drafts  the Slice page's work in progress, per tab (sliceDraft.ts)

const DB_NAME = "farmslicer";
const DB_VERSION = 2;

export type Store = "models" | "drafts";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("models")) db.createObjectStore("models", { keyPath: "sha256" });
      if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** One request in its own transaction; resolves when the transaction commits. */
export function request<T>(
  storeName: Store,
  store: (s: IDBObjectStore) => IDBRequest<T>,
  mode: IDBTransactionMode,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const req = store(tx.objectStore(storeName));
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}
