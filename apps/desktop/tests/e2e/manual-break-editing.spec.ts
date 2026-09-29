import { expect, test, type Page } from "@playwright/test";

import type { SigmaBlock } from "@/features/document";
import { createBoxBlock } from "@/lib/box-blocks";
import { normalizePageLayout } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { readCaretSurface } from "./caret-surface";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 手動改ページ (改段) を TeX の `\newpage` と同じ「本文の流れの中の一点」として扱う編集の約束。
 *
 * - 入れ物 (引用・箱) の中の区切りでも、その位置で入れ物が次のページへ続く
 * - 区切りの隣の Backspace / Delete は区切りを越えるだけで、ブロックの種類によらず何も消さない
 *   (以前は、区切りで始まるリスト・引用が持ち上げられて壊れ、問題・コード・段組みの後ろでは
 *   キャレットが動かなかった)
 * - 区切りはキャレットの位置に入る (`/newpage`・右クリック)
 */

const BREAK = { pagination: { break: true as const } };

function paragraph(id: string, text: string, extra: Partial<Extract<SigmaBlock, { type: "paragraph" }>> = {}) {
  return { type: "paragraph" as const, id, children: text ? [{ type: "text" as const, text }] : [], ...extra };
}

function documentWith(content: SigmaBlock[]): SigmaDocument {
  return {
    ...sampleDocument,
    metadata: { title: "改ページの編集" },
    content,
    pageLayout: normalizePageLayout({}),
  };
}

async function open(page: Page, content: SigmaBlock[]) {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDesktopRuntimeMock(page, documentWith(content));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".page-flow").first()).toBeVisible();
}

/** 見えている編集面の、その id のブロックの文字の先頭・末尾へキャレットを置く。 */
async function placeCaret(page: Page, blockId: string, edge: "start" | "end" | number) {
  await page.evaluate(({ blockId, edge }) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>(`.text-flow-editor [data-sigma-doc-id="${blockId}"]`))
      .find((element) => element.getClientRects().length > 0 && !element.closest(".editor-box-fragment-editor"));
    if (!target) throw new Error(`caret target not found: ${blockId}`);
    const scope = target.matches(".sigma-doc-box-block") ? target.querySelector(".sigma-doc-box-title") ?? target : target;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node.textContent ?? "").length > 0 && !node.parentElement?.closest("[data-formatting-mark], .page-break-marker")) {
        texts.push(node as Text);
      }
    }
    target.scrollIntoView({ block: "center" });
    target.closest<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true });
    const selection = window.getSelection()!;
    if (typeof edge === "number") selection.collapse(texts[0], edge);
    else if (edge === "start") selection.collapse(texts[0], 0);
    else selection.collapse(texts.at(-1)!, texts.at(-1)!.length);
  }, { blockId, edge });
  await expect.poll(async () => (await readCaretSurface(page)).blockId).not.toBeNull();
}

async function savedContent(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem("sigma-studio:e2e-document") ?? "{}").content ?? null));
}

async function savedBreakIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const ids: string[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if ((record.pagination as { break?: boolean } | undefined)?.break === true && typeof record.id === "string") ids.push(record.id);
      Object.values(record).forEach(visit);
    };
    visit(JSON.parse(localStorage.getItem("sigma-studio:e2e-document") ?? "{}").content);
    return ids;
  });
}

/** ブロックの見えている面が何ページ目にあるか (1 始まり)。 */
async function pageNumberOf(page: Page, blockId: string, { continuation = false } = {}): Promise<number | null> {
  return page.evaluate(({ blockId, continuation }) => {
    const canvas = document.querySelector<HTMLElement>(".page-canvas")!;
    const scale = new DOMMatrixReadOnly(getComputedStyle(canvas.closest(".page-stack")!).transform).a || 1;
    const stride = Number(canvas.dataset.pageStride);
    const element = Array.from(document.querySelectorAll<HTMLElement>(`[data-sigma-doc-id="${blockId}"]`))
      .find((candidate) => !!candidate.closest(".editor-box-fragment-editor") === continuation);
    if (!element) return null;
    const top = (element.getBoundingClientRect().top - canvas.getBoundingClientRect().top) / scale;
    return Math.floor(top / stride) + 1;
  }, { blockId, continuation });
}

