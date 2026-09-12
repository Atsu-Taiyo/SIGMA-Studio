import { expect, test, type Page } from "@playwright/test";
import type { SigmaDocument, SigmaBlock } from "@/features/document";
import { createBoxBlock } from "@/lib/box-blocks";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { readCaretSurface } from "./caret-surface";

type Kind = "paragraph" | "problem" | "columns" | "localColumns" | "box" | "quote" | "code" | "boxCode" | "nestedBox" | "longList";

function fixture(kind: Kind): SigmaDocument {
  const paragraph = {
    type: "paragraph" as const,
    id: "long_body",
    children: [{ type: "text" as const, text: "途中の本文を改ページして表示します。\n".repeat(24) + "末尾の本文" }],
  };
  let block: SigmaBlock = paragraph;
  if (kind === "problem") {
    block = {
      type: "problem", id: "problem", tags: [], lead: [], prompt: [paragraph], solution: [], hints: [],
      frame: { enabled: true, styleId: "doublebox" },
    };
  }
  if (kind === "localColumns") {
    block = {
      type: "layoutSection", id: "local_columns",
      layout: { columnCount: 2, columnStartIds: ["long_body", "right_body"] },
      children: [paragraph, { type: "paragraph", id: "right_body", children: [{ type: "text", text: "右段の本文" }] }],
    };
  }
  if (kind === "box") {
    block = { ...createBoxBlock("fancybox", "", { id: "box", bodyId: "long_body" }), blocks: [paragraph] };
  }
  if (kind === "longList") {
    block = { type: "list", id: "long_list", listType: "ordered", items: [{ type: "listItem", id: "long_item", children: paragraph.children }] };
  }
  if (kind === "quote") block = { type: "quote", id: "quote", blocks: [paragraph] };
  if (kind === "code") block = { type: "codeBlock", id: "long_body", language: "text", children: paragraph.children };
  if (kind === "boxCode") {
    block = {
      ...createBoxBlock("fancybox", "", { id: "box", bodyId: "unused" }),
      blocks: [
        { type: "paragraph", id: "box_intro", children: [{ type: "text", text: "コードの前" }] },
        { type: "codeBlock", id: "long_body", language: "text", children: paragraph.children },
        { type: "paragraph", id: "box_after", children: [{ type: "text", text: "コードの後" }] },
      ],
    };
  }
  if (kind === "nestedBox") {
    block = {
      ...createBoxBlock("fancybox", "", { id: "outer_box", bodyId: "unused" }),
      blocks: [
        { type: "paragraph", id: "box_intro", children: [{ type: "text", text: "内枠の前" }] },
        { ...createBoxBlock("doublebox", "", { id: "inner_box", bodyId: "long_body" }), blocks: [paragraph] },
      ],
    };
  }
  return {
    version: "2.0", docId: `audit_${kind}`, metadata: { title: "改ページ監査" },
    content: [block, { type: "paragraph", id: "following", children: [{ type: "text", text: "後続の本文" }] }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: "custom", orientation: "portrait", pageSize: { widthMm: 180, heightMm: 110 },
      marginsMm: { top: 12, right: 12, bottom: 12, left: 12 },
      flow: { type: "columns", columnCount: kind === "columns" ? 2 : 1, columnGapMm: 8 },
    },
  };
}

async function open(page: Page, kind: Kind) {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await installDesktopRuntimeMock(page, fixture(kind));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".editor-box-fragment-viewport").first()).toBeAttached();
  const replica = page.locator(".editor-box-fragment-viewport").last();
  await replica.scrollIntoViewIfNeeded();
  await expect(replica.locator(".ProseMirror")).toBeVisible();
  return replica;
}

function findBody(value: unknown): unknown {
  if (!value || typeof value !== "object") return null;
  if ("id" in value && value.id === "long_body") return value;
  for (const child of Object.values(value)) {
    const found = findBody(child);
    if (found) return found;
  }
  return null;
}

