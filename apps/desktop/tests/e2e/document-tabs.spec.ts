import { expect, test } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await installDesktopRuntimeMock(page, sampleDocument);
  await page.addInitScript((initialDocument: SigmaDocument) => {
    const bridge = window.desktopAPI;
    if (!bridge?.storage) {
      return;
    }

    const workspaceId = "workspace_document_tabs_e2e";
    const initialFileId = "file_e2e_document";
    const documents = new Map<string, SigmaDocument>([
      [initialFileId, structuredClone(initialDocument)],
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
    bridge.storage.createDocument = async () => createDocumentRecord(initialDocument, "無題の教材");
    bridge.storage.createFileFromDocument = async ({ document }: { document: SigmaDocument }) => (
      createDocumentRecord(document, document.metadata.title || "無題の教材")
    );
    bridge.storage.duplicateFile = async (fileId: string) => {
      const source = documents.get(fileId) ?? initialDocument;
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
  }, sampleDocument);
});

test("creates, switches, closes, and reopens Chrome-like document tabs", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("教材タイトル")).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();

  await page.getByLabel("教材タイトル").fill("教材A");
  await page.getByRole("button", { name: "新規教材", exact: true }).click();
  await expect(page.locator(".document-tab")).toHaveCount(2);

  await page.getByLabel("教材タイトル").fill("教材B");
  await page.getByRole("tab", { name: /教材A/ }).click();
  await expect(page.getByLabel("教材タイトル")).toHaveValue("教材A");

  await page.getByRole("tab", { name: /教材B/ }).click();
  await expect(page.getByLabel("教材タイトル")).toHaveValue("教材B");

  await page.getByLabel("教材B のタブを閉じる").click();
  await expect(page.locator(".document-tab")).toHaveCount(1);
  await expect(page.getByLabel("教材タイトル")).toHaveValue("教材A");

  await page.getByRole("button", { name: "教材一覧" }).click();
  const libraryDialog = page.getByRole("dialog", { name: "教材一覧" });
  await expect(libraryDialog).toBeVisible();
  await expect(libraryDialog.getByRole("button", { name: "閉じる", exact: true })).toHaveCount(1);
  expect(await libraryDialog.evaluate((element) => element.parentElement?.parentElement === document.body)).toBe(true);
  const documentBRow = page.locator(".document-library-item").filter({ hasText: "教材B" });
  await expect(documentBRow).toBeVisible();
  await documentBRow.hover();
  await documentBRow.getByRole("button", { name: "削除" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "教材を削除" });
  await expect(deleteDialog).toBeVisible();
  await expect(page.locator('[role="dialog"][aria-modal="false"]')).toHaveCount(1);
  await deleteDialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(deleteDialog).toBeHidden();
  await documentBRow.getByRole("button", { name: /開く/ }).click();
  await expect(page.getByLabel("教材タイトル")).toHaveValue("教材B");

  for (let index = 0; index < 8; index += 1) {
    const expectedCount = index + 3;
    await page.getByRole("button", { name: "新規教材", exact: true }).click();
    await expect(page.locator(".document-tab")).toHaveCount(expectedCount);
  }

  const tabStripMetrics = await page.locator(".document-tabs-scroll").evaluate((element) => {
    const firstTab = element.querySelector<HTMLElement>(".document-tab");
    const stripBounds = element.getBoundingClientRect();
    const firstTabBounds = firstTab?.getBoundingClientRect();
    const actionBounds = document.querySelector<HTMLElement>(".document-tab-actions")?.getBoundingClientRect();
    const menubar = document.querySelector<HTMLElement>(".menubar-row");
    const menubarBounds = menubar?.getBoundingClientRect();
    const menubarPaddingRight = menubar ? Number.parseFloat(window.getComputedStyle(menubar).paddingRight) : 0;
    return {
      overflowX: window.getComputedStyle(element).overflowX,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      firstTabOffset: firstTabBounds ? firstTabBounds.left - stripBounds.left : Number.NaN,
      actionGap: actionBounds ? actionBounds.left - stripBounds.right : Number.NaN,
      actionRightOffset: actionBounds && menubarBounds
        ? menubarBounds.right - menubarPaddingRight - actionBounds.right
        : Number.NaN,
    };
  });
  expect(tabStripMetrics.overflowX).toBe("hidden");
  expect(tabStripMetrics.scrollWidth).toBeLessThanOrEqual(tabStripMetrics.clientWidth + 1);
  expect(Math.abs(tabStripMetrics.firstTabOffset)).toBeLessThanOrEqual(1);
  expect(tabStripMetrics.actionGap).toBeGreaterThanOrEqual(8);
  expect(Math.abs(tabStripMetrics.actionRightOffset)).toBeLessThanOrEqual(1);
});

test("renders $…$ in the material title as math on display surfaces", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("教材タイトル")).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();

  const titleInput = page.getByLabel("教材タイトル");
  await titleInput.fill("二次関数 $x^2$ の復習");
  await titleInput.blur();

  await expect(page.locator(".document-title-rich-overlay .math-preview-inline")).toBeVisible();
  await expect(page.locator(".document-tab-main .math-preview-inline").first()).toBeVisible();
  // 描画のために保存値を書き換えない
  await expect(titleInput).toHaveValue("二次関数 $x^2$ の復習");

  await titleInput.click();
  await expect(page.locator(".document-title-rich-overlay")).toHaveCount(0);

  // 「1 文字しか打てない」事故の回帰ガード
  await titleInput.press("End");
  await titleInput.pressSequentially("と応用");
  await expect(titleInput).toHaveValue("二次関数 $x^2$ の復習と応用");
});

test("leaves a title with a lone $ as plain text", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("教材タイトル")).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();

  const titleInput = page.getByLabel("教材タイトル");
  await titleInput.fill("価格は $100 です");
  await titleInput.blur();

  await expect(page.locator(".document-title-rich-overlay")).toHaveCount(0);
  await expect(page.locator(".document-tab-main span").first()).toHaveText("価格は $100 です");
});
