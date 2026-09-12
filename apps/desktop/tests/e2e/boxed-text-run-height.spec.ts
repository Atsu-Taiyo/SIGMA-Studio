import { expect, test, type Page } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import type { OverlaySnapshot } from "@/components/editor/overlay-canvas/types";
import type { InlineNode, ParagraphNode, SigmaDocument } from "@/types/sigma-doc";

test("connects adjacent boxed body text and inline math with one shared frame height", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createBoxedInlineRunDocument());
  await page.goto("/");
  await expect(page.getByText("準備完了")).toBeVisible();

  await expect(page.locator('.page-flow .text-flow-editor [data-sigma-doc-id="p_boxed_japanese"]')).toBeVisible();
  await expect.poll(async () => boxedRunProof(page, '.page-flow .text-flow-editor [data-sigma-doc-id="p_boxed_japanese"]')).toMatchObject({
    ready: true,
    boxCount: 3,
    kinds: ["text", "math", "text"],
    connectLeft: [false, true, true],
    connectRight: [true, true, false],
    leftBorders: [expect.any(Number), 0, 0],
    rightBorders: [0, 0, expect.any(Number)],
  });

  const japaneseProof = await boxedRunProof(page, '.page-flow .text-flow-editor [data-sigma-doc-id="p_boxed_japanese"]');
  expect(japaneseProof.topDelta).toBeLessThanOrEqual(1);
  expect(japaneseProof.bottomDelta).toBeLessThanOrEqual(1);
  expect(japaneseProof.heightDelta).toBeLessThanOrEqual(1);
  expect(japaneseProof.seamGap).toBeLessThanOrEqual(1.5);
  expect(japaneseProof.maxFrameDelta).toBeLessThanOrEqual(0.75);
  expect(japaneseProof.maxMathOverflow).toBeLessThanOrEqual(1);

  // Two boxed math nodes followed by boxed text: ProseMirror coalesces the two
  // math atoms into one mark span, so the trailing text must still join the run
  // (regression: it used to fall back to its own standalone box).
  await expect.poll(async () => boxedRunProof(page, '.page-flow .text-flow-editor [data-sigma-doc-id="p_boxed_double"]')).toMatchObject({
    ready: true,
    boxCount: 3,
    kinds: ["math", "math", "text"],
    connectLeft: [false, true, true],
    connectRight: [true, true, false],
    leftBorders: [expect.any(Number), 0, 0],
    rightBorders: [0, 0, expect.any(Number)],
  });

  const doubleProof = await boxedRunProof(page, '.page-flow .text-flow-editor [data-sigma-doc-id="p_boxed_double"]');
  expect(doubleProof.maxMathOverflow).toBeLessThanOrEqual(1);
  expect(doubleProof.topDelta).toBeLessThanOrEqual(1);
  expect(doubleProof.bottomDelta).toBeLessThanOrEqual(1);
  expect(doubleProof.heightDelta).toBeLessThanOrEqual(1);
  expect(doubleProof.seamGap).toBeLessThanOrEqual(1.5);
  expect(doubleProof.outerLeftBorder).toBeGreaterThanOrEqual(2);
  expect(doubleProof.outerRightBorder).toBeGreaterThanOrEqual(2);

  await expect.poll(async () => boxedRunProof(page, '.page-flow .text-flow-editor [data-sigma-doc-id="p_boxed_styled_math_text"]')).toMatchObject({
    ready: true,
    boxCount: 3,
    kinds: ["math", "math", "text"],
    connectLeft: [false, true, true],
    connectRight: [true, true, false],
    leftBorders: [expect.any(Number), 0, 0],
    rightBorders: [0, 0, expect.any(Number)],
  });

  const styledMathTextProof = await boxedRunProof(page, '.page-flow .text-flow-editor [data-sigma-doc-id="p_boxed_styled_math_text"]');
  expect(styledMathTextProof.topDelta).toBeLessThanOrEqual(1);
  expect(styledMathTextProof.bottomDelta).toBeLessThanOrEqual(1);
  expect(styledMathTextProof.heightDelta).toBeLessThanOrEqual(1);
  expect(styledMathTextProof.seamGap).toBeLessThanOrEqual(1.5);
  expect(styledMathTextProof.maxMathOverflow).toBeLessThanOrEqual(1);

  await expect.poll(async () => boxedRunProof(page, '.page-flow .text-flow-editor [data-sigma-doc-id="p_boxed_tall"]')).toMatchObject({
    ready: true,
    boxCount: 3,
    kinds: ["text", "math", "text"],
    connectLeft: [false, true, true],
    connectRight: [true, true, false],
  });
  const tallProof = await boxedRunProof(page, '.page-flow .text-flow-editor [data-sigma-doc-id="p_boxed_tall"]');
  expect(tallProof.heightDelta).toBeLessThanOrEqual(1);
  expect(tallProof.maxMathOverflow).toBeLessThanOrEqual(1);

  await expect.poll(async () => boxedRunProof(page, '.page-flow .text-flow-editor [data-sigma-doc-id="p_boxed_gap"]')).toMatchObject({
    ready: true,
    boxCount: 3,
    connectLeft: [false, false, false],
    connectRight: [false, false, false],
  });
});

/**
 * Regression guard for the paged render: the boxed-run frame ends are decided by a
 * measuring pass that lands after the geometry has stopped moving, so a surface cut
 * before it ran printed frames open at both ends. The windows are rebuilt when the
 * staged canvas changes, which is what keeps these flags in sync with the editor.
 */
