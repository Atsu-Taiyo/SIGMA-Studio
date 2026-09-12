import {
  BROWSER_STORE_NAMES,
  type BrowserStoreBackend,
  type BrowserStoreName,
  type BrowserStoreTransaction,
} from "./store-backend";

export const BROWSER_DATABASE_NAME = "sigma-studio";
export const BROWSER_DATABASE_VERSION = 2;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), { once: true });
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(BROWSER_DATABASE_NAME, BROWSER_DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      for (const name of BROWSER_STORE_NAMES) {
        if (!database.objectStoreNames.contains(name)) {
          database.createObjectStore(name);
        }
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB open failed")), { once: true });
    request.addEventListener("blocked", () => reject(new Error("IndexedDB open blocked")), { once: true });
  });
}

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

/**
 * IndexedDB 実装。1 つの `write()` が 1 つの readwrite トランザクションになり、
 * 同じ object store を触る他タブの書き込みはブラウザ側で直列化される。これが
 * デスクトップ版のプロセス間ロックに対応する。
 *
 * トランザクションは `complete` を待ってから解決する。ここを待たずに変更通知を
 * 流すと、他タブが「まだ書かれていない台帳」を読みに来る窓ができる。
 */
export function createIndexedDbStoreBackend(): BrowserStoreBackend {
  let databasePromise: Promise<IDBDatabase> | null = null;

  function database(): Promise<IDBDatabase> {
    if (!databasePromise) {
      databasePromise = openDatabase().catch((error) => {
        // 失敗した Promise を握り続けると、以後の全操作が同じ失敗を返し続ける。
        databasePromise = null;
        throw error;
      });
    }
    return databasePromise;
  }

  async function run<T>(
    stores: readonly BrowserStoreName[],
    mode: IDBTransactionMode,
    body: (tx: BrowserStoreTransaction) => Promise<T>,
  ): Promise<T> {
    const db = await database();
    const transaction = db.transaction([...stores], mode);
    const wrapper: BrowserStoreTransaction = {
      get: <T2,>(store: BrowserStoreName, key: string) =>
        requestToPromise<T2 | undefined>(transaction.objectStore(store).get(key) as IDBRequest<T2 | undefined>),
      getAll: <T2,>(store: BrowserStoreName) =>
        requestToPromise<T2[]>(transaction.objectStore(store).getAll() as IDBRequest<T2[]>),
      put: async (store: BrowserStoreName, key: string, value: unknown) => {
        await requestToPromise(transaction.objectStore(store).put(value, key));
      },
      delete: async (store: BrowserStoreName, key: string) => {
        await requestToPromise(transaction.objectStore(store).delete(key));
      },
    };

    const settled = new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")), { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")), { once: true });
    });

    let value: T;
    try {
      value = await body(wrapper);
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // すでに終了しているトランザクションの abort は無視してよい。
      }
      await settled.catch(() => undefined);
      throw error;
    }

    if (mode === "readwrite") {
      await settled;
    }
    return value;
  }

  return {
    read: (stores, body) => run(stores, "readonly", body),
    write: (stores, body) => run(stores, "readwrite", body),
  };
}
