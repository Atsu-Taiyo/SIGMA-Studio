import { expect, test, type Locator, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

interface SavedBlock {
  id: string;
  type: string;
  children?: SavedBlock[];
  layout?: { columnCount?: number };
}

function createDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_body_clipboard_structure";
  document.metadata = { ...document.metadata, title: "本文コピペの構造 E2E" };
  document.content = [
    { type: "paragraph", id: "p_before", children: [{ type: "text", text: "段組の前の段落です。" }] },
    {
      type: "layoutSection",
      id: "layout_1",
      layout: { columnCount: 2, columnGapMm: 8 },
      children: [
        { type: "paragraph", id: "layout_p1", children: [{ type: "text", text: "左の段の本文です。" }] },
        { type: "paragraph", id: "layout_p2", children: [{ type: "text", text: "右の段の本文です。" }] },
      ],
    },
    { type: "paragraph", id: "p_after", children: [{ type: "text", text: "段組の後の段落です。" }] },
    { type: "paragraph", id: "p_target", children: [{ type: "text", text: "貼り付け先の段落です。" }] },
  ] as SigmaDocument["content"];
  return document;
}

async function openEditor(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 });
  await expect(page.locator('[data-sigma-doc-id="layout_p1"]').first()).toBeVisible();
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
  await page.mouse.move(to.x + to.width - 6, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

async function clickAtEndOfBlock(page: Page, block: Locator): Promise<void> {
  await block.scrollIntoViewIfNeeded();
  const box = await block.boundingBox();
  if (!box) throw new Error("destination paragraph is not visible");
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
}

test("段組セクションを含む範囲をコピーすると段組のまま貼られる", async ({ page }) => {
  await openEditor(page);

  await dragSelectRange(page, "p_before", "p_after");
  await page.keyboard.press("ControlOrMeta+C");

  await clickAtEndOfBlock(page, page.locator('[data-sigma-doc-id="p_target"]').first());
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  // 段組は本文ブロックとしてクリップボードから外れていた。貼り付け後は 2 本になる。
  await expect.poll(async () => (await savedBlocks(page)).filter((block) => block.type === "layoutSection").length)
    .toBe(2);
  const pasted = (await savedBlocks(page)).filter((block) => block.type === "layoutSection").at(-1);
  expect(pasted?.id).not.toBe("layout_1");
  expect(pasted?.layout?.columnCount).toBe(2);
  expect(pasted?.children?.map((child) => child.type)).toEqual(["paragraph", "paragraph"]);
});