test("prints boxed inline text and math with the same connected frame semantics", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createBoxedInlineRunDocument());
  await page.goto("/print?fileId=file_e2e_document");

  await expect(page.locator('.paged-surface-page [data-sigma-doc-id="p_boxed_japanese"]')).toBeVisible();
  await expect.poll(async () => boxedRunProof(page, '.paged-surface-page [data-sigma-doc-id="p_boxed_japanese"]')).toMatchObject({
    ready: true,
    boxCount: 3,
    kinds: ["text", "math", "text"],
    connectLeft: [false, true, true],
    connectRight: [true, true, false],
    leftBorders: [expect.any(Number), 0, 0],
    rightBorders: [0, 0, expect.any(Number)],
  });

  const japaneseProof = await boxedRunProof(page, '.paged-surface-page [data-sigma-doc-id="p_boxed_japanese"]');
  expect(japaneseProof.topDelta).toBeLessThanOrEqual(1);
  expect(japaneseProof.bottomDelta).toBeLessThanOrEqual(1);
  expect(japaneseProof.heightDelta).toBeLessThanOrEqual(1);
  expect(japaneseProof.seamGap).toBeLessThanOrEqual(1.5);
  expect(japaneseProof.maxFrameDelta).toBeLessThanOrEqual(0.75);
  expect(japaneseProof.maxMathOverflow).toBeLessThanOrEqual(1);

  await expect.poll(async () => boxedRunProof(page, '.paged-surface-page [data-sigma-doc-id="p_boxed_double"]')).toMatchObject({
    ready: true,
    boxCount: 3,
    kinds: ["math", "math", "text"],
    connectLeft: [false, true, true],
    connectRight: [true, true, false],
    leftBorders: [expect.any(Number), 0, 0],
    rightBorders: [0, 0, expect.any(Number)],
  });

  const doubleProof = await boxedRunProof(page, '.paged-surface-page [data-sigma-doc-id="p_boxed_double"]');
  expect(doubleProof.topDelta).toBeLessThanOrEqual(1);
  expect(doubleProof.bottomDelta).toBeLessThanOrEqual(1);
  expect(doubleProof.heightDelta).toBeLessThanOrEqual(1);
  expect(doubleProof.maxMathOverflow).toBeLessThanOrEqual(1);
  expect(doubleProof.seamGap).toBeLessThanOrEqual(1.5);
  expect(doubleProof.outerLeftBorder).toBeGreaterThanOrEqual(2);
  expect(doubleProof.outerRightBorder).toBeGreaterThanOrEqual(2);

  await expect.poll(async () => boxedRunProof(page, '.paged-surface-page [data-sigma-doc-id="p_boxed_styled_math_text"]')).toMatchObject({
    ready: true,
    boxCount: 3,
    kinds: ["math", "math", "text"],
    connectLeft: [false, true, true],
    connectRight: [true, true, false],
    leftBorders: [expect.any(Number), 0, 0],
    rightBorders: [0, 0, expect.any(Number)],
  });

  const styledMathTextProof = await boxedRunProof(page, '.paged-surface-page [data-sigma-doc-id="p_boxed_styled_math_text"]');
  expect(styledMathTextProof.topDelta).toBeLessThanOrEqual(1);
  expect(styledMathTextProof.bottomDelta).toBeLessThanOrEqual(1);
  expect(styledMathTextProof.heightDelta).toBeLessThanOrEqual(1);
  expect(styledMathTextProof.maxMathOverflow).toBeLessThanOrEqual(1);
  expect(styledMathTextProof.seamGap).toBeLessThanOrEqual(1.5);

  await expect.poll(async () => boxedRunProof(page, '.paged-surface-page [data-sigma-doc-id="p_boxed_tall"]')).toMatchObject({
    ready: true,
    boxCount: 3,
    kinds: ["text", "math", "text"],
    connectLeft: [false, true, true],
    connectRight: [true, true, false],
  });
  const tallProof = await boxedRunProof(page, '.paged-surface-page [data-sigma-doc-id="p_boxed_tall"]');
  expect(tallProof.heightDelta).toBeLessThanOrEqual(1);
  expect(tallProof.maxMathOverflow).toBeLessThanOrEqual(1);
});

test("connects adjacent boxed figure text and inline math with one shared frame height", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createOverlayBoxedTextDocument());
  await page.goto("/");
  await expect(page.getByText("準備完了")).toBeVisible();

  const selector = '.page-overlay-preview .rich-inline-content:has([data-id="m_overlay_boxed_tall"])';
  await expect(page.locator(selector)).toBeVisible();
  await expect.poll(async () => boxedRunProof(page, selector)).toMatchObject({
    aligned: true,
    ready: true,
    measuring: false,
    boxCount: 3,
    kinds: ["text", "math", "text"],
    connectLeft: [false, true, true],
    connectRight: [true, true, false],
    leftBorders: [expect.any(Number), 0, 0],
    rightBorders: [0, 0, expect.any(Number)],
  });
  await expect.poll(async () => (await boxedRunProof(page, selector)).maxFrameDelta).toBeLessThanOrEqual(0.75);

  const proof = await boxedRunProof(page, selector);
  expect(proof.topDelta).toBeLessThanOrEqual(1);
  expect(proof.bottomDelta).toBeLessThanOrEqual(1);
  expect(proof.heightDelta).toBeLessThanOrEqual(1);
  expect(proof.seamGap).toBeLessThanOrEqual(1.5);
  expect(proof.maxFrameDelta).toBeLessThanOrEqual(0.75);
  expect(proof.maxMathOverflow).toBeLessThanOrEqual(1);
});

test("connects adjacent boxed figure text and inline math while the text shape is focused", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createOverlayBoxedTextDocument());
  await page.goto("/");
  await expect(page.getByText("準備完了")).toBeVisible();
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 20_000 }).catch(() => undefined);

  const previewShape = page.locator('.page-overlay-preview [data-overlay-shape-id="shape_overlay_boxed_text"]').first();
  await expect(previewShape).toBeVisible();
  const previewShapeBox = await previewShape.boundingBox();
  expect(previewShapeBox).not.toBeNull();
  await page.mouse.click(previewShapeBox!.x + 180, previewShapeBox!.y + 36);

  const selectedShape = page.locator('[data-overlay-shape-id="shape_overlay_boxed_text"].overlay-shape-text.selected').first();
  await expect(selectedShape).toBeVisible();
  const selectedShapeBox = await selectedShape.boundingBox();
  expect(selectedShapeBox).not.toBeNull();
  await page.mouse.click(selectedShapeBox!.x + 180, selectedShapeBox!.y + 36);

  const selector = '.overlay-shape-text .ProseMirror[contenteditable="true"] p:has([data-id="m_overlay_boxed_tall"])';
  await expect(page.locator(selector)).toBeVisible();
  await expect.poll(async () => boxedRunProof(page, selector)).toMatchObject({
    aligned: true,
    ready: true,
    measuring: false,
    boxCount: 3,
    kinds: ["text", "math", "text"],
    connectLeft: [false, true, true],
    connectRight: [true, true, false],
    leftBorders: [expect.any(Number), 0, 0],
    rightBorders: [0, 0, expect.any(Number)],
  });

  const proof = await boxedRunProof(page, selector);
  expect(proof.topDelta).toBeLessThanOrEqual(1);
  expect(proof.bottomDelta).toBeLessThanOrEqual(1);
  expect(proof.heightDelta).toBeLessThanOrEqual(1);
  expect(proof.seamGap).toBeLessThanOrEqual(1.5);
  expect(proof.maxMathOverflow).toBeLessThanOrEqual(1);
});

