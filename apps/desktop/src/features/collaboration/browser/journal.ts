import type { MemberRole, OperationIdentity } from "../model/protocol";

export interface BrowserSharedRecord {
  actorId: string;
  sharedDocumentId: string;
  epoch: number;
  state: string;
  role: MemberRole;
  outbox: { update: string; identity: OperationIdentity }[];
  assets: Record<string, { source: string; pending: boolean }>;
}
export interface SharedBrowserStore {
  get(actor: string, id: string): Promise<BrowserSharedRecord | undefined>;
  put(record: BrowserSharedRecord): Promise<void>;
  acquire?(actor: string, id: string): Promise<() => void>;
}

/** A separate, account-scoped Yjs journal. Never reads the browser's local-only SigmaDoc library. */
export function createSharedBrowserStore(): SharedBrowserStore {
  let opened: Promise<IDBDatabase> | undefined;
  const database = () => opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("sigma-studio-shared", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("journals");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opened = undefined; reject(new Error("BROWSER_JOURNAL_UNAVAILABLE")); };
    request.onblocked = () => reject(new Error("BROWSER_JOURNAL_UNAVAILABLE"));
  });
  const key = (actor: string, id: string) => `${actor}/${id}`;
  return {
    async acquire(actor, id) {
      if (!navigator.locks) throw new Error("BROWSER_JOURNAL_UNAVAILABLE");
      return new Promise<() => void>((resolve, reject) => {
        void navigator.locks.request(`sigma-studio-shared/${key(actor, id)}`, { mode: "exclusive", ifAvailable: true }, async lock => {
          if (!lock) { reject(new Error("DOCUMENT_ALREADY_OPEN")); return; }
          await new Promise<void>(release => resolve(release));
        }).catch(() => reject(new Error("BROWSER_JOURNAL_UNAVAILABLE")));
      });
    },
    async get(actor, id) {
      const db = await database();
      return new Promise((resolve, reject) => {
        const request = db.transaction("journals").objectStore("journals").get(key(actor, id));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error("BROWSER_JOURNAL_UNAVAILABLE"));
      });
    },
    async put(record) {
      const db = await database();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction("journals", "readwrite");
        transaction.objectStore("journals").put(record, key(record.actorId, record.sharedDocumentId));
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () => reject(new Error("BROWSER_JOURNAL_UNAVAILABLE"));
      });
    },
  };
}
