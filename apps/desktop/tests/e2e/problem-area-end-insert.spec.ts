import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 問題の領域 (導入文→問題文→コメント→解答) の末尾にも、箱の下と同じ ＋ を出す (Issue #203)。
 *
 * コメントの最後が箱だと、キャレットで箱の後ろへ出る道が無い (trailingNode を切ってある)。
 * 以前は問題の外の前後にしか ＋ が無く、コメントの末尾に足す操作が無かった。
 */

interface SavedProblem {
  id: string;
  type: string;
  prompt?: SavedBlock[];
  hints?: SavedBlock[];
  solution?: SavedBlock[];
}

interface SavedBlock {
  id: string;
  type: string;
  children?: Array<{ text?: string }>;
}

function createDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_problem_area_end_insert";
  document.metadata = { ...document.metadata, title: "問題の領域の末尾に追加 E2E" };
  document.content = [
    { type: "paragraph", id: "p_before", children: [{ type: "text", text: "問題の前の段落です。" }] },
    {
      type: "problem",
      id: "prob_1",
      tags: [],
      lead: [],
      prompt: [{ type: "paragraph", id: "prob_prompt", children: [{ type: "text", text: "問題文です。" }] }],
      hints: [
        { type: "paragraph", id: "prob_hint", children: [{ type: "text", text: "コメントです。" }] },
        {
          type: "boxBlock",
          id: "box_hint",
          styleId: "fancybox",
          title: [{ type: "text", text: "ポイント" }],
          blocks: [{ type: "paragraph", id: "p_in_box", children: [{ type: "text", text: "コメントの最後の箱です。" }] }],
        },
      ],
      solution: [{ type: "paragraph", id: "prob_solution", children: [{ type: "text", text: "解答です。" }] }],
    },
    { type: "paragraph", id: "p_after", children: [{ type: "text", text: "問題の後の段落です。" }] },
  ] as SigmaDocument["content"];
  return document;
}

async function openEditor(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 1200 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 });
  await expect(page.locator('.page-flow [data-sigma-doc-id="box_hint"]').first()).toBeVisible();
}

async function savedContent(page: Page): Promise<SavedProblem[]> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("sigma-studio:e2e-document");
    return raw ? (JSON.parse(raw) as { content: SavedProblem[] }).content : [];
  });
}

async function savedProblem(page: Page): Promise<SavedProblem | undefined> {
  return (await savedContent(page)).find((block) => block.id === "prob_1");
}

/** 本文の中から下端へ寄る (人の動き)。ガターの操作は寄った位置のホバーで決まる。 */
async function approachBottom(page: Page, bottom: number, x: number, offset: number): Promise<void> {
  await page.mouse.move(x, bottom - 24);
  await page.waitForTimeout(80);
  await page.mouse.move(x, bottom + offset);
  await page.waitForTimeout(150);
}

test("the end of the comment offers the plus and adds a paragraph inside the comment", async ({ page }) => {
  test.setTimeout(60_000);
  await openEditor(page);

  const box = (await page.locator('.page-flow [data-sigma-doc-id="box_hint"]').first().boundingBox())!;
  await approachBottom(page, box.y + box.height, box.x + 60, -3);

  const plus = page.locator(".page-block-insert-button");
  await expect(plus).toHaveCount(1);
  // 線はコメントの末尾 (箱の下端) に引かれる。問題の下端ではない。
  const line = (await page.locator(".page-block-insert-line").boundingBox())!;
  expect(Math.abs(line.y - (box.y + box.height))).toBeLessThanOrEqual(3);
  await plus.click();

  await expect.poll(async () => (await savedProblem(page))?.hints?.map((block) => block.type))
    .toEqual(["paragraph", "boxBlock", "paragraph"]);
  // 問題の外には何も増えない。
  expect((await savedContent(page)).map((block) => block.id)).toEqual(["p_before", "prob_1", "p_after"]);

  // 押した直後のキャレットは足した段落にある。
  await page.keyboard.type("追記です");
  await expect.poll(async () => (await savedProblem(page))?.hints?.at(-1)?.children?.map((child) => child.text).join(""))
    .toBe("追記です");
  const problem = (await savedProblem(page))!;
  expect(problem.prompt?.map((block) => block.id)).toEqual(["prob_prompt"]);
  expect(problem.solution?.map((block) => block.id)).toEqual(["prob_solution"]);
  await expect(page.locator(`[data-problem-id="prob_1"][data-problem-area="hints"] [data-sigma-doc-id="${problem.hints!.at(-1)!.id}"]`))
    .toContainText("追記です");
});