test("keeps the boxed frame proportional to text when the page is zoomed in", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 950 });
  await installDesktopRuntimeMock(page, createBoxedInlineRunDocument());
  await page.goto("/");

  const sel = '.page-flow .text-flow-editor [data-sigma-doc-id="p_boxed_japanese"]';
  await expect(page.locator(sel)).toBeVisible();
  await expect.poll(async () => (await boxedRunProof(page, sel)).ready).toBe(true);
  const baseHeight = (await boxedRunProof(page, sel)).maxBoxHeight;

  const zoomIn = page.locator('button[aria-label="拡大"]');
  for (let index = 0; index < 6; index += 1) {
    await zoomIn.click({ timeout: 5000 });
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(700);

  // The canvas is scaled with a transform now, so the applied factor is the custom
  // property both the CSS and the measurement code read — `zoom` is always 1 here.
  const zoom = await page.evaluate(() => Number.parseFloat(
    getComputedStyle(document.querySelector(".page-stack")!).getPropertyValue("--editor-zoom"),
  ));
  expect(zoom).toBeGreaterThan(1.2);

  const zoomedProof = await boxedRunProof(page, sel);
  // Frame height must track zoom LINEARLY (≈ base × zoom). The regression measured
  // zoom-scaled rects and re-applied them inside the zoomed container, so the frame
  // grew by zoom² — caught by the upper bound below (zoom² > base × zoom × 1.3).
  expect(zoomedProof.maxBoxHeight).toBeLessThan(baseHeight * zoom * 1.3);
  expect(zoomedProof.maxBoxHeight).toBeGreaterThan(baseHeight * zoom * 0.7);
  // …and text + math stay aligned inside the run.
  expect(zoomedProof.heightDelta).toBeLessThanOrEqual(1.5);
  expect(zoomedProof.maxMathOverflow).toBeLessThanOrEqual(1.5);
});

test("a 0pt boxed frame hugs its content and grows with padding", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 950 });
  await installDesktopRuntimeMock(page, createBoxedInlineRunDocument());
  await page.goto("/");

  const sel0 = '.page-flow .text-flow-editor [data-sigma-doc-id="p_boxed_pad0"]';
  const sel8 = '.page-flow .text-flow-editor [data-sigma-doc-id="p_boxed_pad8"]';
  await expect(page.locator(sel0)).toBeVisible();
  await expect.poll(async () => (await boxedRunProof(page, sel0)).ready).toBe(true);

  const pad0 = await boxedRunProof(page, sel0);
  const pad8 = await boxedRunProof(page, sel8);

  // 0pt frame hugs the content: line-height:1 strips the font's line-box leading,
  // which otherwise leaves ~13px of CJK leading around the content at 0pt. A small
  // residual remains for sub-1em math (the 1em line box), so the bound is loose.
  expect(pad0.minMathGap).toBeLessThanOrEqual(6);
  expect(pad0.maxMathOverflow).toBeLessThanOrEqual(1);

  // Padding still expands the frame by ~2×paddingY (the content-measurement attempt
  // collapsed this — border-box height was pinned to the content so padding squished it).
  expect(pad8.maxBoxHeight - pad0.maxBoxHeight).toBeGreaterThan(12);
  expect(pad8.maxBoxHeight - pad0.maxBoxHeight).toBeLessThan(20);
});

test("keeps boxed content on the same baseline as the surrounding text", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createBoxedInlineRunDocument());
  await page.goto("/");
  await expect(page.getByText("準備完了")).toBeVisible();

  const lowMathSel = '.page-flow .text-flow-editor [data-sigma-doc-id="p_boxed_baseline_low"]';
  await expect(page.locator(lowMathSel)).toBeVisible();
  await expect.poll(async () => (await boxedRunProof(page, lowMathSel)).ready).toBe(true);
  const lowMathProof = await boxedBaselineProof(page, lowMathSel);
  expect(lowMathProof.bottomDelta).toBeLessThanOrEqual(1);

  const textOnlySel = '.page-flow .text-flow-editor [data-sigma-doc-id="p_boxed_baseline_text_only"]';
  await expect(page.locator(textOnlySel)).toBeVisible();
  await expect.poll(async () => (await boxedRunProof(page, textOnlySel)).ready).toBe(true);
  const textOnlyProof = await boxedBaselineProof(page, textOnlySel);
  expect(textOnlyProof.bottomDelta).toBeLessThanOrEqual(1);
});

test("keeps boxed content on the same baseline as the surrounding text when printed", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createBoxedInlineRunDocument());
  await page.goto("/print?fileId=file_e2e_document");

  const lowMathSel = '.paged-surface-page [data-sigma-doc-id="p_boxed_baseline_low"]';
  await expect(page.locator(lowMathSel)).toBeVisible();
  await expect.poll(async () => (await boxedRunProof(page, lowMathSel)).ready).toBe(true);
  const lowMathProof = await boxedBaselineProof(page, lowMathSel);
  expect(lowMathProof.bottomDelta).toBeLessThanOrEqual(1);

  const textOnlySel = '.paged-surface-page [data-sigma-doc-id="p_boxed_baseline_text_only"]';
  await expect(page.locator(textOnlySel)).toBeVisible();
  await expect.poll(async () => (await boxedRunProof(page, textOnlySel)).ready).toBe(true);
  const textOnlyProof = await boxedBaselineProof(page, textOnlySel);
  expect(textOnlyProof.bottomDelta).toBeLessThanOrEqual(1);
});

