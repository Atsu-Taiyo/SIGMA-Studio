import { expect, test, type Page } from "@playwright/test";
import { normalizePageLayout } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { waitForPagedSurfaceSettled } from "./paged-surface";

const LOW_FIGURE_Y = 4500;
const LOW_FIGURE_HEIGHT = 160;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

for (const columnCount of [1, 2] as const) {
  for (const framed of [false, true]) {
    test(`paragraph fills remaining space before continuing (${columnCount} columns, framed ${framed})`, async ({ page }) => {
      const document = createOverflowSeedDocument();
      document.pageLayout = normalizePageLayout({
        ...document.pageLayout,
        flow: { type: "columns", columnCount, columnGapMm: 8 },
      });
      document.content = [
        { id: "fill_before", type: "paragraph", children: [{ type: "text", text: "先行する行\n".repeat(28) }] },
        { id: "split_body", type: "paragraph", children: [{ type: "text", text: "問題本文の途中でも自然に続けます。\n".repeat(22) }] },
      ];
      if (framed) {
        document.content[1] = {
          type: "problem", id: "split_problem", tags: [], lead: [], hints: [], solution: [],
          prompt: [document.content[1] as Extract<SigmaDocument["content"][number], { type: "paragraph" }>],
          frame: { enabled: true, styleId: "fancybox" },
        };
      }
      await installDesktopRuntimeMock(page, document);
      await page.goto("/");
      await expect(page.locator(".startup-splash")).toBeHidden();
      const source = page.locator('.page-flow [data-sigma-doc-id="split_body"]').first();
      await expect(source).toHaveClass(/text-flow-box-fragment-source/);
      const continuation = page.locator('.editor-box-fragment-viewport[data-box-source-id="split_body"]').first();
      await expect(continuation).toBeAttached();
      const sourceRect = await source.boundingBox();
      const nextRect = await continuation.boundingBox();
      expect(sourceRect).not.toBeNull();
      expect(nextRect).not.toBeNull();
      if (columnCount === 2) expect(nextRect!.x).toBeGreaterThan(sourceRect!.x);
      else expect(nextRect!.y).toBeGreaterThan(sourceRect!.y);
      await continuation.scrollIntoViewIfNeeded();
      await expect(continuation.locator(".editor-box-fragment-editor")).toBeVisible();
      await continuation.locator(".tiptap").click();
      await page.keyboard.type("CONTINUATION_EDIT");
      await expect(source).toContainText("CONTINUATION_EDIT");
      await expect.poll(() => page.evaluate(() => localStorage.getItem("sigma-studio:e2e-document"))).toContain("CONTINUATION_EDIT");
      // Reloading the runtime mock reseeds its original document; print checks that
      // same input's layout, while the assertion above verifies the edit was saved.
      await page.goto("/print?fileId=file_e2e_document&profile=teacher");
      await waitForPagedSurfaceSettled(page);
      await expect(page.locator(".paged-surface-page").first()).toContainText("問題本文");
    });
  }
}

