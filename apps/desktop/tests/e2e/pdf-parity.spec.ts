import { expect, test, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

import webMcpChallengeDocument from "../../public/demo/webmcp-challenge.sigmadoc.json";
import { getArrowheadTrimInStrokes } from "@/features/rendering/core";
import { createBoxBlock } from "@/lib/box-blocks";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { waitForPagedSurfaceSettled } from "./paged-surface";
import { selectUiOptionInPage } from "./ui-select";

/**
 * The contract from docs/pdf-parity-architecture.md: the PDF is the editor screen cut
 * into pages, so every block and every shape must land on the same page at the same
 * offset in both. This spec is the gate — if it fails, the PDF has drifted.
 *
 * Both sides are measured in *page-local* coordinates so the comparison is exactly the
 * one a reader makes: "is this paragraph in the same spot on the sheet?"
 */

/**
 * These also pin the pagination pass's CONVERGENCE, not just editor/PDF agreement: both
 * sides run the same engine, so a case that reports different pages or a 2px offset means
 * the same document settled two different ways. That happened while the pass subtracted
 * the previously *intended* gaps out of the measured top instead of the rendered ones —
 * see `page-canvas/applied-gaps.ts` (`readAppliedGapPx`).
 */

/** 0.5 CSS px ≈ 0.13 mm — below one device pixel, so invisible on paper. */
const TOLERANCE_PX = 0.5;

const SHORT_PAGE = {
  preset: "custom" as const,
  orientation: "portrait" as const,
  pageSize: { widthMm: 90, heightMm: 100 },
  marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
};

interface Geometry {
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function documentWith(
  content: SigmaDocument["content"],
  options: { columnCount?: number; pageLayout?: Partial<SigmaDocument["pageLayout"]> } = {},
): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_pdf_parity",
    metadata: { title: "PDFパリティ確認" },
    content,
    outputProfiles: {
      student: { showSolutions: false },
      teacher: { showSolutions: true },
      answerBook: { onlySolutions: true, showSolutions: true },
    },
    pageLayout: {
      ...SHORT_PAGE,
      flow: { type: "columns", columnCount: options.columnCount ?? 1, columnGapMm: 8 },
      ...options.pageLayout,
    },
  } as SigmaDocument;
}

function paragraphs(prefix: string, count: number, breakAt?: number) {
  return Array.from({ length: count }, (_, index) => ({
    type: "paragraph" as const,
    id: `${prefix}_${index + 1}`,
    children: [{ type: "text" as const, text: `${prefix} ${index + 1} 本文テキストのサンプルです` }],
    ...(index + 1 === breakAt ? { pageBreak: { breakBefore: "always" as const } } : {}),
  }));
}

/**
 * A fingerprint of every measured position on the canvas. Comparing it across frames is
 * how we know the editor's own pagination has converged — measuring a canvas that is
 * still settling produces differences that belong to the clock, not to the renderer.
 */
async function layoutSignature(page: Page, canvasSelector: string): Promise<string> {
  return page.evaluate((selector) => {
    const canvas = document.querySelector<HTMLElement>(selector);
    if (!canvas) {
      return "";
    }
    const canvasRect = canvas.getBoundingClientRect();
    const parts = [canvas.dataset.pageCount ?? "", Math.round(canvasRect.height * 100)];
    // Shapes have to be in the fingerprint too: overlay anchor resolution keeps moving
    // them for a few frames after the text has stopped.
    for (const element of Array.from(canvas.querySelectorAll<HTMLElement>(
      "[data-sigma-doc-id],[data-overlay-shape-id],[data-sigma-doc-math-inline][data-id]",
    ))) {
      const rect = element.getBoundingClientRect();
      parts.push(
        Math.round((rect.top - canvasRect.top) * 100),
        Math.round((rect.left - canvasRect.left) * 100),
        Math.round(rect.height * 100),
      );
    }
    return parts.join(",");
  }, canvasSelector);
}

async function waitForStableLayout(page: Page, canvasSelector: string): Promise<void> {
  // Line heights change when the real font replaces the fallback, which moves page
  // breaks. Sampling before that lands measures a layout that no longer exists.
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);

  let previous = "";
  let stable = 0;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const signature = await layoutSignature(page, canvasSelector);
    if (signature && signature === previous) {
      stable += 1;
      if (stable >= 6) {
        return;
      }
    } else {
      stable = 0;
      previous = signature;
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`レイアウトが収束しませんでした: ${canvasSelector}`);
}

/**
 * Block and shape geometry on the editor canvas, expressed per page sheet.
 *
 * The editor windows its page sheets and overlay shapes, so anything below the fold is
 * simply absent from the DOM. Walking the scroller top to bottom is what makes the
 * comparison cover the whole document rather than just page 1.
 */
async function editorGeometry(page: Page): Promise<Record<string, Geometry[]>> {
  const viewport = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".editor-canvas");
    return {
      scrollHeight: scroller?.scrollHeight ?? 0,
      clientHeight: scroller?.clientHeight ?? 0,
    };
  });
  const step = Math.max(1, Math.floor(viewport.clientHeight * 0.8));
  const stepCount = Math.max(1, Math.ceil(viewport.scrollHeight / step));

  const merged: Record<string, Geometry[]> = {};
  for (let index = 0; index <= stepCount; index += 1) {
    await page.evaluate((top) => {
      const scroller = document.querySelector<HTMLElement>(".editor-canvas");
      if (scroller) {
        scroller.scrollTop = top;
      }
    }, index * step);
    await waitForStableLayout(page, ".page-canvas");
    // Windowing means a later scroll position can reveal occurrences the first one
    // could not see, so keep whichever sample found the most.
    for (const [id, occurrences] of Object.entries(await editorGeometrySnapshot(page))) {
      if (!merged[id] || occurrences.length >= merged[id].length) {
        merged[id] = occurrences;
      }
    }
  }
  return merged;
}