test("the next inserted box reuses the last applied variant and padding", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 950 });
  await installDesktopRuntimeMock(page, createPlainParagraphsDocument());
  await page.goto("/");

  const boxInfo = (id: string) => page.evaluate((docId) => {
    const mark = document.querySelector(`.text-flow-editor [data-sigma-doc-id="${docId}"] .boxed-text`);
    if (!mark) {
      return { boxed: false, variant: null as string | null, padding: 0 };
    }
    return {
      boxed: true,
      variant: mark.getAttribute("data-sigma-doc-boxed-variant"),
      padding: Number.parseFloat(getComputedStyle(mark).getPropertyValue("--boxed-text-padding-y")) || 0,
    };
  }, id);

  // Apply 二重 (double) + 3px padding to the first paragraph.
  await page.locator('.text-flow-editor [data-sigma-doc-id="p_plain_a"]').click({ clickCount: 3 });
  await page.locator(".boxed-text-menu-trigger").click();
  await page.getByRole("button", { name: "二重" }).click();
  for (let index = 0; index < 3; index += 1) {
    await page.locator('button[aria-label="上下余白を1px増やす"]').click();
  }
  await page.keyboard.press("Escape");
  await expect.poll(() => boxInfo("p_plain_a")).toMatchObject({ boxed: true, variant: "double", padding: 3 });

  // Toggling a box on a different, unstyled selection must reuse double + 3px —
  // the selection-tracking toolbar state resets to frame/0 on unboxed text, so this
  // relies on the persisted "last applied format" (regression guard).
  await page.locator('.text-flow-editor [data-sigma-doc-id="p_plain_b"]').click({ clickCount: 3 });
  await page.locator(".boxed-text-toggle-button").click();
  await expect.poll(() => boxInfo("p_plain_b")).toMatchObject({ boxed: true, variant: "double", padding: 3 });
});

/**
 * The per-segment border is the INTENT on the overlay surfaces, not an accident.
 *
 * A boxed run is drawn two different ways in this app: the document body draws one rectangle for
 * the whole run (`drawRunFrames`), and the overlay text shape and table cells paint a border per
 * segment. The second one leaves a seam wherever segments of different natural heights meet, so
 * "merge the segments into one span and let its own line box be the frame" was investigated as a
 * way to remove the seam without measuring anything (WI-14). The geometry works — a merged span
 * with `display: inline-block` encloses a tall `\sum` with zero measurement — but the merge cannot
 * be reproduced on the editing surface, so adopting it would make the box jump on focus:
 *
 * - ProseMirror can only keep one mark span open across adjacent nodes when the mark is *equal* on
 *   both, and `lib/tiptap-adapter.ts` puts `math: true` on the boxed mark of every math atom. A
 *   text + math run therefore splits at the mark level, before any decoration is involved —
 *   measured: two adjacent boxed maths coalesce into ONE `.boxed-text` span, but the text beside
 *   them always gets its own.
 * - `styledText` (priority 300) nests outside `boxed` (200) so the `0.18em` padding scales with the
 *   font the styling sets, which splits a run again wherever colour/font/size changes.
 *
 * Reaching one span therefore means changing the document schema, not the DOM — see the long note
 * in `document-surface.css` above `.boxed-run-framed …` for the measurements and the full argument.
 *
 * This test pins the resulting contract so the difference stays deliberate: only the body draws the
 * single rectangle; the overlay surfaces paint segment borders in BOTH focus states, which is what
 * keeps the box identical across a focus change.
 */
test("overlay text and table cells paint a border per segment while the body draws one rectangle", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 950 });
  await installDesktopRuntimeMock(page, createSegmentBorderIntentDocument());
  await page.goto("/");
  await expect(page.getByText("準備完了")).toBeVisible();

  const bodySelector = '.page-flow .text-flow-editor [data-sigma-doc-id="p_intent_body"]';
  await expect(page.locator(bodySelector)).toBeVisible();
  await expect.poll(async () => segmentBorderProof(page, bodySelector)).toMatchObject({
    stable: true,
    boxedSpans: 3,
    // The body's single rectangle, drawn from the measured run geometry.
    runFrames: 1,
    framed: true,
  });

  const overlaySelector = '.page-overlay-preview .rich-inline-content:has([data-id="m_intent_overlay"])';
  await expect(page.locator(overlaySelector)).toBeVisible();
  await expect.poll(async () => segmentBorderProof(page, overlaySelector)).toMatchObject({
    stable: true,
    boxedSpans: 3,
    // No rectangle anywhere on the static overlay layer — the run is painted by the segments.
    runFrames: 0,
    framed: false,
    // Outer edges of the run are drawn, inner edges are dropped, so the segments read as one box.
    innerBorders: [0, 0, 0, 0],
    // The mark attribute that keeps a text + math run from being held in one span.
    mathAttributes: [null, "true", null],
  });
  const overlayProof = await segmentBorderProof(page, overlaySelector);
  expect(overlayProof.outerLeftBorder).toBeGreaterThanOrEqual(1);
  expect(overlayProof.outerRightBorder).toBeGreaterThanOrEqual(1);

  const cellSelector = '.page-overlay-preview [data-overlay-shape-id="shape_intent_table"] td:has([data-id="m_intent_cell"])';
  await expect(page.locator(cellSelector)).toBeVisible();
  await expect.poll(async () => segmentBorderProof(page, cellSelector)).toMatchObject({
    stable: true,
    boxedSpans: 3,
    runFrames: 0,
    framed: false,
    innerBorders: [0, 0, 0, 0],
  });
  const cellProof = await segmentBorderProof(page, cellSelector);
  expect(cellProof.outerLeftBorder).toBeGreaterThanOrEqual(1);
  expect(cellProof.outerRightBorder).toBeGreaterThanOrEqual(1);

  // Focusing the shape must not swap in a drawn rectangle: that swap is the divergence the
  // `drawRunFrames: false` on these surfaces exists to prevent.
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 20_000 }).catch(() => undefined);
  const previewShape = page.locator('.page-overlay-preview [data-overlay-shape-id="shape_intent_overlay"]').first();
  await expect(previewShape).toBeVisible();
  const previewBox = await previewShape.boundingBox();
  expect(previewBox).not.toBeNull();
  await page.mouse.click(previewBox!.x + 180, previewBox!.y + 36);
  const selectedShape = page.locator('[data-overlay-shape-id="shape_intent_overlay"].overlay-shape-text.selected').first();
  await expect(selectedShape).toBeVisible();
  const selectedBox = await selectedShape.boundingBox();
  expect(selectedBox).not.toBeNull();
  await page.mouse.click(selectedBox!.x + 180, selectedBox!.y + 36);

  const focusedSelector = '.overlay-shape-text .ProseMirror[contenteditable="true"] p:has([data-id="m_intent_overlay"])';
  await expect(page.locator(focusedSelector)).toBeVisible();
  await expect.poll(async () => segmentBorderProof(page, focusedSelector)).toMatchObject({
    stable: true,
    boxedSpans: 3,
    runFrames: 0,
    framed: false,
    // Same painting pattern as the idle view above: the box must not change on focus.
    innerBorders: [0, 0, 0, 0],
    mathAttributes: [null, "true", null],
  });
  const focusedProof = await segmentBorderProof(page, focusedSelector);
  expect(focusedProof.outerLeftBorder).toBeGreaterThanOrEqual(1);
  expect(focusedProof.outerRightBorder).toBeGreaterThanOrEqual(1);
});