test("continuous flow: overflow adds pages without duplicating text", async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await installDesktopRuntimeMock(page, createOverflowSeedDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  // New continuous structure renders.
  await expect(page.locator(".page-canvas")).toHaveCount(1);
  await expect(page.locator(".page-flow")).toHaveCount(1);
  await expect(page.locator(".page-backdrop .a4-page-sheet").first()).toBeVisible();

  const initialPages = await page.locator(".page-backdrop .a4-page-sheet").count();

  // Type enough lines into the explicitly seeded multi-paragraph editor to
  // overflow at least one page.
  const editorIndex = await page.evaluate(() => {
    const editors = Array.from(document.querySelectorAll(".page-flow .tiptap.ProseMirror"));
    return Math.max(0, editors.findIndex((editor) => editor.querySelectorAll(":scope > [data-sigma-doc-id]").length > 1));
  });
  const editors = page.locator(".page-flow .tiptap.ProseMirror");
  expect(editorIndex).toBeLessThan(await editors.count());
  const editor = editors.nth(editorIndex);
  await editor.click();
  await editor.evaluate((element) => {
    const target = Array.from(element.querySelectorAll<HTMLElement>("[data-sigma-doc-id]")).at(-1) ?? element;
    const selection = window.getSelection();
    const range = document.createRange();
    element.focus();
    range.selectNodeContents(target);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  const marker = "UNIQMARKER_PAGEBREAK";
  await page.keyboard.insertText(`${marker} start of overflow content`);
  await expect(editor).toContainText(marker);
  const lineCount = 60;
  for (let i = 0; i < lineCount; i += 1) {
    await page.keyboard.press("Enter");
    await page.keyboard.insertText(`overflow line ${i} with enough words to take up vertical space on the page`);
  }
  // Pagination produced more sheets than we started with.
  await expect.poll(async () => page.locator(".page-backdrop .a4-page-sheet").count())
    .toBeGreaterThan(initialPages);
  const grownPages = await page.locator(".page-backdrop .a4-page-sheet").count();
  expect(grownPages).toBeGreaterThan(initialPages);
  expect(grownPages).toBeGreaterThan(1);

  // Preview/aria mirrors may legitimately expose the same accessible text. The
  // duplication regression concerns the canonical editable flow, so count the
  // marker only in direct SigmaDoc blocks owned by that ProseMirror document.
  await expect.poll(async () => countCanonicalBodyTextOccurrences(page, marker)).toBe(1);
  await expect.poll(async () => countSavedDocumentOccurrences(page, marker)).toBe(1);

  // Blocks after a page boundary are placed by a layout-neutral displacement
  // (data-flow-dy), never by margins on editable paragraph/heading nodes or by
  // spacers that change the measured layout (docs/flow-pagination-architecture.md).
  await expect.poll(async () => page.locator(".page-flow [data-flow-dy]").count()).toBeGreaterThan(0);
  await expect(page.locator(".page-break-spacer")).toHaveCount(0);
  const editablePageGapNodes = await page.evaluate(() => {
    return Array.from(document.querySelectorAll<HTMLElement>(".page-flow .ProseMirror > [data-sigma-doc-id]"))
      .filter((element) =>
        element.classList.contains("page-break-gap") ||
        /(?:^|;)\s*margin-top\s*:/i.test(element.getAttribute("style") ?? ""),
      )
      .length;
  });
  expect(editablePageGapNodes).toBe(0);

  const finalLine = `overflow line ${lineCount - 1}`;
  const caretState = await page.evaluate((needle) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>(".page-flow .ProseMirror > [data-sigma-doc-id]"))
      .find((element) => element.textContent?.includes(needle));
    if (!target) {
      return { activeEditorContainsTarget: false, finalLineDomCount: 0, selectionCollapsed: false };
    }

    target.scrollIntoView({ block: "center", inline: "nearest" });
    const editorElement = target.closest<HTMLElement>(".ProseMirror");
    editorElement?.focus();

    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    let textNode: Text | null = null;
    while (walker.nextNode()) {
      const current = walker.currentNode;
      if (current.textContent?.includes(needle)) {
        textNode = current as Text;
      }
    }
    if (textNode) {
      const selectionOffset = textNode.textContent?.length ?? 0;
      const range = document.createRange();
      range.setStart(textNode, selectionOffset);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }

    // Page fragments can mirror later blocks in a second ProseMirror-shaped
    // read-only surface. The caret contract concerns the canonical editor that
    // owns `target`; persisted SigmaDoc uniqueness is asserted separately above.
    const finalLineDomCount = editorElement
      ? Array.from(editorElement.querySelectorAll(":scope > [data-sigma-doc-id]"))
        .filter((element) => element.textContent?.includes(needle))
        .length
      : 0;
    const selection = window.getSelection();
    return {
      activeEditorContainsTarget: !!editorElement && editorElement.contains(target),
      finalLineDomCount,
      selectionCollapsed: selection?.isCollapsed === true && !!selection.anchorNode && target.contains(selection.anchorNode),
    };
  }, finalLine);
  expect(caretState).toEqual({
    activeEditorContainsTarget: true,
    finalLineDomCount: 1,
    selectionCollapsed: true,
  });

  expect(consoleErrors).toEqual([]);
});

test("a tall code block splits on page boundaries without mounting every continuation editor", async ({ page }) => {
  test.setTimeout(120_000);
  await installDesktopRuntimeMock(page, createTallCodeBlockSeedDocument(500));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  const source = page.locator('[data-sigma-doc-id="tall_code_block"].print-code').first();
  await expect(source).toHaveClass(/text-flow-box-fragment-source/);
  await expect.poll(async () => page.locator(
    '.editor-box-fragment-viewport[data-box-source-id="tall_code_block"]',
  ).count()).toBeGreaterThan(10);

  const fragments = page.locator('.editor-box-fragment-viewport[data-box-source-id="tall_code_block"]');
  const fragmentCount = await fragments.count();
  const mountedEditorCount = await fragments.locator(".editor-box-fragment-editor").count();
  expect(mountedEditorCount).toBeLessThan(fragmentCount);

  const initialLineCuts = await countVisibleCodeLineCuts(page, "tall_code_block");
  expect(initialLineCuts).toEqual([]);

  const middle = fragments.nth(Math.floor(fragmentCount / 2));
  await middle.scrollIntoViewIfNeeded();
  await expect(middle.locator(".editor-box-fragment-editor")).toBeVisible();
  expect(await countVisibleCodeLineCuts(page, "tall_code_block")).toEqual([]);

  const clip = await source.evaluate((element) => ({
    clipPath: getComputedStyle(element).clipPath,
    hiddenBottom: getComputedStyle(element).getPropertyValue("--text-flow-box-fragment-hidden-bottom"),
  }));
  expect(clip.clipPath).not.toBe("none");
  expect(Number.parseFloat(clip.hiddenBottom)).toBeGreaterThan(0);

  const last = fragments.last();
  await last.scrollIntoViewIfNeeded();
  await expect(last.locator(".editor-box-fragment-editor")).toBeVisible();
  await expect(last).toContainText("CODE_LINE_499");
  expect(await countVisibleCodeLineCuts(page, "tall_code_block")).toEqual([]);

  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });
  await waitForPagedSurfaceSettled(page);
  await expect.poll(async () => page.locator(".paged-surface-page").count()).toBeGreaterThan(10);
  const printedCodeFragments = page.locator(
    '.paged-surface-page [data-paged-code-fragment] > .editor-box-fragment-editor > .print-code',
  );
  await expect(printedCodeFragments).toHaveCount(
    (await page.locator(".paged-surface-page").count()) - 1,
  );
  await expect(printedCodeFragments.last()).toContainText("CODE_LINE_499");
  expect(await countVisibleCodeLineCuts(page, "tall_code_block")).toEqual([]);
});

