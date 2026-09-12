import { expect, test, type Page } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import type { ParagraphNode, ProblemNode, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

test("pastes a copied problem before or after the right-clicked problem", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    problem("problem_source", "コピー元の問題"),
    problem("problem_target", "貼り付け基準の問題"),
  ]));

  await page.goto("/");

  await openProblemContextMenu(page, "problem_source");
  const sourceMenu = page.getByRole("menu", { name: "問題操作" });
  await expect(sourceMenu).toBeVisible();
  await expect(sourceMenu.getByRole("menuitem", { name: "問題を前に貼り付け" })).toHaveCount(0);
  await expect(sourceMenu.getByRole("menuitem", { name: "問題を後に貼り付け" })).toHaveCount(0);
  await sourceMenu.getByRole("menuitem", { name: "問題をコピー" }).click();

  await openProblemContextMenu(page, "problem_target");
  const targetMenu = page.getByRole("menu", { name: "問題操作" });
  await expect(targetMenu).toBeVisible();
  await targetMenu.getByRole("menuitem", { name: "問題を前に貼り付け" }).click();

  await openProblemContextMenu(page, "problem_target");
  const reopenedTargetMenu = page.getByRole("menu", { name: "問題操作" });
  await expect(reopenedTargetMenu).toBeVisible();
  await reopenedTargetMenu.getByRole("menuitem", { name: "問題を後に貼り付け" }).click();

  await expect(page.locator('[data-problem-id][data-problem-area="prompt"]')).toHaveCount(4);
  await expect.poll(async () => (await topLevelProblemSummary(page)).length).toBe(4);
  const summary = await topLevelProblemSummary(page);
  expect(summary).toHaveLength(4);
  expect(summary[0]).toMatchObject({ id: "problem_source", promptText: "コピー元の問題" });
  expect(summary[1]?.id).not.toBe("problem_source");
  expect(summary[1]).toMatchObject({ promptText: "コピー元の問題" });
  expect(summary[1]?.promptBlockIds).not.toContain("problem_source_prompt");
  expect(summary[2]).toMatchObject({ id: "problem_target", promptText: "貼り付け基準の問題" });
  expect(summary[3]?.id).not.toBe("problem_source");
  expect(summary[3]?.id).not.toBe(summary[1]?.id);
  expect(summary[3]).toMatchObject({ promptText: "コピー元の問題" });
  expect(summary[3]?.promptBlockIds).not.toContain("problem_source_prompt");
});

test("shows the 改ページを挿入 item when right-clicking a paragraph in the 問題文 (prompt) area", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    problem("problem_1", "問題文の段落"),
  ]));

  await page.goto("/");

  await openProblemContextMenu(page, "problem_1");
  const menu = page.getByRole("menu", { name: "問題操作" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "ここを段組にする", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "段組を変更", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "改ページを挿入" })).toBeVisible();
  // Problem-level actions must still be reachable from the same menu — inserting the
  // break capability must not push out the pre-existing 問題操作 items (issue #315 Phase 2).
  await expect(menu.getByRole("menuitem", { name: "問題をコピー" })).toBeVisible();
});

test("does not offer column selection actions from selected text in the 問題文", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    problem("problem_1", "問題文の選択範囲"),
  ]));

  await page.goto("/");
  const prompt = page.locator('[data-problem-id="problem_1"][data-problem-area="prompt"] [data-sigma-doc-id="problem_1_prompt"]');
  await expect(prompt).toBeVisible();
  await prompt.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await prompt.dispatchEvent("contextmenu", { clientX: 160, clientY: 160 });

  const menu = page.getByRole("menu", { name: "問題操作" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /段組/u })).toHaveCount(0);
});

async function openProblemContextMenu(page: Page, problemId: string): Promise<void> {
  const promptArea = page.locator(`[data-problem-id="${problemId}"][data-problem-area="prompt"]`).first();
  await expect(promptArea).toBeVisible();
  await promptArea.click({ button: "right" });
}

async function topLevelProblemSummary(page: Page): Promise<Array<{
  id: string;
  promptText: string;
  promptBlockIds: string[];
}>> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return [];
    }

    const document = JSON.parse(raw) as SigmaDocument;
    return document.content
      .filter((block): block is ProblemNode => block.type === "problem")
      .map((block) => ({
        id: block.id,
        promptText: block.prompt.map((promptBlock) =>
          promptBlock.type === "paragraph" || promptBlock.type === "heading"
            ? promptBlock.children.map((child) => child.type === "text" ? child.text : "").join("")
            : "",
        ).join("\n"),
        promptBlockIds: block.prompt.map((promptBlock) => promptBlock.id),
      }));
  });
}

function problem(id: string, promptText: string): ProblemNode {
  return {
    id,
    type: "problem",
    tags: [],
    lead: [],
    prompt: [paragraph(`${id}_prompt`, promptText)],
    solution: [],
    hints: [],
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
    docId: "problem_context_menu_e2e_doc",
    metadata: { title: "問題右クリック E2E" },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}