/**
 * What paints the run's outline under `rootSelector`, and where.
 *
 * `innerBorders` are the edges that face a neighbour (every seam contributes the right edge of one
 * segment and the left edge of the next); `outerLeftBorder` / `outerRightBorder` are the two ends
 * of the run. Segment painting means: ends drawn, seams dropped.
 *
 * Read four times across animation frames and reported as `stable` only when all four agree and
 * none of them was taken while the measuring pass was in flight. Two matching reads are not
 * enough — the geometry settles through a measure → decoration → re-measure chain, and the
 * measuring pass forces every segment's border back on (`.boxed-run-measuring …` in
 * `document-surface.css`), so a read taken inside it reports seams that are not really painted.
 */
async function segmentBorderProof(page: Page, rootSelector: string): Promise<{
  boxedSpans: number;
  framed: boolean;
  innerBorders: number[];
  mathAttributes: Array<string | null>;
  outerLeftBorder: number;
  outerRightBorder: number;
  runFrames: number;
  stable: boolean;
}> {
  return page.evaluate(async (selector) => {
    const read = () => {
      const root = document.querySelector<HTMLElement>(selector);
      const boxes = Array.from(root?.querySelectorAll<HTMLElement>(".boxed-text") ?? [])
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      // The painting element is the height target (the box itself in static output, a nested
      // decoration span on the editing surface) — `.boxed-text` around it has `border: 0`.
      const painters = boxes.map((box) => box.querySelector<HTMLElement>('[data-boxed-run-height-target="true"]') ?? box);
      const borderWidth = (element: HTMLElement | undefined, side: "Left" | "Right") => (
        element ? Number.parseFloat(getComputedStyle(element)[`border${side}Width`]) || 0 : 0
      );
      const innerBorders: number[] = [];
      painters.forEach((painter, index) => {
        if (index > 0) {
          innerBorders.push(borderWidth(painter, "Left"));
        }
        if (index < painters.length - 1) {
          innerBorders.push(borderWidth(painter, "Right"));
        }
      });
      // A drawn rectangle anywhere in the same shape (or in the framed container, for the body)
      // counts: the point is that these surfaces produce none at all.
      const frameScope = root?.closest(".boxed-run-framed")
        ?? root?.closest("[data-overlay-shape-id]")
        ?? root;
      return {
        boxedSpans: boxes.length,
        framed: Boolean(root?.closest(".boxed-run-framed")),
        innerBorders,
        mathAttributes: boxes.map((box) => box.getAttribute("data-sigma-doc-boxed-math")),
        measuring: Boolean(document.querySelector(".boxed-run-measuring")),
        outerLeftBorder: borderWidth(painters[0], "Left"),
        outerRightBorder: borderWidth(painters[painters.length - 1], "Right"),
        runFrames: frameScope?.querySelectorAll(".boxed-run-frame").length ?? 0,
      };
    };

    const reads = [read()];
    for (let index = 0; index < 3; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      reads.push(read());
    }
    const serialized = reads.map((entry) => JSON.stringify(entry));
    const { measuring, ...last } = reads[reads.length - 1];
    void measuring;
    return {
      ...last,
      stable: serialized.every((entry) => entry === serialized[0]) && reads.every((entry) => !entry.measuring),
    };
  }, rootSelector);
}

async function boxedRunProof(page: Page, rootSelector: string): Promise<{
  aligned: boolean;
  bottomDelta: number;
  boxCount: number;
  connectLeft: boolean[];
  connectRight: boolean[];
  heightDelta: number;
  kinds: string[];
  leftBorders: number[];
  maxBoxHeight: number;
  maxFrameDelta: number;
  maxMathOverflow: number;
  measuring: boolean;
  minMathGap: number;
  outerLeftBorder: number;
  outerRightBorder: number;
  ready: boolean;
  rightBorders: number[];
  seamGap: number;
  topDelta: number;
}> {
  return page.evaluate(async (selector) => {
    type RunMetric = {
      borderLeft: number;
      borderRight: number;
      bottom: number;
      connectLeft: boolean;
      connectRight: boolean;
      height: number;
      kind: "math" | "text";
      left: number;
      mathContentHeight: number;
      mathOverflow: number;
      right: number;
      top: number;
    };

    const read = () => {
      const root = document.querySelector<HTMLElement>(selector);
      const runs = (root
        ? Array.from(root.querySelectorAll<HTMLElement>('[data-boxed-run-height-target="true"]'))
        : [])
        .filter((element) => Boolean(element.closest(".boxed-text")))
        .map((element): RunMetric => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);

          // 数式ノードは素の DOM (`.inline-math-node` が計測対象そのもの)。React ノードビュー
          // だった頃は Tiptap の包みが計測対象で、数式はその子だった。
          const isMath = element.matches(".inline-math-node") || Boolean(element.querySelector(".inline-math-node"));
          const mathEl = element.querySelector(".math-preview")
            ?? (element.matches(".inline-math-node") ? element : element.querySelector(".inline-math-node"));
          const mathRect = mathEl?.getBoundingClientRect();
          return {
            borderLeft: Number.parseFloat(style.borderLeftWidth) || 0,
            borderRight: Number.parseFloat(style.borderRightWidth) || 0,
            bottom: rect.bottom,
            connectLeft: element.getAttribute("data-boxed-run-connect-left") === "true",
            connectRight: element.getAttribute("data-boxed-run-connect-right") === "true",
            height: rect.height,
            kind: isMath ? "math" : "text",
            left: rect.left,
            mathContentHeight: mathRect ? mathRect.height : 0,
            mathOverflow: mathRect ? Math.max(0, rect.top - mathRect.top, mathRect.bottom - rect.bottom) : 0,
            right: rect.right,
            top: rect.top,
          };
        })
        .sort((a, b) => a.left - b.left);

      return {
        aligned: root?.getAttribute("data-boxed-run-aligned") === "true",
        measuring: Boolean(document.querySelector(".boxed-run-measuring, .boxed-inline-run-measuring")),
        runs,
      };
    };

    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const first = read();
    const frames = [first];
    for (let index = 0; index < 30; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      frames.push(read());
    }

    let maxFrameDelta = 0;
    for (const frame of frames.slice(1)) {
      frame.runs.forEach((run, index) => {
        const base = first.runs[index];
        if (!base) {
          return;
        }
        for (const key of ["bottom", "height", "left", "right", "top"] as const) {
          maxFrameDelta = Math.max(maxFrameDelta, Math.abs(run[key] - base[key]));
        }
      });
    }

    const tops = first.runs.map((run) => run.top);
    const bottoms = first.runs.map((run) => run.bottom);
    const heights = first.runs.map((run) => run.height);
    const seamGaps = first.runs.slice(1).map((run, index) => Math.abs(run.left - first.runs[index].right));

    return {
      bottomDelta: bottoms.length > 1 ? Math.max(...bottoms) - Math.min(...bottoms) : 0,
      aligned: first.aligned,
      boxCount: first.runs.length,
      connectLeft: first.runs.map((run) => run.connectLeft),
      connectRight: first.runs.map((run) => run.connectRight),
      heightDelta: heights.length > 1 ? Math.max(...heights) - Math.min(...heights) : 0,
      kinds: first.runs.map((run) => run.kind),
      leftBorders: first.runs.map((run) => run.borderLeft),
      maxBoxHeight: heights.length > 0 ? Math.max(...heights) : 0,
      maxFrameDelta,
      maxMathOverflow: first.runs.length > 0 ? Math.max(0, ...first.runs.map((run) => run.mathOverflow)) : 0,
      measuring: frames.some((frame) => frame.measuring),
      minMathGap: (() => {
        const gaps = first.runs.filter((run) => run.kind === "math").map((run) => run.height - run.mathContentHeight);
        return gaps.length > 0 ? Math.min(...gaps) : 0;
      })(),
      outerLeftBorder: first.runs[0]?.borderLeft ?? 0,
      outerRightBorder: first.runs[first.runs.length - 1]?.borderRight ?? 0,
      ready: first.aligned && first.runs.length > 0 && frames.every((frame) => !frame.measuring),
      rightBorders: first.runs.map((run) => run.borderRight),
      seamGap: seamGaps.length > 0 ? Math.max(...seamGaps) : 0,
      topDelta: tops.length > 1 ? Math.max(...tops) - Math.min(...tops) : 0,
    };
  }, rootSelector);
}