test("pressing it again on an empty trailing paragraph does not stack another", async ({ page }) => {
  test.setTimeout(60_000);
  await openEditor(page);

  const box = (await page.locator('.page-flow [data-sigma-doc-id="box_hint"]').first().boundingBox())!;
  await approachBottom(page, box.y + box.height, box.x + 60, -3);
  await page.locator(".page-block-insert-button").click();
  await expect.poll(async () => (await savedProblem(page))?.hints?.length).toBe(3);

  const added = (await savedProblem(page))!.hints!.at(-1)!;
  const empty = (await page.locator(`.page-flow [data-sigma-doc-id="${added.id}"]`).first().boundingBox())!;
  await approachBottom(page, empty.y + empty.height, empty.x + 60, -2);
  await expect(page.locator(".page-block-insert-button")).toHaveCount(1);
  await page.locator(".page-block-insert-button").click();
  await page.waitForTimeout(300);
  expect((await savedProblem(page))?.hints?.length).toBe(3);
});

test("the end of the prompt adds inside the prompt", async ({ page }) => {
  test.setTimeout(60_000);
  await openEditor(page);

  const prompt = (await page.locator('.page-flow [data-sigma-doc-id="prob_prompt"]').first().boundingBox())!;
  await approachBottom(page, prompt.y + prompt.height, prompt.x + 60, -2);
  await expect(page.locator(".page-block-insert-button")).toHaveCount(1);
  await page.locator(".page-block-insert-button").click();

  await expect.poll(async () => (await savedProblem(page))?.prompt?.length).toBe(2);
  expect((await savedProblem(page))?.hints?.map((block) => block.id)).toEqual(["prob_hint", "box_hint"]);
  expect((await savedContent(page)).map((block) => block.id)).toEqual(["p_before", "prob_1", "p_after"]);
});

test("below the problem the plus still adds after the problem", async ({ page }) => {
  test.setTimeout(60_000);
  await openEditor(page);

  const areas = page.locator('[data-problem-id="prob_1"][data-problem-area]');
  const bottoms = await areas.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().bottom));
  const solution = (await page.locator('.page-flow [data-sigma-doc-id="prob_solution"]').first().boundingBox())!;
  const problemBottom = Math.max(...bottoms);
  await approachBottom(page, problemBottom, solution.x + 60, 3);

  await expect(page.locator(".page-block-insert-button")).toHaveCount(1);
  await page.locator(".page-block-insert-button").click();

  await expect.poll(async () => (await savedContent(page)).length).toBe(4);
  const content = await savedContent(page);
  expect(content[0].id).toBe("p_before");
  expect(content[1].id).toBe("prob_1");
  expect(content[2].type).toBe("paragraph");
  expect(content[3].id).toBe("p_after");
  expect(content[1].solution?.map((block) => block.id)).toEqual(["prob_solution"]);
});

test("the gap between two areas never draws the plus at the problem's far edge", async ({ page }) => {
  test.setTimeout(60_000);
  await openEditor(page);

  const prompt = page.locator('[data-problem-id="prob_1"][data-problem-area="prompt"]').first();
  const hints = page.locator('[data-problem-id="prob_1"][data-problem-area="hints"]').first();
  const promptBox = (await prompt.boundingBox())!;
  const hintsBox = (await hints.boundingBox())!;
  const gapY = (promptBox.y + promptBox.height + hintsBox.y) / 2;
  await page.mouse.move(promptBox.x + 80, gapY - 20);
  await page.waitForTimeout(80);
  await page.mouse.move(promptBox.x + 80, gapY);
  await page.waitForTimeout(150);

  const line = page.locator(".page-block-insert-line");
  if (await line.count() > 0) {
    const box = (await line.boundingBox())!;
    expect(Math.abs(box.y - gapY)).toBeLessThanOrEqual(12);
  }
});
