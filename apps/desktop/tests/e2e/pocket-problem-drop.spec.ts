import { expect, test, type Locator, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { getDefaultPageLayout } from "@/features/document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { installDocumentTabMock } from "./document-tab-mock";

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
  document.docId = "doc_e2e_pocket_problem_drop";
  document.metadata = { ...document.metadata, title: "ポケットの問題ドロップ E2E" };
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

/**
 * ポケットのカードを、問題を含む本文の上へドロップする。
 *
 * 複数のブロックにまたがる範囲を選んでポケットに入れた直後は、その選択が編集面に残っている。
 * 残したままだと貼り付けは落とした位置ではなく、その選択を置き換える形で入ってしまうので、
 * 落とした位置を「そこをクリックした」のと同じに扱う (`beforePlaceCaret`)。
 */

async function dragCardTo(page: Page, card: Locator, x: number, y: number): Promise<void> {
  const box = await card.boundingBox();
  if (!box) throw new Error("card is not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 12, { steps: 4 });
  await page.mouse.move(x, y, { steps: 16 });
  await page.mouse.up();
}

test("drops a range holding a problem at the drop point, leaving the original range alone", async ({ page }) => {
  await openEditor(page);
  await dragSelectRange(page, "p_before", "p_after");
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  const card = page.locator("[data-pocket-item] button[data-kind]").first();
  await expect(card).toHaveAttribute("data-kind", "blocks");

  const target = page.locator('[data-sigma-doc-id="p_target"]').first();
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  // 選択が残ったまま、貼り付け先の段落の末尾へ落とす。
  await dragCardTo(page, card, box.x + box.width - 4, box.y + box.height / 2);

  await expect.poll(async () => (await savedBlocks(page)).filter((block) => block.type === "problem").length).toBe(2);
  const blocks = await savedBlocks(page);
  // 元の範囲は無変更。落とした先の後ろに、段落・問題・段落が新しい ID で入る。
  expect(blocks.slice(0, 4).map((block) => block.id)).toEqual(["p_before", "prob_1", "p_after", "p_target"]);
  expect(blocks.slice(4).map((block) => block.type)).toEqual(["paragraph", "problem", "paragraph"]);
  expect(blocks.slice(4).map((block) => block.id)).not.toContain("prob_1");
  const pasted = blocks[5];
  expect(pasted?.tags).toEqual(["代数"]);
  expect(pasted?.prompt?.length).toBe(1);
  expect(pasted?.solution?.length).toBe(1);
  // ポケットの項目は減らない。
  await expect(page.locator("[data-pocket-item]")).toHaveCount(1);
});

test("a problem copied into the pocket lands on a whiteboard as separate paragraphs, in page order", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1200 });
  await page.addInitScript(() => window.localStorage.clear());
  const whiteboard = {
    ...createDocument(),
    docId: "doc_e2e_pocket_problem_whiteboard",
    metadata: { title: "ホワイトボード" },
    content: [],
    pageLayout: {
      ...getDefaultPageLayout("whiteboard"),
      overlay: { overlaySnapshot: { version: 1, shapes: [], assets: {} } },
    },
  } as SigmaDocument;
  await installDocumentTabMock(page, createDocument(), whiteboard);
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 });
  await expect(page.locator('[data-sigma-doc-id="prob_prompt"]').first()).toBeVisible();

  await dragSelectRange(page, "p_before", "p_after");
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  const card = page.locator("[data-pocket-item] button[data-kind]").first();
  await expect(card).toHaveAttribute("data-kind", "blocks");

  await page.mouse.click(700, 1100);
  await page.getByRole("button", { name: "新規教材", exact: true }).click();
  await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();
  await card.click();

  // 問題の領域は、1 つに連結されず、紙面の並び (導入文 → 問題文 → ヒント → 解答) で段落のまま入る。
  const shape = page.locator(".overlay-shape", { hasText: "導入文です。" });
  await expect(shape).toHaveCount(1);
  const lines = (await shape.first().innerText()).split("\n").map((line) => line.trim()).filter(Boolean);
  expect(lines).toEqual([
    "問題の前の段落です。",
    "導入文です。",
    "問題文です。",
    "ヒントです。",
    "解答です。",
    "問題の後の段落です。",
  ]);
});

test("a problem copied with Cmd+C and pasted on a whiteboard becomes its text only", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1200 });
  await page.addInitScript(() => window.localStorage.clear());
  const whiteboard = {
    ...createDocument(),
    docId: "doc_e2e_whiteboard_paste",
    metadata: { title: "ホワイトボード" },
    content: [],
    pageLayout: {
      ...getDefaultPageLayout("whiteboard"),
      overlay: { overlaySnapshot: { version: 1, shapes: [], assets: {} } },
    },
  } as SigmaDocument;
  await installDocumentTabMock(page, createDocument(), whiteboard);
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 });
  await expect(page.locator('[data-sigma-doc-id="prob_prompt"]').first()).toBeVisible();

  // ポケットを使わない、ふつうのコピー。
  await dragSelectRange(page, "p_before", "p_after");
  await page.keyboard.press("ControlOrMeta+C");

  await page.mouse.click(700, 1100);
  await page.getByRole("button", { name: "新規教材", exact: true }).click();
  const canvas = page.locator(".whiteboard-page-canvas");
  await expect(canvas).toBeVisible();
  const viewport = (await canvas.boundingBox())!;
  await page.mouse.click(viewport.x + 80, viewport.y + viewport.height - 80);
  await expect(page.locator(".overlay-shape")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+V");

  // テキスト部分だけが、文章の図形として 1 つ貼られる。問題の領域は紙面の並びの段落のまま、番号や枠は付かない。
  const shape = page.locator(".overlay-shape", { hasText: "導入文です。" });
  await expect(shape).toHaveCount(1);
  const lines = (await shape.first().innerText()).split("\n").map((line) => line.trim()).filter(Boolean);
  expect(lines).toEqual([
    "問題の前の段落です。",
    "導入文です。",
    "問題文です。",
    "ヒントです。",
    "解答です。",
    "問題の後の段落です。",
  ]);
  await expect(page.locator(".overlay-shape .problem-frame, .overlay-shape [data-problem-id]")).toHaveCount(0);
  // 見えている範囲の中央あたりに置かれる。
  const box = (await shape.first().boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - (viewport.x + viewport.width / 2))).toBeLessThanOrEqual(40);
  expect(Math.abs(box.y + box.height / 2 - (viewport.y + viewport.height / 2))).toBeLessThanOrEqual(60);
  await expect(page.locator(".save-state").first()).toContainText("ホワイトボードに文章の図形として貼り付けました");

  // もう一度貼ると、もう 1 つ貼れる (何度でも)。
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.locator(".overlay-shape", { hasText: "導入文です。" })).toHaveCount(2);
});