test("oversized code uses a bounded display while retaining the full saved source", async ({ page }) => {
  const seed = createTallCodeBlockSeedDocument();
  await installDesktopRuntimeMock(page, seed);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  const source = page.locator('[data-sigma-doc-id="tall_code_block"].print-code').first();
  await expect(source).toBeVisible();
  expect((await source.textContent())!.length).toBeLessThan(1000);
  await expect(source).not.toContainText("CODE_LINE_9999");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document") ?? "{}"));
  expect(saved.content).toEqual(seed.content);
});

test("a syntax-highlighted JSON block uses complete visual lines on every page", async ({ page }) => {
  test.setTimeout(120_000);
  await installDesktopRuntimeMock(page, createHighlightedJsonCodeBlockSeedDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  const source = page.locator('[data-sigma-doc-id="highlighted_json_code"].print-code').first();
  await expect(source).toHaveClass(/text-flow-box-fragment-source/);
  const sourcePageIndex = await source.evaluate((element) => {
    const canvas = element.closest(".page-canvas");
    if (!(canvas instanceof HTMLElement)) {
      throw new Error("page canvas not found");
    }
    const stride = Number.parseFloat(canvas.dataset.pageStride ?? "0");
    return Math.floor((element.getBoundingClientRect().top - canvas.getBoundingClientRect().top) / stride);
  });
  // The JSON block is deliberately preceded by body text. Its large total height
  // must not make it jump wholesale to a fresh page while complete rows still fit.
  expect(sourcePageIndex).toBe(0);
  const fragments = page.locator(
    '.editor-box-fragment-viewport[data-box-source-id="highlighted_json_code"]',
  );
  await expect.poll(() => fragments.count()).toBeGreaterThan(1);
  expect(await countVisibleCodeLineCuts(page, "highlighted_json_code")).toEqual([]);

  for (let index = 0, count = await fragments.count(); index < count; index += 1) {
    const fragment = fragments.nth(index);
    await fragment.scrollIntoViewIfNeeded();
    await expect(fragment.locator(".editor-box-fragment-editor")).toBeVisible();
    expect(await countVisibleCodeLineCuts(page, "highlighted_json_code")).toEqual([]);
  }
});

async function countVisibleCodeLineCuts(page: Page, blockId: string): Promise<Array<{
  boundaryY: number;
  boundary: "bottom" | "top";
  fragmentIndex: string;
  lineBottom: number;
  lineTop: number;
}>> {
  return page.evaluate((id) => {
    const cuts: Array<{
      boundaryY: number;
      boundary: "bottom" | "top";
      fragmentIndex: string;
      lineBottom: number;
      lineTop: number;
    }> = [];
    const inspect = (code: Element, top: number, bottom: number, fragmentIndex: string) => {
      const range = document.createRange();
      range.selectNodeContents(code);
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        if (rect.top < top - 0.75 && rect.bottom > top + 0.75) {
          cuts.push({ boundary: "top", boundaryY: top, fragmentIndex, lineTop: rect.top, lineBottom: rect.bottom });
        }
        if (rect.top < bottom - 0.75 && rect.bottom > bottom + 0.75) {
          cuts.push({ boundary: "bottom", boundaryY: bottom, fragmentIndex, lineTop: rect.top, lineBottom: rect.bottom });
        }
      }
      range.detach();
    };

    const source = document.querySelector<HTMLElement>(
      `[data-sigma-doc-id="${CSS.escape(id)}"].text-flow-box-fragment-source`,
    );
    if (source) {
      const rect = source.getBoundingClientRect();
      const visibleHeight = Number.parseFloat(
        getComputedStyle(source).getPropertyValue("--text-flow-box-fragment-visible-height"),
      );
      inspect(source, rect.top, rect.top + visibleHeight, "source");
    }
    for (const viewport of document.querySelectorAll<HTMLElement>(
      `.editor-box-fragment-viewport[data-box-source-id="${CSS.escape(id)}"]`,
    )) {
      const code = viewport.querySelector(".print-code");
      if (!code) {
        continue;
      }
      const rect = viewport.getBoundingClientRect();
      inspect(code, rect.top, rect.bottom, viewport.dataset.boxFragmentIndex ?? "unknown");
    }
    return cuts;
  }, blockId);
}

