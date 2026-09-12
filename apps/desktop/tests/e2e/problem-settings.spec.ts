import { expect, test } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import type { SigmaDocument } from "@/types/sigma-doc";

test("does not render a detail sidebar and opens problem settings from the hover action", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument());

  await page.goto("/");
  const detailSidebar = page.locator('[aria-label="詳細"]');
  const paragraph = page.locator('[data-sigma-doc-id="body_1"]');
  const heading = page.locator('[data-sigma-doc-id="heading_1"]');
  const problemArea = page.locator('[data-problem-id="problem_1"][data-problem-area="prompt"]');

  await expect(paragraph).toBeVisible();
  await expect(detailSidebar).toHaveCount(0);

  await paragraph.click();
  await expect(detailSidebar).toHaveCount(0);

  await heading.click();
  await expect(detailSidebar).toHaveCount(0);

  await problemArea.click();
  await expect(detailSidebar).toHaveCount(0);
  await problemArea.hover();
  const problemAction = problemArea.getByRole("button", { name: "問題操作" });
  await expect(problemAction).toBeVisible();
  await problemAction.click();
  const problemMenu = page.getByRole("menu", { name: "問題操作" });
  await expect(problemMenu).toBeVisible();
  await problemMenu.getByRole("menuitem", { name: "問題の設定…" }).click();
  await expect(page.getByRole("dialog", { name: "問題設定" })).toBeVisible();

  await page.locator(".editor-canvas").dispatchEvent("click");
  await expect(detailSidebar).toHaveCount(0);
});

function createDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "problem_settings_e2e_doc",
    metadata: { title: "問題設定 E2E" },
    content: [
      {
        type: "paragraph",
        id: "body_1",
        children: [{ type: "text", text: "通常の本文" }],
      },
      {
        type: "heading",
        id: "heading_1",
        level: 2,
        children: [{ type: "text", text: "見出し" }],
      },
      {
        type: "problem",
        id: "problem_1",
        tags: [],
        lead: [],
        prompt: [{
          type: "paragraph",
          id: "problem_prompt_1",
          children: [{ type: "text", text: "問題文" }],
        }],
        solution: [],
        hints: [],
      },
    ],
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}
