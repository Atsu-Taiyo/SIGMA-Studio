import { expect, test, type Locator, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

interface SavedBlock {
  id: string;
  type: string;
  tags?: string[];
  lead?: SavedBlock[];
  prompt?: SavedBlock[];
  hints?: SavedBlock[];
  solution?: SavedBlock[];
  children?: SavedBlock[];
  blocks?: SavedBlock[];
}

function createDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_problem_clipboard";
  document.metadata = { ...document.metadata, title: "問題のコピペ E2E" };
  document.content = [
    { type: "paragraph", id: "p_before", children: [{ type: "text", text: "問題の前の段落です。" }] },
    {
      type: "problem",
      id: "prob_1",
      tags: ["代数"],
      lead: [{ type: "paragraph", id: "prob_lead", children: [{ type: "text", text: "導入文です。" }] }],
      prompt: [{ type: "paragraph", id: "prob_prompt", children: [{ type: "text", text: "問題文です。" }] }],
      hints: [{ type: "paragraph", id: "prob_hint", children: [{ type: "text", text: "ヒントです。" }] }],
      solution: [{ type: "paragraph", id: "prob_solution", children: [{ type: "text", text: "解答です。" }] }],
    },
    { type: "paragraph", id: "p_after", children: [{ type: "text", text: "問題の後の段落です。" }] },
    { type: "paragraph", id: "p_target", children: [{ type: "text", text: "貼り付け先の段落です。" }] },
  ] as SigmaDocument["content"];
  return document;
}

async function openEditor(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 1200 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 });
  await expect(page.locator('[data-sigma-doc-id="prob_prompt"]').first()).toBeVisible();
}

async function savedBlocks(page: Page): Promise<SavedBlock[]> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("sigma-studio:e2e-document");
    const value: unknown = raw ? JSON.parse(raw) : null;
    const collect = (entry: unknown): SavedBlock[] => {
      if (!entry || typeof entry !== "object") return [];
      const content = (entry as { content?: unknown }).content;
      if (Array.isArray(content)) return content as SavedBlock[];
      return Object.values(entry).flatMap(collect);
    };
    return collect(value);
  });
}

async function dragSelectRange(page: Page, fromBlockId: string, toBlockId: string): Promise<void> {
  const fromBlock = page.locator(`[data-sigma-doc-id="${fromBlockId}"]`).first();
  await fromBlock.scrollIntoViewIfNeeded();
  const from = await fromBlock.boundingBox();
  const to = await page.locator(`[data-sigma-doc-id="${toBlockId}"]`).first().boundingBox();
  if (!from || !to) throw new Error("range endpoints are not visible");
  await page.mouse.click(from.x + 6, from.y + from.height / 2);
  await page.mouse.move(from.x + 4, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 6, to.y + to.height / 2, { steps: 16 });
  await page.mouse.up();
}

async function clickAtEndOfBlock(page: Page, block: Locator): Promise<void> {
  await block.scrollIntoViewIfNeeded();
  const box = await block.boundingBox();
  if (!box) throw new Error("destination paragraph is not visible");
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
}

test("問題を含む範囲をコピーすると問題のまま貼られる", async ({ page }) => {
  await openEditor(page);

  await dragSelectRange(page, "p_before", "p_after");
  await page.keyboard.press("ControlOrMeta+C");

  await clickAtEndOfBlock(page, page.locator('[data-sigma-doc-id="p_target"]').first());
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  await expect.poll(async () => (await savedBlocks(page)).filter((block) => block.type === "problem").length)
    .toBe(2);
  const pasted = (await savedBlocks(page)).filter((block) => block.type === "problem").at(-1);
  expect(pasted?.id).not.toBe("prob_1");
  expect(pasted?.tags).toEqual(["代数"]);
  expect(pasted?.lead?.length).toBe(1);
  expect(pasted?.prompt?.length).toBe(1);
  expect(pasted?.hints?.length).toBe(1);
  expect(pasted?.solution?.length).toBe(1);
});

test("問題ブロックを選んで ⌘C / ⌘V でコピペできる", async ({ page }) => {
  await openEditor(page);

  // ブロックハンドル (ホバーで出る) で問題そのものを選ぶ。本文の上では中の段落のグリップが
  // 出るので、問題ごと掴むときは左ガター (余白) から寄る。
  const promptBlock = page.locator('[data-sigma-doc-id="prob_prompt"]').first();
  const promptBox = (await promptBlock.boundingBox())!;
  await page.mouse.move(promptBox.x - 40, promptBox.y + promptBox.height / 2, { steps: 3 });
  const handle = page.locator('.page-block-handle[data-block-id="prob_1"]').first();
  await expect(handle).toBeVisible();
  await handle.click();
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+C");
  await expect(page.locator(".save-state").first()).toContainText("問題をコピーしました", { timeout: 5_000 });

  await clickAtEndOfBlock(page, page.locator('[data-sigma-doc-id="p_target"]').first());
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  await expect.poll(async () => (await savedBlocks(page)).filter((block) => block.type === "problem").length)
    .toBe(2);
});
