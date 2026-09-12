import { expect, test, type Page } from "@playwright/test";

import type { SigmaDocument, SigmaBlock, RichBlock } from "@/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => window.localStorage.clear());
});

test("focuses inserted problem prompt when clicked after the follow-up body block", async ({ page }) => {
  await page.goto(process.env.SIGMA_STUDIO_E2E_BASE_URL ?? "/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await insertProblem(page);
  const ids = await getLastInsertedProblemIds(page);

  await clickBlock(page, ids.promptBlockId);
  await page.keyboard.type("PROMPT_FOCUS_MARK");

  await expect.poll(() => textOfBlock(page, ids.promptBlockId)).toContain("PROMPT_FOCUS_MARK");
  await expect.poll(() => textOfBlock(page, ids.trailingBodyBlockId)).not.toContain("PROMPT_FOCUS_MARK");
});

test("focuses inserted problem solution when clicked after the follow-up body block", async ({ page }) => {
  await page.goto(process.env.SIGMA_STUDIO_E2E_BASE_URL ?? "/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await insertProblem(page);
  const ids = await getLastInsertedProblemIds(page);

  await clickBlock(page, ids.solutionBlockId);
  await page.keyboard.type("SOLUTION_FOCUS_MARK");

  await expect.poll(() => textOfBlock(page, ids.solutionBlockId)).toContain("SOLUTION_FOCUS_MARK");
  await expect.poll(() => textOfBlock(page, ids.trailingBodyBlockId)).not.toContain("SOLUTION_FOCUS_MARK");
});

test("focuses an empty problem comment area when clicked after body focus", async ({ page }) => {
  await installDesktopRuntimeMock(page, createCommentFocusDocument());
  await page.goto(process.env.SIGMA_STUDIO_E2E_BASE_URL ?? "/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await focusBlockEnd(page, "body_after_problem");
  await expect.poll(() => selectedBlockId(page)).toBe("body_after_problem");

  await clickBlock(page, "comment_focus");
  await expect.poll(() => selectedBlockId(page)).toBe("comment_focus");
  await page.keyboard.type("COMMENT_FOCUS_MARK");

  await expect.poll(() => textOfBlock(page, "comment_focus")).toContain("COMMENT_FOCUS_MARK");
  await expect.poll(() => textOfBlock(page, "body_after_problem")).not.toContain("COMMENT_FOCUS_MARK");
});

for (const blockId of ["body_after_problem", "prompt_focus", "comment_focus", "solution_focus"]) {
  test(`Japanese composition and arrow navigation in ${blockId}`, async ({ page }) => {
    await installDesktopRuntimeMock(page, createCommentFocusDocument());
    await page.goto(process.env.SIGMA_STUDIO_E2E_BASE_URL ?? "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("準備完了")).toBeVisible();
    await clickBlock(page, blockId);
    await focusBlockEnd(page, blockId);
    const before = await textOfBlock(page, blockId);
    const client = await page.context().newCDPSession(page);
    for (const text of ["n", "の", "にほん", "日本"]) {
      await client.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
      await expect.poll(() => textOfBlock(page, blockId)).toBe(before + text);
      await page.waitForTimeout(100);
    }
    await client.send("Input.insertText", { text: "日本" });
    await expect.poll(() => textOfBlock(page, blockId)).toBe(before + "日本");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.insertText("語");
    await expect.poll(() => textOfBlock(page, blockId)).toBe(before + "日語本");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("sigma-studio:e2e-document"))).toContain("日語本");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.insertText("後");
    await expect.poll(() => textOfBlock(page, blockId)).toBe(before + "日語本後");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("sigma-studio:e2e-document"))).toContain("日語本後");
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!) as SigmaDocument);
    const reopened = await page.context().newPage();
    await installDesktopRuntimeMock(reopened, saved);
    await reopened.goto(process.env.SIGMA_STUDIO_E2E_BASE_URL ?? "/", { waitUntil: "domcontentloaded" });
    await expect.poll(() => textOfBlock(reopened, blockId)).toBe(before + "日語本後");
    await reopened.close();
    await client.detach();
  });
}