async function editorGeometrySnapshot(page: Page): Promise<Record<string, Geometry[]>> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".page-canvas");
    if (!canvas) {
      return {};
    }
    const zoomRaw = Number(getComputedStyle(canvas).getPropertyValue("--editor-zoom"));
    const zoom = Number.isFinite(zoomRaw) && zoomRaw > 0 ? zoomRaw : 1;
    const canvasRect = canvas.getBoundingClientRect();
    const stride = Number(canvas.dataset.pageStride ?? "0");
    const result: Record<string, { pageIndex: number; x: number; y: number; w: number; h: number }[]> = {};
    if (!stride) {
      return result;
    }
    // A framed problem split across pages renders the same block id once per fragment,
    // so occurrences are collected as a list rather than collapsed to the first one.
    for (const element of Array.from(canvas.querySelectorAll<HTMLElement>(
      "[data-sigma-doc-id],[data-overlay-shape-id],[data-sigma-doc-math-inline][data-id]",
    ))) {
      const id = element.getAttribute("data-sigma-doc-id")
        ?? element.getAttribute("data-overlay-shape-id")
        ?? element.getAttribute("data-id");
      if (!id) {
        continue;
      }
      let rect = element.getBoundingClientRect();
      // A continuation keeps the whole source document translated behind a clipped viewport.
      // Count only painted occurrences, as with the output page-window check below.
      const fragment = element.closest<HTMLElement>(".editor-box-fragment-viewport");
      if (fragment) {
        const clip = fragment.getBoundingClientRect();
        if (rect.bottom <= clip.top || rect.top >= clip.bottom || rect.right <= clip.left || rect.left >= clip.right) continue;
        rect = new DOMRect(Math.max(rect.left, clip.left), Math.max(rect.top, clip.top),
          Math.min(rect.right, clip.right) - Math.max(rect.left, clip.left),
          Math.min(rect.bottom, clip.bottom) - Math.max(rect.top, clip.top));
      }
      const source = element.closest<HTMLElement>(".text-flow-box-fragment-source");
      if (source) {
        const height = parseFloat(getComputedStyle(source).getPropertyValue("--text-flow-box-fragment-visible-height"));
        const bounds = source.getBoundingClientRect();
        if (Number.isFinite(height)) {
          const bottom = Math.min(rect.bottom, bounds.top + height * zoom);
          rect = new DOMRect(rect.left, Math.max(rect.top, bounds.top), rect.width, bottom - Math.max(rect.top, bounds.top));
        }
      }
      // Compare painted bands, not the hidden natural top of a multi-page paragraph.
      // Subpixel edge intersections contain no complete painted line.
      if (rect.width <= 0.5 * zoom || rect.height <= 0.5 * zoom) continue;
      const canvasY = (rect.top - canvasRect.top) / zoom;
      const pageIndex = Math.floor(canvasY / stride);
      (result[id] ??= []).push({
        pageIndex,
        x: (rect.left - canvasRect.left) / zoom,
        y: canvasY - pageIndex * stride,
        w: rect.width / zoom,
        h: rect.height / zoom,
      });
    }
    return result;
  });
}

/** The same geometry as it is actually painted into the output page windows. */
async function pagedGeometry(page: Page): Promise<Record<string, Geometry[]>> {
  return page.evaluate(() => {
    const result: Record<string, { pageIndex: number; x: number; y: number; w: number; h: number }[]> = {};
    for (const window of Array.from(document.querySelectorAll<HTMLElement>(".paged-surface-page"))) {
      const pageIndex = Number(window.dataset.pageNumber ?? "0") - 1;
      const windowRect = window.getBoundingClientRect();
      for (const element of Array.from(window.querySelectorAll<HTMLElement>(
        "[data-sigma-doc-id],[data-overlay-shape-id],[data-sigma-doc-math-inline][data-id]",
      ))) {
        const id = element.getAttribute("data-sigma-doc-id")
          ?? element.getAttribute("data-overlay-shape-id")
          ?? element.getAttribute("data-id");
        if (!id) {
          continue;
        }
        let rect = element.getBoundingClientRect();
        const fragment = element.closest<HTMLElement>(".editor-box-fragment-viewport");
        if (fragment) {
          const clip = fragment.getBoundingClientRect();
          if (rect.bottom <= clip.top || rect.top >= clip.bottom || rect.right <= clip.left || rect.left >= clip.right) continue;
          rect = new DOMRect(Math.max(rect.left, clip.left), Math.max(rect.top, clip.top),
            Math.min(rect.right, clip.right) - Math.max(rect.left, clip.left),
            Math.min(rect.bottom, clip.bottom) - Math.max(rect.top, clip.top));
        }
        const source = element.closest<HTMLElement>(".text-flow-box-fragment-source");
        if (source) {
          const height = parseFloat(getComputedStyle(source).getPropertyValue("--text-flow-box-fragment-visible-height"));
          const bounds = source.getBoundingClientRect();
          if (Number.isFinite(height)) {
            const bottom = Math.min(rect.bottom, bounds.top + height);
            rect = new DOMRect(rect.left, Math.max(rect.top, bounds.top), rect.width, bottom - Math.max(rect.top, bounds.top));
          }
        }
        // Page windows retain off-page descendants for layout. Only rectangles intersecting the
        // paper are painted; counting clipped math nodes would report one copy on every page.
        if (rect.width <= 0.5 || rect.height <= 0.5
          || rect.bottom <= windowRect.top || rect.top >= windowRect.bottom
          || rect.right <= windowRect.left || rect.left >= windowRect.right) {
          continue;
        }
        (result[id] ??= []).push({
          pageIndex,
          x: rect.left - windowRect.left,
          y: rect.top - windowRect.top,
          w: rect.width,
          h: rect.height,
        });
      }
    }
    return result;
  });
}