test("a break inside a quote continues the quote on the next page", async ({ page }) => {
  await open(page, [
    paragraph("before", "引用の前"),
    { type: "quote", id: "quote", blocks: [paragraph("q1", "引用の一行目"), paragraph("q2", "引用の二行目", BREAK), paragraph("q3", "引用の三行目")] },
    paragraph("after", "引用の後"),
  ]);
  await expect.poll(() => pageNumberOf(page, "q1")).toBe(1);
  // 区切りの後ろの子は続きの面 (2 ページ目) に描かれる。1 ページ目の正本はそこで切れている。
  await expect.poll(() => pageNumberOf(page, "q2", { continuation: true })).toBe(2);
  await expect.poll(() => pageNumberOf(page, "q3", { continuation: true })).toBe(2);
  await expect.poll(() => pageNumberOf(page, "after")).toBe(2);
  // 改ページの印は区切りの前のページに見えている。
  const marker = page.locator('.page-flow .page-break-marker[data-page-break-block-id="q2"]').first();
  await expect(marker).toBeVisible();

  // 区切りを挟んだ引用の片どうしも、Backspace / Delete で行き来できる (何も消さない)。
  const before = await savedContent(page);
  await placeCaret(page, "q1", "end");
  await page.keyboard.press("Delete");
  await expect.poll(async () => readCaretSurface(page)).toMatchObject({ blockId: "q2", offset: 0, caretVisible: true });
  await page.keyboard.press("Backspace");
  await expect.poll(async () => readCaretSurface(page)).toMatchObject({ blockId: "q1", offset: "引用の一行目".length, caretVisible: true });
  expect(await savedContent(page)).toBe(before);
});

test("Backspace right after a break moves before it without changing any kind of block", async ({ page }) => {
  await open(page, [
    paragraph("a1", "段落一"),
    { type: "heading", id: "h1", level: 2, children: [{ type: "text", text: "見出し" }], ...BREAK },
    paragraph("a2", "段落二"),
    { type: "codeBlock", id: "c1", children: [{ type: "text", text: "code" }], ...BREAK },
    paragraph("a3", "段落三"),
    { type: "list", id: "l1", listType: "bullet", items: [{ type: "listItem", id: "li1", children: [{ type: "text", text: "項目" }] }], ...BREAK },
    paragraph("a4", "段落四"),
    { type: "quote", id: "quote", blocks: [paragraph("qa", "引用")], ...BREAK },
    paragraph("a5", "段落五"),
    { ...createBoxBlock("fancybox", "箱の題", { id: "box", bodyId: "box_body", bodyText: "箱の本文" }), ...BREAK },
    paragraph("a6", "段落六"),
    { type: "problem", id: "problem", tags: [], lead: [paragraph("lead", "導入")], prompt: [paragraph("prompt", "問題文")], hints: [], solution: [], ...BREAK },
    paragraph("a7", "段落七"),
    { type: "layoutSection", id: "section", layout: { columnCount: 1 }, children: [paragraph("inside", "一段組")], ...BREAK },
  ]);
  const before = await savedContent(page);
  for (const [ownerTextId, previousId] of [
    ["h1", "a1"], ["c1", "a2"], ["li1", "a3"], ["qa", "a4"], ["box", "a5"], ["lead", "a6"], ["inside", "a7"],
  ] as const) {
    await placeCaret(page, ownerTextId, "start");
    await page.keyboard.press("Backspace");
    await expect.poll(async () => (await readCaretSurface(page)).blockId, ownerTextId).toBe(previousId);
    const caret = await readCaretSurface(page);
    expect(caret.offset, ownerTextId).toBe(caret.text.length);
    expect(await savedContent(page), ownerTextId).toBe(before);
  }
});

