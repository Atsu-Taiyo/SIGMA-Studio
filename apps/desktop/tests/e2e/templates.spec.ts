import { expect, test } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
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

  // Hovering the new-document (＋) button reveals the "add from template" menu.
  await page.getByRole("button", { name: "新規教材" }).hover();
  await page.getByRole("menuitem", { name: "テンプレートから追加" }).click();

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