async function openEditor(page: Page, document: SigmaDocument) {
  await installDesktopRuntimeMock(page, document);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".page-flow")).toHaveCount(1);
  await waitForStableLayout(page, ".page-canvas");
}

/**
 * Drives the zoom control through the DOM rather than Playwright clicks: the editor toolbar
 * re-renders continuously, so the actionability check never sees it hold still. The control is the
 * app's own `Select`, so the value is applied by opening it and clicking the option element.
 */
async function setEditorZoom(page: Page, zoom: number) {
  await selectUiOptionInPage(page, "ズーム", String(zoom));
  await waitForStableLayout(page, ".page-canvas");
}

async function openPaged(page: Page, document: SigmaDocument) {
  await installDesktopRuntimeMock(page, document);
  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".paged-surface[data-paged-surface-state='ready']")).toHaveCount(1);
  await waitForStableLayout(page, ".paged-surface-stage .page-canvas");
  // The windows are rebuilt when the canvas changes, so the cut has to be caught up with
  // the settled canvas before reading geometry out of it.
  await waitForPagedSurfaceSettled(page);
}

/**
 * Compares the two sides and reports every disagreement at once — a single "first
 * mismatch" failure hides whether the drift is one block or the whole document.
 */
function sortOccurrences(occurrences: Geometry[]): Geometry[] {
  return [...occurrences].sort((a, b) => (
    a.pageIndex - b.pageIndex || a.y - b.y || a.x - b.x
  ));
}

function expectParity(
  editor: Record<string, Geometry[]>,
  paged: Record<string, Geometry[]>,
  ids: string[],
): void {
  const problems: string[] = [];
  for (const id of ids) {
    const left = editor[id] ? sortOccurrences(editor[id]) : null;
    const right = paged[id] ? sortOccurrences(paged[id]) : null;
    if (!left) {
      problems.push(`${id}: エディタに存在しない`);
      continue;
    }
    if (!right) {
      problems.push(`${id}: PDF面に存在しない`);
      continue;
    }
    if (left.length !== right.length) {
      problems.push(
        `${id}: 出現回数が違う editor=${left.length} pdf=${right.length}`
        + ` (editor pages=${left.map((item) => item.pageIndex).join("/")},`
        + ` pdf pages=${right.map((item) => item.pageIndex).join("/")})`,
      );
      continue;
    }
    left.forEach((leftItem, index) => {
      const rightItem = right[index];
      const label = left.length > 1 ? `${id}[${index}]` : id;
      if (leftItem.pageIndex !== rightItem.pageIndex) {
        problems.push(`${label}: ページが違う editor=${leftItem.pageIndex} pdf=${rightItem.pageIndex}`);
        return;
      }
      for (const axis of ["x", "y", "w", "h"] as const) {
        const delta = Math.abs(leftItem[axis] - rightItem[axis]);
        if (delta > TOLERANCE_PX) {
          problems.push(
            `${label}.${axis}: ${delta.toFixed(3)}px ずれ`
            + ` (editor=${leftItem[axis].toFixed(2)} pdf=${rightItem[axis].toFixed(2)})`,
          );
        }
      }
    });
  }
  expect(problems, problems.join("\n")).toEqual([]);
}

/**
 * Reads the output geometry once it stops changing.
 *
 * Overlay anchor resolution can nudge a shape after the surface has already cut its
 * windows, which rebuilds them. Waiting for the cut revision narrows that window but does
 * not close it — the last adjustment can land after the revision has been quiet. Two
 * identical reads is the property actually needed: the numbers being compared are final.
 */
async function settledPagedGeometry(page: Page): Promise<Record<string, Geometry[]>> {
  let previous = JSON.stringify(await pagedGeometry(page));
  let stable = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await page.waitForTimeout(150);
    const current = await pagedGeometry(page);
    const serialized = JSON.stringify(current);
    if (serialized === previous) {
      stable += 1;
      // Three quiet reads: a single repeat still slipped through when a late recompute
      // landed just after the comparison.
      if (stable >= 3) {
        return current;
      }
    } else {
      stable = 0;
      previous = serialized;
    }
  }
  return pagedGeometry(page);
}

async function runParity(page: Page, document: SigmaDocument, ids: string[]) {
  await openEditor(page, document);
  const editor = await editorGeometry(page);
  await openPaged(page, document);
  const paged = await settledPagedGeometry(page);
  expect(Object.keys(editor).length).toBeGreaterThan(0);
  expectParity(editor, paged, ids);
}

test("WebMCP Challenge fixture matches the desktop PDF surface", async ({ page }) => {
  test.setTimeout(120_000);
  await runParity(page, webMcpChallengeDocument as SigmaDocument, [
    "challenge_heading",
    "challenge_intro",
    "challenge_math",
    "challenge_explanation",
    "challenge_task",
    "challenge_shape_note",
    "challenge_graph",
    "challenge_table",
  ]);
});

test("本文が複数ページに渡っても、全ブロックが同じページの同じ位置に出る", async ({ page }) => {
  test.setTimeout(120_000);
  const document = documentWith(paragraphs("flow", 40));
  await runParity(page, document, Array.from({ length: 40 }, (_, i) => `flow_${i + 1}`));
});

test("ブロック下余白を含む本文が、編集面とPDF面で同じページの同じ位置に出る", async ({ page }) => {
  // 下余白は編集面・PDF 面とも `document-surface.css` の同じ custom property から出る。
  // 片側だけに CSS 差分ができると、余白ぶんずつページ割りが食い違ってここが落ちる。
  test.setTimeout(120_000);
  const content = paragraphs("space", 40).map((paragraph, index) => (
    index % 4 === 1 ? { ...paragraph, spaceAfterPx: 18 } : paragraph
  ));
  const document = documentWith(content);
  await runParity(page, document, Array.from({ length: 40 }, (_, i) => `space_${i + 1}`));
});