test("arrow keys move through existing body text beside the paragraph mark", async ({ page }) => {
  await installDesktopRuntimeMock(page, createCommentFocusDocument());
  await page.goto(process.env.SIGMA_STUDIO_E2E_BASE_URL ?? "/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();
  await clickBlock(page, "body_after_problem");
  await focusBlockEnd(page, "body_after_problem");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.insertText("左");
  await expect.poll(() => textOfBlock(page, "body_after_problem")).toBe("本文を編左集");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.insertText("右");
  await expect.poll(() => textOfBlock(page, "body_after_problem")).toBe("本文を編左集右");
});

async function insertProblem(page: Page) {
  await page.getByRole("button", { name: "挿入", exact: true }).click();
  await page.getByRole("menuitem", { name: "問題", exact: true }).click();
}

async function getLastInsertedProblemIds(page: Page): Promise<{
  promptBlockId: string;
  solutionBlockId: string;
  trailingBodyBlockId: string;
}> {
  return page.evaluate(() => {
    const areas = Array.from(document.querySelectorAll<HTMLElement>("[data-problem-area][data-problem-id]"));
    const groups = new Map<string, { y: number; prompt?: HTMLElement; solution?: HTMLElement }>();
    for (const area of areas) {
      const problemId = area.getAttribute("data-problem-id");
      const kind = area.getAttribute("data-problem-area");
      if (!problemId) {
        continue;
      }
      const group = groups.get(problemId) ?? { y: Number.NEGATIVE_INFINITY };
      group.y = Math.max(group.y, area.getBoundingClientRect().y);
      if (kind === "prompt") {
        group.prompt = area;
      } else if (kind === "solution") {
        group.solution = area;
      }
      groups.set(problemId, group);
    }

    const inserted = [...groups.values()]
      .filter((group) =>
        group.prompt?.textContent?.includes("問題文を入力") &&
        group.solution?.textContent?.includes("解答を入力")
      )
      .sort((a, b) => a.y - b.y)
      .at(-1);
    if (!inserted?.prompt || !inserted.solution) {
      throw new Error("Inserted problem was not found");
    }

    const promptBlockId = firstTextBlockId(inserted.prompt);
    const solutionBlockId = firstTextBlockId(inserted.solution);
    const bodyBlock = Array.from(document.querySelectorAll<HTMLElement>(".page-flow [data-sigma-doc-id]"))
      .findLast((element) => !element.closest("[data-problem-area]"));
    const trailingBodyBlockId = bodyBlock?.getAttribute("data-sigma-doc-id");
    if (!promptBlockId || !solutionBlockId || !trailingBodyBlockId) {
      throw new Error("Inserted problem block ids were not found");
    }

    return { promptBlockId, solutionBlockId, trailingBodyBlockId };

    function firstTextBlockId(root: HTMLElement): string | null {
      return root.querySelector<HTMLElement>("[data-sigma-doc-id]")?.getAttribute("data-sigma-doc-id") ?? null;
    }
  });
}

async function clickBlock(page: Page, blockId: string) {
  const block = page.locator(`[data-sigma-doc-id="${blockId}"]`);
  await expect(block).toHaveCount(1);
  await block.scrollIntoViewIfNeeded();

  const box = await block.boundingBox();
  expect(box).not.toBeNull();
  await block.click({
    position: {
      x: Math.max(1, Math.min(12, box!.width / 2)),
      y: Math.max(1, Math.min(box!.height / 2, box!.height - 1)),
    },
  });
}

async function focusBlockEnd(page: Page, blockId: string) {
  const block = page.locator(`[data-sigma-doc-id="${blockId}"]`);
  await expect(block).toHaveCount(1);
  await block.scrollIntoViewIfNeeded();

  await page.evaluate((targetBlockId) => {
    const blockElement = document.querySelector<HTMLElement>(`[data-sigma-doc-id="${targetBlockId}"]`);
    const editorElement = blockElement?.closest<HTMLElement>(".text-flow-editor");
    const selection = window.getSelection();
    if (!blockElement || !editorElement || !selection) {
      throw new Error(`Block ${targetBlockId} cannot be focused`);
    }

    editorElement.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(blockElement);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }, blockId);
}

async function textOfBlock(page: Page, blockId: string): Promise<string> {
  return page.evaluate((targetBlockId) => {
    const block = document.querySelector(`[data-sigma-doc-id="${targetBlockId}"]`);
    return block?.textContent ?? "";
  }, blockId);
}

async function selectedBlockId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const anchorParent = selection?.anchorNode
      ? selection.anchorNode.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode as Element
        : selection.anchorNode.parentElement
      : null;
    return anchorParent?.closest("[data-sigma-doc-id]")?.getAttribute("data-sigma-doc-id") ?? null;
  });
}

function createCommentFocusDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_problem_area_focus",
    metadata: { title: "問題エリアフォーカス E2E" },
    content: [
      {
        type: "problem",
        id: "problem_focus",
        tags: [],
        lead: [],
        prompt: [paragraph("prompt_focus", "問題文を入力")],
        hints: [paragraph("comment_focus", "")],
        solution: [paragraph("solution_focus", "解答を入力")],
        answer: { type: "math", expected: "" },
      },
      paragraph("body_after_problem", "本文を編集"),
    ],
    outputProfiles: {
      student: { showSolutions: false, showHints: false, includeAnswers: false },
      teacher: { showSolutions: true, showHints: true, includeAnswers: true, includeComments: true },
      answerBook: { showSolutions: true, showHints: false, includeAnswers: true, onlySolutions: true },
    },
  };
}

function paragraph(id: string, text: string): Extract<SigmaBlock | RichBlock, { type: "paragraph" }> {
  return {
    type: "paragraph",
    id,
    children: text ? [{ type: "text", text }] : [],
  };
}