test("Delete right before a break moves after it without joining blocks", async ({ page }) => {
  await open(page, [
    paragraph("a1", "段落一"),
    { type: "quote", id: "quote", blocks: [paragraph("qa", "引用")], ...BREAK },
    paragraph("a2", "段落二"),
    { type: "problem", id: "problem", tags: [], lead: [paragraph("lead", "導入")], prompt: [paragraph("prompt", "問題文")], hints: [], solution: [], ...BREAK },
    paragraph("a3", "段落三"),
    { type: "layoutSection", id: "section", layout: { columnCount: 1 }, children: [paragraph("inside", "一段組")], ...BREAK },
  ]);
  const before = await savedContent(page);
  for (const [previousId, ownerTextId] of [["a1", "qa"], ["a2", "lead"], ["a3", "inside"]] as const) {
    await placeCaret(page, previousId, "end");
    await page.keyboard.press("Delete");
    await expect.poll(async () => (await readCaretSurface(page)).blockId, previousId).toBe(ownerTextId);
    expect((await readCaretSurface(page)).offset, previousId).toBe(0);
    expect(await savedContent(page), previousId).toBe(before);
  }
});

test("/newpage breaks at the caret, and Backspace on the fresh empty line takes the empty page back", async ({ page }) => {
  await open(page, [paragraph("first", "一ページ目"), paragraph("second", "次のページへ")]);
  await placeCaret(page, "second", "start");
  await page.keyboard.type("/newpage");
  await expect(page.locator(".slash-command-option").first()).toContainText("改ページ");
  await page.keyboard.press("Enter");
  await expect.poll(() => savedBreakIds(page)).toEqual(["second"]);
  await expect.poll(() => pageNumberOf(page, "second")).toBe(2);
  await expect.poll(async () => (await readCaretSurface(page)).blockId).toBe("second");
  expect(await savedContent(page)).not.toContain("/newpage");

  // 末尾で区切ると空の行が次のページに生まれ、そこで Backspace すると空のページごと消える。
  await placeCaret(page, "second", "end");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await expect.poll(() => savedBreakIds(page)).toHaveLength(2);
  await expect(page.locator(".page-canvas")).toHaveAttribute("data-page-count", "3");
  await expect.poll(async () => (await readCaretSurface(page)).text).toBe("");
  await page.keyboard.press("Backspace");
  await expect.poll(() => savedBreakIds(page)).toEqual(["second"]);
  await expect(page.locator(".page-canvas")).toHaveAttribute("data-page-count", "2");
  await expect.poll(async () => (await readCaretSurface(page)).blockId).toBe("second");
});

test("the block menu removes only the break at, around, or right after the clicked block", async ({ page }) => {
  await open(page, [
    paragraph("far", "離れた段落"),
    paragraph("just_before", "区切りの直前"),
    paragraph("owner", "区切りの後", BREAK),
    paragraph("later", "後ろの段落"),
  ]);
  const menu = page.getByRole("menu", { name: "本文操作" });
  const removeItem = menu.getByRole("menuitem", { name: "改ページを解除", exact: true });
  for (const [blockId, removable] of [["far", false], ["just_before", true], ["owner", true], ["later", false]] as const) {
    await placeCaret(page, blockId, "end");
    await page.locator(`.page-flow [data-sigma-doc-id="${blockId}"]`).first().click({ button: "right" });
    await expect(menu).toBeVisible();
    await expect(removeItem, blockId).toHaveCount(removable ? 1 : 0);
    await page.keyboard.press("Escape");
  }
  await page.locator('.page-flow [data-sigma-doc-id="just_before"]').first().click({ button: "right" });
  await removeItem.click();
  await expect.poll(() => savedBreakIds(page)).toEqual([]);
});