test("1ptの行・混在サイズ・数式・段落余白が編集面とPDF面で一致する", async ({ page }) => {
  test.setTimeout(120_000);
  const content: SigmaDocument["content"] = [
    { type: "paragraph", id: "tiny_note", children: [{ type: "text", text: "小さい注記", fontSize: 1 }] },
    { type: "paragraph", id: "mixed_sizes", children: [
      { type: "text", text: "本文\n" },
      { type: "text", text: "小さい文字で折り返す行。".repeat(140), fontSize: 1 },
    ] },
    { type: "paragraph", id: "tiny_space", lineHeight: "1.5", spaceAfterPx: 18, children: [{ type: "text", text: "段落余白", fontSize: 1 }] },
    { type: "paragraph", id: "tiny_math", children: [
      { type: "text", text: "注記", fontSize: 1 },
      { type: "mathInline", display: "inline", id: "tiny_fraction", tex: "\\dfrac{1}{\\dfrac{x}{y}}" },
    ] },
    ...paragraphs("following", 12),
  ];
  const source = documentWith(content);
  await openEditor(page, source);
  const editor = await editorGeometry(page);
  expect(editor.tiny_note[0].h).toBeLessThan(3);
  expect(editor.tiny_space[0].h).toBeCloseTo(20, 0);
  await setEditorZoom(page, 150);
  expectParity(editor, await editorGeometry(page), content.map((block) => block.id));
  await openPaged(page, source);
  const paged = await settledPagedGeometry(page);
  expectParity(editor, paged, [...content.map((block) => block.id), "tiny_fraction"]);
});

test("標準ゴシック・標準明朝を同梱フォントに固定し、編集面とPDF面で共有する", async ({ page }) => {
  test.setTimeout(120_000);
  const document = documentWith([
    {
      type: "paragraph",
      id: "fixed_sans_body",
      children: [{ type: "text", text: "日本語 ABC 123 Ⅱ⓪△ℓ₁₂ の固定ゴシック確認" }],
    },
    {
      type: "paragraph",
      id: "fixed_serif_body",
      children: [{
        type: "text",
        text: "日本語 ABC 123 Ⅱ⓪△ℓ₁₂ の固定明朝確認",
        fontFamily: 'ui-serif, "Yu Mincho", YuMincho, "Hiragino Mincho ProN", "BIZ UDPMincho", "MS PMincho", serif',
      }],
    },
  ]);

  await openEditor(page, document);
  const editorSans = await readRenderedFont(
    page,
    ".page-canvas [data-sigma-doc-id='fixed_sans_body']",
    "M PLUS 1p",
  );
  const editorSerif = await readRenderedFont(
    page,
    ".page-canvas [data-sigma-doc-id='fixed_serif_body'] span[style*='font-family']",
    "Noto Serif JP",
  );

  await openPaged(page, document);
  const pagedSans = await readRenderedFont(
    page,
    ".paged-surface-page [data-sigma-doc-id='fixed_sans_body']",
    "M PLUS 1p",
  );
  const pagedSerif = await readRenderedFont(
    page,
    ".paged-surface-page [data-sigma-doc-id='fixed_serif_body'] span[style*='font-family']",
    "Noto Serif JP",
  );

  expect(editorSans.family)
    .toBe('"M PLUS 1p", "Noto Sans Symbols", "STIX Two Math", sans-serif');
  expect(pagedSans.family).toBe(editorSans.family);
  expect(editorSerif.family)
    .toBe('"Noto Serif JP", "Noto Sans Symbols", "STIX Two Math", serif');
  expect(pagedSerif.family).toBe(editorSerif.family);
  for (const font of [editorSans, editorSerif, pagedSans, pagedSerif]) {
    expect(font.loadedFaceCount).toBeGreaterThan(0);
  }
  const serifPlatformFonts = await readPlatformFonts(
    page,
    ".paged-surface-page [data-sigma-doc-id='fixed_serif_body']",
  );
  expect(serifPlatformFonts.map((font) => font.familyName)).toEqual(expect.arrayContaining([
    "Noto Serif JP ExtraLight",
    "Noto Sans Symbols",
  ]));
  const sansPlatformFonts = await readPlatformFonts(
    page,
    ".paged-surface-page [data-sigma-doc-id='fixed_sans_body']",
  );
  expect(sansPlatformFonts.map((font) => font.familyName)).toEqual(expect.arrayContaining([
    "M PLUS 1p",
    "Noto Sans Symbols",
  ]));
  expect([...serifPlatformFonts, ...sansPlatformFonts].filter((font) => !font.isCustomFont))
    .toEqual([]);
});

test("共通テスト選択肢と一般数式が、編集面とPDF面で同じ静的組版箱を使う", async ({ page }) => {
  test.setTimeout(120_000);
  const document = documentWith([{
    type: "paragraph",
    id: "math_parity_body",
    children: [
      { type: "text", text: "選択肢" },
      {
        type: "mathInline",
        id: "math_parity_choice",
        tex: String.raw`\kyoutsuuchoice{0}`,
        display: "inline",
      },
      { type: "text", text: "と分数" },
      {
        type: "mathInline",
        id: "math_parity_fraction",
        tex: String.raw`\frac{x}{\frac{a}{b}}`,
        display: "inline",
      },
    ],
  }]);

  await runParity(page, document, [
    "math_parity_body",
    "math_parity_choice",
    "math_parity_fraction",
  ]);
});

