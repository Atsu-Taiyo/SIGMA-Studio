import { expect, test } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { waitForPagedSurfaceSettled } from "./paged-surface";

/**
 * Regression cover for overlay text that outgrows its stored box.
 *
 * The editor draws overlay text as absolutely positioned HTML with `overflow: visible`, so text
 * larger than `props.w`/`props.h` still shows on screen. The PDF used to be produced by a second
 * renderer that put the same text inside an SVG `<foreignObject>`, where Chromium drops glyphs
 * that fall outside the rect rather than clipping them at paint time — the overflow silently
 * vanished from the PDF. The PDF path now shares the editor's DOM (see the second test), and the
 * `foreignObject` rule lives with the SVG serialiser that still needs it.
 *
 * Both fixtures below store a box far too small for their content: a callout whose text wraps to
 * many lines, and a text shape holding a big operator (~2.9em tall, where the old estimator
 * assumed 1em). Each assertion checks the *rendered* geometry rather than the stored props,
 * because the fix derives the drawn box from the content instead of mutating the document.
 */

const CALLOUT_STORED_HEIGHT = 48;
const CALLOUT_TEXT = "この吹き出しの本文は保存されている高さよりもずっと長く、折り返して何行にもなります。印刷時に途中で消えてはいけません。";
const TEXT_SHAPE_STORED_HEIGHT = 16;

function overflowingOverlayDocument(): SigmaDocument {
  const problem = sampleDocument.content.find((block) => block.type === "problem");
  if (!problem || problem.type !== "problem") {
    throw new Error("Overlay text overflow E2E fixture requires the sample problem");
  }

  return {
    ...sampleDocument,
    content: [{ ...problem, lead: [], hints: [], solution: [] }],
    pageLayout: {
      ...sampleDocument.pageLayout,
      overlay: {
        ...sampleDocument.pageLayout?.overlay,
        overlaySnapshot: {
          version: 1,
          assets: {},
          shapes: [
            {
              id: "shape_overflow_callout",
              type: "callout",
              x: 60,
              y: 420,
              rotation: 0,
              props: {
                w: 200,
                h: CALLOUT_STORED_HEIGHT,
                radius: 18,
                tail: {
                  baseStart: { x: 44, y: CALLOUT_STORED_HEIGHT },
                  baseEnd: { x: 84, y: CALLOUT_STORED_HEIGHT },
                  tip: { x: 28, y: CALLOUT_STORED_HEIGHT + 28 },
                },
                blocks: [{ type: "paragraph", id: "overlay_text_overflow_spec_46", children: [{ type: "text", text: CALLOUT_TEXT }] }],
                color: "#111111",
                size: "m",
                dash: "solid",
                strokeWidth: "m",
              },
            },
            {
              id: "shape_overflow_math_text",
              type: "text",
              x: 330,
              y: 420,
              rotation: 0,
              props: {
                w: 160,
                h: TEXT_SHAPE_STORED_HEIGHT,
                color: "#111111",
                size: "m",
                blocks: [{
                    type: "paragraph", id: "overlay_text_overflow_spec_47",
                    children: [{
                      type: "mathInline",
                      id: "math_overflow_sum",
                      tex: "\\sum_{i=1}^{n} i",
                      display: "inline",
                    }],
                  }],
              },
            },
          ],
        },
      },
    },
  } as SigmaDocument;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await installDesktopRuntimeMock(page, overflowingOverlayDocument());
});

test("grows the on-screen box of overlay text that outgrows its stored size", async ({ page }) => {
  await page.goto("/");

  const callout = page.locator('[data-overlay-shape-id="shape_overflow_callout"]');
  await expect(callout).toBeVisible();
  // The stored body is 48px plus a 28px tail. Wrapped to a 200px-wide box the text needs several
  // lines, so the drawn shape has to be substantially taller than the stored geometry.
  await expect.poll(async () => (await callout.boundingBox())?.height ?? 0)
    .toBeGreaterThan(CALLOUT_STORED_HEIGHT + 28);

  const mathText = page.locator('[data-overlay-shape-id="shape_overflow_math_text"]');
  await expect(mathText).toBeVisible();
  // A big operator with both limits is ~2.9em; a 16px stored height is one line.
  await expect.poll(async () => (await mathText.boundingBox())?.height ?? 0)
    .toBeGreaterThan(TEXT_SHAPE_STORED_HEIGHT * 1.8);
});