test("a figure placed below the text keeps its page visible", async ({ page }) => {
  test.setTimeout(60_000);
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  // Seed a document with a figure placed far below all text (page-anchored at
  // y≈4500). The web editor no longer persists its current document to
  // `sigma-studio:document`, so this uses the desktop storage boundary the app reads.
  const seedDocument = createLowFigureSeedDocument();
  await installDesktopRuntimeMock(page, seedDocument);
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("Low figure pagination E2E");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect.poll(async () => readSavedLowFigureY(page)).toBe(LOW_FIGURE_Y);

  const pagination = await page.evaluate(({ figureY, figureHeight }) => {
    const canvas = document.querySelector<HTMLElement>(".page-canvas");
    if (!canvas) {
      return null;
    }
    const pageHeight = Number.parseFloat(getComputedStyle(canvas).getPropertyValue("--page-height"));
    const pageGap = Number.parseFloat(getComputedStyle(canvas).getPropertyValue("--page-gap"));
    const totalHeight = Number.parseFloat(canvas.style.height);
    const figureBottom = Math.max(0, figureY + figureHeight);
    const requiredPageCount = figureBottom > pageHeight
      ? Math.ceil((figureBottom - pageHeight) / (pageHeight + pageGap)) + 1
      : 1;
    const totalPageCount = totalHeight > pageHeight
      ? Math.round((totalHeight - pageHeight) / (pageHeight + pageGap)) + 1
      : 1;
    return { pageGap, pageHeight, requiredPageCount, totalPageCount };
  }, { figureY: LOW_FIGURE_Y, figureHeight: LOW_FIGURE_HEIGHT });
  expect(pagination).not.toBeNull();
  expect(pagination!.requiredPageCount).toBeGreaterThan(1);
  expect(pagination!.totalPageCount).toBeGreaterThanOrEqual(pagination!.requiredPageCount);

  // Only the visible page window is mounted. Scroll to the required final page
  // before locating its sheet instead of treating the mounted sheet count as
  // the document's total page count.
  const finalPageTop = (pagination!.requiredPageCount - 1) * (pagination!.pageHeight + pagination!.pageGap);
  await page.locator(".page-canvas").evaluate((canvas, targetTop) => {
    canvas.closest<HTMLElement>(".editor-canvas")?.scrollTo({ top: targetTop });
  }, finalPageTop);
  const sheets = page.locator(".page-backdrop .a4-page-sheet");
  await expect.poll(async () => sheets.evaluateAll((elements, targetTop) =>
    elements.some((element) => Math.abs(Number.parseFloat((element as HTMLElement).style.top) - targetTop) < 1), finalPageTop)).toBe(true);

  // Overlay shapes use the same page window. Prove the figure is rendered and
  // the required final sheet covers its lower edge.
  const figure = page.locator('.page-overlay-preview [data-overlay-shape-id="shape_low_test"]');
  await expect(figure).toBeVisible();
  const figureBox = await figure.boundingBox();
  const finalSheetBox = await sheets.evaluateAll((elements, targetTop) => {
    const sheet = elements.find((element) =>
      Math.abs(Number.parseFloat((element as HTMLElement).style.top) - targetTop) < 1);
    if (!sheet) {
      return null;
    }
    const rect = sheet.getBoundingClientRect();
    return { height: rect.height, width: rect.width, x: rect.x, y: rect.y };
  }, finalPageTop);
  expect(figureBox).not.toBeNull();
  expect(finalSheetBox).not.toBeNull();
  const figureBottom = figureBox!.y + figureBox!.height;
  const finalSheetBottom = finalSheetBox!.y + finalSheetBox!.height;
  expect(finalSheetBottom).toBeGreaterThanOrEqual(figureBottom - 1);
  expect(finalSheetBox!.y).toBeLessThan(figureBottom);

  expect(consoleErrors).toEqual([]);
});