/**
 * Compares the glyph baseline of the first text node *inside* a boxed run against
 * the first text node *outside* it, within the same container. Height + `vertical-
 * align: top` regresses this: when the line's strut (line-height:1.8) is taller
 * than the frame, the frame — and everything inside it — pins to the top of the
 * line, so the boxed text's glyphs sit a few px below the baseline of the
 * surrounding unboxed text. Baseline-anchoring keeps both on the same line.
 */
async function boxedBaselineProof(page: Page, rootSelector: string): Promise<{ bottomDelta: number; innerBottom: number; outerBottom: number }> {
  return page.evaluate((selector) => {
    const root = document.querySelector<HTMLElement>(selector);
    if (!root) {
      throw new Error(`missing root for selector: ${selector}`);
    }

    const rectOf = (node: Text): DOMRect => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      range.detach();
      return rect;
    };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let outerNode: Text | null = null;
    let innerNode: Text | null = null;
    let current: Node | null;
    while ((current = walker.nextNode())) {
      const text = current as Text;
      if (!text.textContent || text.textContent.trim().length === 0) {
        continue;
      }
      const insideBoxed = Boolean(text.parentElement?.closest(".boxed-text"));
      if (insideBoxed) {
        innerNode ??= text;
      } else {
        outerNode ??= text;
      }
      if (innerNode && outerNode) {
        break;
      }
    }

    if (!innerNode || !outerNode) {
      throw new Error(`could not find both an inner and outer text node under: ${selector}`);
    }

    const outerBottom = rectOf(outerNode).bottom;
    const innerBottom = rectOf(innerNode).bottom;
    return {
      bottomDelta: Math.abs(outerBottom - innerBottom),
      innerBottom,
      outerBottom,
    };
  }, rootSelector);
}

/**
 * Two boxed maths of very different heights, adjacent, so ProseMirror coalesces them
 * into one mark span. The tall `\sum` sets the run height and the short `\frac12` has
 * to be stretched up to it — the case where both members used to be measured as the
 * whole span, leaving the fraction at its natural height with a notch in the frame.
 */
function boxedSumThenFractionParagraph(): ParagraphNode {
  return {
    type: "paragraph",
    id: "p_boxed_sum_frac",
    lineHeight: "1.8",
    children: [
      { type: "text", text: "式", marks: ["boxed"] },
      { type: "mathInline", id: "m_boxed_sum", tex: "\\sum_{k=1}^{n}", display: "inline", marks: ["boxed"] },
      { type: "mathInline", id: "m_boxed_frac", tex: "\\frac{1}{2}", display: "inline", marks: ["boxed"] },
      { type: "text", text: "です", marks: ["boxed"] },
    ],
  };
}

function createBoxedInlineRunDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "boxed_inline_run_connection_doc",
    metadata: { title: "囲み文字と数式の接続" },
    content: [
      boxedJapaneseParagraph(),
      boxedDoubleParagraph(),
      boxedStyledMathThenTextParagraph(),
      boxedTallParagraph(),
      boxedPaddingParagraph("p_boxed_pad0", 0),
      boxedPaddingParagraph("p_boxed_pad8", 8),
      boxedGapParagraph(),
      boxedSumThenFractionParagraph(),
      boxedBaselineLowMathParagraph(),
      boxedBaselineTextOnlyParagraph(),
    ],
    outputProfiles: {
      student: {},
      teacher: { showSolutions: true, showHints: true },
      answerBook: { includeAnswers: true, onlySolutions: true },
    },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 18, right: 18, bottom: 18, left: 18 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
    },
  };
}

