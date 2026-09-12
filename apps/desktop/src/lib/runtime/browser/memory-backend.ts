import {
  BROWSER_STORE_NAMES,
  type BrowserStoreBackend,
  type BrowserStoreName,
  type BrowserStoreTransaction,
} from "./store-backend";

/**
 * メモリ上の保存層。用途は 2 つ。
 *
 * 1. ユニットテスト。vitest は node 環境で動くので `indexedDB` が存在しない。
 * 2. IndexedDB を開けないブラウザ (プライベートウィンドウ、サイトデータ拒否) の
 *    フォールバック。**このタブを閉じるまでしか保たない**ので、呼び出し側は
 *    `capabilities.browserStorage` を見て「保存できない」ことを表示する。
 *
 * `write()` は例外時に丸ごと巻き戻す。IndexedDB のトランザクションと同じ体験にして、
 * テストで書きかけの状態が残らないようにする。
 */
export function createMemoryStoreBackend(): BrowserStoreBackend {
  const stores = new Map<BrowserStoreName, Map<string, unknown>>(
    BROWSER_STORE_NAMES.map((name) => [name, new Map<string, unknown>()]),
  );
  let queue: Promise<unknown> = Promise.resolve();

  function storeOf(name: BrowserStoreName): Map<string, unknown> {
    const store = stores.get(name);
    if (!store) {
      throw new Error(`Unknown store: ${name}`);
    }
    return store;
  }

  const transaction: BrowserStoreTransaction = {
    async get<T>(store: BrowserStoreName, key: string): Promise<T | undefined> {
      const value = storeOf(store).get(key);
      return value === undefined ? undefined : structuredClone(value) as T;
    },
    async getAll<T>(store: BrowserStoreName): Promise<T[]> {
      return [...storeOf(store).values()].map((value) => structuredClone(value) as T);
    },
    async put(store: BrowserStoreName, key: string, value: unknown): Promise<void> {
      storeOf(store).set(key, structuredClone(value));
    },
    async delete(store: BrowserStoreName, key: string): Promise<void> {
      storeOf(store).delete(key);
    },
  };

  function enqueue<T>(run: (tx: BrowserStoreTransaction) => Promise<T>, rollback: boolean): Promise<T> {
    const result = queue.then(async () => {
      const snapshot = rollback
        ? new Map([...stores].map(([name, store]) => [name, new Map(store)] as const))
        : null;
      try {
        return await run(transaction);
      } catch (error) {
        if (snapshot) {
          for (const [name, store] of snapshot) {
            stores.set(name, store);
          }
        }
        throw error;
      }
    });
    queue = result.catch(() => undefined);
    return result;
  }

  return {
    read: (_stores, run) => enqueue(run, false),
    write: (_stores, run) => enqueue(run, true),
  };
}
