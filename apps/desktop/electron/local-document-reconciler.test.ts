import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBlankDocument } from "@/lib/blank-document";
import type { LibraryFileRow } from "@/lib/library-ledger";

import { getSourceDependencies } from "../tests/helpers/source-dependencies";
import { LocalDocumentReconciler, type LocalDocumentReconcilerPorts } from "./local-document-reconciler";
import type { LocalStoreChangeEvent } from "./local-store-change-events";
import { LocalStoreWriteIdentity } from "./local-store-write-identity";

const NOW = Date.parse("2026-09-09T00:00:00.000Z");

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function harness() {
  const document = createBlankDocument("External title");
  const raw = JSON.stringify(document);
  const file: LibraryFileRow = {
    fileId: "file_a", workspaceId: "workspace_a", folderId: null, docId: "before",
    title: "Before", documentPath: "documents/file_a.sigmadoc.json", revision: 7,
    createdAt: new Date(NOW - 20_000).toISOString(), updatedAt: "before", deletedAt: null,
  };
  const rows = new Map([[file.fileId, file]]);
  const persisted = new Map(rows);
  const events: LocalStoreChangeEvent[] = [];
  const order: string[] = [];
  const write = vi.fn(async () => {
    order.push("write");
    for (const [fileId, row] of rows) persisted.set(fileId, structuredClone(row));
  });
  const readDocument = vi.fn<LocalDocumentReconcilerPorts["readDocument"]>(async () => {
    order.push("read"); return raw;
  });
  const stat = vi.fn(async () => ({ size: raw.length, mtimeMs: NOW, ino: 1 }));
  const writeIdentity = new LocalStoreWriteIdentity({ readFile: readDocument, stat });
  const ports = {
    withLedger: vi.fn<LocalDocumentReconcilerPorts["withLedger"]>(async (operation) => {
      order.push("lock");
      try {
        return await operation({
          findVisibleFile: (fileId) => { order.push(`find:${fileId}`); return rows.get(fileId) ?? null; },
          replaceFile: (row) => { order.push("replace"); rows.set(row.fileId, row); },
          write,
        });
      } finally { order.push("unlock"); }
    }),
    listVisibleFileIds: vi.fn(async () => { order.push("list"); return [...rows.keys()]; }),
    resolveDocumentPath: (row: LibraryFileRow) => `/data/${row.documentPath}`,
    readDocument,
    writeRecoveryBackup: vi.fn(async () => { order.push("backup"); return "/recovery/exact-bytes"; }),
    writeIdentity,
    missingBodyGraceMs: 10_000,
    log: vi.fn<LocalDocumentReconcilerPorts["log"]>((event) => { order.push(`log:${event}`); }),
  } satisfies LocalDocumentReconcilerPorts;
  const reconciler = new LocalDocumentReconciler(ports);
  const onChange = (event: LocalStoreChangeEvent) => {
    order.push(`event:${"change" in event ? event.change : event.type}`);
    events.push(event);
  };
  return { document, raw, file, rows, persisted, events, order, write, stat, ports, reconciler, onChange };
}