test("two-column flow continues onto the next page after the right column", async ({ page }) => {
  test.setTimeout(60_000);
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await installDesktopRuntimeMock(page, createTwoColumnOverflowSeedDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  await expect.poll(async () => page.locator(".page-column-guides span").count()).toBeGreaterThan(0);
  await expect.poll(async () => page.locator(".page-backdrop .a4-page-sheet").count()).toBeGreaterThan(1);

  const layoutProof = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".page-canvas");
    const canvasRect = canvas?.getBoundingClientRect();
    const pageHeight = canvas ? parseFloat(getComputedStyle(canvas).getPropertyValue("--page-height")) : 0;
    const pageGap = canvas ? parseFloat(getComputedStyle(canvas).getPropertyValue("--page-gap")) : 0;
    const blocks = Array.from(document.querySelectorAll<HTMLElement>('.page-flow [data-sigma-doc-id^="p_two_column_"]'))
      .map((element) => ({
        id: element.getAttribute("data-sigma-doc-id") ?? "",
        left: canvasRect ? element.getBoundingClientRect().left - canvasRect.left : 0,
        top: canvasRect ? element.getBoundingClientRect().top - canvasRect.top : 0,
        visibility: getComputedStyle(element).visibility,
      }));
    return {
      hiddenBlocks: blocks.filter((block) => block.visibility === "hidden").length,
      nextPageBlocks: blocks.filter((block) => block.top >= pageHeight + pageGap).length,
      rightColumnBlocks: blocks.filter((block) => block.left > 200).length,
      blockCount: blocks.length,
    };
  });

  expect(layoutProof.blockCount).toBeGreaterThan(20);
  expect(layoutProof.hiddenBlocks).toBe(0);
  expect(layoutProof.rightColumnBlocks).toBeGreaterThan(0);
  expect(layoutProof.nextPageBlocks).toBeGreaterThan(0);
  await expect(page.locator(".page-flow").getByText("TWO_COLUMN_UNIQUE_39", { exact: false })).toHaveCount(1);
  expect(consoleErrors).toEqual([]);
});

