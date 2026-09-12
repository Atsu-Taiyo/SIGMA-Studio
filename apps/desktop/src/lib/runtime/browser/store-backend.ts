/**
 * ブラウザ保存層のトランザクション契約。
 *
 * デスクトップ版は library.json の read-modify-write を `data/locks/library.lock` の
 * プロセス間ロックで守っている。ブラウザには相当するロックが無いので、代わりに
 * IndexedDB のトランザクションそのものを不可分の単位として使う。台帳の書き換えと
 * 本文の書き込みを必ず 1 つの `write()` に入れること — 分けると、タブが 2 つ開いて
 * いるときに「行はあるが本文が無い」状態を作れてしまう。
 */

export const BROWSER_STORE_NAMES = [
  "library",
  "documents",
  "workspaceState",
  "templates",
  "materials",
  "documentVersionMetadata",
  "documentVersionSnapshots",
] as const;

export type BrowserStoreName = (typeof BROWSER_STORE_NAMES)[number];

export interface BrowserStoreTransaction {
  get<T>(store: BrowserStoreName, key: string): Promise<T | undefined>;
  getAll<T>(store: BrowserStoreName): Promise<T[]>;
  put(store: BrowserStoreName, key: string, value: unknown): Promise<void>;
  delete(store: BrowserStoreName, key: string): Promise<void>;
}

export interface BrowserStoreBackend {
  read<T>(
    stores: readonly BrowserStoreName[],
    run: (tx: BrowserStoreTransaction) => Promise<T>,
  ): Promise<T>;
  /**
   * 読み書きトランザクション。`run` の中で **IndexedDB 以外の Promise を await しない**こと。
   * IndexedDB のトランザクションは、保留中の要求が無いまま制御が戻ると自動で閉じる。
   */
  write<T>(
    stores: readonly BrowserStoreName[],
    run: (tx: BrowserStoreTransaction) => Promise<T>,
  ): Promise<T>;
}
