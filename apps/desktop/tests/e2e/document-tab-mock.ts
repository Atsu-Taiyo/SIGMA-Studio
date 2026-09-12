import type { Page } from "@playwright/test";

import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * In-memory workspace storage so a test can open several material tabs.
 *
 * Material tabs are React state inside one renderer, not separate windows, so this mock is enough
 * to exercise everything that crosses a tab boundary (`document-tabs.spec.ts` for the tab strip
 * itself, `cross-tab-shape-paste.spec.ts` for the clipboard).
 */
export async function installDocumentTabMock(
  page: Page,
  initialDocument: SigmaDocument,
  /**
   * What「新規教材」creates. Defaults to a copy of the initial document (the behaviour
   * `document-tabs.spec.ts` was written against); pass a blank one when the test needs the new
   * tab to start with nothing on it.
   */
  newDocument: SigmaDocument = initialDocument,
): Promise<void> {
  await installDesktopRuntimeMock(page, initialDocument);
  await page.addInitScript(({ seedDocument, blankDocument }: { seedDocument: SigmaDocument; blankDocument: SigmaDocument }) => {
    const bridge = window.desktopAPI;
    if (!bridge?.storage) {
      return;
    }

    const workspaceId = "workspace_document_tabs_e2e";
    const initialFileId = "file_e2e_document";
    const documents = new Map<string, SigmaDocument>([
      [initialFileId, structuredClone(seedDocument)],
    ]);
    const revisions = new Map<string, number>([[initialFileId, 1]]);
    let nextFileNumber = 1;
    let workspaceState = { openFileIds: [initialFileId], activeFileId: initialFileId };

    const metadata = (fileId: string, document: SigmaDocument) => {
      const updatedAt = document.updatedAt ?? new Date().toISOString();
      return {
        fileId,
        workspaceId,
        folderId: null,
        kind: "personal" as const,
        docId: document.docId,
        title: document.metadata.title,
        documentPath: `/tmp/${fileId}.sigmadoc.json`,
        revision: revisions.get(fileId) ?? 1,
        createdAt: updatedAt,
        updatedAt,
      };
    };
    const createDocumentRecord = (source: SigmaDocument, title: string) => {
      const sequence = nextFileNumber;
      nextFileNumber += 1;
      const fileId = `file_document_tabs_${sequence}`;
      const now = new Date().toISOString();
      const document = structuredClone(source);
      document.docId = `doc_document_tabs_${sequence}`;
      document.metadata = { ...document.metadata, title };
      document.updatedAt = now;
      documents.set(fileId, document);
      revisions.set(fileId, 1);
      return { file: metadata(fileId, document), document: structuredClone(document) };
    };

    bridge.storage.initializeWorkspace = async () => ({
      ok: true,
      state: structuredClone(workspaceState),
    });
    bridge.storage.listFiles = async () => (
      Array.from(documents, ([fileId, document]) => metadata(fileId, document))
    );
    bridge.storage.loadDocument = async (fileId: string) => (
      documents.has(fileId) ? structuredClone(documents.get(fileId) ?? null) : null
    );
    bridge.storage.loadDocumentWithRecovery = async (fileId: string) => {
      const document = documents.get(fileId);
      const revision = revisions.get(fileId);
      if (!document || revision === undefined) {
        return {
          ok: false as const,
          error: "教材を読み込めませんでした。",
          failureKind: "missing" as const,
        };
      }
      return {
        ok: true as const,
        document: structuredClone(document),
        revision,
        recoveryIssues: [],
      };
    };
    bridge.storage.saveDocument = async (
      fileId: string,
      document: SigmaDocument,
      options: { expectedRevision: number },
    ) => {
      const currentRevision = revisions.get(fileId);
      if (currentRevision === undefined) {
        return { ok: false, error: "教材が見つかりません。" };
      }
      if (options.expectedRevision !== currentRevision) {
        return {
          ok: false,
          code: "revision-mismatch" as const,
          currentRevision,
          error: "他の変更が先に保存されています。",
        };
      }
      documents.set(fileId, structuredClone(document));
      const revision = currentRevision + 1;
      revisions.set(fileId, revision);
      return { ok: true, revision };
    };
    bridge.storage.createDocument = async () => createDocumentRecord(blankDocument, "無題の教材");
    bridge.storage.createFileFromDocument = async ({ document }: { document: SigmaDocument }) => (
      createDocumentRecord(document, document.metadata.title || "無題の教材")
    );
    bridge.storage.duplicateFile = async (fileId: string) => {
      const source = documents.get(fileId) ?? seedDocument;
      return createDocumentRecord(source, `${source.metadata.title || "無題の教材"} のコピー`);
    };
    bridge.storage.deleteFile = async (fileId: string) => {
      documents.delete(fileId);
      revisions.delete(fileId);
      return { ok: true };
    };
    bridge.storage.saveWorkspace = async (state) => {
      workspaceState = structuredClone(state);
      return { ok: true };
    };
  }, { seedDocument: initialDocument, blankDocument: newDocument });
}