function createOverlayBoxedTextDocument(): SigmaDocument {
  const overlaySnapshot: OverlaySnapshot = {
    version: 1,
    assets: {},
    shapes: [
      {
        id: "shape_overlay_boxed_text",
        type: "text",
        x: 80,
        y: 90,
        props: {
          w: 360,
          h: 72,
          color: "#111827",
          size: "m",
          blocks: [
              {
                type: "paragraph", id: "boxed_text_run_height_spec_39",
                lineHeight: "1.8",
                children: [
                  {
                    type: "text",
                    text: "辺",
                    marks: ["boxed"],
                    boxedPaddingY: 0,
                  },
                  {
                    type: "mathInline",
                    id: "m_overlay_boxed_tall",
                    tex: "\\sum_{k=1}^{n} k",
                    display: "inline",
                    marks: ["boxed"],
                    boxedPaddingY: 0,
                  },
                  {
                    type: "text",
                    text: "は",
                    marks: ["boxed"],
                    boxedPaddingY: 0,
                  },
                ],
              },
            ],
        },
      },
    ],
  };

  return {
    version: "2.0",
    docId: "overlay_boxed_inline_run_connection_doc",
    metadata: { title: "図中の囲み文字と数式の接続" },
    content: [
      { type: "paragraph", id: "p_overlay_context", children: [{ type: "text", text: "図中テキストの囲み検証" }] },
    ],
    outputProfiles: {
      student: {},
      teacher: { showSolutions: true, showHints: true },
      answerBook: { includeAnswers: true, onlySolutions: true },
    },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 18, right: 18, bottom: 18, left: 18 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
      overlay: { overlaySnapshot },
    },
  };
}

/** One text + math + text boxed run on each of the three surfaces that draw one. */
function createSegmentBorderIntentDocument(): SigmaDocument {
  const boxedRun = (mathId: string): InlineNode[] => ([
    { type: "text", text: "辺", marks: ["boxed"], boxedPaddingY: 0 },
    { type: "mathInline", id: mathId, tex: "\\sum_{k=1}^{n} k", display: "inline", marks: ["boxed"], boxedPaddingY: 0 },
    { type: "text", text: "は", marks: ["boxed"], boxedPaddingY: 0 },
  ]);

  const overlaySnapshot: OverlaySnapshot = {
    version: 1,
    assets: {},
    shapes: [
      {
        id: "shape_intent_overlay",
        type: "text",
        x: 80,
        y: 90,
        props: {
          w: 360,
          h: 72,
          color: "#111827",
          size: "m",
          blocks: [{ type: "paragraph", id: "boxed_text_run_height_spec_40", lineHeight: "1.8", children: boxedRun("m_intent_overlay") }],
        },
      },
      {
        id: "shape_intent_table",
        type: "tableShape",
        x: 80,
        y: 220,
        rotation: 0,
        props: {
          w: 320,
          h: 80,
          table: {
            version: 1,
            kind: "plain",
            columns: [
              { id: "intent_col_1", width: { mode: "fixed", value: 200 } },
              { id: "intent_col_2", width: { mode: "fixed", value: 120 } },
            ],
            rows: [{ id: "intent_row_1", height: { mode: "fixed", value: 80 }, role: "body" }],
            cells: [
              {
                id: "intent_cell_boxed",
                rowId: "intent_row_1",
                columnId: "intent_col_1",
                content: [{ type: "paragraph", id: "intent_cell_boxed_p", align: "center", children: boxedRun("m_intent_cell") }],
              },
              {
                id: "intent_cell_plain",
                rowId: "intent_row_1",
                columnId: "intent_col_2",
                content: [{ type: "paragraph", id: "intent_cell_plain_p", align: "center", children: [{ type: "text", text: "B" }] }],
              },
            ],
            grid: {
              borderColor: "#111827",
              borderWidth: 1,
              borderStyle: "solid",
              showOuterBorder: true,
              showInnerBorders: true,
              lineOverrides: [],
            },
            defaultCellStyle: {
              align: "center",
              verticalAlign: "middle",
              paddingX: 8,
              paddingY: 5,
              color: "#111827",
              fontSize: 15,
              fontWeight: "normal",
            },
          },
        },
      },
    ],
  };

  return {
    version: "2.0",
    docId: "boxed_segment_border_intent_doc",
    metadata: { title: "囲み枠をセグメントごとに描く面" },
    content: [
      {
        type: "paragraph",
        id: "p_intent_body",
        lineHeight: "1.8",
        children: boxedRun("m_intent_body"),
      },
    ],
    outputProfiles: {
      student: {},
      teacher: { showSolutions: true, showHints: true },
      answerBook: { includeAnswers: true, onlySolutions: true },
    },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 18, right: 18, bottom: 18, left: 18 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
      overlay: { overlaySnapshot },
    },
  };
}

function boxedJapaneseParagraph(): ParagraphNode {
  return {
    type: "paragraph",
    id: "p_boxed_japanese",
    lineHeight: "1.8",
    children: [
      // Real boxed body text also carries a font/style mark, which nests the
      // height-target span below `.boxed-text` (regression guard for the
      // direct-child CSS combinator failing on styled text).
      { type: "text", text: "辺", marks: ["boxed"], fontFamily: "serif" },
      { type: "mathInline", id: "m_boxed_japanese", tex: "\\overline{P(\\alpha)Q(\\beta)}", display: "inline", marks: ["boxed"] },
      { type: "text", text: "は", marks: ["boxed"], fontFamily: "serif" },
    ],
  };
}

function boxedDoubleParagraph(): ParagraphNode {
  return {
    type: "paragraph",
    id: "p_boxed_double",
    lineHeight: "1.8",
    children: [
      { type: "mathInline", id: "m_boxed_double_left", tex: "\\alpha\\beta = X + Yi", display: "inline", marks: ["boxed"], boxedVariant: "double" },
      { type: "mathInline", id: "m_boxed_double_middle", tex: "\\alpha\\beta", display: "inline", marks: ["boxed"], boxedVariant: "double" },
      { type: "text", text: "とすると,", marks: ["boxed"], boxedVariant: "double", fontFamily: "serif" },
    ],
  };
}

function boxedStyledMathThenTextParagraph(): ParagraphNode {
  return {
    type: "paragraph",
    id: "p_boxed_styled_math_text",
    lineHeight: "1.8",
    children: [
      {
        type: "mathInline",
        id: "m_boxed_styled_left",
        tex: "\\left(3\\text{次関数の}\\right)",
        display: "inline",
        marks: ["boxed"],
        fontFamily: "\"Hiragino Sans\", \"Hiragino Kaku Gothic ProN\", sans-serif",
        fontSize: 14,
        boxedPaddingY: 12,
      },
      {
        type: "mathInline",
        id: "m_boxed_styled_right",
        tex: "Max・\\min",
        display: "inline",
        marks: ["boxed"],
        fontFamily: "\"Hiragino Sans\", \"Hiragino Kaku Gothic ProN\", sans-serif",
        fontSize: 14,
        boxedPaddingY: 12,
      },
      {
        type: "text",
        text: "の問題に帰着する！",
        marks: ["boxed"],
        fontFamily: "\"Hiragino Sans\", \"Hiragino Kaku Gothic ProN\", sans-serif",
        fontSize: 14,
        boxedPaddingY: 12,
      },
    ],
  };
}