test("manual page break sends the following paragraph to the next column", async ({ page }) => {
  test.setTimeout(60_000);
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await installDesktopRuntimeMock(page, createManualBreakSeedDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect.poll(async () => page.locator(".page-column-guides span").count()).toBeGreaterThan(0);

  const first = page.locator('[data-sigma-doc-id="p_manual_first"]').first();
  await expect(first).toBeVisible();
  await first.click();
  await page.evaluate(() => {
    const target = document.querySelector<HTMLElement>('[data-sigma-doc-id="p_manual_first"]');
    const textNode = target?.firstChild;
    if (!target || !textNode) {
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  const box = await first.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box!.x + 8, box!.y + 8, { button: "right" });
  const menu = page.locator(".page-context-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "改段を挿入", exact: true }).click();
  await expect.poll(async () => savedTopLevelBreakBefore(page, "p_manual_second")).toBe(true);

  const breakProof = await page.evaluate(() => {
    const firstUnit = document.querySelector<HTMLElement>('[data-flow-unit-id^="p_manual_first"]');
    const secondUnit = document.querySelector<HTMLElement>('[data-flow-unit-id^="p_manual_second"]');
    const saved = window.localStorage.getItem("sigma-studio:e2e-document");
    const documentJson = saved ? JSON.parse(saved) : null;
    const secondBlock = documentJson?.content?.find((block: { id?: string }) => block.id === "p_manual_second");
    return {
      firstLeft: firstUnit ? firstUnit.getBoundingClientRect().left : null,
      secondLeft: secondUnit ? secondUnit.getBoundingClientRect().left : null,
      secondBreakBefore: secondBlock?.pagination?.break ?? null,
      markerCount: document.querySelectorAll('.page-flow .page-break-marker[data-page-break-block-id="p_manual_second"]').length,
    };
  });

  expect(breakProof.secondBreakBefore).toBe(true);
  expect(breakProof.markerCount).toBeGreaterThan(0);
  expect(breakProof.firstLeft).not.toBeNull();
  expect(breakProof.secondLeft).not.toBeNull();
  expect(breakProof.secondLeft!).toBeGreaterThan(breakProof.firstLeft! + 100);

  const firstAfterBreak = page.locator('[data-sigma-doc-id="p_manual_first"]').first();
  const firstAfterBreakBox = await firstAfterBreak.boundingBox();
  expect(firstAfterBreakBox).toBeTruthy();
  await page.mouse.click(firstAfterBreakBox!.x + 8, firstAfterBreakBox!.y + 8, { button: "right" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "改段を解除", exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: "改段を解除", exact: true }).click();
  await expect.poll(async () => savedTopLevelBreakBefore(page, "p_manual_second")).toBeNull();

  const releaseProof = await page.evaluate(() => {
    const saved = window.localStorage.getItem("sigma-studio:e2e-document");
    const documentJson = saved ? JSON.parse(saved) : null;
    const secondBlock = documentJson?.content?.find((block: { id?: string }) => block.id === "p_manual_second");
    return secondBlock?.pagination?.break ?? null;
  });

  expect(releaseProof).toBeNull();
  expect(consoleErrors).toEqual([]);
});

test("body context menu wraps only the clicked block in columns", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createColumnWrapContextMenuSeedDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  const target = page.locator('[data-sigma-doc-id="p_context_middle"]').first();
  await expect(target).toBeVisible();
  await target.click();
  const box = await target.boundingBox();
  expect(box).toBeTruthy();

  await page.mouse.click(box!.x + 8, box!.y + 8, { button: "right" });
  const menu = page.locator(".page-context-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "ここを段組にする", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "素材に追加", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "改ページを挿入", exact: true })).toBeVisible();

  await menu.getByRole("menuitem", { name: "ここを段組にする", exact: true }).hover();
  await expect(menu.getByRole("menuitem", { name: "2段組", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "3段組", exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: "2段組", exact: true }).click();
  await expect.poll(async () => savedFirstLayoutSectionColumnCount(page)).toBe(2);

  const wrapProof = await page.evaluate(() => {
    const saved = window.localStorage.getItem("sigma-studio:e2e-document");
    const documentJson = saved ? JSON.parse(saved) : null;
    const content = documentJson?.content ?? [];
    const section = content.find((block: { type?: string }) => block.type === "layoutSection");
    return {
      types: content.map((block: { type?: string }) => block.type),
      beforeId: content[0]?.id ?? null,
      afterId: content[2]?.id ?? null,
      sectionColumnCount: section?.layout?.columnCount ?? null,
      sectionChildren: section?.children?.map((block: { id?: string }) => block.id) ?? [],
      emptyNeighbor: section?.children?.[1],
    };
  });

  expect(wrapProof.types).toEqual(["paragraph", "layoutSection", "paragraph"]);
  expect(wrapProof.beforeId).toBe("p_context_before");
  expect(wrapProof.afterId).toBe("p_context_after");
  expect(wrapProof.sectionColumnCount).toBe(2);
  expect(wrapProof.sectionChildren).toHaveLength(2);
  expect(wrapProof.sectionChildren[0]).toBe("p_context_middle");
  expect(wrapProof.emptyNeighbor).toMatchObject({ type: "paragraph", children: [{ type: "text", text: "" }] });
});

test("body context menu edits or unwraps an existing local column section", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createLayoutSectionContextMenuSeedDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  const target = page.locator('[data-layout-section-id="local_context_section"] [data-sigma-doc-id="local_context_first"]').first();
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  expect(box).toBeTruthy();

  await page.mouse.click(box!.x + 8, box!.y + 8, { button: "right" });
  const menu = page.locator(".page-context-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "段組を変更", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "段組を解除", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "ここを段組にする", exact: true })).toHaveCount(0);

  await menu.getByRole("menuitem", { name: "段組を変更", exact: true }).hover();
  await menu.getByRole("menuitemradio", { name: "3段組", exact: true }).click();
  await expect.poll(async () => savedLocalSectionColumnCount(page)).toBe(3);

  const changedTarget = page.locator('[data-layout-section-id="local_context_section"] [data-sigma-doc-id="local_context_first"]').first();
  const changedBox = await changedTarget.boundingBox();
  expect(changedBox).toBeTruthy();
  await page.mouse.click(changedBox!.x + 8, changedBox!.y + 8, { button: "right" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "段組を解除", exact: true }).click();
  await expect.poll(async () => savedTopLevelContentSignature(page)).toBe(
    "local_context_first:paragraph|local_context_second:paragraph|local_context_tail:paragraph",
  );

  const unwrapProof = await page.evaluate(() => {
    const saved = window.localStorage.getItem("sigma-studio:e2e-document");
    const documentJson = saved ? JSON.parse(saved) : null;
    return (documentJson?.content ?? []).map((block: { id?: string; type?: string }) => ({ id: block.id, type: block.type }));
  });

  expect(unwrapProof).toEqual([
    { id: "local_context_first", type: "paragraph" },
    { id: "local_context_second", type: "paragraph" },
    { id: "local_context_tail", type: "paragraph" },
  ]);
});

test("independent local columns do not offer manual page or column breaks", async ({ page }) => {
  await installDesktopRuntimeMock(page, createLayoutSectionContextMenuSeedDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  const target = page.locator('[data-layout-section-id="local_context_section"] [data-sigma-doc-id="local_context_first"]').first();
  await target.click({ button: "right" });
  const menu = page.locator(".page-context-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /改[段ページ]+を挿入/ })).toHaveCount(0);
  await expect.poll(() => savedLocalSectionBreakBefore(page, "local_context_second")).toBeNull();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-layout-section-id="local_context_section"] .page-break-marker')).toHaveCount(0);
});

function createLowFigureSeedDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_continuous_pagination";
  document.metadata = { title: "Low figure pagination E2E" };
  document.comments = [];
  document.content = [{
    id: "low_figure_body",
    type: "paragraph",
    children: [{ type: "text", text: "本文より下に配置した図形のページを確認します。" }],
  }];
  const pageLayout = normalizePageLayout(document.pageLayout);
  pageLayout.overlay = {
    overlaySnapshot: {
      version: 1,
      shapes: [
        {
          id: "shape_low_test",
          type: "geo",
          x: 120,
          y: LOW_FIGURE_Y,
          anchor: { type: "page" },
          props: {
            w: 220,
            h: LOW_FIGURE_HEIGHT,
            geo: "rectangle",
            fill: "none",
            color: "#1133cc",
            labelColor: "#111111",
            dash: "solid",
            size: "m",
          },
        },
      ],
      assets: {},
    },
  };
  document.pageLayout = pageLayout;
  return document;
}

async function readSavedLowFigureY(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    const shapes = document?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const figure = shapes.find((shape: { id?: string }) => shape.id === "shape_low_test");
    return typeof figure?.y === "number" ? figure.y : null;
  });
}

function createOverflowSeedDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_continuous_overflow";
  document.metadata = { title: "Continuous overflow E2E" };
  document.comments = [];
  document.content = [
    {
      id: "overflow_intro",
      type: "paragraph",
      children: [{ type: "text", text: "連続ページの冒頭です。" }],
    },
    {
      id: "overflow_body",
      type: "paragraph",
      children: [{ type: "text", text: "この本文の後ろに改行を追加します。" }],
    },
  ];
  const pageLayout = normalizePageLayout(document.pageLayout);
  pageLayout.overlay = undefined;
  document.pageLayout = pageLayout;
  return document;
}

function createTallCodeBlockSeedDocument(lineCount = 10_000): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_tall_code_block";
  document.metadata = { title: "Tall code block E2E" };
  document.comments = [];
  document.content = [{
    id: "tall_code_block",
    type: "codeBlock",
    language: "javascript",
    children: [{
      type: "text",
      text: Array.from(
        { length: lineCount },
        (_, index) => `CODE_LINE_${index} = ${index};`,
      ).join("\n"),
    }],
  }];
  const pageLayout = normalizePageLayout(document.pageLayout);
  pageLayout.flow = { type: "columns", columnCount: 1, columnGapMm: 8 };
  pageLayout.overlay = undefined;
  document.pageLayout = pageLayout;
  return document;
}

function createHighlightedJsonCodeBlockSeedDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_highlighted_json_code";
  document.metadata = { title: "Highlighted JSON pagination E2E" };
  document.comments = [];
  const scripts = Object.fromEntries(Array.from(
    { length: 90 },
    (_, index) => [`viewer:task:${String(index).padStart(2, "0")}`, `npm run viewer-task-${index}`],
  ));
  document.content = [
    ...Array.from({ length: 8 }, (_, index) => ({
      type: "paragraph" as const,
      id: `highlighted_intro_${index}`,
      children: [{ type: "text" as const, text: `コード前の本文 ${index + 1}` }],
    })),
    {
      id: "highlighted_json_code",
      type: "codeBlock",
      language: "json",
      children: [{
        type: "text",
        text: JSON.stringify({ name: "sigma-studio", scripts, overrides: { postcss: "^8.5.14" } }, null, 2),
      }],
    },
  ];
  const pageLayout = normalizePageLayout(document.pageLayout);
  pageLayout.flow = { type: "columns", columnCount: 1, columnGapMm: 8 };
  pageLayout.overlay = undefined;
  document.pageLayout = pageLayout;
  return document;
}

