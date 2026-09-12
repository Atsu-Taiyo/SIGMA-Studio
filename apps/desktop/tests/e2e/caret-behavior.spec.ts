import { expect, test, type Page } from "@playwright/test";

import { normalizePageLayout } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";
import { readCaretSurface } from "./caret-surface";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

test("Enter keeps the caret at the start of the split block across render-unit boundaries", async ({ page }) => {
  await installDesktopRuntimeMock(page, createBoundaryDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  await expectRenderUnitBoundaryBetween(page, "boundary_39", "boundary_40");

  await placeCaret(page, "boundary_39", 4);
  await page.keyboard.press("Enter");

  await expect.poll(async () => savedTopLevelBlockCount(page)).toBe(51);
  await expect.poll(async () => readCaretSurface(page)).toMatchObject({
    text: "RIGHT",
    offset: 0,
  });
});

test("Undo restores both the document and the caret offset", async ({ page }) => {
  await installDesktopRuntimeMock(page, createBoundaryDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  await placeCaret(page, "boundary_0", 2);
  await page.keyboard.insertText("X");
  await expect.poll(async () => savedBlockText(page, "boundary_0")).toBe("境界X0");

  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");

  await expect.poll(async () => savedBlockText(page, "boundary_0")).toBe("境界0");
  await expect.poll(async () => readCaretSurface(page)).toMatchObject({
    blockId: "boundary_0",
    offset: 2,
  });

  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+y");

  await expect.poll(async () => savedBlockText(page, "boundary_0")).toBe("境界X0");
  await expect.poll(async () => readCaretSurface(page)).toMatchObject({
    blockId: "boundary_0",
    offset: 3,
  });
});

test("vertical movement crosses a render-unit boundary without jumping to the document end", async ({ page }) => {
  await installDesktopRuntimeMock(page, createBoundaryDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  await expectRenderUnitBoundaryBetween(page, "boundary_39", "boundary_40");

  await placeCaret(page, "boundary_39", 2);
  await page.keyboard.press("ArrowDown");

  await expect.poll(async () => readCaretSurface(page)).toMatchObject({
    blockId: "boundary_40",
    caretVisible: true,
  });
  const moved = await readCaretSurface(page);
  // 選択とフォーカスが同じ面にあること (別の面へ選択だけ置いて回るのは退行)。
  expect(moved.activeSurface).toEqual(moved.selectionSurface);
});

test("Enter splits a problem lead instead of being ignored", async ({ page }) => {
  await installDesktopRuntimeMock(page, createProblemLeadDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  await placeCaret(page, "problem_lead", 2);
  await expect.poll(async () => readCaretSurface(page)).toMatchObject({
    blockId: "problem_lead",
    offset: 2,
  });
  await page.keyboard.press("Enter");

  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    return document?.content?.[0]?.lead?.map(
      (block: { children?: Array<{ text?: string }> }) =>
        block.children?.map((child) => child.text ?? "").join("") ?? "",
    );
  })).toEqual(["導入", "文"]);
  await expect.poll(async () => readCaretSurface(page)).toMatchObject({
    text: "文",
    offset: 0,
  });
});

/**
 * 区切り線はトップレベルの atom で、キャレットは中へ入らずノードごと選ばれる。
 *
 * この試験が守るのは「区切り線が**編集面から見える 1 つのブロック**であり続けること」:
 * 他の本文ブロックと同じく `data-sigma-doc-id` を DOM に出し、選ぶとその面がフォーカスを持ち、
 * 削除して undo/redo してもキャレットがどの面にも属さない状態へ落ちない。
 *
 * 論理位置としての表現 (`kind: "node"` の bookmark が null にならず、復元すると NodeSelection
 * に戻ること) は `TextFlowEditor.test.ts` の「キャレット位置の正規化」が押さえている。
 */
test("区切り線を選んだ状態で undo/redo してもキャレットを失わない", async ({ page }) => {
  await installDesktopRuntimeMock(page, createDividerDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  const divider = page.locator('.text-flow-editor [data-sigma-doc-id="divider_1"]');
  await expect(divider).toBeVisible();
  await divider.click();

  await expect.poll(async () => readCaretSurface(page)).toMatchObject({
    activeSurface: { kind: "source" },
    blockId: "divider_1",
    caretVisible: true,
  });

  await page.keyboard.press("Backspace");
  await expect.poll(async () => savedBlockIds(page)).toEqual(["p_before", "p_after"]);

  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");

  await expect.poll(async () => savedBlockIds(page)).toEqual(["p_before", "divider_1", "p_after"]);
  await expect.poll(async () => readCaretSurface(page)).toMatchObject({
    activeSurface: { kind: "source" },
    caretVisible: true,
  });
  expect((await readCaretSurface(page)).blockId).not.toBeNull();

  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+y");

  await expect.poll(async () => savedBlockIds(page)).toEqual(["p_before", "p_after"]);
  await expect.poll(async () => readCaretSurface(page)).toMatchObject({
    activeSurface: { kind: "source" },
    caretVisible: true,
  });
  expect((await readCaretSurface(page)).blockId).not.toBeNull();
});

async function savedBlockIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    return (document?.content ?? []).map((block: { id?: string }) => block.id ?? "");
  });
}

function createDividerDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "caret_divider_e2e";
  document.metadata = { title: "区切り線カーソルE2E" };
  document.comments = [];
  document.content = [
    { type: "paragraph", id: "p_before", children: [{ type: "text", text: "区切り線の前" }] },
    { type: "divider", id: "divider_1" },
    { type: "paragraph", id: "p_after", children: [{ type: "text", text: "区切り線の後" }] },
  ];
  const pageLayout = normalizePageLayout(document.pageLayout);
  pageLayout.overlay = undefined;
  document.pageLayout = pageLayout;
  return document;
}

test("段落先頭の Backspace で結合した後、可視な面に collapsed なキャレットが付く", async ({ page }) => {
  await installDesktopRuntimeMock(page, createBoundaryDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  await placeCaret(page, "boundary_1", 0);
  await page.keyboard.press("Backspace");

  await expect.poll(async () => savedBlockText(page, "boundary_0")).toBe("境界0境界1");
  // 結合先の「元の末尾」に、畳まれたキャレットが付いていること。
  await expect.poll(async () => readCaretSurface(page)).toMatchObject({
    blockId: "boundary_0",
    caretVisible: true,
    collapsed: true,
    offset: 3,
  });
  const joined = await readCaretSurface(page);
  expect(joined.activeSurface).toEqual(joined.selectionSurface);
});

test("段組みでくるむ／解除した後にブロック全体が選択されたままにならない", async ({ page }) => {
  test.setTimeout(90_000);
  await installDesktopRuntimeMock(page, createBoundaryDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  const target = page.locator('.page-flow [data-sigma-doc-id="boundary_0"]').first();
  await target.click();
  const box = await target.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box!.x + 8, box!.y + 8, { button: "right" });

  const menu = page.locator(".page-context-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "ここを段組にする", exact: true }).hover();
  await menu.getByRole("menuitem", { name: "2段組", exact: true }).click();

  await expect.poll(() => page.evaluate(() => {
    const saved = window.localStorage.getItem("sigma-studio:e2e-document");
    const parsed = saved ? JSON.parse(saved) : null;
    return (parsed?.content ?? []).some((block: { type?: string }) => block.type === "layoutSection");
  })).toBe(true);

  // ここが回帰の本体: 焦点を戻すときにブロックを全選択したまま残すと、次に打った文字が
  // ブロックごと置き換わる (`docs/caret-behavior-spec.md` が禁止する状態)。
  // `collapsed` と空文字列だけだと「選択が 1 つも無い」状態でも緑になるので、
  // キャレットが実在して見えていることまで確かめる。
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
  await expect.poll(() => readCaretSurface(page)).toMatchObject({
    blockId: "boundary_0",
    caretVisible: true,
    collapsed: true,
  });
  expect((await readCaretSurface(page)).activeSurface?.kind).toBe("source");

  // 解除でも同じこと。
  const wrapped = page.locator('.page-flow [data-sigma-doc-id="boundary_0"]').first();
  const wrappedBox = await wrapped.boundingBox();
  expect(wrappedBox).toBeTruthy();
  await page.mouse.click(wrappedBox!.x + 8, wrappedBox!.y + 8, { button: "right" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "段組を解除", exact: true }).click();

  await expect.poll(() => page.evaluate(() => {
    const saved = window.localStorage.getItem("sigma-studio:e2e-document");
    const parsed = saved ? JSON.parse(saved) : null;
    return (parsed?.content ?? []).some((block: { type?: string }) => block.type === "layoutSection");
  })).toBe(false);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
  await expect.poll(() => readCaretSurface(page)).toMatchObject({
    blockId: "boundary_0",
    caretVisible: true,
    collapsed: true,
  });
});

async function placeCaret(page: Page, blockId: string, offset: number): Promise<void> {
  await page.evaluate(({ targetBlockId, targetOffset }) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>(
      `.text-flow-editor [data-sigma-doc-id="${targetBlockId}"]`,
    )).find((element) => element.getClientRects().length > 0);
    const text = target?.firstChild;
    if (!target || !(text instanceof Text)) {
      throw new Error(`caret target not found: ${targetBlockId}`);
    }
    target.scrollIntoView({ block: "center", inline: "nearest" });
    target.closest<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true });
    const range = document.createRange();
    range.setStart(text, targetOffset);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { targetBlockId: blockId, targetOffset: offset });
}