test("実PDFでも最終ページの後に空白ページを追加しない", async ({ page }) => {
  test.setTimeout(120_000);
  const document = documentWith(paragraphs("real_pdf", 70), {
    pageLayout: {
      preset: "B5",
      orientation: "portrait",
      pageSize: { widthMm: 182, heightMm: 257 },
      marginsMm: { top: 18, right: 17, bottom: 18, left: 17 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
    },
  });
  await openPaged(page, document);

  const previewPageCount = Number(await page.locator(".paged-surface")
    .getAttribute("data-paged-surface-page-count"));
  expect(previewPageCount).toBeGreaterThan(1);

  const pdf = await page.pdf({
    displayHeaderFooter: false,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    preferCSSPageSize: true,
    printBackground: true,
  });
  const parsedPdf = await PDFDocument.load(pdf);
  expect(parsedPdf.getPageCount()).toBe(previewPageCount);
  const expectedWidthPoints = document.pageLayout!.pageSize.widthMm / 25.4 * 72;
  const expectedHeightPoints = document.pageLayout!.pageSize.heightMm / 25.4 * 72;
  for (const pdfPage of parsedPdf.getPages()) {
    const { width, height } = pdfPage.getMediaBox();
    expect(Math.abs(width - expectedWidthPoints)).toBeLessThanOrEqual(0.75);
    expect(Math.abs(height - expectedHeightPoints)).toBeLessThanOrEqual(0.75);
  }
});

test("コードのページ窓は編集ボタンを本文に混ぜず構文色を保つ", async ({ page }) => {
  const document = documentWith([{
    type: "codeBlock", id: "code_pdf", language: "javascript",
    children: [{ type: "text", text: "const answer = 42;" }],
  }]);
  await openEditor(page, document);
  const editingCode = page.locator('.page-canvas .print-code[data-sigma-doc-id="code_pdf"]');
  await expect(editingCode.locator('[data-code-block-action-button="true"]')).toHaveCount(1);
  await expect(editingCode.locator(".hljs-keyword")).toHaveText("const");

  await openPaged(page, document);
  const pageCode = page.locator('.paged-surface-page .print-code[data-sigma-doc-id="code_pdf"]');
  await expect(pageCode).toHaveText("const answer = 42;");
  await expect(pageCode.locator('[data-code-block-action-button="true"]')).toHaveCount(0);
  await expect(pageCode.locator(".hljs-keyword")).toHaveText("const");
});

async function readRenderedFont(
  page: Page,
  selector: string,
  face: string,
): Promise<{ family: string; loadedFaceCount: number }> {
  return page.evaluate(async ({ targetSelector, targetFace }) => {
    const element = document.querySelector<HTMLElement>(targetSelector);
    if (!element) {
      throw new Error(`本文要素が見つかりません: ${targetSelector}`);
    }
    const loadedFaces = await document.fonts.load(`400 16px "${targetFace}"`, "日本語 ABC 123");
    await document.fonts.ready;
    return {
      family: getComputedStyle(element).fontFamily,
      loadedFaceCount: loadedFaces.length,
    };
  }, { targetSelector: selector, targetFace: face });
}

async function readPlatformFonts(
  page: Page,
  selector: string,
): Promise<Array<{ familyName: string; isCustomFont: boolean }>> {
  const session = await page.context().newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) {
    throw new Error(`本文要素が見つかりません: ${selector}`);
  }
  const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
  await session.detach();
  return fonts;
}

test("2段組でも、全ブロックが同じページ・同じ段の同じ位置に出る", async ({ page }) => {
  test.setTimeout(120_000);
  const document = documentWith(paragraphs("col", 40), { columnCount: 2 });
  await runParity(page, document, Array.from({ length: 40 }, (_, i) => `col_${i + 1}`));
});

test("手動改ページを含む本文が、同じ位置で切り替わる", async ({ page }) => {
  test.setTimeout(120_000);
  const document = documentWith(paragraphs("brk", 24, 9));
  await runParity(page, document, Array.from({ length: 24 }, (_, i) => `brk_${i + 1}`));
});

test("枠付き問題エリアが、同じページの同じ位置に出る", async ({ page }) => {
  test.setTimeout(120_000);
  const document = documentWith([
    ...paragraphs("intro", 3),
    {
      type: "problem",
      id: "parity_problem",
      tags: [],
      numbering: { enabled: true },
      frame: { enabled: true },
      lead: paragraphs("lead", 1),
      prompt: paragraphs("prompt", 8),
      solution: paragraphs("solution", 8),
      hints: [],
    },
    ...paragraphs("outro", 6),
  ] as SigmaDocument["content"]);
  await runParity(page, document, [
    ...Array.from({ length: 3 }, (_, i) => `intro_${i + 1}`),
    "lead_1",
    ...Array.from({ length: 8 }, (_, i) => `prompt_${i + 1}`),
    ...Array.from({ length: 8 }, (_, i) => `solution_${i + 1}`),
    ...Array.from({ length: 6 }, (_, i) => `outro_${i + 1}`),
  ]);
});

test("確保高さ付き解答エリア先頭の改ページを編集面とPDF面で守る", async ({ page }) => {
  test.setTimeout(120_000);
  const document = documentWith([
    ...paragraphs("atomic_intro", 1),
    {
      type: "problem", id: "atomic_problem", tags: [],
      numbering: { enabled: false }, frame: { enabled: false },
      lead: [], prompt: paragraphs("atomic_prompt", 1), hints: [],
      solution: [{ ...paragraphs("atomic_solution", 1)[0], pagination: { break: true } }],
      areaLayout: { solution: { minHeightMm: 60 } },
    },
  ] as SigmaDocument["content"]);

  await openEditor(page, document);
  const editor = await editorGeometry(page);
  expect(editor.atomic_intro_1?.[0]?.pageIndex).toBe(0);
  expect(editor.atomic_solution_1?.[0]?.pageIndex).toBe(1);

  await openPaged(page, document);
  const paged = await settledPagedGeometry(page);
  expectParity(editor, paged, ["atomic_intro_1", "atomic_prompt_1", "atomic_solution_1"]);
});

