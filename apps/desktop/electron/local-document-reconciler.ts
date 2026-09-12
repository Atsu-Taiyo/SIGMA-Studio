import { ensurePageLayout } from "@/features/document";
import { resolveDocumentTitle } from "@/lib/document-title";
import type { LibraryFileRow } from "@/lib/library-ledger";
import { recoverSigmaDocument } from "@/lib/sigma-doc-schema";

import type { LocalStoreChangeEvent } from "./local-store-change-events";
import type { LocalStoreWriteIdentity } from "./local-store-write-identity";

/** The store retains ledger locking, visibility rules and durable write ordering. */
export interface DocumentReconciliationLedger {
  findVisibleFile(fileId: string): LibraryFileRow | null;
  replaceFile(file: LibraryFileRow): void;
  write(): Promise<void>;
}

export interface LocalDocumentReconcilerPorts {
  withLedger(operation: (ledger: DocumentReconciliationLedger) => Promise<void>): Promise<void>;
  listVisibleFileIds(): Promise<string[]>;
  resolveDocumentPath(file: LibraryFileRow): string;
  readDocument(filePath: string): Promise<string>;
  writeRecoveryBackup(fileId: string, raw: string): Promise<string>;
  writeIdentity: Pick<LocalStoreWriteIdentity, "matchesStat" | "matchesSignature">;
  missingBodyGraceMs: number;
  log(
    event: "file-body-missing" | "file-soft-deleted-by-reconcile" | "file-body-unreadable-by-reconcile",
    details: Record<string, unknown>,
  ): void;
}

/** Reconciles externally observed document bytes; filesystem scheduling stays outside. */
export class LocalDocumentReconciler {
  constructor(private readonly ports: LocalDocumentReconcilerPorts) {}

  async reconcileAll(onChange: (event: LocalStoreChangeEvent) => void): Promise<void> {
    // Give each file its own ledger transaction. Holding one transaction across
    // every body read would starve other writers in a large document library.
    const fileIds = await this.ports.listVisibleFileIds();
    for (const fileId of fileIds) {
      await this.reconcile(fileId, onChange);
    }
  }

  async reconcile(fileId: string, onChange: (event: LocalStoreChangeEvent) => void): Promise<void> {
    return this.ports.withLedger(async (ledger) => {
      const file = ledger.findVisibleFile(fileId);
      if (!file) {
        return;
      }
      const documentPath = this.ports.resolveDocumentPath(file);

      // 自分の書き込みなら、ここで本文を読まずに帰る (教材が大きいほど効く)。
      // 一致しなかった場合だけ従来どおり読んでハッシュで確かめる。
      if (await this.ports.writeIdentity.matchesStat(documentPath)) {
        return;
      }

      let raw: string | null = null;
      try {
        raw = await this.ports.readDocument(documentPath);
      } catch {
        // 行が本文より先に存在し得る作成直後の窓では、外部削除と誤診断しない。
        const createdAtMs = Date.parse(file.createdAt);
        const withinGracePeriod = Number.isFinite(createdAtMs) &&
          Date.now() - createdAtMs < this.ports.missingBodyGraceMs;
        if (withinGracePeriod) {
          this.ports.log("file-body-missing", { fileId, createdAt: file.createdAt });
          onChange({ type: "document", fileId, change: "changed", timestamp: Date.now() });
          return;
        }

        this.ports.log("file-soft-deleted-by-reconcile", { fileId, createdAt: file.createdAt });
        const now = new Date().toISOString();
        ledger.replaceFile({
          ...file,
          deletedAt: now,
          updatedAt: now,
        });
        await ledger.write();
        onChange({ type: "document", fileId, change: "deleted", timestamp: Date.now() });
        return;
      }

      if (this.ports.writeIdentity.matchesSignature(documentPath, raw)) {
        return;
      }

      // Unreadable external edits leave the ledger intact. The change event lets
      // the renderer load again and present the document-open failure itself.
      let input: unknown;
      try {
        input = JSON.parse(raw);
      } catch (error) {
        this.ports.log("file-body-unreadable-by-reconcile", {
          fileId,
          reason: error instanceof Error ? error.message : "JSON構文が壊れています",
        });
        onChange({ type: "document", fileId, change: "changed", timestamp: Date.now() });
        return;
      }
      const recovered = recoverSigmaDocument(input);
      if (!recovered.ok) {
        this.ports.log("file-body-unreadable-by-reconcile", { fileId, reason: recovered.error });
        onChange({ type: "document", fileId, change: "changed", timestamp: Date.now() });
        return;
      }
      if (recovered.issues.length > 0) {
        await this.ports.writeRecoveryBackup(fileId, raw);
      }
      const document = ensurePageLayout(recovered.document);
      const now = new Date().toISOString();
      ledger.replaceFile({
        ...file,
        docId: document.docId,
        title: resolveDocumentTitle(document),
        revision: Math.max(0, file.revision) + 1,
        updatedAt: document.updatedAt ?? now,
      });
      await ledger.write();
      onChange({ type: "document", fileId, change: "changed", timestamp: Date.now() });
    });
  }
}