function boxedTallParagraph(): ParagraphNode {
  // A genuinely tall inline math (limits above/below) must stay fully enclosed by
  // the shared frame — the literal "数式の高さと枠線を揃える" requirement.
  return {
    type: "paragraph",
    id: "p_boxed_tall",
    lineHeight: "1.8",
    children: [
      { type: "text", text: "辺", marks: ["boxed"], fontFamily: "serif" },
      { type: "mathInline", id: "m_boxed_tall", tex: "\\sum_{k=1}^{n} k", display: "inline", marks: ["boxed"] },
      { type: "text", text: "は", marks: ["boxed"], fontFamily: "serif" },
    ],
  };
}

function createPlainParagraphsDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "boxed_inherit_doc",
    metadata: { title: "囲み形式の引き継ぎ" },
    content: [
      { type: "paragraph", id: "p_plain_a", children: [{ type: "text", text: "あいうえお" }] },
      { type: "paragraph", id: "p_plain_b", children: [{ type: "text", text: "かきくけこ" }] },
    ],
    outputProfiles: {
      student: {},
      teacher: { showSolutions: true, showHints: true },
      answerBook: { includeAnswers: true, onlySolutions: true },
    },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 18, right: 18, bottom: 18, left: 18 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
    },
  };
}

function boxedPaddingParagraph(id: string, paddingY: number): ParagraphNode {
  // Single boxed math so the frame height is driven purely by the math content
  // (no neighbouring text descent). Lets us assert: 0pt hugs the math, and padding
  // grows the frame by 2×paddingY.
  return {
    type: "paragraph",
    id,
    lineHeight: "1.8",
    children: [
      { type: "mathInline", id: `m_${id}`, tex: "x+1", display: "inline", marks: ["boxed"], boxedPaddingY: paddingY },
    ],
  };
}

function boxedGapParagraph(): ParagraphNode {
  return {
    type: "paragraph",
    id: "p_boxed_gap",
    lineHeight: "1.8",
    children: [
      { type: "text", text: "A", marks: ["boxed"] },
      { type: "text", text: " " },
      { type: "mathInline", id: "m_boxed_gap", tex: "x", display: "inline", marks: ["boxed"] },
      { type: "text", text: " " },
      { type: "text", text: "B", marks: ["boxed"] },
    ],
  };
}

function boxedBaselineLowMathParagraph(): ParagraphNode {
  // A short (low) inline math inside a boxed run, in a 1.8 line-height paragraph.
  // The line box's strut is taller than the frame, which is exactly the case that
  // regresses under `height` + `vertical-align: top` (the frame pins to the line's
  // top and its content floats below the surrounding text's baseline).
  return {
    type: "paragraph",
    id: "p_boxed_baseline_low",
    lineHeight: "1.8",
    children: [
      { type: "text", text: "外A" },
      { type: "text", text: "辺", marks: ["boxed"] },
      { type: "mathInline", id: "m_boxed_baseline_low", tex: "x+1", display: "inline", marks: ["boxed"] },
      { type: "text", text: "は", marks: ["boxed"] },
      { type: "text", text: "外B" },
    ],
  };
}

function boxedBaselineTextOnlyParagraph(): ParagraphNode {
  // A boxed run with no math at all — also taller-strut-than-frame, so it must stay
  // on the same baseline as the unboxed text around it.
  return {
    type: "paragraph",
    id: "p_boxed_baseline_text_only",
    lineHeight: "1.8",
    children: [
      { type: "text", text: "外C" },
      { type: "text", text: "重要", marks: ["boxed"] },
      { type: "text", text: "外D" },
    ],
  };
}

test("stretches a short boxed fraction to the tall sum coalesced beside it", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createBoxedInlineRunDocument());
  await page.goto("/");
  await expect(page.getByText("準備完了")).toBeVisible();

  const selector = '.page-flow .text-flow-editor [data-sigma-doc-id="p_boxed_sum_frac"]';
  await expect(page.locator(selector)).toBeVisible();
  await expect.poll(async () => boxedRunProof(page, selector)).toMatchObject({
    ready: true,
    boxCount: 4,
    kinds: ["text", "math", "math", "text"],
    connectLeft: [false, true, true, true],
    connectRight: [true, true, true, false],
  });

  const proof = await boxedRunProof(page, selector);
  expect(proof.heightDelta).toBeLessThanOrEqual(1);
  expect(proof.topDelta).toBeLessThanOrEqual(1);
  expect(proof.bottomDelta).toBeLessThanOrEqual(1);

  // The outline is ONE drawn rectangle enclosing the whole run, not a border per segment
  // meeting at the seams. Per-segment borders left a third of a pixel of misalignment
  // beside the fraction, which showed as a sliver poking out under the frame.
  const frame = await page.evaluate((rootSelector) => {
    const root = document.querySelector<HTMLElement>(rootSelector);
    const frames = Array.from(root?.querySelectorAll<HTMLElement>(".boxed-run-frame") ?? []);
    if (frames.length !== 1) {
      return { count: frames.length };
    }
    const box = frames[0].getBoundingClientRect();
    const segments = Array.from(root!.querySelectorAll<HTMLElement>('[data-boxed-run-height-target="true"]'))
      .map((element) => element.getBoundingClientRect());
    return {
      count: 1,
      // Every segment sits inside the drawn rectangle, and the rectangle hugs them.
      overhangTop: Math.max(...segments.map((rect) => box.top - rect.top)),
      overhangBottom: Math.max(...segments.map((rect) => rect.bottom - box.bottom)),
    };
  }, selector);
  expect(frame.count).toBe(1);
  expect(frame.overhangTop!).toBeLessThanOrEqual(0.25);
  expect(frame.overhangBottom!).toBeLessThanOrEqual(0.25);
  expect(proof.seamGap).toBeLessThanOrEqual(1.5);
  expect(proof.maxMathOverflow).toBeLessThanOrEqual(1);
});