test("ページを超える枠付き問題でも、2回続けてレンダーしたページ割りが一致する", async ({ page }) => {
  test.setTimeout(120_000);
  // 収まらない枠付き問題は「次ページ頭へ送って keep-together」に一本化した。以前は
  // 「atomic として送る」と「分割して個別に流す」が毎パス入れ替わり、同じ文書が
  // レンダーのたびに違うページ割りに落ち着いていた (gap が 114px ⇔ 4px を往復)。
  const document = documentWith([
    ...paragraphs("intro", 8),
    {
      type: "problem",
      id: "overflowing_problem",
      tags: [],
      numbering: { enabled: true },
      frame: { enabled: true },
      lead: [],
      prompt: paragraphs("tall_prompt", 3),
      solution: paragraphs("tall_solution", 70),
      hints: [],
    },
    ...paragraphs("outro", 6),
  ] as SigmaDocument["content"]);

  await openPaged(page, document);
  const first = await settledPagedGeometry(page);
  await openPaged(page, document);
  const second = await settledPagedGeometry(page);

  expect(Object.keys(first).length).toBeGreaterThan(0);
  expect(second).toEqual(first);
});

test("ページをまたぐ箱が、同じ位置で切れる", async ({ page }) => {
  test.setTimeout(120_000);
  const box = createBoxBlock("itembox");
  const document = documentWith([
    ...paragraphs("before", 4),
    { ...box, id: "parity_box", blocks: paragraphs("boxbody", 14) },
    ...paragraphs("after", 4),
  ] as SigmaDocument["content"]);
  await runParity(page, document, [
    ...Array.from({ length: 4 }, (_, i) => `before_${i + 1}`),
    ...Array.from({ length: 14 }, (_, i) => `boxbody_${i + 1}`),
    ...Array.from({ length: 4 }, (_, i) => `after_${i + 1}`),
  ]);
});

for (const columnCount of [1, 2]) {
  test(`箱内の手動区切りと入れ子の問題が編集面とPDF面で一致する (${columnCount}段)`, async ({ page }) => {
    const box = createBoxBlock("itembox");
    const document = documentWith([
      { ...box, id: "nested_box", blocks: [
        { type: "paragraph", id: "before_break", children: [{ type: "text", text: "区切りの前" }] },
        { type: "problem", id: "nested_problem", tags: [], lead: [], hints: [], solution: [],
          numbering: { value: 7 }, frame: { enabled: true, styleId: "doublebox" },
          areaLayout: { solution: { minHeightMm: 20 } }, prompt: [
          { type: "paragraph", id: "after_break", pagination: { break: true }, children: [{ type: "text", text: "区切りの後" }] },
        ] },
      ] },
      { type: "paragraph", id: "after_box", children: [{ type: "text", text: "箱の後" }] },
    ], { columnCount });
    await runParity(page, document, ["before_break", "after_break", "after_box"]);
  });
}

/**
 * Intermittent (roughly one run in three) and pinned: a shape anchored to a block on a
 * later page settles 2px — exactly its anchor `dy` — below where the editor puts it.
 *
 * Not a read race: waiting for three quiet reads of the output does not change it, so the
 * surface really settles there. `resolveShapesPosition` resolves against the block rects
 * captured by the last `recompute`, and those are measured BEFORE that pass applies its
 * page gaps. When no later pass happens to re-measure, the shape stays anchored to where
 * the block was rather than where the layout put it. Re-measuring once webfonts land
 * removed one trigger; the remaining fix is for `recompute` to store the rects it decided
 * (`measuredTop + cumulative gap`, which it already computes for box fragments) instead of
 * the ones it measured beforehand.
 */
/**
 * Reserve-space shapes make the layout circular — a shape reserves vertical space, that
 * pushes the block it is anchored to, and the shape follows the block — so this is the
 * case most sensitive to the pass not converging.
 */
test("ブロックにアンカーされた図形が、同じページの同じ位置に出る", async ({ page }) => {
  test.setTimeout(120_000);
  const document = documentWith(paragraphs("anchor", 30));
  document.pageLayout!.overlay = {
    overlaySnapshot: {
      version: 1,
      assets: {},
      shapes: [
        {
          id: "shape_page1",
          type: "geo",
          x: 40,
          y: 40,
          props: { w: 60, h: 40, geo: "rectangle", fill: "none", color: "#111827", labelColor: "#111827", dash: "solid", size: "m" },
          anchor: { type: "block", blockId: "anchor_2", dx: 10, dy: 4 },
        },
        {
          id: "shape_page3",
          type: "geo",
          x: 40,
          y: 900,
          props: { w: 50, h: 30, geo: "ellipse", fill: "solid", color: "#111827", fillColor: "#dbeafe", labelColor: "#111827", dash: "solid", size: "m" },
          anchor: { type: "block", blockId: "anchor_22", dx: 20, dy: 2 },
        },
      ],
    },
  } as never;
  await runParity(page, document, ["shape_page1", "shape_page3", "anchor_2", "anchor_22"]);
});

/**
 * A fill's transparency is a painted property: a stylesheet can override the presentation
 * attribute without changing the markup, so the two surfaces are compared on computed style.
 */
test("塗りの不透明度が、編集画面と PDF 面で同じ見た目になる", async ({ page }) => {
  test.setTimeout(120_000);
  const document = documentWith(paragraphs("fill", 8));
  document.pageLayout!.overlay = {
    overlaySnapshot: {
      version: 1,
      assets: {},
      shapes: [
        {
          id: "shape_fill_translucent",
          type: "geo",
          x: 40,
          y: 40,
          props: {
            geo: "rectangle",
            w: 90,
            h: 50,
            fill: "solid",
            fillColor: "#3366cc",
            fillOpacity: 0.35,
            color: "#111827",
            labelColor: "#111827",
            dash: "solid",
            size: "m",
          },
          anchor: { type: "block", blockId: "fill_2", dx: 10, dy: 4 },
        },
        {
          id: "shape_fill_invisible",
          type: "geo",
          x: 150,
          y: 40,
          props: {
            geo: "rectangle",
            w: 90,
            h: 50,
            fill: "solid",
            fillColor: "#cc3366",
            fillOpacity: 0,
            color: "#111827",
            labelColor: "#111827",
            dash: "solid",
            size: "m",
          },
          anchor: { type: "block", blockId: "fill_2", dx: 120, dy: 4 },
        },
      ],
    },
  } as never;

  await openEditor(page, document);
  const editorFills = await readPaintedFills(page);
  await openPaged(page, document);
  const pagedFills = await readPaintedFills(page);

  expect(editorFills).toEqual([
    "shape_fill_invisible|rgb(204, 51, 102)|0",
    "shape_fill_translucent|rgb(51, 102, 204)|0.35",
  ]);
  expect(pagedFills).toEqual(editorFills);
});