async function savedTopLevelBlockCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    return raw ? JSON.parse(raw).content.length : -1;
  });
}

async function savedBlockText(page: Page, blockId: string): Promise<string | null> {
  return page.evaluate((targetBlockId) => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    const block = document?.content?.find((candidate: { id?: string }) => candidate.id === targetBlockId);
    return block?.children?.map((child: { text?: string }) => child.text ?? "").join("") ?? null;
  }, blockId);
}

/**
 * 2 つのブロックが**別の描画ユニット**に載っていることを確かめる。
 *
 * 境界が消えた文書で「境界をまたぐ」試験をしても、何も検証していないのと同じになる。
 * チャンク境界はブロック id で覚える (`text-run-chunking.ts`) ので、件数だけ見ても分からない。
 */
async function expectRenderUnitBoundaryBetween(page: Page, beforeId: string, afterId: string) {
  await expect.poll(async () => page.evaluate(([first, second]) => {
    const unitOf = (blockId: string) => document
      .querySelector(`.text-flow-editor [data-sigma-doc-id="${blockId}"]`)
      ?.closest("[data-flow-unit-id]")
      ?.getAttribute("data-flow-unit-id") ?? null;
    const before = unitOf(first);
    const after = unitOf(second);
    return before !== null && after !== null && before !== after;
  }, [beforeId, afterId])).toBe(true);
}

function createBoundaryDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "caret_boundary_e2e";
  document.metadata = { title: "カーソル境界E2E" };
  document.comments = [];
  // 50 件 = 40 + 10。末尾が min (10) を割ると隣のユニットへ併合されて境界そのものが消え、
  // 「境界をまたぐ」試験が空振りになる。件数を変えるときは境界が残ることを必ず確かめる。
  document.content = Array.from({ length: 50 }, (_, index) => ({
    type: "paragraph" as const,
    id: `boundary_${index}`,
    children: [{
      type: "text" as const,
      text: index === 39 ? "LEFTRIGHT" : `境界${index}`,
    }],
  }));
  const pageLayout = normalizePageLayout(document.pageLayout);
  pageLayout.overlay = undefined;
  document.pageLayout = pageLayout;
  return document;
}

function createProblemLeadDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "caret_problem_lead_e2e";
  document.metadata = { title: "問題リードカーソルE2E" };
  document.comments = [];
  document.content = [{
    id: "problem_caret",
    type: "problem",
    tags: [],
    lead: [{
      id: "problem_lead",
      type: "paragraph",
      children: [{ type: "text", text: "導入文" }],
    }],
    prompt: [{
      id: "problem_prompt",
      type: "paragraph",
      children: [{ type: "text", text: "問題文" }],
    }],
    hints: [],
    solution: [],
    answer: { type: "math", expected: "" },
  }];
  const pageLayout = normalizePageLayout(document.pageLayout);
  pageLayout.overlay = undefined;
  document.pageLayout = pageLayout;
  return document;
}