async function countCanonicalBodyTextOccurrences(page: Page, needle: string): Promise<number> {
  return page.evaluate((text) => {
    const canonicalText = Array.from(document.querySelectorAll<HTMLElement>(
      ".page-flow .ProseMirror > [data-sigma-doc-id]",
    )).map((element) => element.textContent ?? "").join("\n");
    return canonicalText.split(text).length - 1;
  }, needle);
}

async function countSavedDocumentOccurrences(page: Page, needle: string): Promise<number> {
  return page.evaluate((text) => {
    const saved = window.localStorage.getItem("sigma-studio:e2e-document") ?? "";
    return saved.split(text).length - 1;
  }, needle);
}

function createTwoColumnOverflowSeedDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_two_column_overflow";
  document.metadata = { title: "Two column overflow E2E" };
  document.comments = [];
  document.content = Array.from({ length: 40 }, (_, index) => ({
    type: "paragraph" as const,
    id: `p_two_column_${index}`,
    children: [{
      type: "text" as const,
      text: `TWO_COLUMN_UNIQUE_${index} ` +
        "二段組の本文が十分な高さを持ち、左段から右段、さらに次ページへ流れることを確認します。".repeat(3),
    }],
  }));
  const pageLayout = normalizePageLayout(document.pageLayout);
  pageLayout.flow = { type: "columns", columnCount: 2, columnGapMm: 8 };
  pageLayout.overlay = undefined;
  document.pageLayout = pageLayout;
  return document;
}

function createManualBreakSeedDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_manual_column_break";
  document.metadata = { title: "Manual column break E2E" };
  document.comments = [];
  document.content = [
    {
      type: "paragraph",
      id: "p_manual_first",
      children: [{ type: "text", text: "手動改ページを入れる前の段落です。" }],
    },
    {
      type: "paragraph",
      id: "p_manual_second",
      children: [{ type: "text", text: "この段落が次の段へ送られることを確認します。" }],
    },
  ];
  const pageLayout = normalizePageLayout(document.pageLayout);
  pageLayout.flow = { type: "columns", columnCount: 2, columnGapMm: 8 };
  pageLayout.overlay = undefined;
  document.pageLayout = pageLayout;
  return document;
}

function createColumnWrapContextMenuSeedDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_context_menu_column_wrap";
  document.metadata = { title: "Context menu column wrap E2E" };
  document.comments = [];
  document.content = [
    {
      type: "paragraph",
      id: "p_context_before",
      children: [{ type: "text", text: "段組にしない前段落です。" }],
    },
    {
      type: "paragraph",
      id: "p_context_middle",
      children: [{ type: "text", text: "右クリックしたこの段落だけを段組にします。" }],
    },
    {
      type: "paragraph",
      id: "p_context_after",
      children: [{ type: "text", text: "段組にしない後段落です。" }],
    },
  ];
  const pageLayout = normalizePageLayout(document.pageLayout);
  pageLayout.flow = { type: "columns", columnCount: 1, columnGapMm: 8 };
  pageLayout.overlay = undefined;
  document.pageLayout = pageLayout;
  return document;
}

function createLayoutSectionContextMenuSeedDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_local_column_context_menu";
  document.metadata = { title: "Local column context menu E2E" };
  document.comments = [];
  document.content = [
    {
      type: "layoutSection",
      id: "local_context_section",
      layout: { columnCount: 2, columnGapMm: 8 },
      children: [
        {
          type: "paragraph",
          id: "local_context_first",
          children: [{ type: "text", text: "局所段組の最初の段落です。" }],
        },
        {
          type: "paragraph",
          id: "local_context_second",
          children: [{ type: "text", text: "この段落が次の段へ送られることを確認します。" }],
        },
      ],
    },
    {
      type: "paragraph",
      id: "local_context_tail",
      children: [{ type: "text", text: "段組の後の本文です。" }],
    },
  ];
  const pageLayout = normalizePageLayout(document.pageLayout);
  pageLayout.flow = { type: "columns", columnCount: 1, columnGapMm: 8 };
  pageLayout.overlay = undefined;
  document.pageLayout = pageLayout;
  return document;
}

async function savedLocalSectionColumnCount(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const saved = window.localStorage.getItem("sigma-studio:e2e-document");
    const documentJson = saved ? JSON.parse(saved) : null;
    const section = documentJson?.content?.find((block: { id?: string }) => block.id === "local_context_section");
    return section?.layout?.columnCount ?? null;
  });
}

async function savedFirstLayoutSectionColumnCount(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const saved = window.localStorage.getItem("sigma-studio:e2e-document");
    const documentJson = saved ? JSON.parse(saved) : null;
    const section = documentJson?.content?.find((block: { type?: string }) => block.type === "layoutSection");
    return section?.layout?.columnCount ?? null;
  });
}

async function savedTopLevelBreakBefore(page: Page, blockId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const saved = window.localStorage.getItem("sigma-studio:e2e-document");
    const documentJson = saved ? JSON.parse(saved) : null;
    const block = documentJson?.content?.find((item: { id?: string }) => item.id === id);
    return block?.pagination?.break ?? null;
  }, blockId);
}

async function savedLocalSectionBreakBefore(page: Page, blockId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const saved = window.localStorage.getItem("sigma-studio:e2e-document");
    const documentJson = saved ? JSON.parse(saved) : null;
    const section = documentJson?.content?.find((block: { id?: string }) => block.id === "local_context_section");
    const block = section?.children?.find((item: { id?: string }) => item.id === id);
    return block?.pagination?.break ?? null;
  }, blockId);
}

async function savedTopLevelContentSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const saved = window.localStorage.getItem("sigma-studio:e2e-document");
    const documentJson = saved ? JSON.parse(saved) : null;
    return (documentJson?.content ?? [])
      .map((block: { id?: string; type?: string }) => `${block.id ?? ""}:${block.type ?? ""}`)
      .join("|");
  });
}