/** Each shape's painted fill, de-duplicated because the paged surface clones a page per window. */
async function readPaintedFills(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const seen = new Set<string>();
    for (const shape of Array.from(document.querySelectorAll("[data-overlay-shape-id]"))) {
      const drawn = shape.querySelector(".overlay-vector-svg > *:not(defs)");
      if (!drawn) {
        continue;
      }
      const painted = window.getComputedStyle(drawn);
      seen.add(`${shape.getAttribute("data-overlay-shape-id")}|${painted.fill}|${painted.fillOpacity}`);
    }
    return [...seen].sort();
  });
}

/**
 * The PDF path draws shapes with the same React components as the editor, so an arrow head that
 * only exists in the SVG string exporter would be invisible on paper. The heads all read one spec
 * table now; this checks the paper side of that claim rather than trusting the unit parity test.
 */
test("新しい端点装飾が、編集画面と PDF 面で同じマーカーとして出る", async ({ page }) => {
  test.setTimeout(120_000);
  const document = documentWith(paragraphs("head", 8));
  document.pageLayout!.overlay = {
    overlaySnapshot: {
      version: 1,
      assets: {},
      shapes: [
        {
          id: "shape_heads",
          type: "arrow",
          x: 40,
          y: 40,
          props: {
            start: { x: 0, y: 0 },
            end: { x: 160, y: 0 },
            arrowheadStart: "diamond",
            arrowheadEnd: "triangle",
            fill: "none",
            color: "#111827",
            labelColor: "#111827",
            dash: "solid",
            size: "l",
          },
          anchor: { type: "block", blockId: "head_2", dx: 10, dy: 4 },
        },
      ],
    },
  } as never;

  await openEditor(page, document);
  const editorMarkers = await readArrowheadMarkers(page);
  const editorSpan = await readDrawnLineSpans(page);
  await openPaged(page, document);
  const pagedMarkers = await readArrowheadMarkers(page);
  const pagedSpan = await readDrawnLineSpans(page);

  // `refX` sits behind each head's own tip (9 and 7) by exactly what the line gave up, so the head's
  // point lands on the stored endpoint. A stale 9/7 here would mean the paper still draws the line
  // past the tip.
  const diamondTrim = getArrowheadTrimInStrokes("diamond");
  const triangleTrim = getArrowheadTrimInStrokes("triangle");
  expect(editorMarkers).toEqual([
    `diamond-shape_heads-start|10|8|${9 - diamondTrim}|4|auto-start-reverse|M 1 4 L 5 1 L 9 4 L 5 7 Z|rgb(17, 24, 39)|none|3px|none`,
    `triangle-shape_heads-end|8|8|${7 - triangleTrim}|4|auto|M 1 1 L 7 4 L 1 7 Z|rgb(17, 24, 39)|none|3px|none`,
  ]);
  expect(pagedMarkers).toEqual(editorMarkers);

  // The ink itself: both heads' marker units of a 3px stroke come off a 160px line.
  expect(editorSpan).toEqual([`shape_heads|160|${Math.round(160 - (diamondTrim + triangleTrim) * 3)}`]);
  expect(pagedSpan).toEqual(editorSpan);
});

/** Each drawn `<line>`'s stored width and the width actually painted, de-duplicated per shape. */
async function readDrawnLineSpans(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const seen = new Set<string>();
    for (const shape of Array.from(document.querySelectorAll("[data-overlay-shape-id]"))) {
      const drawn = shape.querySelector(".overlay-vector-svg > line");
      if (!drawn) {
        continue;
      }
      const span = Number(drawn.getAttribute("x2")) - Number(drawn.getAttribute("x1"));
      const box = shape.getBoundingClientRect();
      seen.add(`${shape.getAttribute("data-overlay-shape-id")}|${Math.round(box.width - 20)}|${Math.round(span)}`);
    }
    return [...seen].sort();
  });
}

/**
 * Every distinct `<marker>` on the surface, flattened to one comparable string each. The paged
 * surface clones a page per window, so identical markers are de-duplicated before comparing.
 */
async function readArrowheadMarkers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const seen = new Set<string>();
    for (const marker of Array.from(document.querySelectorAll("marker"))) {
      const child = marker.firstElementChild;
      const geometry = child?.tagName === "circle"
        ? `circle ${child.getAttribute("cx")},${child.getAttribute("cy")} r${child.getAttribute("r")}`
        : child?.getAttribute("d") ?? "";
      // Computed style, not attributes: a head states its fill as a presentation attribute, which
      // any stylesheet on the surface silently outranks. Comparing the attributes alone would call
      // a hollow triangle identical to a filled one.
      const painted = child ? window.getComputedStyle(child) : null;
      seen.add([
        marker.getAttribute("id"),
        marker.getAttribute("markerWidth"),
        marker.getAttribute("markerHeight"),
        marker.getAttribute("refX"),
        marker.getAttribute("refY"),
        marker.getAttribute("orient"),
        geometry,
        painted?.fill,
        painted?.stroke,
        painted?.strokeWidth,
        painted?.strokeDasharray,
      ].join("|"));
    }
    return [...seen].sort();
  });
}