describe("external document reconciliation", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not inspect bytes for a file the ledger no longer exposes", async () => {
    const h = harness();
    await h.reconciler.reconcile("file_hidden", h.onChange);
    expect(h.order).toEqual(["lock", "find:file_hidden", "unlock"]);
    expect(h.ports.readDocument).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("suppresses the first own-write event by stat and a duplicate event by exact bytes", async () => {
    const h = harness();
    const path = h.ports.resolveDocumentPath(h.file);
    h.ports.writeIdentity.rememberSignature(path, h.raw);
    h.ports.writeIdentity.recordStat(path, `${h.raw.length}:${NOW}:1`);
    await h.reconciler.reconcile(h.file.fileId, h.onChange);
    expect(h.ports.readDocument).not.toHaveBeenCalled();
    await h.reconciler.reconcile(h.file.fileId, h.onChange);
    expect(h.stat).toHaveBeenCalledOnce();
    expect(h.ports.readDocument).toHaveBeenCalledOnce();
    expect(h.persisted.get(h.file.fileId)).toEqual(h.file);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it.each([7, -2])("persists external metadata at the next revision (%s) before notifying inside the ledger lock", async (revision) => {
    const h = harness();
    const file = { ...h.file, revision, futureField: { keep: true } };
    h.rows.set(file.fileId, file);
    await h.reconciler.reconcile(file.fileId, h.onChange);
    expect(h.persisted.get(file.fileId)).toEqual({
      ...file, docId: h.document.docId, title: "External title",
      revision: Math.max(0, revision) + 1, updatedAt: h.document.updatedAt,
    });
    expect(h.order).toEqual(["lock", "find:file_a", "read", "replace", "write", "event:changed", "unlock"]);
    expect(h.events).toEqual([{ type: "document", fileId: file.fileId, change: "changed", timestamp: NOW }]);
  });

  it.each([
    { age: 9_999, change: "changed", written: false },
    { age: 10_000, change: "deleted", written: true },
    { age: 10_001, change: "deleted", written: true },
    { age: -1, change: "changed", written: false },
    { age: NaN, change: "deleted", written: true },
  ])("keeps the existing missing-body grace boundary for age $age", async ({ age, change, written }) => {
    const h = harness();
    const file = { ...h.file, createdAt: Number.isFinite(age) ? new Date(NOW - age).toISOString() : "invalid" };
    h.rows.set(file.fileId, file);
    h.ports.readDocument.mockRejectedValueOnce(new Error("unavailable body"));
    await h.reconciler.reconcile(file.fileId, h.onChange);
    expect(h.events).toEqual([{ type: "document", fileId: file.fileId, change, timestamp: NOW }]);
    expect(h.write).toHaveBeenCalledTimes(written ? 1 : 0);
    expect(h.rows.get(file.fileId)).toEqual(written
      ? { ...file, deletedAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() }
      : file);
    expect(h.order).toEqual(written
      ? ["lock", "find:file_a", "log:file-soft-deleted-by-reconcile", "replace", "write", "event:deleted", "unlock"]
      : ["lock", "find:file_a", "log:file-body-missing", "event:changed", "unlock"]);
  });

  it.each(["json", "schema"])("reports an unreadable external %s edit without changing ledger rows or saving a backup", async (kind) => {
    const h = harness();
    h.ports.readDocument.mockResolvedValueOnce(kind === "json" ? "{broken"
      : JSON.stringify({ ...h.document, pageLayout: { preset: "scroll" } }));
    await h.reconciler.reconcile(h.file.fileId, h.onChange);
    expect(h.rows.get(h.file.fileId)).toBe(h.file);
    expect(h.persisted.get(h.file.fileId)).toEqual(h.file);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.ports.writeRecoveryBackup).not.toHaveBeenCalled();
    expect(h.ports.log).toHaveBeenCalledWith("file-body-unreadable-by-reconcile", {
      fileId: h.file.fileId, reason: expect.any(String),
    });
    expect(h.order).toEqual(["lock", "find:file_a", "log:file-body-unreadable-by-reconcile", "event:changed", "unlock"]);
  });

  it("backs up the exact recoverable bytes before replacing metadata and notifying", async () => {
    const h = harness();
    const raw = JSON.stringify({
      ...h.document,
      pageLayout: {
        preset: "A4", overlay: { overlaySnapshot: {
          version: 1, assets: {}, shapes: [{ id: "legacy", type: "callout", x: 30, y: 40, props: { w: 180, h: 80 } }],
        } },
      },
    }, null, 2);
    h.ports.readDocument.mockResolvedValueOnce(raw);
    await h.reconciler.reconcile(h.file.fileId, h.onChange);
    expect(h.ports.writeRecoveryBackup).toHaveBeenCalledWith(h.file.fileId, raw);
    expect(h.persisted.get(h.file.fileId)).toMatchObject({ revision: 8, title: "External title" });
    expect(h.order).toEqual(["lock", "find:file_a", "backup", "replace", "write", "event:changed", "unlock"]);
  });

  it("does not notify when the ledger write fails and still leaves the transaction", async () => {
    const h = harness();
    h.write.mockRejectedValueOnce(new Error("ledger write failed"));
    await expect(h.reconciler.reconcile(h.file.fileId, h.onChange)).rejects.toThrow("ledger write failed");
    expect(h.persisted.get(h.file.fileId)).toEqual(h.file);
    expect(h.events).toEqual([]);
    expect(h.order).toEqual(["lock", "find:file_a", "read", "replace", "unlock"]);
  });

  it("scans a single file list in order with separate ledger transactions and waits for each write", async () => {
    const h = harness();
    h.rows.set("file_b", { ...h.file, fileId: "file_b", documentPath: "documents/file_b.sigmadoc.json" });
    const enteredWrite = deferred();
    const releaseWrite = deferred();
    h.write.mockImplementationOnce(async () => { h.order.push("write-pending"); enteredWrite.resolve(); await releaseWrite.promise; });
    const scanning = h.reconciler.reconcileAll(h.onChange);
    await enteredWrite.promise;
    expect(h.ports.withLedger).toHaveBeenCalledOnce();
    expect(h.events).toEqual([]);
    releaseWrite.resolve();
    await scanning;
    expect(h.ports.listVisibleFileIds).toHaveBeenCalledOnce();
    expect(h.ports.withLedger).toHaveBeenCalledTimes(2);
    expect(h.order).toEqual([
      "list", "lock", "find:file_a", "read", "replace", "write-pending", "event:changed", "unlock",
      "lock", "find:file_b", "read", "replace", "write", "event:changed", "unlock",
    ]);
    expect(h.events.map((event) => "fileId" in event ? event.fileId : null)).toEqual(["file_a", "file_b"]);
  });
});

describe("local store reconciliation dependencies", () => {
  it("keeps reconciliation and owned-write state independent of filesystem IO, watchers and the store controller", () => {
    const runtimeImports = (file: string) => getSourceDependencies(
      readFileSync(new URL(file, import.meta.url), "utf8"),
    ).filter((entry) => !entry.typeOnly).map(({ specifier }) => specifier);
    expect(runtimeImports("./local-document-reconciler.ts")).toEqual([
      "@/features/document", "@/lib/document-title", "@/lib/sigma-doc-schema",
    ]);
    expect(runtimeImports("./local-store-write-identity.ts")).toEqual(["node:crypto"]);
    expect(runtimeImports("./local-store-change-events.ts")).toEqual([]);
  });
});
