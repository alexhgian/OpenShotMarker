/**
 * Durable bytes behind the sql.js database.
 *
 * sql.js is an in-memory SQLite: closing the tab loses it unless the serialised
 * database is written somewhere. In the browser that is IndexedDB; in tests it is a
 * Map. The store does not care which, which is what makes the persistence path
 * testable without a browser.
 */

export interface BlobStore {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, bytes: Uint8Array): Promise<void>;
  clear(key: string): Promise<void>;
}

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | null> {
    return this.blobs.get(key) ?? null;
  }

  async set(key: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(key, bytes.slice());
  }

  async clear(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

const DB_NAME = 'tc-marker';
const STORE_NAME = 'sqlite';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE_NAME, mode);
        const req = fn(t.objectStore(STORE_NAME));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export class IndexedDbBlobStore implements BlobStore {
  async get(key: string): Promise<Uint8Array | null> {
    const value = await tx<unknown>('readonly', (s) => s.get(key) as IDBRequest<unknown>);
    if (value == null) return null;
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return null;
  }

  async set(key: string, bytes: Uint8Array): Promise<void> {
    // Copy: the caller's view may be backed by WASM memory that moves under it.
    await tx('readwrite', (s) => s.put(new Uint8Array(bytes), key) as IDBRequest<IDBValidKey>);
  }

  async clear(key: string): Promise<void> {
    await tx('readwrite', (s) => s.delete(key) as unknown as IDBRequest<undefined>);
  }
}