/**
 * The PDF path stopped being a second renderer.
 *
 * This test used to open the PDF preview and inspect `<foreignObject>` elements inside
 * `.print-page-overlay-layer`, because the preview was `PrintPreview`, which serialised the
 * overlay to an SVG string. Since the PDF-parity rewrite the preview (and the exported PDF) is
 * `PagedRenderSurface`, which cuts pages out of the same canvas DOM the editor draws — there is no
 * `foreignObject` and no `.print-page-overlay-layer` on this path at all. `PrintPreview` itself is
 * still live for the page navigator, workspace/template thumbnails and the embedded viewer
 * package, so its SVG overlay path is not dead code; it just is not what the PDF is made of.
 *
 * The `overflow="visible"` + bled-out rect invariant those assertions protected still applies to
 * that SVG serialiser, and it is pinned where that code lives:
 * `src/features/rendering/adapters/svg/overlay-svg.test.ts` ("height=… overflow=\"visible\"").
 * What this test checks now is the property the PDF path actually has to hold: the box the print
 * output draws is the *content* box, so nothing is cut off.
 */
test("draws overflowing overlay text at its content height in the PDF preview", async ({ page }) => {
  await page.goto("/");
  const sourceCallout = page.locator('[data-overlay-shape-id="shape_overflow_callout"]');
  const sourceMathText = page.locator('[data-overlay-shape-id="shape_overflow_math_text"]');
  await expect(sourceCallout).toBeVisible();
  // DOM measurement writes the derived heights back on the next animation frame. Wait for the
  // canvas to own those final boxes before asking the PDF surface to snapshot the SigmaDoc.
  await expect.poll(async () => (await sourceCallout.boundingBox())?.height ?? 0)
    .toBeGreaterThan(CALLOUT_STORED_HEIGHT + 28);
  await expect.poll(async () => (await sourceMathText.boundingBox())?.height ?? 0)
    .toBeGreaterThan(TEXT_SHAPE_STORED_HEIGHT * 1.8);

  await page.getByRole("button", { name: "ファイル", exact: true }).click();
  await page.getByRole("menuitem", { name: "エクスポート" }).hover();
  await page.getByRole("menuitem", { name: "PDFを書き出し" }).click();
  await expect(page.getByRole("dialog", { name: "PDFプレビュー" })).toBeVisible();
  await waitForPagedSurfaceSettled(page);

  // Measure the page windows: those are the printed output. `.paged-surface-stage` is only the
  // off-screen source canvas (`left: -100000px`), so a shape could be missing from every printed
  // page and a stage-scoped assertion would still pass. Every window holds a complete copy of the
  // canvas, but `applyPageOwnership` (`print/paged-render/page-windows.ts`) strips
  // `data-overlay-shape-id` from the windows that do not own the shape, so this stays
  // document-wide on multi-page documents.
  const printedShapes = page.locator(".paged-surface-page .page-overlay-preview [data-overlay-shape-id]");
  await expect(printedShapes).toHaveCount(2);

  const boxes = await printedShapes.evaluateAll((nodes) => nodes.map((node) => ({
    id: node.getAttribute("data-overlay-shape-id"),
    height: Math.round(node.getBoundingClientRect().height),
    scrollHeight: (node as HTMLElement).scrollHeight,
    clientHeight: (node as HTMLElement).clientHeight,
  })));

  for (const box of boxes) {
    // Nothing may need scrolling to be seen: the drawn box is derived from the content, so a
    // mis-estimate can only make the shape slightly too tall, never clip ink out of the PDF.
    expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight);
  }

  const callout = boxes.find((box) => box.id === "shape_overflow_callout");
  expect(callout).toBeDefined();
  // The stored box is one line tall plus a 28px tail; the wrapped sentence needs several lines.
  expect(callout!.height).toBeGreaterThan(CALLOUT_STORED_HEIGHT + 28);
  const mathText = boxes.find((box) => box.id === "shape_overflow_math_text");
  expect(mathText).toBeDefined();
  // A big operator with both limits is ~2.9em; the stored 16px height is one line.
  expect(mathText!.height).toBeGreaterThan(TEXT_SHAPE_STORED_HEIGHT * 1.8);

  // The full sentence must survive into the print DOM, not just its first line.
  await expect(page.locator('.paged-surface-page [data-overlay-shape-id="shape_overflow_callout"]'))
    .toContainText(CALLOUT_TEXT);
});
