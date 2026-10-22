import { expect, test, type Page } from "@playwright/test";

import { createBlankDocument } from "@/lib/blank-document";
import { customPageSetupDocument } from "../helpers/template-fixtures";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { installDocumentTabMock } from "./document-tab-mock";
import type { SigmaBlock, SigmaDocument, ParagraphNode } from "@/types/sigma-doc";
import type { TemplateItem } from "@/types/template";

test("inserts a workspace template from the gallery into the current document", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("intro_p", "前の本文"),
  ]), {
    templates: [createTemplate()],
  });

  await page.goto("/");

  // Hovering the new-document (＋) button reveals the "insert template" menu item.
  await page.getByRole("button", { name: "新規教材" }).hover();
  await page.getByRole("menuitem", { name: "テンプレートを挿入" }).click();

  const dialog = page.locator(".template-gallery-dialog");
  await expect(dialog).toBeVisible();

  // The participating workspace appears as a tab.
  await expect(dialog.getByRole("tab", { name: "E2E" })).toBeVisible();

  // The template card is shown with its name and is clickable.
  const card = dialog.locator(".template-gallery-card", { hasText: "二段組プリント" });
  await expect(card).toBeVisible();
  await card.locator(".template-gallery-card-apply").click();

  // The template's content is merged into the open document.
  await expect(dialog).toBeHidden();
  await expect(page.locator(".text-flow-editor").filter({ hasText: "テンプレ本文" })).toBeVisible();
  await expect.poll(async () => {
    const serialized = await page.evaluate(() => window.localStorage.getItem("sigma-studio:e2e-document") ?? "");
    return serialized.includes("テンプレ本文");
  }).toBe(true);
});

const B5_LANDSCAPE = {
  preset: "B5",
  orientation: "landscape",
  pageSize: { widthMm: 257, heightMm: 182 },
  marginsMm: { top: 16, right: 10, bottom: 15, left: 10 },
  flow: { type: "columns", columnCount: 2, columnGapMm: 6 },
  header: { enabled: true, blocks: [{ children: [{ text: "○○高校 数学科" }] }] },
};

async function storedFiles(page: Page) {
  return page.evaluate(async () => {
    const files = await window.desktopAPI!.storage.listFiles();
    return Promise.all(files.map(async (file) => ({ fileId: file.fileId, document: await window.desktopAPI!.storage.loadDocument(file.fileId) })));
  });
}

async function closeCreatedNotice(page: Page) {
  await page.getByRole("dialog", { name: /を作成しました$/ }).getByRole("button", { name: "閉じる" }).click();
}

test("テンプレートから新規 creates a new file with the template's page setup and leaves the open document alone", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  // The open material is a plain A4 one; the saved template is B5 landscape with its own margins, header and a shape.
  const open = createBlankDocument("開いている教材");
  open.content = [paragraph("open_p", "前の本文")];
  const template = { ...createTemplate(), name: "B5横プリント", document: customPageSetupDocument() };
  await installDocumentTabMock(page, open, createBlankDocument(), { templates: [template] });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  const before = await storedFiles(page);
  expect(before).toHaveLength(1);

  await page.getByRole("button", { name: "新規教材", exact: true }).hover();
  await page.getByRole("menuitem", { name: "テンプレートから新規" }).click();
  const dialog = page.locator(".template-gallery-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator(".template-gallery-card", { hasText: "B5横プリント" }).locator(".template-gallery-card-apply").click();
  await expect(dialog).toBeHidden();
  await closeCreatedNotice(page);

  // A new tab opened on a new file, not an insertion into the open one.
  await expect(page.locator(".document-tab")).toHaveCount(2);
  await expect(page.getByLabel("教材タイトル")).toHaveValue("B5横プリント");
  await expect(page.locator(".text-flow-editor").filter({ hasText: "テンプレの本文" }).first()).toBeVisible();
  await expect(page.locator(".page-running-region").filter({ hasText: "○○高校 数学科" }).first()).toBeVisible();
  await expect.poll(async () => (await storedFiles(page)).length).toBe(2);
  const after = await storedFiles(page);
  const created = after.find((file) => !before.some((item) => item.fileId === file.fileId))!;
  expect(created.document).toMatchObject({ metadata: { title: "B5横プリント" }, pageLayout: B5_LANDSCAPE });
  expect(created.document?.pageLayout?.overlay?.overlaySnapshot?.shapes).toHaveLength(1);
  expect(created.document?.docId).not.toBe(template.document.docId);

  // The page setup dialog of the new tab shows the template's margins.
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("menuitem", { name: /ページ設定/ }).first().click();
  const pageSettings = page.getByRole("dialog", { name: "ページ設定" });
  await expect(pageSettings).toContainText("B5");
  await expect(pageSettings.locator("#margin-top")).toHaveValue("16");
  await expect(pageSettings.locator("#margin-left")).toHaveValue("10");
  await pageSettings.getByRole("button", { name: "キャンセル" }).click();

  // The material that was open is untouched: same page setup, same body, no template content.
  const original = after.find((file) => file.fileId === before[0].fileId)!;
  expect(original.document?.pageLayout).toEqual(before[0].document?.pageLayout);
  expect(original.document?.content).toEqual(before[0].document?.content);
  await page.getByRole("tab", { name: "開いている教材", exact: true }).click();
  await expect(page.getByLabel("教材タイトル")).toHaveValue("開いている教材");
  await expect(page.locator(".text-flow-editor").filter({ hasText: "前の本文" }).first()).toBeVisible();
  await expect(page.locator(".text-flow-editor").filter({ hasText: "テンプレの本文" })).toHaveCount(0);
});