/**
 * The header/footer overlay was the last place the PDF path drew shapes from an SVG string, with
 * its own coordinate space: the editing band subtracted the page sheet's 2px border while the
 * displayed region did not, and the SVG `viewBox` scaled the difference away. React places shapes
 * at absolute px, so the two surfaces have to agree.
 *
 * The fixture stays short on purpose: a running-region shape is cloned onto every page, and
 * `expectParity` requires equal occurrence counts — the editor only mounts the pages inside its
 * window (`PAGE_WINDOW_OVERSCAN`), so a taller document would report fewer copies than the paged
 * surface. Keep any header/footer parity fixture within one window.
 */
test("ヘッダー/フッターの図形が、編集画面と PDF 面で同じ位置に出る", async ({ page }) => {
  test.setTimeout(120_000);
  const document = documentWith(paragraphs("running", 12));
  const runningOverlay = (id: string, geo: string) => ({
    overlaySnapshot: {
      version: 1,
      assets: {},
      shapes: [{
        id,
        type: "geo",
        x: 24,
        y: 6,
        props: { w: 48, h: 18, geo, fill: "none", color: "#111827", labelColor: "#111827", dash: "solid", size: "m" },
      }],
    },
  });
  document.pageLayout!.header = {
    enabled: true,
    heightMm: 16,
    offsetMm: 4,
    showOnFirstPage: true,
    blocks: [{ type: "paragraph", id: "running_header_text", children: [{ type: "text", text: "ヘッダー" }] }],
    overlay: runningOverlay("shape_header", "rectangle"),
  } as never;
  document.pageLayout!.footer = {
    enabled: true,
    heightMm: 16,
    offsetMm: 4,
    showOnFirstPage: true,
    blocks: [{ type: "paragraph", id: "running_footer_text", children: [{ type: "text", text: "フッター" }] }],
    overlay: runningOverlay("shape_footer", "ellipse"),
  } as never;

  await runParity(page, document, ["shape_header", "shape_footer"]);
});

/**
 * Invariant 5 of docs/pdf-parity-architecture.md: the PDF is always cut at 100%, so if
 * the zoom level changed the layout, editing at 80% would silently produce a different
 * paper than the one exported.
 */
test("ズーム倍率を変えても紙面が動かない", async ({ page }) => {
  test.setTimeout(240_000);
  const document = documentWith(paragraphs("zoom", 16));
  await openEditor(page, document);
  const at100 = await editorGeometrySnapshot(page);

  // 80% は倍率の選択肢に無い。ネイティブ select に流し込んでいた頃は値が "" になり、
  // 実際には下限の 10% が適用されていた。意図 (整数倍でない倍率) を保つ 75% に置き換える。
  for (const zoom of [50, 75, 150, 200]) {
    await setEditorZoom(page, zoom);
    // Reading a box through a non-integer transform and dividing back out leaves a
    // sub-pixel remainder in the reported *size* — 150% reports widths ~0.6px off while
    // 50/80/200% are exact. Position and page assignment, which are what decide the
    // paper, stay exact at every level.
    const sizeTolerance = Number.isInteger(zoom / 100) ? TOLERANCE_PX : 1;
    const scaled = await editorGeometrySnapshot(page);
    const problems: string[] = [];
    for (const [id, baseList] of Object.entries(at100)) {
      const otherList = scaled[id];
      if (!otherList || otherList.length !== baseList.length) {
        continue;
      }
      baseList.forEach((base, index) => {
        const other = otherList[index];
        for (const axis of ["x", "y"] as const) {
          const delta = Math.abs(base[axis] - other[axis]);
          if (delta > TOLERANCE_PX) {
            problems.push(`${zoom}% ${id}.${axis}: ${delta.toFixed(3)}px ずれ`);
          }
        }
        for (const axis of ["w", "h"] as const) {
          const delta = Math.abs(base[axis] - other[axis]);
          if (delta > sizeTolerance) {
            problems.push(`${zoom}% ${id}.${axis}: ${delta.toFixed(3)}px ずれ`);
          }
        }
        if (base.pageIndex !== other.pageIndex) {
          problems.push(`${zoom}% ${id}: ページが違う 100%=${base.pageIndex} ${zoom}%=${other.pageIndex}`);
        }
      });
    }
    expect(problems.slice(0, 12), problems.slice(0, 12).join("\n")).toEqual([]);
  }
});

test("枠付き問題エリア内の手動改ページでも、分割位置が一致する", async ({ page }) => {
  test.setTimeout(180_000);
  const document = documentWith([
    {
      type: "problem",
      id: "parity_framed_problem",
      tags: [],
      numbering: { enabled: false },
      frame: { enabled: true },
      lead: [],
      prompt: [
        ...paragraphs("framed", 6),
        ...paragraphs("framedb", 6, 1),
      ],
      solution: [],
      hints: [],
    },
  ] as SigmaDocument["content"]);
  await runParity(page, document, [
    ...Array.from({ length: 6 }, (_, i) => `framed_${i + 1}`),
    ...Array.from({ length: 6 }, (_, i) => `framedb_${i + 1}`),
  ]);
});

/**
 * The `object-break-parity` fixture: a two-paragraph framed prompt broken at the second.
 */
test("枠付き問題文を2段落だけで分割しても、位置が一致する", async ({ page }) => {
  test.setTimeout(180_000);
  const document = documentWith([
    {
      type: "problem",
      id: "parity_framed_problem",
      tags: [],
      numbering: { enabled: false },
      frame: { enabled: true },
      lead: [],
      prompt: paragraphs("parity_framed", 2, 2),
      solution: [],
      hints: [],
    },
  ] as SigmaDocument["content"]);
  await runParity(page, document, ["parity_framed_1", "parity_framed_2"]);
});