test("continued box IME input updates the source and shares undo/redo history", async ({ page }) => {
  const replica = await open(page, "box");
  const point = await replica.locator('[data-sigma-doc-id="long_body"]').evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.trim()) last = node as Text;
    }
    const range = document.createRange();
    range.setStart(last!, last!.length - 1);
    range.setEnd(last!, last!.length);
    const rect = range.getBoundingClientRect();
    return { x: rect.right - 1, y: (rect.top + rect.bottom) / 2 };
  });
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press("End");
  await expect.poll(async () => (await readCaretSurface(page)).blockId).toBe("long_body");
  const original = await page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!).content);
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.imeSetComposition", { text: "つづき", selectionStart: 3, selectionEnd: 3 });
    await client.send("Input.imeSetComposition", { text: "続き入力", selectionStart: 4, selectionEnd: 4 });
    await client.send("Input.insertText", { text: "続き入力" });
  } finally {
    await client.detach();
  }
  const savedContent = () => page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!).content);
  await expect.poll(async () => JSON.stringify(await savedContent())).toContain("続き入力");
  await expect(page.locator('.page-flow [data-sigma-doc-id="long_body"]')).toContainText("続き入力");
  const edited = await savedContent();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect.poll(savedContent).toEqual(original);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+y");
  await expect.poll(savedContent).toEqual(edited);
  await expect.poll(async () => (await readCaretSurface(page)).caretVisible).toBe(true);
});

for (const kind of ["paragraph", "problem", "columns", "localColumns", "box", "quote", "code", "boxCode", "nestedBox", "longList"] as const) {
  test(`continuation has the same origin as its measured source: ${kind}`, async ({ page }) => {
    const replica = await open(page, kind);
    await expect.poll(() => replica.evaluate(viewport => {
      const editor = viewport.querySelector(".ProseMirror")!;
      const block = editor.querySelector(":scope > [data-sigma-doc-id]")!;
      const sourceId = (viewport as HTMLElement).dataset.boxSourceId;
      const original = document.querySelector<HTMLElement>(`.page-flow [data-sigma-doc-id="${sourceId}"]`)!;
      const originalRect = original.getBoundingClientRect();
      const copyRect = block.getBoundingClientRect();
      const differences = Array.from(block.querySelectorAll<HTMLElement>("[data-sigma-doc-id]")).flatMap(child => {
        const source = original.querySelector<HTMLElement>(`[data-sigma-doc-id="${child.dataset.sigmaDocId}"]`);
        if (!source) return [];
        return [Math.abs(
          (child.getBoundingClientRect().top - copyRect.top)
          - (source.getBoundingClientRect().top - originalRect.top),
        )];
      });
      const visibleHeight = Number.parseFloat(original.style.getPropertyValue("--text-flow-box-fragment-visible-height"));
      const pageBodyHeight = 86 * 96 / 25.4;
      return Math.max(
        Math.abs(copyRect.bottom - viewport.getBoundingClientRect().bottom),
        visibleHeight - pageBodyHeight,
        (viewport as HTMLElement).offsetHeight - pageBodyHeight,
        ...differences,
      );
    })).toBeLessThanOrEqual(1);
  });
}

for (const kind of ["paragraph", "problem", "columns", "localColumns", "box", "quote", "nestedBox"] as const) {
  test(`Enter in the continuation preserves the new paragraph and following content: ${kind}`, async ({ page }) => {
    const replica = await open(page, kind);
    const readLastTextPoint = () => replica.locator('[data-sigma-doc-id="long_body"]').evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let last: Text | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.trim()) last = node as Text;
      }
      const range = document.createRange();
      range.setStart(last!, last!.length - 1);
      range.setEnd(last!, last!.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.right - 1, y: (rect.top + rect.bottom) / 2 };
    });
    // Mouse coordinates have no Playwright actionability wait. Wait for layout/font
    // measurement to settle before clicking the last visible character.
    let previousPoint = "";
    let stableSamples = 0;
    await expect.poll(async () => {
      const point = JSON.stringify(await readLastTextPoint());
      stableSamples = point === previousPoint ? stableSamples + 1 : 0;
      previousPoint = point;
      return stableSamples;
    }).toBeGreaterThanOrEqual(2);
    const lastTextPoint = await readLastTextPoint();
    await page.mouse.click(lastTextPoint.x, lastTextPoint.y);
    await page.keyboard.press("End");
    await expect.poll(async () => {
      const caret = await readCaretSurface(page);
      return caret.blockId === "long_body" && caret.caretVisible && caret.offset === caret.text.length;
    }).toBe(true);
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("改ページ先で作成した段落");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("sigma-studio:e2e-document")))
      .toContain("改ページ先で作成した段落");
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!)) as SigmaDocument;
    expect(findBody(saved)).toEqual(findBody(fixture(kind)));
    expect(JSON.stringify(saved)).toContain("後続の本文");
    expect(JSON.stringify(saved)).toContain("末尾の本文");
    await expect.poll(async () => (await readCaretSurface(page)).caretVisible).toBe(true);
    await installDesktopRuntimeMock(page, saved);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator(".page-flow")).toContainText("改ページ先で作成した段落");
  });
}