test("a template saved from the open B5 material comes back with its page setup through テンプレートから新規", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const open = customPageSetupDocument();
  await installDocumentTabMock(page, open, createBlankDocument(), { templates: [] });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  const before = await storedFiles(page);

  await page.getByRole("button", { name: "新規教材", exact: true }).hover();
  await page.getByRole("menuitem", { name: "テンプレートから新規" }).click();
  const dialog = page.locator(".template-gallery-dialog");
  // The gallery that creates a new material still offers "save the open material as a template".
  await dialog.getByRole("button", { name: "現在の文書を保存" }).click();
  const card = dialog.locator(".template-gallery-card", { hasText: "B5横の教材" });
  await expect(card).toBeVisible();
  await card.locator(".template-gallery-card-apply").click();
  await expect(dialog).toBeHidden();
  await closeCreatedNotice(page);

  await expect(page.locator(".document-tab")).toHaveCount(2);
  await expect.poll(async () => (await storedFiles(page)).length).toBe(2);
  const after = await storedFiles(page);
  const created = after.find((file) => !before.some((item) => item.fileId === file.fileId))!;
  expect(created.document?.pageLayout).toMatchObject(B5_LANDSCAPE);
  expect(created.document?.content).toEqual(open.content);
  const original = after.find((file) => file.fileId === before[0].fileId)!;
  expect(original.document?.pageLayout).toEqual(before[0].document?.pageLayout);
  expect(original.document?.content).toEqual(before[0].document?.content);
});

test("テンプレートを挿入 keeps the open material's page setup and adds the template's body to it", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const open = createBlankDocument("開いている教材");
  open.content = [paragraph("open_p", "前の本文")];
  const template = { ...createTemplate(), name: "B5横プリント", document: customPageSetupDocument() };
  await installDocumentTabMock(page, open, createBlankDocument(), { templates: [template] });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  const before = await storedFiles(page);

  await page.getByRole("button", { name: "新規教材", exact: true }).hover();
  await page.getByRole("menuitem", { name: "テンプレートを挿入" }).click();
  const dialog = page.locator(".template-gallery-dialog");
  await dialog.locator(".template-gallery-card", { hasText: "B5横プリント" }).locator(".template-gallery-card-apply").click();
  await expect(dialog).toBeHidden();

  await expect(page.locator(".document-tab")).toHaveCount(1);
  await expect(page.locator(".text-flow-editor").filter({ hasText: "テンプレの本文" }).first()).toBeVisible();
  expect((await storedFiles(page))).toHaveLength(1);
  expect(before[0].document?.pageLayout).toMatchObject({ preset: "A4", orientation: "portrait" });
});

function createTemplate(): TemplateItem {
  return {
    version: 1,
    id: "template_two_column",
    workspaceId: "workspace_e2e",
    name: "二段組プリント",
    document: createDocument([paragraph("template_p", "テンプレ本文")]),
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

function paragraph(id: string, text: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    children: text ? [{ type: "text", text }] : [],
  };
}

function createDocument(content: SigmaBlock[]): SigmaDocument {
  return {
    version: "2.0",
    docId: "templates_e2e_doc",
    metadata: { title: "テンプレE2E" },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}
