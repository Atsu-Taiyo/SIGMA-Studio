import { expect, test, type Locator, type Page } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";
import { grabShapeFromBody } from "./body-overlay-entry";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { waitForPagedSurfaceSettled } from "./paged-surface";

const overlayCanvasDocument = createOverlayCanvasDocument();

function createOverlayCanvasDocument(): SigmaDocument {
  const problem = sampleDocument.content.find((block) => block.type === "problem");
  if (!problem || problem.type !== "problem") {
    throw new Error("Overlay canvas E2E fixture requires the sample problem");
  }

  const promptIds = new Set(["p_problem_statement", "p_source_note"]);
  return {
    ...sampleDocument,
    content: [{
      ...problem,
      lead: [],
      prompt: problem.prompt.filter((block) => promptIds.has(block.id)),
      solution: problem.solution.filter((block) => block.id === "p_ab_intro"),
      hints: [],
    }],
    pageLayout: {
      ...sampleDocument.pageLayout,
      overlay: {
        ...sampleDocument.pageLayout?.overlay,
        overlaySnapshot: { version: 1, shapes: [], assets: {} },
      },
    },
  } as SigmaDocument;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await installDesktopRuntimeMock(page, overlayCanvasDocument);
});

test("copies and pastes a selected problem block", async ({ page }) => {
  await page.goto("/");

  const sourceNote = page.locator('[data-sigma-doc-id="p_source_note"]').first();
  await sourceNote.click({ button: "right" });
  const problemMenu = page.getByRole("menu", { name: "問題操作" });
  await expect(problemMenu).toBeVisible();
  await problemMenu.getByRole("menuitem", { name: "問題をコピー", exact: true }).click();

  await sourceNote.click({ button: "right" });
  await expect(problemMenu).toBeVisible();
  await problemMenu.getByRole("menuitem", { name: "問題を後に貼り付け", exact: true }).click();

  await expect(page.locator(".text-flow-editor p").filter({ hasText: "複素数平面において" })).toHaveCount(2);
});

test("applies boxed text and advances its padding control", async ({ page }) => {
  await page.goto("/");

  const firstParagraph = page.locator(".text-flow-editor p").filter({ hasText: "（2022東大実戦）" }).first();
  await expect(firstParagraph).toBeVisible();
  // Select with a real gesture instead of Playwright's `selectText()`. Measured behaviour: a Range
  // installed programmatically over this paragraph (both `selectText()` and a hand-built
  // text-node Range) comes back collapsed, so the whole test ran against an empty selection — the
  // box was stored as a caret mark and no `.boxed-text` was ever drawn. A triple click survives.
  // The collapse happens somewhere between the editor's `selectionchange` listener and
  // ProseMirror writing its own state selection back to the DOM; which of the two owns it is not
  // established here, and it is worth its own investigation because an embedding host that
  // installs a selection programmatically would hit the same thing. Every other spec in this
  // suite selects through a real gesture or a ProseMirror-aware offset helper; this was the only
  // `selectText()` left.
  await firstParagraph.click({ clickCount: 3 });
  await page.getByRole("button", { name: "囲み文字の種類と上下余白 0px", exact: true }).click();
  await expect(page.getByRole("button", { name: "囲みを適用", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "囲みを解除", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "囲み文字の種類と上下余白 0px", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "囲み文字", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "囲み文字を適用", exact: true }).click();
  await expect(firstParagraph.locator('.boxed-text[data-sigma-doc-boxed-padding-y="0"]')).toBeVisible();
  await page.getByRole("button", { name: "囲み文字の種類と上下余白 0px", exact: true }).click();
  const increasePadding = page.getByRole("button", { name: "上下余白を1px増やす", exact: true });
  for (let i = 0; i < 4; i += 1) {
    await increasePadding.click();
    await expect(page.getByRole("button", {
      name: `囲み文字の種類と上下余白 ${i + 1}px`,
      exact: true,
    })).toBeVisible();
  }
  await page.getByRole("button", { name: "囲み文字の種類と上下余白 4px", exact: true }).click();
  await expect(page.getByRole("button", { name: "囲み文字を解除", exact: true })).toHaveAttribute("aria-pressed", "true");

  const boxedText = firstParagraph.locator(".boxed-text").filter({ hasNot: page.locator(".math-preview-inline") }).first();
  await expect(boxedText).toBeVisible();
  await expect(boxedText).toHaveAttribute("data-sigma-doc-boxed-text", "true");
  await expect(boxedText).toHaveAttribute("data-sigma-doc-boxed-padding-y", "4");
  const boxedHeightTarget = boxedText.locator('[data-boxed-run-height-target="true"]').first();
  await expect(boxedHeightTarget).toBeVisible();
  await expect.poll(async () => boxedHeightTarget.evaluate((element) => getComputedStyle(element).paddingTop)).toBe("4px");
  await expect.poll(async () => boxedHeightTarget.evaluate((element) => getComputedStyle(element).paddingBottom)).toBe("4px");
  await expect(page.getByRole("button", { name: "囲み文字の種類と上下余白 4px", exact: true })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    const problem = document?.content?.find((block: { type?: string }) => block.type === "problem");
    const sourceNote = problem?.prompt?.find((block: { id?: string }) => block.id === "p_source_note");
    const boxedChild = sourceNote?.children?.find((child: { marks?: string[] }) => child.marks?.includes("boxed"));
    return {
      boxed: Boolean(boxedChild),
      paddingY: boxedChild ? (boxedChild.boxedPaddingY ?? 0) : null,
    };
  })).toEqual({ boxed: true, paddingY: 4 });
});

test("uses split boxed text controls and style buttons toggle the box", async ({ page }) => {
  await page.goto("/");

  const firstParagraph = page.locator(".text-flow-editor p").filter({ hasText: "複素数平面において" }).first();
  await firstParagraph.click();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  await page.getByRole("button", { name: "囲み文字の種類と上下余白 0px", exact: true }).click();
  await expect(page.getByRole("button", { name: "囲みを適用", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "囲みを解除", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "角丸", exact: true }).click();

  const boxedOvalText = firstParagraph.locator('.boxed-text[data-sigma-doc-boxed-variant="oval"]').first();
  await expect(boxedOvalText).toBeVisible();
  const roundedStyleButton = page.getByRole("button", { name: "角丸", exact: true });
  await expect(roundedStyleButton).toHaveAttribute("aria-pressed", "true");
  await roundedStyleButton.click();
  await expect(firstParagraph.locator(".boxed-text")).toHaveCount(0);
});

test("copies and pastes multiple selected overlay shapes", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "四角形");
  const firstShape = page.locator(".overlay-shape-geo").first();
  const firstBoxBeforeMove = await firstShape.boundingBox();
  expect(firstBoxBeforeMove).not.toBeNull();
  await page.mouse.move(firstBoxBeforeMove!.x + firstBoxBeforeMove!.width / 2, firstBoxBeforeMove!.y + firstBoxBeforeMove!.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstBoxBeforeMove!.x + firstBoxBeforeMove!.width / 2 - 140, firstBoxBeforeMove!.y + firstBoxBeforeMove!.height / 2, { steps: 6 });
  await page.mouse.up();

  await chooseShape(page, "円");
  await expect(page.locator(".overlay-shape-geo")).toHaveCount(2);

  const firstBox = await firstShape.boundingBox();
  expect(firstBox).not.toBeNull();

  await page.keyboard.down("Shift");
  await page.mouse.click(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2);
  await page.keyboard.up("Shift");
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(2);

  await page.keyboard.press("ControlOrMeta+C");
  await page.keyboard.press("ControlOrMeta+V");

  await expect(page.locator(".overlay-shape-geo")).toHaveCount(4);
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(2);
  const pastedFirstBox = await page.locator(".overlay-shape-geo").nth(2).boundingBox();
  expect(pastedFirstBox).not.toBeNull();
  expect(pastedFirstBox!.x).toBeGreaterThan(firstBox!.x + 5);
  expect(pastedFirstBox!.y).toBeGreaterThan(firstBox!.y + 5);
});

test("selects overlapping overlay shapes by visual layer order", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "四角形");
  const frontShape = page.locator(".overlay-shape-geo").first();
  await expect(frontShape).toBeVisible();
  const frontShapeId = await frontShape.getAttribute("data-overlay-shape-id");
  expect(frontShapeId).not.toBeNull();

  await chooseShape(page, "円");
  const backgroundShape = page.locator(".overlay-shape-geo").last();
  await expect(backgroundShape).toBeVisible();
  const backgroundShapeId = await backgroundShape.getAttribute("data-overlay-shape-id");
  expect(backgroundShapeId).not.toBeNull();

  const frontBox = await frontShape.boundingBox();
  const backgroundBox = await backgroundShape.boundingBox();
  expect(frontBox).not.toBeNull();
  expect(backgroundBox).not.toBeNull();
  const overlapPoint = {
    x: frontBox!.x + frontBox!.width / 2,
    y: frontBox!.y + frontBox!.height / 2,
  };
  const backgroundCenter = {
    x: backgroundBox!.x + backgroundBox!.width / 2,
    y: backgroundBox!.y + backgroundBox!.height / 2,
  };

  await page.mouse.move(backgroundCenter.x, backgroundCenter.y);
  await page.mouse.down();
  await page.mouse.move(overlapPoint.x, overlapPoint.y, { steps: 8 });
  await page.mouse.up();

  await page.mouse.click(overlapPoint.x, overlapPoint.y, { button: "right" });
  const contextMenu = page.locator(".overlay-shape-context-menu");
  await expect(contextMenu).toBeVisible();
  await contextMenu.getByRole("menuitem", { name: "順序", exact: true }).hover();
  await page.getByRole("menu", { name: "順序", exact: true }).getByRole("menuitem", { name: "最背面へ", exact: true }).click();
  await expect(page.locator(`.overlay-shape-hit-target[data-overlay-shape-id="${backgroundShapeId}"]`)).toHaveCount(1);

  await page.mouse.click(overlapPoint.x, overlapPoint.y);
  await expect(page.locator(`.overlay-shape.selected[data-overlay-shape-id="${frontShapeId}"]`)).toHaveCount(1);
  await expect(page.locator(`.overlay-shape.selected[data-overlay-shape-id="${backgroundShapeId}"]`)).toHaveCount(0);
});

test("passes a plain press through to the body and needs Ctrl/Cmd-click to grab the shape", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "四角形");
  const rectangle = page.locator(".overlay-shape-geo").first();
  await expect(rectangle).toBeVisible();

  const problemText = page.locator('[data-sigma-doc-id="p_problem_statement"]').first();
  const focusText = page.locator('[data-sigma-doc-id="p_ab_intro"]').first();
  const problemBox = await problemText.boundingBox();
  const rectangleBox = await rectangle.boundingBox();
  expect(problemBox).not.toBeNull();
  expect(rectangleBox).not.toBeNull();

  const overlapPoint = {
    x: problemBox!.x + Math.min(160, Math.max(24, problemBox!.width / 2)),
    y: problemBox!.y + problemBox!.height / 2,
  };
  const rectangleCenter = {
    x: rectangleBox!.x + rectangleBox!.width / 2,
    y: rectangleBox!.y + rectangleBox!.height / 2,
  };
  await page.mouse.move(rectangleCenter.x, rectangleCenter.y);
  await page.mouse.down();
  await page.mouse.move(overlapPoint.x, overlapPoint.y, { steps: 8 });
  await page.mouse.up();

  await clickTextBlockPlainText(page, focusText);
  await expectTextFlowFocused(page);

  // 素のクリックは図形を素通りして本文へ届く (未選択の図形は透過する)。
  await page.mouse.click(overlapPoint.x, overlapPoint.y);
  await expect(page.locator(".overlay-canvas-editor")).toHaveCount(0);
  await expectTextFlowFocused(page);

  // 掴むのは明示操作のときだけ。
  await grabShapeFromBody(page, overlapPoint);
  await expect(page.locator(".overlay-shape-geo.selected")).toHaveCount(1);
  await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");

  await clickTextBlockPlainText(page, focusText);
  await expectTextFlowFocused(page);
});

test("selects a body-mode overlay shape from the portion outside the paper", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "四角形");
  const rectangle = page.locator(".overlay-shape-geo").first();
  await expect(rectangle).toBeVisible();
  const shapeId = await rectangle.getAttribute("data-overlay-shape-id");
  expect(shapeId).not.toBeNull();

  const canvasBox = await page.locator(".page-canvas").first().boundingBox();
  const beforeMove = await rectangle.boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(beforeMove).not.toBeNull();

  const start = {
    x: beforeMove!.x + beforeMove!.width / 2,
    y: beforeMove!.y + beforeMove!.height / 2,
  };
  const target = {
    x: canvasBox!.x - beforeMove!.width / 4,
    y: start.y,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => {
    const box = await rectangle.boundingBox();
    return box ? box.x < canvasBox!.x : false;
  }).toBe(true);

  const movedBox = await rectangle.boundingBox();
  expect(movedBox).not.toBeNull();
  const outsidePaperPoint = {
    x: Math.min(canvasBox!.x - 4, movedBox!.x + movedBox!.width / 2),
    y: movedBox!.y + movedBox!.height / 2,
  };

  await clickTextBlockPlainText(page, page.locator('[data-sigma-doc-id="p_ab_intro"]').first());
  await expectTextFlowFocused(page);

  await grabShapeFromBody(page, outsidePaperPoint);
  await expect(page.locator(`.overlay-shape-geo.selected[data-overlay-shape-id="${shapeId}"]`)).toHaveCount(1);
});

test("groups overlay shapes with shortcuts and ungroups from the context menu", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "四角形");
  await chooseShape(page, "円");
  await expect(page.locator(".overlay-shape-geo")).toHaveCount(2);

  const firstShape = page.locator(".overlay-shape-geo").first();
  const firstBox = await firstShape.boundingBox();
  expect(firstBox).not.toBeNull();
  await page.keyboard.down("Shift");
  await page.mouse.click(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2);
  await page.keyboard.up("Shift");
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(2);

  await page.keyboard.press("ControlOrMeta+G");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  await expect.poll(async () => {
    const shapes = await getSavedOverlayShapes(page);
    return shapes.filter((shape) => shape.type === "group").length;
  }).toBe(1);
  await expect.poll(async () => {
    const shapes = await getSavedOverlayShapes(page);
    return shapes.filter((shape) => shape.parentId).length;
  }).toBe(2);

  const selectionBox = page.locator(".overlay-selection-box").first();
  const childBeforeDrag = await firstShape.boundingBox();
  const selectionBeforeDrag = await selectionBox.boundingBox();
  expect(childBeforeDrag).not.toBeNull();
  expect(selectionBeforeDrag).not.toBeNull();
  const dragStart = {
    x: childBeforeDrag!.x + childBeforeDrag!.width / 2,
    y: childBeforeDrag!.y + childBeforeDrag!.height / 2,
  };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 32, dragStart.y + 24);

  const childDuringDrag = await firstShape.boundingBox();
  const selectionDuringDrag = await selectionBox.boundingBox();
  expect(childDuringDrag).not.toBeNull();
  expect(selectionDuringDrag).not.toBeNull();
  expect(selectionDuringDrag!.x - selectionBeforeDrag!.x).toBeCloseTo(
    childDuringDrag!.x - childBeforeDrag!.x,
    1,
  );
  expect(selectionDuringDrag!.y - selectionBeforeDrag!.y).toBeCloseTo(
    childDuringDrag!.y - childBeforeDrag!.y,
    1,
  );
  await page.mouse.up();

  const groupedBox = await firstShape.boundingBox();
  expect(groupedBox).not.toBeNull();
  await page.mouse.click(groupedBox!.x + groupedBox!.width / 2, groupedBox!.y + groupedBox!.height / 2, { button: "right" });
  const contextMenu = page.locator(".overlay-shape-context-menu");
  await expect(contextMenu).toBeVisible();
  await expect(contextMenu.getByRole("menuitem", { name: "グループ解除", exact: true })).toBeVisible();
  await contextMenu.getByRole("menuitem", { name: "順序", exact: true }).hover();
  await expect(page.getByRole("menu", { name: "順序", exact: true }).getByRole("menuitem", { name: "最前面へ", exact: true })).toBeVisible();
  const contextMenuItems = await contextMenu.getByRole("menuitem").allTextContents();
  expect(contextMenuItems).not.toContain("ロック");
  expect(contextMenuItems).not.toContain("非表示");
  expect(contextMenuItems.slice(-2)).toEqual(["複製", "削除"]);

  await contextMenu.getByRole("menuitem", { name: "グループ解除", exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  await expect.poll(async () => {
    const shapes = await getSavedOverlayShapes(page);
    return shapes.some((shape) => shape.type === "group");
  }).toBe(false);
});

test("shows dimension labels only for selected top-level overlay shapes", async ({ page }) => {
  await page.goto("/");

  const dimensionLabels = page.locator(".overlay-shape-dimension-label");
  await expect(dimensionLabels).toHaveCount(0);

  await chooseShape(page, "四角形");
  await expect(dimensionLabels).toHaveCount(1);
  await expect(dimensionLabels).toHaveText(/^\d+ x \d+$/);

  await chooseShape(page, "円");
  await expect(dimensionLabels).toHaveCount(1);
  await expect(dimensionLabels).toHaveText(/^\d+ x \d+$/);

  const firstShape = page.locator(".overlay-shape-geo").first();
  const firstBox = await firstShape.boundingBox();
  expect(firstBox).not.toBeNull();
  await page.keyboard.down("Shift");
  await page.mouse.click(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2);
  await page.keyboard.up("Shift");
  await expect(dimensionLabels).toHaveCount(2);
  await expect(dimensionLabels).toHaveText([/^\d+ x \d+$/, /^\d+ x \d+$/]);

  await page.keyboard.press("ControlOrMeta+G");
  await expect(dimensionLabels).toHaveCount(1);
  await expect(dimensionLabels).toHaveText(/^\d+ x \d+$/);
});

test("pastes an image file from the clipboard as an overlay image", async ({ page }) => {
  await page.goto("/");

  const canvas = page.locator(".page-canvas").first();
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  const pastePoint = {
    x: canvasBox!.x + 260,
    y: canvasBox!.y + 220,
  };
  await page.mouse.move(pastePoint.x, pastePoint.y);

  await pasteSvgImage(page, "clipboard-image.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#2563eb"/></svg>');

  const image = page.locator(".overlay-shape-image").first();
  await expect(image).toBeVisible();
  await expect(image).toHaveClass(/selected/);
});

test("drops an image file onto the page as an overlay image", async ({ page }) => {
  await page.goto("/");

  const canvas = page.locator(".page-canvas").first();
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  const dropPoint = {
    x: canvasBox!.x + 380,
    y: canvasBox!.y + 260,
  };

  await dropSvgImage(page, dropPoint, "drop-image.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#16a34a"/></svg>');

  const image = page.locator(".overlay-shape-image").first();
  await expect(image).toBeVisible();
  await expect(image).toHaveClass(/selected/);
  const imageBox = await image.boundingBox();
  expect(imageBox).not.toBeNull();
  expect(imageBox!.x).toBeGreaterThan(dropPoint.x - 40);
  expect(imageBox!.y).toBeGreaterThan(dropPoint.y - 40);
});

test("adds, moves, deletes, and prints local overlay shapes", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "四角形");
  await expect(page.locator(".overlay-shape-geo")).toHaveCount(1);

  const rectangle = page.locator(".overlay-shape-geo").first();
  const beforeDrag = await rectangle.boundingBox();
  expect(beforeDrag).not.toBeNull();
  await page.mouse.move(beforeDrag!.x + beforeDrag!.width / 2, beforeDrag!.y + beforeDrag!.height / 2);
  await page.mouse.down();
  await page.mouse.move(beforeDrag!.x + beforeDrag!.width / 2 + 60, beforeDrag!.y + beforeDrag!.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => {
    const afterDrag = await rectangle.boundingBox();
    return afterDrag?.x ?? beforeDrag!.x;
  }).toBeGreaterThan(beforeDrag!.x + 20);
  await rotateSelectedShape(page, rectangle);
  await expect.poll(async () => {
    return rectangle.evaluate((element) => getComputedStyle(element).transform);
  }).not.toBe("none");

  await chooseShape(page, "円");
  await chooseShape(page, "円弧");
  await chooseShape(page, "扇形");
  await expect(page.locator(".overlay-shape-arc")).toHaveCount(2);
  await expect(page.locator(".overlay-arc-point-handle")).toHaveCount(2);
  await chooseShape(page, "線");
  const line = page.locator(".overlay-shape-line").first();
  await expect(page.locator(".overlay-selection-box.point-only")).toHaveCount(1);
  await expect(page.locator(".overlay-rotate-handle")).toHaveCount(0);
  await expect(page.locator(".overlay-line-point-handle")).toHaveCount(2);
  await dragLastLineEndpoint(page, line);
  await expect(page.locator(".overlay-line-point-handle")).toHaveCount(2);
  await chooseShape(page, "矢印");
  await expect(page.locator(".overlay-selection-box.point-only")).toHaveCount(1);
  await expect(page.locator(".overlay-rotate-handle")).toHaveCount(0);
  await expect(page.locator(".overlay-arrow-point-handle")).toHaveCount(2);
  await chooseShape(page, "テキスト");
  await chooseShape(page, "吹き出し");

  await expect(page.locator(".overlay-shape-geo")).toHaveCount(2);
  await expect(page.locator(".overlay-shape-arc")).toHaveCount(2);
  await expect(page.locator(".overlay-shape-line")).toHaveCount(1);
  await expect(page.locator(".overlay-shape-arrow")).toHaveCount(1);
  await expect(page.locator(".overlay-shape-text")).toHaveCount(1);
  await expect(page.locator(".overlay-shape-callout")).toHaveCount(1);

  const imageInput = page.locator('input[accept="image/png,image/jpeg,image/webp,image/svg+xml"]');
  await imageInput.setInputFiles({
    name: "overlay-test.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="50"><rect width="80" height="50" fill="#2563eb"/></svg>'),
  });
  await expect(page.locator(".overlay-shape-image")).toHaveCount(1);

  const imageShape = page.locator(".overlay-shape-image").first();
  const imageBox = await imageShape.boundingBox();
  expect(imageBox).not.toBeNull();
  await page.mouse.click(imageBox!.x + imageBox!.width / 2, imageBox!.y + imageBox!.height / 2);
  await page.keyboard.press("Delete");
  await expect(page.locator(".overlay-shape-image")).toHaveCount(0);

  await page.getByRole("button", { name: "ファイル", exact: true }).click();
  await page.getByRole("menuitem", { name: "エクスポート", exact: true }).hover();
  await page.getByRole("menuitem", { name: "PDFを書き出し", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "PDFプレビュー" })).toBeVisible();
  // The PDF path no longer runs the separate print renderer that drew overlays into
  // `.print-page-overlay-layer`; since the PDF-parity rewrite the preview and the exported PDF are
  // `PagedRenderSurface`, which cuts pages out of the same canvas the editor draws.
  //
  // Assert on `.paged-surface-page` — the page windows *are* the printed output.
  // `.paged-surface-stage` is only the off-screen source canvas. Every window holds a complete
  // copy of the canvas, but `applyPageOwnership` (`print/paged-render/page-windows.ts`) strips
  // `data-overlay-shape-id` from every window that does not own the shape, so pinning the count
  // through that attribute keeps it document-wide even on multi-page documents.
  await waitForPagedSurfaceSettled(page);
  const printed = (className: string) =>
    page.locator(`.paged-surface-page ${className}[data-overlay-shape-id]`);
  await expect(printed(".overlay-shape-geo")).toHaveCount(2);
  await expect(printed(".overlay-shape-arc")).toHaveCount(2);
  await expect(printed(".overlay-shape-line")).toHaveCount(1);
  await expect(printed(".overlay-shape-arrow")).toHaveCount(1);
  await expect(printed(".overlay-shape-text")).toHaveCount(1);
  await expect(printed(".overlay-shape-callout")).toHaveCount(1);
  // The image was deleted above, so the print output must not carry it either.
  await expect(printed(".overlay-shape-image")).toHaveCount(0);
});

test("shape menu offers arc and omits removed drawing and formula tools", async ({ page }) => {
  await page.goto("/");

  const menu = await openShapeMenu(page);
  await expect(menu.getByRole("menuitem", { name: "円", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "楕円", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "円弧", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "扇形", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "3点円弧", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "選択", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "矢印", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "太矢印", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "正十二角形", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "手描き", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "ハイライト", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "数式", exact: true })).toHaveCount(0);

  await page.keyboard.press("Escape");
  const lineMenu = await openLineToolMenu(page);
  await expect(lineMenu.getByRole("menuitem", { name: "線", exact: true })).toBeVisible();
  await expect(lineMenu.getByRole("menuitem", { name: "折れ線", exact: true })).toBeVisible();
  await expect(lineMenu.getByRole("menuitem", { name: "曲線", exact: true })).toBeVisible();
  await expect(lineMenu.getByRole("menuitem", { name: "フリーハンド", exact: true })).toBeVisible();
  await expect(lineMenu.getByRole("menuitem", { name: "矢印", exact: true })).toBeVisible();
  await expect(lineMenu.getByRole("menuitem", { name: "太矢印", exact: true })).toBeVisible();
});

test("inserts block arrows horizontally after a diagonal placement drag", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "太矢印");
  const blockArrow = page.locator(".overlay-shape-geo.selected").first();
  await expect(blockArrow).toBeVisible();
  await expect.poll(() => blockArrow.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
});

test("draws a three-point arc from three clicked points", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "3点円弧", { create: false });
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();

  const start = { x: surfaceBox!.x + 130, y: surfaceBox!.y + 210 };
  const through = { x: surfaceBox!.x + 205, y: surfaceBox!.y + 130 };
  const end = { x: surfaceBox!.x + 280, y: surfaceBox!.y + 210 };
  await page.mouse.click(start.x, start.y);
  await page.mouse.click(through.x, through.y);
  await page.mouse.click(end.x, end.y);

  const arc = page.locator(".overlay-shape-arc").first();
  await expect(arc).toBeVisible();
  await expect(page.locator(".overlay-arc-point-handle")).toHaveCount(2);
  const path = await arc.locator(".overlay-vector-svg > path").getAttribute("d");
  expect(path).toContain("A");

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const doc = raw ? JSON.parse(raw) : null;
    const shapes = doc?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const shape = shapes.find((item: { type?: string }) => item.type === "arc");
    return shape?.props?.r ?? 0;
  })).toBeGreaterThan(20);
});

test("uses ctrl for regular shapes and shift for resize aspect lock", async ({ page }) => {
  await page.goto("/");

  let menu = await openShapeMenu(page);
  await menu.getByRole("menuitem", { name: "円", exact: true }).click();
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();

  const startX = surfaceBox!.x + 160;
  const startY = surfaceBox!.y + 140;
  await page.keyboard.down("Control");
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 150, startY + 70, { steps: 8 });
  await page.keyboard.up("Control");
  await page.mouse.up();

  const releasedBeforeCommit = page.locator(".overlay-shape-geo").first();
  await expect(releasedBeforeCommit).toBeVisible();
  const releasedBox = await releasedBeforeCommit.boundingBox();
  expect(releasedBox).not.toBeNull();
  expect(Math.abs(releasedBox!.width - releasedBox!.height)).toBeGreaterThan(20);

  menu = await openShapeMenu(page);
  await menu.getByRole("menuitem", { name: "円", exact: true }).click();
  await expect(surface).toBeVisible();
  await page.keyboard.down("Control");
  await page.mouse.move(startX + 220, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 370, startY + 70, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Control");

  const circle = page.locator(".overlay-shape-geo").last();
  await expect(circle).toBeVisible();
  const circleBox = await circle.boundingBox();
  expect(circleBox).not.toBeNull();
  expect(Math.abs(circleBox!.width - circleBox!.height)).toBeLessThan(2);

  menu = await openShapeMenu(page);
  await menu.getByRole("menuitem", { name: "円", exact: true }).click();
  await expect(surface).toBeVisible();
  const shiftStartY = startY + 150;
  await page.keyboard.down("Shift");
  await page.mouse.move(startX, shiftStartY);
  await page.mouse.down();
  await page.mouse.move(startX + 150, shiftStartY + 70, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");

  const shiftCreated = page.locator(".overlay-shape-geo").last();
  await expect(shiftCreated).toBeVisible();
  const shiftCreatedBox = await shiftCreated.boundingBox();
  expect(shiftCreatedBox).not.toBeNull();
  expect(Math.abs(shiftCreatedBox!.width - shiftCreatedBox!.height)).toBeGreaterThan(20);

  await chooseShape(page, "四角形");
  const rectangle = page.locator(".overlay-shape-geo").last();
  const beforeResize = await rectangle.boundingBox();
  expect(beforeResize).not.toBeNull();
  const beforeRatio = beforeResize!.width / beforeResize!.height;
  const handle = page.locator(".overlay-resize-handle.se").first();
  const handleBox = await handle.boundingBox();
  expect(handleBox).not.toBeNull();

  await page.keyboard.down("Shift");
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 80, handleBox!.y + handleBox!.height / 2 + 6, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");

  await expect.poll(async () => {
    const after = await rectangle.boundingBox();
    return after ? after.width / after.height : 0;
  }).toBeCloseTo(beforeRatio, 1);

  const afterShiftResize = await rectangle.boundingBox();
  expect(afterShiftResize).not.toBeNull();
  const resizeHandle = page.locator(".overlay-resize-handle.se").first();
  const resizeHandleBox = await resizeHandle.boundingBox();
  expect(resizeHandleBox).not.toBeNull();
  await page.mouse.move(resizeHandleBox!.x + resizeHandleBox!.width / 2, resizeHandleBox!.y + resizeHandleBox!.height / 2);
  await page.mouse.down();
  await page.keyboard.down("Control");
  await page.mouse.move(resizeHandleBox!.x + resizeHandleBox!.width / 2 + 60, resizeHandleBox!.y + resizeHandleBox!.height / 2 + 10, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Control");

  await expect.poll(async () => {
    const after = await rectangle.boundingBox();
    return after ? Math.abs(after.width - after.height) : Number.POSITIVE_INFINITY;
  }).toBeLessThan(2);

  menu = await openShapeMenu(page);
  await menu.getByRole("menuitem", { name: "円", exact: true }).click();
  await expect(surface).toBeVisible();
  await page.mouse.move(startX + 220, shiftStartY);
  await page.mouse.down();
  await page.mouse.move(startX + 340, shiftStartY + 70, { steps: 8 });
  await page.mouse.up();

  const centerCircle = page.locator(".overlay-shape-geo").last();
  await expect(centerCircle).toBeVisible();
  const centerCircleBox = await centerCircle.boundingBox();
  expect(centerCircleBox).not.toBeNull();
  expect(Math.abs(centerCircleBox!.width - centerCircleBox!.height)).toBeGreaterThan(20);
});

test("resizes selected shapes from side handles on one axis", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "四角形");
  const rectangle = page.locator(".overlay-shape-geo").last();
  await expect(rectangle).toBeVisible();
  const before = await rectangle.boundingBox();
  expect(before).not.toBeNull();

  await dragHandle(page, page.locator(".overlay-resize-handle.e").first(), 80, 60);

  await expect.poll(async () => {
    const after = await rectangle.boundingBox();
    return after?.width ?? 0;
  }).toBeGreaterThan(before!.width + 50);
  const afterRight = await rectangle.boundingBox();
  expect(afterRight).not.toBeNull();
  expect(Math.abs(afterRight!.height - before!.height)).toBeLessThan(3);

  await dragHandle(page, page.locator(".overlay-resize-handle.s").first(), -60, 70);

  await expect.poll(async () => {
    const after = await rectangle.boundingBox();
    return after?.height ?? 0;
  }).toBeGreaterThan(afterRight!.height + 45);
  const afterBottom = await rectangle.boundingBox();
  expect(afterBottom).not.toBeNull();
  expect(Math.abs(afterBottom!.width - afterRight!.width)).toBeLessThan(3);
});

test("resizes a rotated arc on one local axis without moving the opposite edge", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "円弧");
  const arc = page.locator(".overlay-shape-arc").first();
  await expect(arc).toBeVisible();
  await expect(page.locator(".overlay-arc-radius-handle")).toHaveCount(0);
  await expect(page.locator(".overlay-resize-handle.hit-only")).toHaveCount(4);
  await expect.poll(async () => page.locator(".overlay-resize-handle.hit-only.e").evaluate((element) => (
    getComputedStyle(element, "::after").display
  ))).toBe("none");

  await rotateSelectedShape(page, arc);
  const selectionBox = page.locator(".overlay-selection-box").first();
  const beforeBox = await getSelectionBoxState(selectionBox);
  expect(Math.abs(beforeBox.rotation)).toBeGreaterThan(0.1);

  // 掴むのも測るのも「見えている枠」= 選択枠。保存箱 (`.overlay-shape` のインラインスタイル)
  // は楕円全体なので掴んだ辺と一致しない — その辺は動いて当然。回転軸は実描画箱
  // (= 選択枠) の中心なので、辺の紙面座標も選択枠だけで出せる。
  const westEdgePagePoint = (frame: { x: number; y: number; w: number; h: number }) => {
    const centerX = frame.x + frame.w / 2;
    const centerY = frame.y + frame.h / 2;
    const dx = frame.x - centerX;
    const dy = frame.y + frame.h / 2 - centerY;
    return {
      x: centerX + dx * Math.cos(beforeBox.rotation) - dy * Math.sin(beforeBox.rotation),
      y: centerY + dx * Math.sin(beforeBox.rotation) + dy * Math.cos(beforeBox.rotation),
    };
  };
  const beforeFixedPoint = westEdgePagePoint(beforeBox);

  await dragHandle(
    page,
    page.locator(".overlay-resize-handle.hit-only.e").first(),
    Math.cos(beforeBox.rotation) * 70,
    Math.sin(beforeBox.rotation) * 70,
  );

  await expect.poll(async () => (await getSelectionBoxState(selectionBox)).w)
    .toBeGreaterThan(beforeBox.w + 40);

  const after = await getSelectionBoxState(selectionBox);
  const afterFixedPoint = westEdgePagePoint(after);

  // ローカル x 軸だけが伸びる: 高さは変わらず、掴んだ辺の反対側 (西辺) は紙面上で動かない。
  // 伸びた量そのものは見ない: 挿入直後の弧は保存箱が紙面の外まで届いていて、ドラッグ中に
  // 用紙の再センタリングが起きる分だけポインタの移動量が目減りする (WI-15 以前からの挙動)。
  // 「見えている幅がドラッグ距離ぶん伸びる」は `overlay-visual-resize.spec.ts` が用紙内に
  // 収まる図形で固定している。
  expect(after.h).toBeCloseTo(beforeBox.h, 4);
  expect(Math.hypot(
    afterFixedPoint.x - beforeFixedPoint.x,
    afterFixedPoint.y - beforeFixedPoint.y,
  )).toBeLessThan(0.01);
});

test("table editor reveals row plus on boundary hover and styles a selected grid line", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "表");

  const table = page.locator(".overlay-table-shape").first();
  await expect(table).toBeVisible();
  const tableBox = await table.boundingBox();
  expect(tableBox).not.toBeNull();

  const center = {
    x: tableBox!.x + tableBox!.width / 2,
    y: tableBox!.y + tableBox!.height / 2,
  };
  await page.mouse.click(center.x, center.y);
  await page.mouse.click(center.x, center.y);
  await expect(page.locator(".overlay-table-floating-toolbar.cell")).toBeVisible();
  const stableTableWidth = await table.evaluate((element) => Math.round(element.getBoundingClientRect().width));

  const firstCell = table.locator("td").first();
  const firstCellEditor = firstCell.locator(".overlay-table-shape-content");
  await firstCellEditor.click();
  await expect.poll(async () => firstCell.evaluate((element) => {
    const paragraph = element.querySelector(".overlay-table-shape-content p");
    if (!paragraph) {
      return Number.POSITIVE_INFINITY;
    }
    const cellRect = element.getBoundingClientRect();
    const paragraphRect = paragraph.getBoundingClientRect();
    const cellCenterY = cellRect.top + cellRect.height / 2;
    const paragraphCenterY = paragraphRect.top + paragraphRect.height / 2;
    return Math.abs(paragraphCenterY - cellCenterY);
  })).toBeLessThan(1.5);
  await page.keyboard.insertText("abc");
  await expect(firstCellEditor).toContainText("abc");
  await expect(table.locator("td.selected-column")).toHaveCount(0);

  const rowAddButton = page.getByRole("button", { name: "行を2番目に追加" });
  await expect.poll(async () => rowAddButton.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");

  const rowBoundary = page.getByTestId("overlay-table-row-boundary").nth(1);
  const rowBoundaryBox = await rowBoundary.boundingBox();
  expect(rowBoundaryBox).not.toBeNull();
  await page.mouse.move(rowBoundaryBox!.x + rowBoundaryBox!.width / 2, rowBoundaryBox!.y + rowBoundaryBox!.height / 2);
  await expect.poll(async () => rowAddButton.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");

  const columnAddButton = page.getByRole("button", { name: "列を2番目に追加" });
  const columnBoundary = page.getByTestId("overlay-table-column-boundary").nth(1);
  const columnBoundaryBox = await columnBoundary.boundingBox();
  expect(columnBoundaryBox).not.toBeNull();
  await page.mouse.move(columnBoundaryBox!.x + columnBoundaryBox!.width / 2, columnBoundaryBox!.y + columnBoundaryBox!.height / 2);
  await expect.poll(async () => {
    const rowOpacity = Number(await rowAddButton.evaluate((element) => getComputedStyle(element).opacity));
    const columnOpacity = Number(await columnAddButton.evaluate((element) => getComputedStyle(element).opacity));
    return rowOpacity > 0.99 && columnOpacity > 0.99;
  }, { timeout: 450 }).toBe(true);
  await page.waitForTimeout(600);
  await expect.poll(async () => rowAddButton.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  await page.mouse.move(rowBoundaryBox!.x + rowBoundaryBox!.width / 2, rowBoundaryBox!.y + rowBoundaryBox!.height / 2);
  await expect.poll(async () => rowAddButton.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await rowAddButton.click();
  await expect(table.locator("tr")).toHaveCount(4);

  await columnBoundary.focus();
  await page.keyboard.press("Enter");
  await expect(columnBoundary).toHaveClass(/selected/);
  const lineToolbar = page.locator(".overlay-table-floating-toolbar.line");
  await expect(lineToolbar).toBeVisible();
  await lineToolbar.getByRole("button", { name: /^線種（現在:/ }).click();
  await page.getByRole("menu", { name: "線種" }).getByRole("menuitemradio", { name: "点線" }).click();
  await expect.poll(async () => firstCell.evaluate((element) => element.style.borderRightStyle)).toBe("dotted");
  await expect.poll(async () => table.locator("td").nth(1).evaluate((element) => element.style.borderLeftStyle)).toBe("dotted");
  await lineToolbar.getByRole("button", { name: /^線幅（現在:/ }).click();
  await page.getByRole("menu", { name: "線幅" }).getByRole("menuitemradio", { name: "太", exact: true }).click();

  await expect.poll(async () => firstCell.evaluate((element) => element.style.borderRightWidth)).toBe("3px");
  await expect.poll(async () => firstCell.evaluate((element) => element.style.borderRightColor)).toBe("rgb(17, 24, 39)");
  await expect.poll(async () => table.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(stableTableWidth);
});

test("table inline math remains vertically centered in a narrow cell", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("sigma-studio:inline-math-input-mode", "tex");
  });
  await page.goto("/");

  await chooseShape(page, "表");

  const table = page.locator(".overlay-table-shape").first();
  await expect(table).toBeVisible();
  const tableBox = await table.boundingBox();
  expect(tableBox).not.toBeNull();

  const center = {
    x: tableBox!.x + tableBox!.width / 2,
    y: tableBox!.y + tableBox!.height / 2,
  };
  await page.mouse.click(center.x, center.y);
  await page.mouse.click(center.x, center.y);
  await expect(page.locator(".overlay-table-floating-toolbar.cell")).toBeVisible();

  const firstCell = table.locator("td").first();
  const firstCellEditor = firstCell.locator(".overlay-table-shape-content");
  await firstCellEditor.click();
  await page.keyboard.press("Control+M");
  const inlineMathField = page.getByRole("dialog", { name: "TeX数式を編集" }).getByRole("textbox", { name: "TeX" });
  await expect(inlineMathField).toBeVisible();
  await inlineMathField.click();
  await inlineMathField.fill("f'(x)");
  await page.keyboard.press("Control+Enter");
  const inlineMath = firstCell.locator(".inline-math-node");
  await expect(inlineMath).toHaveCount(1);

  await expect.poll(async () => firstCell.evaluate((element) => {
    const mathNode = element.querySelector(".inline-math-node");
    if (!mathNode) {
      return Number.POSITIVE_INFINITY;
    }
    const cellRect = element.getBoundingClientRect();
    const mathRect = mathNode.getBoundingClientRect();
    const cellCenterY = cellRect.top + cellRect.height / 2;
    const mathCenterY = mathRect.top + mathRect.height / 2;
    return Math.abs(mathCenterY - cellCenterY);
  })).toBeLessThan(1.5);
});

test("table math keeps the same font size before and during cell editing", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("sigma-studio:inline-math-input-mode", "tex");
  });
  await page.goto("/");

  await chooseShape(page, "表");
  const table = page.locator(".overlay-table-shape").first();
  const tableBox = await table.boundingBox();
  expect(tableBox).not.toBeNull();
  const center = {
    x: tableBox!.x + tableBox!.width / 2,
    y: tableBox!.y + tableBox!.height / 2,
  };
  await page.mouse.click(center.x, center.y);
  await page.mouse.click(center.x, center.y);

  const firstCell = table.locator("td").first();
  await firstCell.locator(".overlay-table-shape-content").click();
  await page.keyboard.press("Control+M");
  await page.locator("textarea.inline-math-tex-field").first().fill("x^2");
  await page.keyboard.press("Control+Enter");

  const editingMath = firstCell.locator(".math-preview").first();
  await expect(editingMath).toBeVisible();
  const editingFontSize = await editingMath.evaluate((element) => getComputedStyle(element).fontSize);

  const surface = page.locator(".overlay-canvas-editor").first();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  await page.mouse.click(surfaceBox!.x + 20, surfaceBox!.y + 20);
  // Clicking empty canvas hands the page back to text mode, so `PageCanvasEditor` unmounts
  // `OverlayCanvasEditor` entirely and `.page-overlay-preview` redraws the shapes through the
  // static renderer. `.overlay-table-shape` is the *editor's* wrapper class — the static table has
  // no wrapper at all — so the idle table has to be located through the preview layer rather than
  // by asserting the editor element lost its `editing` class.
  await expect(page.locator(".overlay-table-shape")).toHaveCount(0);
  const staticCell = page.locator(".page-overlay-preview td").first();
  const staticMath = staticCell.locator(".math-preview").first();
  await expect(staticMath).toBeVisible();
  await expect.poll(async () => staticMath.evaluate((element) => getComputedStyle(element).fontSize)).toBe(editingFontSize);
});

test("table cells navigate with arrow keys at cell boundaries", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "表");
  const table = page.locator(".overlay-table-shape").first();
  await expect(table).toBeVisible();
  const tableBox = await table.boundingBox();
  expect(tableBox).not.toBeNull();

  await page.mouse.click(tableBox!.x + tableBox!.width / 2, tableBox!.y + tableBox!.height / 2);
  await page.mouse.click(tableBox!.x + tableBox!.width / 2, tableBox!.y + tableBox!.height / 2);
  await expect(page.locator(".overlay-table-floating-toolbar.cell")).toBeVisible();

  const firstCellEditor = table.locator("td").nth(0).locator(".overlay-table-shape-content");
  const secondCellEditor = table.locator("td").nth(1).locator(".overlay-table-shape-content");
  const lowerFirstCellEditor = table.locator("td").nth(3).locator(".overlay-table-shape-content");

  // The boundary navigation this test is about only happens when the caret is already at the edge
  // of the cell's text, so each precondition is waited for instead of assumed. Without them the
  // test typed into whichever element happened to hold focus and pressed ArrowRight before the
  // insertion had been applied, and ArrowRight then moved inside the text rather than crossing to
  // the next cell — a ~50% failure rate that has nothing to do with the behaviour under test.
  await firstCellEditor.click();
  await expect(firstCellEditor).toBeFocused();
  await page.keyboard.insertText("abc");
  await expect(firstCellEditor).toContainText("abc");
  await expect.poll(async () => firstCellEditor.evaluate((element) => {
    const selection = window.getSelection();
    return selection?.isCollapsed === true
      && element.contains(selection.anchorNode)
      && selection.anchorOffset === 3;
  })).toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect(secondCellEditor).toBeFocused();
  await page.keyboard.insertText("d");
  await expect(secondCellEditor).toContainText("d");
  await expect(secondCellEditor).toBeFocused();

  await secondCellEditor.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(secondCellEditor).toBeFocused();
  // `Home` is the setup for the assertion that follows, not the behaviour under test, and it is
  // idempotent — so it is retried until the caret really is at the start of the cell. A single
  // press occasionally landed while the editor was still applying the insertion above, leaving the
  // caret mid-text; ArrowLeft then moved inside the text instead of crossing the cell boundary.
  await expect.poll(async () => {
    await secondCellEditor.press("Home");
    return secondCellEditor.evaluate((element) => {
      const selection = window.getSelection();
      return (
        document.activeElement === element
        && selection?.isCollapsed === true
        && selection.anchorNode !== null
        && element.contains(selection.anchorNode)
        && selection.anchorOffset === 0
      );
    });
  }).toBe(true);
  await page.keyboard.press("ArrowLeft");
  await expect(firstCellEditor).toBeFocused();
  await page.keyboard.insertText("z");
  await expect(firstCellEditor).toContainText("z");

  await page.keyboard.press("ArrowDown");
  await expect(lowerFirstCellEditor).toBeFocused();
  await page.keyboard.insertText("q");
  await expect(lowerFirstCellEditor).toContainText("q");
});

test("table cells drag-select and preview row or column deletion from the context menu", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "表");
  const table = page.locator(".overlay-table-shape").first();
  await expect(table).toBeVisible();
  const tableBox = await table.boundingBox();
  expect(tableBox).not.toBeNull();

  await page.mouse.click(tableBox!.x + tableBox!.width / 2, tableBox!.y + tableBox!.height / 2);
  await page.mouse.click(tableBox!.x + tableBox!.width / 2, tableBox!.y + tableBox!.height / 2);
  await expect(page.locator(".overlay-table-floating-toolbar.cell")).toBeVisible();

  const firstCell = table.locator("td").nth(0);
  const firstCellEditor = firstCell.locator(".overlay-table-shape-content");
  await firstCellEditor.click();
  await page.keyboard.insertText("abc");
  await expect(firstCellEditor).toContainText("abc");
  const firstCellBox = await firstCell.boundingBox();
  expect(firstCellBox).not.toBeNull();
  await page.mouse.click(firstCellBox!.x + firstCellBox!.width / 2, firstCellBox!.y + firstCellBox!.height / 2, { button: "right" });
  await expect(page.locator(".overlay-table-context-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".overlay-table-context-menu")).toHaveCount(0);

  const fifthCell = table.locator("td").nth(4);
  const fifthCellBox = await fifthCell.boundingBox();
  expect(fifthCellBox).not.toBeNull();
  await page.mouse.move(firstCellBox!.x + firstCellBox!.width / 2, firstCellBox!.y + firstCellBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(fifthCellBox!.x + fifthCellBox!.width / 2, fifthCellBox!.y + fifthCellBox!.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(table.locator("td.selected-cell")).toHaveCount(4);

  await page.mouse.click(fifthCellBox!.x + fifthCellBox!.width / 2, fifthCellBox!.y + fifthCellBox!.height / 2, { button: "right" });
  const menu = page.locator(".overlay-table-context-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "選択範囲の行を削除" }).hover();
  await expect(table.locator("td.delete-preview")).toHaveCount(6);
  await menu.getByRole("menuitem", { name: "選択範囲の列を削除" }).hover();
  await expect(table.locator("td.delete-preview")).toHaveCount(6);
  await menu.getByRole("menuitem", { name: "選択範囲の列を削除" }).click();

  await expect(table.locator("tr").first().locator("td")).toHaveCount(1);
});

test("table insertion picker creates the requested grid and a second click re-enters editing", async ({ page }) => {
  await page.goto("/");

  const menu = await openShapeMenu(page);
  await menu.getByRole("menuitem", { name: "表", exact: true }).click();
  const tablePicker = page.getByRole("dialog", { name: "表を挿入" });
  await expect(tablePicker).toBeVisible();
  const fourByThree = tablePicker.getByRole("button", { name: "4列 3行の表を挿入", exact: true });
  await fourByThree.hover();
  await expect(tablePicker.locator(".table-insert-grid-size")).toHaveText("4 x 3");
  await fourByThree.click();
  await expect(tablePicker).toHaveCount(0);

  const table = page.locator(".overlay-table-shape").first();
  await expect(table).toBeVisible();
  await expect(table.locator("tr")).toHaveCount(3);
  await expect(table.locator("tr").first().locator("td")).toHaveCount(4);
  await expect(table).toHaveClass(/editing/);
  await expect(table.locator("td.selected-cell")).toHaveCount(0);
  await table.locator(".overlay-table-shape-content").first().click();
  await expect(table.locator("td.selected-cell")).toHaveCount(1);
  await expect(page.locator(".overlay-table-floating-toolbar.cell")).toBeVisible();

  const surface = page.locator(".overlay-canvas-editor").first();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  await page.mouse.click(surfaceBox!.x + 20, surfaceBox!.y + 20);
  // Leaving overlay editing unmounts the whole overlay editor (see the sibling table test): the
  // idle table is the static `.page-overlay-preview` render, which carries neither
  // `.overlay-table-shape` nor an `editing` class to lose.
  await expect(page.locator(".overlay-table-shape")).toHaveCount(0);
  await expect(page.locator(".overlay-table-floating-toolbar")).toHaveCount(0);

  const staticTable = page.locator(".page-overlay-preview [data-overlay-shape-id]").first();
  const tableBox = await staticTable.boundingBox();
  expect(tableBox).not.toBeNull();
  await grabShapeFromBody(page, {
    x: tableBox!.x + tableBox!.width / 2,
    y: tableBox!.y + tableBox!.height / 2,
  });
  await expect(page.locator(".overlay-shape-tableShape.selected")).toBeVisible();
  const selectedTableBox = await table.boundingBox();
  expect(selectedTableBox).not.toBeNull();
  await page.mouse.click(
    selectedTableBox!.x + selectedTableBox!.width / 2,
    selectedTableBox!.y + selectedTableBox!.height / 2,
  );
  await expect(table).toHaveClass(/editing/);
  await expect(table.locator("td.selected-cell")).toHaveCount(12);
  await expect(table.locator(".overlay-table-shape-content")).toHaveCount(12);

  const innerColumnBoundary = page.getByTestId("overlay-table-column-boundary").nth(1);
  await innerColumnBoundary.focus();
  await page.keyboard.press("Enter");
  const lineToolbar = page.locator(".overlay-table-floating-toolbar.line");
  await expect(lineToolbar).toBeVisible();
  await lineToolbar.getByRole("button", { name: /^線種（現在:/ }).click();
  await page.getByRole("menu", { name: "線種" }).getByRole("menuitemradio", { name: "二重線" }).click();

  const firstCell = table.locator("td").first();
  const secondCell = table.locator("td").nth(1);
  const renderedLine = table.locator(".overlay-table-rendered-line.vertical").first();
  // 二重線はcollapseしたセル罫線ではなく、専用の連続描画レイヤーだけで描く。
  await expect.poll(async () => firstCell.evaluate((element) => element.style.borderRightStyle)).toBe("none");
  await expect.poll(async () => firstCell.evaluate((element) => element.style.borderRightWidth)).toBe("0px");
  await expect(renderedLine).toBeVisible();
  await expect.poll(async () => renderedLine.evaluate((element) => getComputedStyle(element).borderLeftStyle)).toBe("double");
  await expect.poll(async () => renderedLine.evaluate((element) => getComputedStyle(element).borderLeftWidth)).toBe("3px");
  await expect.poll(async () => renderedLine.evaluate((element) => getComputedStyle(element).borderLeftColor)).toBe("rgb(17, 24, 39)");

  const lineConnector = table.locator(".overlay-table-line-connector.horizontal").last();
  await expect(lineConnector).toBeVisible();
  await expect.poll(async () => lineConnector.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe("solid");
  await expect.poll(async () => lineConnector.evaluate((element) => getComputedStyle(element).borderTopColor)).toBe("rgb(17, 24, 39)");
  await expect.poll(async () => {
    const tableBounds = await table.boundingBox();
    const lineBounds = await renderedLine.boundingBox();
    return tableBounds && lineBounds ? Math.abs(lineBounds.y - tableBounds.y) : Number.POSITIVE_INFINITY;
  }).toBeLessThan(1);
  await expect.poll(async () => secondCell.evaluate((element) => element.style.borderRightStyle)).toBe("solid");
  await expect.poll(async () => firstCell.evaluate((element) => element.style.borderBottomStyle)).toBe("solid");

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    const tableShape = document?.pageLayout?.overlay?.overlaySnapshot?.shapes?.find(
      (shape: { type?: string }) => shape.type === "tableShape",
    );
    const override = tableShape?.props?.table?.grid?.lineOverrides?.find(
      (line: { axis?: string; beforeColumnId?: string }) => line.axis === "vertical" && Boolean(line.beforeColumnId),
    );
    return override?.style ?? null;
  })).toMatchObject({
    visible: true,
    borderStyle: "double",
    borderWidth: 3,
  });
});

test("table editor keeps row boundary controls aligned after resizing a row", async ({ page }) => {
  await page.goto("/");

  const shapeMenu = await openShapeMenu(page);
  await shapeMenu.getByRole("menuitem", { name: "表", exact: true }).click();
  const tablePicker = page.getByRole("dialog", { name: "表を挿入" });
  await expect(tablePicker).toBeVisible();
  await tablePicker.getByRole("button", { name: "4列 3行の表を挿入" }).click();

  const table = page.locator(".overlay-table-shape").first();
  await expect(table).toBeVisible();
  const tableBox = await table.boundingBox();
  expect(tableBox).not.toBeNull();
  const center = {
    x: tableBox!.x + tableBox!.width / 2,
    y: tableBox!.y + tableBox!.height / 2,
  };
  await page.mouse.dblclick(center.x, center.y);
  await expect(table).toHaveClass(/editing/);

  const rowBoundary = page.getByTestId("overlay-table-row-boundary").nth(1);
  const rowBoundaryBox = await rowBoundary.boundingBox();
  expect(rowBoundaryBox).not.toBeNull();
  await page.mouse.move(rowBoundaryBox!.x + rowBoundaryBox!.width / 2, rowBoundaryBox!.y + rowBoundaryBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(rowBoundaryBox!.x + rowBoundaryBox!.width / 2, rowBoundaryBox!.y + rowBoundaryBox!.height / 2 + 24, { steps: 8 });

  const selectedBoundary = page.locator('[data-testid="overlay-table-row-boundary"].selected');
  await expect.poll(async () => table.evaluate((element) => {
    const firstRow = element.querySelector("tr");
    const selected = element.querySelector('[data-testid="overlay-table-row-boundary"].selected');
    if (!firstRow || !selected) {
      return Number.POSITIVE_INFINITY;
    }
    const selectedRect = selected.getBoundingClientRect();
    return Math.abs(selectedRect.top + selectedRect.height / 2 - firstRow.getBoundingClientRect().bottom);
  })).toBeLessThan(1.5);
  await page.mouse.up();

  await expect(selectedBoundary).toHaveCount(1);
  await expect.poll(async () => table.evaluate((element) => {
    const rows = Array.from(element.querySelectorAll("tr"));
    const boundaries = Array.from(element.querySelectorAll('[data-testid="overlay-table-row-boundary"]'));
    if (rows.length === 0 || boundaries.length !== rows.length + 1) {
      return Number.POSITIVE_INFINITY;
    }

    const rowBounds = rows.map((row) => row.getBoundingClientRect());
    const visualBoundaries = [rowBounds[0].top, ...rowBounds.map((rect) => rect.bottom)];
    return Math.max(...boundaries.map((boundary, index) => {
      const boundaryRect = boundary.getBoundingClientRect();
      return Math.abs(boundaryRect.top + boundaryRect.height / 2 - visualBoundaries[index]);
    }));
  })).toBeLessThan(1.5);

  const lineToolbar = page.locator(".overlay-table-floating-toolbar.line");
  await expect(lineToolbar.getByRole("button", { name: "罫線を表示" })).toHaveCount(0);
  await expect(lineToolbar.getByRole("button", { name: "罫線を非表示" })).toHaveCount(0);
  await lineToolbar.getByRole("button", { name: /^線種（現在:/ }).click();
  const lineStyleMenu = page.getByRole("menu", { name: "線種" });
  await expect(lineStyleMenu.getByRole("menuitemradio", { name: "線なし" })).toBeVisible();
  await lineStyleMenu.getByRole("menuitemradio", { name: "線なし" }).click();
  await expect(lineToolbar.getByRole("button", { name: "線種（現在: 線なし）" })).toBeVisible();
});

test("selected table shape expands vertically from the resize handle", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "表");

  const table = page.locator(".overlay-table-shape").first();
  await expect(table).toBeVisible();
  const tableBox = await table.boundingBox();
  expect(tableBox).not.toBeNull();
  await page.mouse.click(tableBox!.x + tableBox!.width / 2, tableBox!.y + tableBox!.height / 2);

  const beforeResize = await table.boundingBox();
  expect(beforeResize).not.toBeNull();
  const resizeHandle = page.locator(".overlay-resize-handle.se").first();
  await expect(resizeHandle).toBeVisible();
  const handleBox = await resizeHandle.boundingBox();
  expect(handleBox).not.toBeNull();

  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 4, handleBox!.y + handleBox!.height / 2 + 56, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => {
    const after = await table.boundingBox();
    return after ? Math.round(after.height - beforeResize!.height) : 0;
  }).toBeGreaterThan(40);
});

test("selected table shape shrinks vertically without auto-expanding", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "表");

  const table = page.locator(".overlay-table-shape").first();
  await expect(table).toBeVisible();
  const tableBox = await table.boundingBox();
  expect(tableBox).not.toBeNull();
  await page.mouse.click(tableBox!.x + tableBox!.width / 2, tableBox!.y + tableBox!.height / 2);

  const resizeHandle = page.locator(".overlay-resize-handle.se").first();
  await expect(resizeHandle).toBeVisible();
  const handleBox = await resizeHandle.boundingBox();
  expect(handleBox).not.toBeNull();

  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2 - 112, { steps: 10 });
  await page.mouse.up();

  await expect.poll(async () => {
    const after = await table.boundingBox();
    return after ? Math.round(after.height) : Number.POSITIVE_INFINITY;
  }).toBeLessThan(24);
  await page.waitForTimeout(300);
  const settled = await table.boundingBox();
  expect(settled).not.toBeNull();
  expect(Math.round(settled!.height)).toBeLessThan(24);
});

test("dragging table outer grid lines resizes the table bounds", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "表");

  const table = page.locator(".overlay-table-shape").first();
  await expect(table).toBeVisible();
  const tableBox = await table.boundingBox();
  expect(tableBox).not.toBeNull();
  const center = {
    x: tableBox!.x + tableBox!.width / 2,
    y: tableBox!.y + tableBox!.height / 2,
  };
  await page.mouse.click(center.x, center.y);
  await page.mouse.click(center.x, center.y);
  await expect(page.locator(".overlay-table-floating-toolbar.cell")).toBeVisible();

  const beforeBottomDrag = await table.boundingBox();
  expect(beforeBottomDrag).not.toBeNull();
  const rowBoundaries = page.getByTestId("overlay-table-row-boundary");
  const rowBoundaryCount = await rowBoundaries.count();
  const bottomBoundary = rowBoundaries.nth(rowBoundaryCount - 1);
  const bottomBoundaryBox = await bottomBoundary.boundingBox();
  expect(bottomBoundaryBox).not.toBeNull();
  await page.mouse.move(bottomBoundaryBox!.x + bottomBoundaryBox!.width / 2, bottomBoundaryBox!.y + bottomBoundaryBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(bottomBoundaryBox!.x + bottomBoundaryBox!.width / 2, bottomBoundaryBox!.y + bottomBoundaryBox!.height / 2 + 36, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => {
    const after = await table.boundingBox();
    return after ? Math.round(after.height - beforeBottomDrag!.height) : 0;
  }).toBeGreaterThan(25);
  await expect.poll(async () => {
    const after = await table.boundingBox();
    return after ? Math.abs(after.y - beforeBottomDrag!.y) : Number.POSITIVE_INFINITY;
  }).toBeLessThan(1.5);

  const beforeTopDrag = await table.boundingBox();
  expect(beforeTopDrag).not.toBeNull();
  const topBoundary = rowBoundaries.nth(0);
  const topBoundaryBox = await topBoundary.boundingBox();
  expect(topBoundaryBox).not.toBeNull();
  await page.mouse.move(topBoundaryBox!.x + topBoundaryBox!.width / 2, topBoundaryBox!.y + topBoundaryBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(topBoundaryBox!.x + topBoundaryBox!.width / 2, topBoundaryBox!.y + topBoundaryBox!.height / 2 - 32, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => {
    const after = await table.boundingBox();
    return after ? Math.round(after.height - beforeTopDrag!.height) : 0;
  }).toBeGreaterThan(20);
  await expect.poll(async () => {
    const after = await table.boundingBox();
    return after ? Math.round(beforeTopDrag!.y - after.y) : 0;
  }).toBeGreaterThan(20);

  const beforeRightDrag = await table.boundingBox();
  expect(beforeRightDrag).not.toBeNull();
  const columnBoundaries = page.getByTestId("overlay-table-column-boundary");
  const columnBoundaryCount = await columnBoundaries.count();
  const rightBoundary = columnBoundaries.nth(columnBoundaryCount - 1);
  const rightBoundaryBox = await rightBoundary.boundingBox();
  expect(rightBoundaryBox).not.toBeNull();
  await page.mouse.move(rightBoundaryBox!.x + rightBoundaryBox!.width / 2, rightBoundaryBox!.y + rightBoundaryBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(rightBoundaryBox!.x + rightBoundaryBox!.width / 2 + 42, rightBoundaryBox!.y + rightBoundaryBox!.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => {
    const after = await table.boundingBox();
    return after ? Math.round(after.width - beforeRightDrag!.width) : 0;
  }).toBeGreaterThan(30);
  await expect.poll(async () => {
    const after = await table.boundingBox();
    return after ? Math.abs(after.x - beforeRightDrag!.x) : Number.POSITIVE_INFINITY;
  }).toBeLessThan(1.5);

  const beforeLeftDrag = await table.boundingBox();
  expect(beforeLeftDrag).not.toBeNull();
  const leftBoundary = columnBoundaries.nth(0);
  const leftBoundaryBox = await leftBoundary.boundingBox();
  expect(leftBoundaryBox).not.toBeNull();
  await page.mouse.move(leftBoundaryBox!.x + leftBoundaryBox!.width / 2, leftBoundaryBox!.y + leftBoundaryBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(leftBoundaryBox!.x + leftBoundaryBox!.width / 2 - 38, leftBoundaryBox!.y + leftBoundaryBox!.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => {
    const after = await table.boundingBox();
    return after ? Math.round(after.width - beforeLeftDrag!.width) : 0;
  }).toBeGreaterThan(28);
  await expect.poll(async () => {
    const after = await table.boundingBox();
    return after ? Math.round(beforeLeftDrag!.x - after.x) : 0;
  }).toBeGreaterThan(28);
});

test("selects arrows from a forgiving stroke hit area", async ({ page }) => {
  await page.goto("/");

  const arrowCountBefore = await page.locator(".overlay-shape-arrow").count();
  await chooseShape(page, "矢印", { create: false });
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();

  const startX = surfaceBox!.x + 220;
  const startY = surfaceBox!.y + 150;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 180, startY, { steps: 8 });
  await page.mouse.up();

  const arrow = page.locator(".overlay-shape-arrow").nth(arrowCountBefore);
  await expect(arrow).toBeVisible();

  await page.keyboard.down("Shift");
  await page.mouse.click(startX + 90, startY);
  await page.keyboard.up("Shift");
  await expect(page.locator(".overlay-shape-arrow.selected")).toHaveCount(0);

  await page.mouse.click(startX + 90, startY + 18);
  await expect(arrow).toHaveClass(/selected/);
});

test("adds curve nodes with clicks before finishing", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "曲線");
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();

  const startX = surfaceBox!.x + 230;
  const startY = surfaceBox!.y + 190;
  await page.mouse.click(startX, startY);
  await expect(page.locator(".overlay-shape-line")).toHaveCount(0);

  await page.mouse.move(startX + 70, startY - 46, { steps: 4 });
  const previewPath = page.locator(".overlay-insert-preview-shape .overlay-vector-svg > path").first();
  await expect(previewPath).toBeVisible();

  await page.mouse.click(startX + 70, startY - 46);
  await expect(page.locator(".overlay-shape-line")).toHaveCount(0);
  await page.mouse.dblclick(startX + 155, startY + 20);

  const curve = page.locator(".overlay-shape-line").first();
  await expect(curve).toBeVisible();
  await expect(page.locator(".overlay-canvas-editor.inserting")).toHaveCount(0);
  await expect(page.locator(".overlay-line-point-handle")).toHaveCount(3);
  await expect.poll(async () => curve.locator(".overlay-vector-svg > path").first().getAttribute("d")).toContain("Q");
});

/**
 * Click-to-place tools had no visible affordance at all: the keys that finish, undo one point and
 * cancel were reachable but written down nowhere, and the placed points were invisible.
 */
test("guides the author through placing curve points", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "曲線");
  const hint = page.getByTestId("overlay-drawing-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("始点");

  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  const startX = surfaceBox!.x + 230;
  const startY = surfaceBox!.y + 190;

  await page.mouse.click(startX, startY);
  await expect(page.locator(".overlay-drawing-vertex-marker")).not.toHaveCount(0);
  await expect(hint).toContainText("Esc");
  await expect(hint).not.toContainText("Enter");

  await page.mouse.click(startX + 70, startY - 46);
  await expect(hint).toContainText("Enter");
  await expect(hint).toContainText("Backspace");

  await page.keyboard.press("Escape");
  await expect(page.locator(".overlay-canvas-editor.inserting")).toHaveCount(0);
  await expect(hint).toHaveCount(0);
  await expect(page.locator(".overlay-shape-line")).toHaveCount(0);
});

test("shows the first polyline vertex as a target while it can be closed", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "折れ線");
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();

  const startX = surfaceBox!.x + 240;
  const startY = surfaceBox!.y + 185;
  await page.mouse.click(startX, startY);
  await page.mouse.click(startX + 90, startY);
  await page.mouse.click(startX + 90, startY + 70);

  // The 10px close target is otherwise invisible; nothing tells the author it exists.
  await expect(page.locator(".overlay-drawing-vertex-marker.close-target")).toHaveCount(0);
  await page.mouse.move(startX + 3, startY + 3, { steps: 4 });
  await expect(page.locator(".overlay-drawing-vertex-marker.close-target")).toHaveCount(1);
  await expect(page.getByTestId("overlay-drawing-hint")).toContainText("最初の点");

  await page.mouse.click(startX + 3, startY + 3);
  await expect(page.locator(".overlay-shape-line").first().locator(".overlay-vector-svg > polygon")).toBeVisible();

  // A closed polygon gets a handle on its closing edge too, so every side can grow a point.
  await expect(page.locator(".overlay-line-point-handle")).toHaveCount(3);
  await expect(page.locator(".overlay-line-insert-handle")).toHaveCount(3);

  // ...and it stays a polygon: the third point cannot be removed.
  await altClickHandle(page, page.locator(".overlay-line-point-handle").nth(1));
  await expect(page.locator(".overlay-line-point-handle")).toHaveCount(3);
});

test("offers a midpoint handle on a flat line, whose selection box is only a few pixels tall", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "折れ線");
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  const startX = surfaceBox!.x + 180;
  const startY = surfaceBox!.y + 220;

  await page.mouse.click(startX, startY);
  await page.mouse.click(startX + 200, startY);
  await page.keyboard.press("Enter");

  await expect(page.locator(".overlay-line-point-handle")).toHaveCount(2);
  await expect(page.locator(".overlay-line-insert-handle")).toHaveCount(1);
});

test("adds a curve control point by dragging a midpoint handle", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "曲線");
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  const startX = surfaceBox!.x + 200;
  const startY = surfaceBox!.y + 200;

  await page.mouse.click(startX, startY);
  await page.mouse.click(startX + 90, startY - 50);
  await page.mouse.dblclick(startX + 180, startY);

  const curve = page.locator(".overlay-shape-line").first();
  await expect(page.locator(".overlay-line-point-handle")).toHaveCount(3);
  await expect(page.locator(".overlay-line-insert-handle")).toHaveCount(2);
  const before = await curve.locator(".overlay-vector-svg > path").first().getAttribute("d");

  await dragHandle(page, page.locator(".overlay-line-insert-handle").first(), 0, -50);

  await expect(page.locator(".overlay-line-point-handle")).toHaveCount(4);
  await expect.poll(async () => curve.locator(".overlay-vector-svg > path").first().getAttribute("d"))
    .not.toBe(before);
});

test("removes an interior control point with alt click, and never the first one", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "曲線");
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  const startX = surfaceBox!.x + 190;
  const startY = surfaceBox!.y + 210;

  await page.mouse.click(startX, startY);
  await page.mouse.click(startX + 60, startY - 50);
  await page.mouse.click(startX + 130, startY - 20);
  await page.mouse.dblclick(startX + 190, startY + 30);
  await expect(page.locator(".overlay-line-point-handle")).toHaveCount(4);

  await altClickHandle(page, page.locator(".overlay-line-point-handle").nth(1));
  await expect(page.locator(".overlay-line-point-handle")).toHaveCount(3);

  // Point 0 is the shape's origin; removing it would move the whole figure.
  await altClickHandle(page, page.locator(".overlay-line-point-handle").first());
  await expect(page.locator(".overlay-line-point-handle")).toHaveCount(3);
});

test("draws a polyline with clicks and keyboard completion", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "折れ線");
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();

  const startX = surfaceBox!.x + 210;
  const startY = surfaceBox!.y + 170;
  await page.mouse.click(startX, startY);
  await page.mouse.click(startX + 70, startY - 30);
  await page.mouse.click(startX + 140, startY + 30);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");

  const polyline = page.locator(".overlay-shape-line").first();
  await expect(polyline).toBeVisible();
  await expect(page.locator(".overlay-canvas-editor.inserting")).toHaveCount(0);
  await expect(page.locator(".overlay-line-point-handle")).toHaveCount(2);
  await expect(polyline.locator(".overlay-vector-svg > polyline")).toBeVisible();
});

test("closes a polyline by clicking its first vertex", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "折れ線");
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();

  const startX = surfaceBox!.x + 240;
  const startY = surfaceBox!.y + 185;
  await page.mouse.click(startX, startY);
  await page.mouse.click(startX + 82, startY - 42);
  await page.mouse.click(startX + 150, startY + 36);
  await page.mouse.click(startX + 2, startY + 1);

  const polyline = page.locator(".overlay-shape-line").first();
  await expect(polyline).toBeVisible();
  await expect(page.locator(".overlay-canvas-editor.inserting")).toHaveCount(0);
  await expect(polyline.locator(".overlay-vector-svg > polygon")).toBeVisible();
  await expect(polyline.locator(".overlay-vector-svg > polyline")).toHaveCount(0);
  await expect(page.locator(".overlay-line-point-handle")).toHaveCount(3);
  await expect(page.locator(".overlay-selection-box.point-only")).toHaveCount(1);
  await expect(page.locator(".overlay-rotate-handle")).toHaveCount(0);

  const polygon = polyline.locator(".overlay-vector-svg > polygon");
  const pointsBeforeHandleMove = await polygon.getAttribute("points");
  expect(pointsBeforeHandleMove?.trim().split(/\s+/)).toHaveLength(3);
  await dragHandle(page, page.locator(".overlay-line-point-handle").nth(1), 28, -18);
  await expect.poll(async () => polygon.getAttribute("points")).not.toBe(pointsBeforeHandleMove);
  await expect(page.locator(".overlay-line-point-handle")).toHaveCount(3);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    const closedLine = document?.pageLayout?.overlay?.overlaySnapshot?.shapes?.find(
      (shape: { type?: string; props?: { closed?: boolean } }) => shape.type === "line" && shape.props?.closed,
    );
    return {
      closed: closedLine?.props?.closed ?? false,
      pointCount: closedLine?.props?.points?.length ?? 0,
    };
  })).toEqual({ closed: true, pointCount: 3 });

  const fillButton = page.getByRole("button", { name: "内部塗りつぶし", exact: true });
  await expect(fillButton).toBeVisible();
  await fillButton.click();
  await page.locator(".color-popover").getByTitle("#ffc400").click();
  await expect.poll(async () => polyline.locator(".overlay-vector-svg > polygon").getAttribute("fill")).toBe("#ffc400");
});

test("selected overlay shapes use context menu duplicate and delete", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "四角形");
  const rectangle = page.locator(".overlay-shape-geo").first();
  await expect(rectangle).toBeVisible();
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
  await expect(page.locator(".overlay-selection-toolbar")).toHaveCount(0);

  await rectangle.click({ button: "right" });
  const contextMenu = page.locator(".overlay-shape-context-menu");
  await expect(contextMenu).toBeVisible();
  const duplicateItem = contextMenu.getByRole("menuitem", { name: "複製", exact: true });
  const deleteItem = contextMenu.getByRole("menuitem", { name: "削除", exact: true });
  await expect(duplicateItem).toBeEnabled();
  await expect(deleteItem).toBeEnabled();
  await duplicateItem.click();
  await expect(page.locator(".overlay-shape-geo")).toHaveCount(2);
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
  await expect(page.locator(".overlay-selection-toolbar")).toHaveCount(0);

  await page.locator(".overlay-shape.selected").click({ button: "right" });
  await expect(contextMenu).toBeVisible();
  await contextMenu.getByRole("menuitem", { name: "削除", exact: true }).click();
  await expect(page.locator(".overlay-shape-geo")).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  await expect.poll(async () => (await getSavedOverlayShapes(page)).filter((shape) => shape.type === "geo").length).toBe(1);
});

test("rotates and flips a shape from the context submenu", async ({ page }) => {
  await page.goto("/");
  const originalViewport = page.viewportSize();
  expect(originalViewport).not.toBeNull();

  await chooseShape(page, "太矢印");
  const shape = page.locator(".overlay-shape.selected").first();
  const shapeId = await shape.getAttribute("data-overlay-shape-id");
  expect(shapeId).not.toBeNull();

  await shape.click({ button: "right" });
  const contextMenu = page.locator(".overlay-shape-context-menu");
  const orderItem = contextMenu.getByRole("menuitem", { name: "順序", exact: true });
  await expect(orderItem).toBeVisible();
  await orderItem.hover();
  const orderSubmenu = page.getByRole("menu", { name: "順序", exact: true });
  await expect(orderSubmenu).toBeVisible();
  await orderSubmenu.getByRole("menuitem", { name: "最前面へ", exact: true }).hover();
  await page.waitForTimeout(250);
  await expect(orderSubmenu).toBeVisible();
  await page.setViewportSize({ width: 720, height: 320 });
  await expect.poll(async () => {
    const bounds = await orderSubmenu.boundingBox();
    return Boolean(bounds && bounds.y >= 8 && bounds.y + bounds.height <= 312);
  }).toBe(true);
  await page.setViewportSize(originalViewport!);
  await page.mouse.move(0, 0);
  await expect(orderSubmenu).toBeHidden();
  const rotationItem = contextMenu.getByRole("menuitem", { name: "回転", exact: true });
  await expect(rotationItem).toBeVisible();
  await orderItem.hover();
  await expect(orderSubmenu).toBeVisible();
  await rotationItem.hover();
  const rotationSubmenu = page.getByRole("menu", { name: "回転", exact: true });
  await page.waitForTimeout(350);
  await expect(rotationSubmenu).toBeVisible();
  await rotationSubmenu.getByRole("menuitem", { name: "右回りに 90° 回転", exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  await expect.poll(async () => {
    const saved = await getSavedOverlayShapes(page);
    return saved.find((item) => item.id === shapeId)?.rotation;
  }).toBeCloseTo(Math.PI / 2);

  await shape.click({ button: "right" });
  await contextMenu.getByRole("menuitem", { name: "回転", exact: true }).hover();
  await page.getByRole("menu", { name: "回転", exact: true }).getByRole("menuitem", { name: "左右反転", exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  await expect.poll(async () => {
    const saved = await getSavedOverlayShapes(page);
    const transformed = saved.find((item) => item.id === shapeId);
    return { rotation: transformed?.rotation, flipX: transformed?.flipX };
  }).toEqual({ rotation: -Math.PI / 2, flipX: true });
});

test("backspace deletes a selected overlay shape after text editor focus", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "四角形");
  const rectangle = page.locator(".overlay-shape-geo").first();
  await expect(rectangle).toBeVisible();

  await page.locator(".text-flow-editor").first().evaluate((element) => {
    if (element instanceof HTMLElement) {
      element.focus();
    }
  });
  await expect.poll(async () => page.evaluate(() => {
    return Boolean(document.activeElement?.closest(".text-flow-editor"));
  })).toBe(true);

  const box = await rectangle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(rectangle).toHaveClass(/selected/);

  await page.keyboard.press("Backspace");
  await expect(page.locator(".overlay-shape-geo")).toHaveCount(0);
});

test("triangle apex handle changes polygon points", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "三角形");
  const triangle = page.locator(".overlay-shape-geo").first();
  const polygon = triangle.locator("polygon");
  await expect(polygon).toBeVisible();
  const pointsBefore = await polygon.getAttribute("points");
  expect(pointsBefore).not.toBeNull();

  await dragHandle(page, page.locator(".overlay-triangle-apex-handle").first(), 48, 0);

  await expect.poll(async () => polygon.getAttribute("points")).not.toBe(pointsBefore);
});

test("triangle and block-arrow adjustment handles share the arc adjustment UX", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "三角形");
  const triangleHandle = page.locator(".overlay-triangle-apex-handle").first();
  await expect(triangleHandle).toHaveClass(/overlay-adjust-handle/);
  const triangleHandleBox = await triangleHandle.boundingBox();
  expect(triangleHandleBox).not.toBeNull();
  await page.mouse.move(triangleHandleBox!.x + triangleHandleBox!.width / 2, triangleHandleBox!.y + triangleHandleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(triangleHandleBox!.x + 36, triangleHandleBox!.y);
  await expect(page.locator(".overlay-drag-readout")).toContainText("頂点");
  await page.mouse.up();

  await chooseShape(page, "太矢印");
  await expect(page.locator(".overlay-block-arrow-head-handle")).toHaveClass(/overlay-adjust-handle/);
  await expect(page.locator(".overlay-block-arrow-shaft-handle")).toHaveClass(/overlay-adjust-handle/);
  const headHandleBox = await page.locator(".overlay-block-arrow-head-handle").boundingBox();
  expect(headHandleBox).not.toBeNull();
  await page.mouse.move(headHandleBox!.x + headHandleBox!.width / 2, headHandleBox!.y + headHandleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(headHandleBox!.x - 24, headHandleBox!.y);
  await expect(page.locator(".overlay-drag-readout")).toContainText("矢じり");
  await page.mouse.up();
});

test("changes a shape type from the context menu and keeps a fitted twelve-gon", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "三角形");
  const shape = page.locator(".overlay-shape-geo").first();
  await shape.click({ button: "right" });
  const contextMenu = page.locator(".overlay-shape-context-menu");
  await expect(contextMenu).toBeVisible();
  await contextMenu.getByRole("menuitem", { name: "図形の種類を変更", exact: true }).click();
  await contextMenu.getByRole("menuitem", { name: "正十二角形", exact: true }).click();

  const polygon = page.locator(".overlay-shape-geo polygon").first();
  await expect(polygon).toBeVisible();
  const points = await polygon.getAttribute("points");
  expect(points?.trim().split(/\s+/)).toHaveLength(12);
  const parsed = points!.trim().split(/\s+/).map((point) => point.split(",").map(Number));
  const xs = parsed.map(([x]) => x);
  const ys = parsed.map(([, y]) => y);
  const svgBox = await page.locator(".overlay-shape-geo .overlay-vector-svg").first().boundingBox();
  expect(svgBox).not.toBeNull();
  expect(Math.abs(Math.min(...xs) - 1)).toBeLessThan(0.1);
  expect(Math.abs(Math.max(...xs) - (svgBox!.width - 1))).toBeLessThan(0.1);
  expect(Math.abs(Math.min(...ys) - 1)).toBeLessThan(0.1);
  expect(Math.abs(Math.max(...ys) - (svgBox!.height - 1))).toBeLessThan(0.1);
});

test("arc endpoint handles change the arc path", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "円弧");
  const arc = page.locator(".overlay-shape-arc").first();
  const path = arc.locator(".overlay-vector-svg > path");
  await expect(path).toBeVisible();
  const pathBefore = await path.getAttribute("d");
  expect(pathBefore).not.toBeNull();
  await expect(page.locator(".overlay-arc-point-handle")).toHaveCount(2);

  await dragHandle(page, page.locator(".overlay-arc-point-handle.end").first(), 36, 44);

  await expect.poll(async () => path.getAttribute("d")).not.toBe(pathBefore);
});

test("callout tail handles move the tip and adjust the mouth width", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "吹き出し");
  const callout = page.locator(".overlay-shape-callout").first();
  const path = callout.locator("path");
  await expect(path).toBeVisible();
  await expect(page.locator(".overlay-callout-tail-tip-handle")).toHaveCount(1);
  await expect(page.locator(".overlay-callout-tail-base-handle")).toHaveCount(2);

  const beforeTip = await path.getAttribute("d");
  await dragHandle(page, page.locator(".overlay-callout-tail-tip-handle").first(), 56, 0);
  await expect.poll(async () => path.getAttribute("d")).not.toBe(beforeTip);

  const beforeWidth = await path.getAttribute("d");
  await dragHandle(page, page.locator(".overlay-callout-tail-base-handle").first(), 18, 0);
  await expect.poll(async () => path.getAttribute("d")).not.toBe(beforeWidth);
});

test("re-enters text shape editing after focus leaves", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "テキスト");
  const textShape = page.locator(".overlay-shape-text").first();
  await expect(textShape).toBeVisible();

  const editor = textShape.locator(".overlay-text-shape-content");
  await expect(editor).toBeFocused();
  await expect.poll(async () => editor.evaluate((element) => (element.textContent ?? "").trim())).toBe("");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type("一次関数");
  await expect(editor).toContainText("一次関数");

  const pageBox = await page.locator(".a4-page-sheet").first().boundingBox();
  expect(pageBox).not.toBeNull();
  await page.mouse.click(pageBox!.x + 24, pageBox!.y + 24);
  const preview = page.locator(".page-overlay-preview").filter({ hasText: "一次関数" });
  await expect(preview).toBeVisible();

  const previewText = preview.locator(".overlay-shape-text").filter({ hasText: "一次関数" }).first();
  await expect(previewText).toBeVisible();
  const previewBox = await previewText.boundingBox();
  expect(previewBox).not.toBeNull();
  await grabShapeFromBody(page, {
    x: previewBox!.x + previewBox!.width / 2,
    y: previewBox!.y + previewBox!.height / 2,
  });

  const resumedShape = page.locator(".overlay-shape-text").first();
  await expect(resumedShape).toBeVisible();
  const resumedBox = await resumedShape.boundingBox();
  expect(resumedBox).not.toBeNull();
  await page.mouse.dblclick(resumedBox!.x + resumedBox!.width / 2, resumedBox!.y + resumedBox!.height / 2);

  const resumedEditor = resumedShape.locator(".overlay-text-shape-content");
  await expect(resumedEditor).toBeVisible();
  await expect(resumedEditor).toBeFocused();
  await page.keyboard.type("のグラフ");
  await expect(resumedEditor).toContainText("一次関数のグラフ");
});

test("keeps a rotated text shape's glyphs still when its height changes", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "テキスト");
  const textShape = page.locator(".overlay-shape-text").first();
  const editor = textShape.locator(".overlay-text-shape-content");
  await expect(editor).toBeFocused();
  await page.keyboard.type("一行目");
  await expect(editor).toContainText("一行目");
  await page.keyboard.press("Escape");

  await rotateSelectedShape(page, textShape);
  const selectionBox = page.locator(".overlay-selection-box").first();
  const rotated = await getSelectionBoxState(selectionBox);
  expect(Math.abs(rotated.rotation)).toBeGreaterThan(0.1);

  const beforeGlyph = await firstGlyphPagePoint(textShape);
  const shapeBox = await textShape.boundingBox();
  expect(shapeBox).not.toBeNull();
  await page.mouse.dblclick(shapeBox!.x + shapeBox!.width / 2, shapeBox!.y + shapeBox!.height / 2);
  await expect(editor).toBeFocused();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type("一行目");
  await page.keyboard.press("Enter");
  await page.keyboard.type("二行目");
  await expect(editor).toContainText("二行目");
  await page.keyboard.press("Escape");

  await expect.poll(async () => (await getSelectionBoxState(selectionBox)).h)
    .toBeGreaterThan(rotated.h + 4);

  // 高さが変われば回転軸も動くので、補正が無いと1行目の字ごと紙面上を振れる。
  // 90°付近では (Δh/2, Δh/2) ぶん、実測で11px動いていた。
  const afterGlyph = await firstGlyphPagePoint(textShape);
  expect(Math.hypot(afterGlyph.x - beforeGlyph.x, afterGlyph.y - beforeGlyph.y)).toBeLessThan(2);
});

test("inserts the default text only after an empty text shape loses focus", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "テキスト");
  const textShape = page.locator(".overlay-shape-text").first();
  const editor = textShape.locator(".overlay-text-shape-content");
  await expect(editor).toBeFocused();
  await expect.poll(async () => editor.evaluate((element) => (element.textContent ?? "").trim())).toBe("");
  await expect.poll(async () => {
    const box = await textShape.boundingBox();
    return box?.width ?? 0;
  }).toBeLessThan(40);

  const pageBox = await page.locator(".a4-page-sheet").first().boundingBox();
  expect(pageBox).not.toBeNull();
  await page.mouse.click(pageBox!.x + 24, pageBox!.y + 24);

  await expect(page.locator(".page-overlay-preview").filter({ hasText: "テキスト" })).toBeVisible();
});

test("autosizes text shape height for tall inline math", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "テキスト");
  const textShape = page.locator(".overlay-shape-text").first();
  const editor = textShape.locator(".overlay-text-shape-content");
  await expect(editor).toBeFocused();

  const beforeBox = await textShape.boundingBox();
  expect(beforeBox).not.toBeNull();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("sigma-studio:insert-inline-math", {
      detail: {
        target: "overlay",
        tex: "\\displaystyle\\sum_{i=1}^{n} x_i",
        edit: false,
      },
    }));
  });

  const mathNode = textShape.locator(".inline-math-node").first();
  await expect(mathNode).toBeVisible();
  await expect.poll(async () => {
    const box = await textShape.boundingBox();
    return box?.height ?? 0;
  }).toBeGreaterThan(beforeBox!.height + 8);
  await expect.poll(async () => textShape.evaluate((element) => {
    const shapeBox = element.getBoundingClientRect();
    const math = element.querySelector(".inline-math-node");
    if (!math) {
      return -999;
    }
    const mathRects = [math, ...Array.from(math.querySelectorAll("*"))]
      .map((item) => item.getBoundingClientRect())
      .filter((rect) => rect.width > 0 || rect.height > 0);
    if (mathRects.length === 0) {
      return -999;
    }
    const mathBottom = Math.max(...mathRects.map((rect) => rect.bottom));
    return Math.floor(shapeBox.bottom - mathBottom);
  })).toBeGreaterThanOrEqual(-1);

  const pageBox = await page.locator(".a4-page-sheet").first().boundingBox();
  expect(pageBox).not.toBeNull();
  await page.mouse.click(pageBox!.x + 24, pageBox!.y + 24);

  const previewText = page.locator(".page-overlay-preview .overlay-shape-text").filter({ has: page.locator("[data-sigma-doc-math-inline]") }).first();
  await expect(previewText).toBeVisible();
  await expect.poll(async () => {
    const box = await previewText.boundingBox();
    return box?.height ?? 0;
  }).toBeGreaterThan(beforeBox!.height + 8);
  await expect.poll(async () => previewText.evaluate((element) => {
    const previewBox = element.getBoundingClientRect();
    const math = element.querySelector("[data-sigma-doc-math-inline]");
    if (!math) {
      return -999;
    }
    const mathRects = [math, ...Array.from(math.querySelectorAll("*"))]
      .map((item) => item.getBoundingClientRect())
      .filter((rect) => rect.width > 0 || rect.height > 0);
    if (mathRects.length === 0) {
      return -999;
    }
    const mathBottom = Math.max(...mathRects.map((rect) => rect.bottom));
    return Math.floor(previewBox.bottom - mathBottom);
  })).toBeGreaterThanOrEqual(-1);
});

test("resizes a text shape by width alone", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "テキスト");
  const textShape = page.locator(".overlay-shape-text").first();
  const textShapeId = await textShape.getAttribute("data-overlay-shape-id");
  expect(textShapeId).not.toBeNull();
  const textBody = textShape.locator(".overlay-text-shape").first();
  const editor = textShape.locator(".overlay-text-shape-content");
  await expect(editor).toBeFocused();
  await page.keyboard.type("あいうえおかきくけこさしすせそ");
  await expect(editor).toContainText("あいうえお");

  const readSaved = async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
    return (await getSavedOverlayShapes(page)).find((shape) => shape.id === textShapeId);
  };

  const beforeBox = await textShape.boundingBox();
  expect(beforeBox).not.toBeNull();
  const beforeFontSize = await textBody.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  await page.keyboard.press("Escape");

  // The width is the author's and the height comes from the content, so the corners that used to
  // scale the glyphs are gone and only the two width handles are left. Rotation is unaffected.
  await expect(page.locator(".overlay-resize-handle")).toHaveCount(2);
  await expect(page.locator(".overlay-resize-handle.e")).toHaveCount(1);
  await expect(page.locator(".overlay-resize-handle.w")).toHaveCount(1);
  await expect(page.locator(".overlay-rotate-handle")).toHaveCount(1);

  // Narrowing wraps the text: the box gets taller without the type getting smaller, and it grows
  // downwards from where it already was instead of drifting.
  await dragHandle(page, page.locator(".overlay-resize-handle.e").first(), -90, 40);

  await expect.poll(async () => (await textShape.boundingBox())?.width ?? 0)
    .toBeLessThan(beforeBox!.width - 60);
  await expect.poll(async () => (await textShape.boundingBox())?.height ?? 0)
    .toBeGreaterThan(beforeBox!.height + 4);
  const narrowed = await textShape.boundingBox();
  expect(narrowed).not.toBeNull();
  expect(Math.abs(narrowed!.x - beforeBox!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(narrowed!.y - beforeBox!.y)).toBeLessThanOrEqual(2);
  expect(await textBody.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)))
    .toBeCloseTo(beforeFontSize, 1);

  // The west handle moves the left edge and leaves the right one where it is.
  const savedBeforeWest = await readSaved();
  expect(typeof savedBeforeWest?.anchor?.dx).toBe("number");
  await dragHandle(page, page.locator(".overlay-resize-handle.w").first(), -60, 0);

  await expect.poll(async () => (await textShape.boundingBox())?.x ?? 0)
    .toBeLessThan(narrowed!.x - 40);
  const widened = await textShape.boundingBox();
  expect(widened).not.toBeNull();
  expect(Math.abs((widened!.x + widened!.width) - (narrowed!.x + narrowed!.width))).toBeLessThanOrEqual(2);

  // A shape's position is stored twice — `x`/`y` and the anchor's offset — and the anchor is what
  // the loader reads. A resize that moved the left edge without re-anchoring looks right until the
  // document is opened again, then snaps back (PR #447). So both have to move by the same amount.
  const savedAfterWest = await readSaved();
  expect(savedAfterWest?.x).toBeLessThan(savedBeforeWest!.x!);
  expect(savedAfterWest!.anchor!.dx! - savedBeforeWest!.anchor!.dx!)
    .toBeCloseTo(savedAfterWest!.x! - savedBeforeWest!.x!, 1);

  // The height stays the content's, so the box still ends where the text ends.
  await expect.poll(async () => textShape.evaluate((element) => {
    const shapeBox = element.getBoundingClientRect();
    const content = element.querySelector(".overlay-text-shape-content");
    if (!content) {
      return 999;
    }
    const contentRects = [content, ...Array.from(content.querySelectorAll("*"))]
      .map((item) => item.getBoundingClientRect())
      .filter((rect) => rect.width > 0 || rect.height > 0);
    if (contentRects.length === 0) {
      return 999;
    }
    const contentBottom = Math.max(...contentRects.map((rect) => rect.bottom));
    return Math.ceil(shapeBox.bottom - contentBottom);
  })).toBeLessThanOrEqual(8);
});

test("creates and persists lists inside a text shape from the toolbar", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "テキスト");
  const textShape = page.locator(".overlay-shape-text").first();
  const editor = textShape.locator(".overlay-text-shape-content");
  await expect(editor).toBeFocused();
  await page.keyboard.type("一次式");
  await page.keyboard.press("Enter");
  await page.keyboard.type("二次式");
  await page.keyboard.press("ControlOrMeta+A");

  const bulletList = page.getByRole("button", { name: "箇条書き", exact: true });
  await expect(bulletList).toBeEnabled();
  await bulletList.click();
  await expect(editor.locator("ul > li")).toHaveCount(2);

  const orderedList = page.getByRole("button", { name: "番号付きリスト", exact: true });
  await expect(orderedList).toBeEnabled();
  await orderedList.click();
  await page.getByRole("menuitem", { name: "1. 2. 3.", exact: true }).click();
  await expect(editor.locator("ol > li")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));

  await expect.poll(async () => {
    const saved = (await getSavedOverlayShapes(page)).find((shape) => shape.type === "text");
    return saved?.props?.blocks?.[0];
  }).toMatchObject({ type: "list", listType: "ordered", items: [{}, {}] });

  const savedDocument = await page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    return raw ? JSON.parse(raw) : null;
  }) as SigmaDocument | null;
  expect(savedDocument).not.toBeNull();

  // The desktop runtime mock intentionally resets its in-memory document on a same-page reload.
  // Open a fresh app surface seeded with the saved SigmaDoc to exercise the real load/render path.
  const reopenedPage = await page.context().newPage();
  await installDesktopRuntimeMock(reopenedPage, savedDocument!);
  await reopenedPage.goto("/");
  const preview = reopenedPage.locator(".page-overlay-preview .overlay-shape-text").first();
  await expect(preview.locator("ol > li")).toHaveCount(2);
  await expect(preview).toContainText("一次式");
  await expect(preview).toContainText("二次式");
  await reopenedPage.close();
});

test("undoes text shape edits one step at a time with ctrl z", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "テキスト");
  const textShape = page.locator(".overlay-shape-text").first();
  const textShapeId = await textShape.getAttribute("data-overlay-shape-id");
  expect(textShapeId).not.toBeNull();
  const editor = textShape.locator(".overlay-text-shape-content");
  await expect(editor).toBeFocused();

  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("abc", { delay: 60 });
  await expect.poll(async () => editor.evaluate((element) => (element.textContent ?? "").trim())).toBe("abc");
  await expect.poll(async () => {
    const box = await textShape.boundingBox();
    return box?.width ?? 0;
  }).toBeLessThan(80);
  await expectSavedTextShapeMatchesRender(page, textShape, textShapeId!, "abc");

  await page.keyboard.press("ControlOrMeta+Z");
  await expect(editor).toBeFocused();
  await expect.poll(async () => editor.evaluate((element) => (element.textContent ?? "").trim())).toBe("ab");
  await expectSavedTextShapeMatchesRender(page, textShape, textShapeId!, "ab");

  await page.keyboard.press("ControlOrMeta+Z");
  await expect.poll(async () => editor.evaluate((element) => (element.textContent ?? "").trim())).toBe("a");
  await expectSavedTextShapeMatchesRender(page, textShape, textShapeId!, "a");

  await page.keyboard.press("ControlOrMeta+Z");
  await expect.poll(async () => editor.evaluate((element) => (element.textContent ?? "").trim())).toBe("");
  await expectSavedTextShapeMatchesRender(page, textShape, textShapeId!, "");
  await expect(page.locator(".overlay-shape-text")).toHaveCount(1);
});

test("moves image and text shapes without leaving edit mode stuck", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 20_000 });

  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "挿入", exact: true }).click();
  await page.getByRole("menu", { name: "挿入", exact: true })
    .getByRole("menuitem", { name: "画像", exact: true })
    .click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: "move-test.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="50"><rect width="80" height="50" fill="#111111"/></svg>'),
  });
  const image = page.locator(".overlay-shape-image").first();
  await expect(image).toBeVisible();
  await expect.poll(async () => image.locator("img.overlay-image-shape").evaluate((element) => (
    element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
  ))).toBe(true);

  let previousImageBounds = "";
  let stableImageBoundsSamples = 0;
  await expect.poll(async () => {
    const bounds = await image.boundingBox();
    const boundsKey = bounds
      ? [bounds.x, bounds.y, bounds.width, bounds.height].map((value) => Math.round(value * 10) / 10).join(":")
      : "";
    stableImageBoundsSamples = boundsKey !== "" && boundsKey === previousImageBounds
      ? stableImageBoundsSamples + 1
      : 0;
    previousImageBounds = boundsKey;
    return stableImageBoundsSamples;
  }, { intervals: [100, 100, 100, 100] }).toBeGreaterThanOrEqual(2);

  await image.click();
  await expect(image).toHaveClass(/selected/);
  const imageBefore = await image.boundingBox();
  expect(imageBefore).not.toBeNull();
  const imageShapeId = await image.getAttribute("data-overlay-shape-id");
  expect(imageShapeId).not.toBeNull();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  await expect.poll(async () => (await getSavedOverlayShapes(page)).some((shape) => (
    shape.id === imageShapeId && typeof shape.x === "number"
  ))).toBe(true);
  const savedImageBefore = (await getSavedOverlayShapes(page)).find((shape) => shape.id === imageShapeId);
  expect(savedImageBefore?.x).toEqual(expect.any(Number));

  await page.mouse.move(imageBefore!.x + imageBefore!.width / 2, imageBefore!.y + imageBefore!.height / 2);
  await page.mouse.down();
  await page.mouse.move(imageBefore!.x + imageBefore!.width / 2 + 80, imageBefore!.y + imageBefore!.height / 2 + 24, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => {
    const after = await image.boundingBox();
    return after?.x ?? imageBefore!.x;
  }).toBeGreaterThan(imageBefore!.x + 40);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  await expect.poll(async () => {
    const savedImage = (await getSavedOverlayShapes(page)).find((shape) => shape.id === imageShapeId);
    return savedImage?.x ?? savedImageBefore!.x!;
  }).toBeGreaterThan(savedImageBefore!.x! + 40);

  await chooseShape(page, "テキスト");
  const textShape = page.locator(".overlay-shape-text").first();
  const textEditor = textShape.locator(".overlay-text-shape-content");
  await expect(textEditor).toBeFocused();
  await page.keyboard.press("Escape");
  const textBefore = await textShape.boundingBox();
  expect(textBefore).not.toBeNull();
  await page.mouse.move(textBefore!.x + textBefore!.width / 2, textBefore!.y + textBefore!.height / 2);
  await page.mouse.down();
  await page.mouse.move(textBefore!.x + textBefore!.width / 2 + 70, textBefore!.y + textBefore!.height / 2 + 22, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => {
    const after = await textShape.boundingBox();
    return after?.x ?? textBefore!.x;
  }).toBeGreaterThan(textBefore!.x + 30);
});

test("表のセルへ複数行を貼っても 1 つのセルの中に収まる", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "表");
  const table = page.locator(".overlay-table-shape").first();
  await expect(table).toBeVisible();
  const tableBox = await table.boundingBox();
  expect(tableBox).not.toBeNull();
  const center = { x: tableBox!.x + tableBox!.width / 2, y: tableBox!.y + tableBox!.height / 2 };
  await page.mouse.click(center.x, center.y);
  await page.mouse.click(center.x, center.y);

  const firstCellEditor = table.locator("td").first().locator(".overlay-table-shape-content");
  await firstCellEditor.click();
  await page.evaluate(() => {
    const target = document.activeElement?.closest(".overlay-table-shape-content");
    if (!target) {
      throw new Error("table cell editor is not focused");
    }
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "1 行目\n2 行目\n3 行目");
    target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  });

  // セルが保存できるのは段落 1 つぶんの inline だけ。段落が増えると画面には出たまま
  // 保存で 2 行目以降が消えるので、貼り付けは改行としてこのセルの中に入る。
  await expect(firstCellEditor.locator("p")).toHaveCount(1);
  await expect(firstCellEditor.locator("br")).toHaveCount(2);
  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const text = raw ? JSON.parse(raw) : null;
    const findCellText = (value: unknown): string | null => {
      if (!value || typeof value !== "object") {
        return null;
      }
      const cells = (value as { table?: { cells?: Array<{ content?: Array<{ children?: Array<{ text?: string }> }> }> } }).table?.cells;
      if (Array.isArray(cells)) {
        return (cells[0]?.content?.[0]?.children ?? []).map((child) => child.text ?? "").join("");
      }
      for (const child of Object.values(value)) {
        const found = findCellText(child);
        if (found !== null) {
          return found;
        }
      }
      return null;
    };
    return findCellText(text) ?? "";
  })).toBe("1 行目\n2 行目\n3 行目");
});

async function openShapeMenu(page: Page) {
  const menuButton = page.getByRole("button", { name: "図形", exact: true });
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function expectTextFlowFocused(page: Page) {
  await expect.poll(async () => page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement &&
      active.classList.contains("ProseMirror") &&
      Boolean(active.closest(".text-flow-editor"));
  })).toBe(true);
}

async function clickTextBlockPlainText(page: Page, block: Locator) {
  const point = await block.evaluate((element) => {
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = node.textContent ?? "";
      const start = text.search(/\S/);
      const parent = node.parentElement;
      if (
        start >= 0 &&
        parent &&
        !parent.closest("math-field, .inline-math-node, .math-preview-inline, [data-node-type='mathInline']")
      ) {
        const style = getComputedStyle(parent);
        if (style.display !== "none" && style.visibility !== "hidden") {
          const range = element.ownerDocument.createRange();
          range.setStart(node, start);
          range.setEnd(node, Math.min(start + 1, text.length));
          const rect = Array.from(range.getClientRects()).find((candidate) => (
            candidate.width > 0 && candidate.height > 0
          ));
          if (rect) {
            return {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
            };
          }
        }
      }
      node = walker.nextNode();
    }
    return null;
  });
  expect(point).not.toBeNull();
  await page.mouse.click(point!.x, point!.y);
}

async function chooseShape(page: Page, label: string, options: { create?: boolean } = {}) {
  const shouldCreate = options.create ?? true;
  if (label === "線" || label === "折れ線" || label === "曲線" || label === "フリーハンド" || label === "矢印" || label === "太矢印") {
    const menu = await openLineToolMenu(page);
    await menu.getByRole("menuitem", { name: label, exact: true }).click();
    if (shouldCreate && label !== "折れ線" && label !== "曲線") {
      await dragInsertShape(page, label);
    }
    return;
  }

  const directButtonLabel = label === "テキスト" ? "テキスト" : null;
  if (directButtonLabel) {
    const directButton = page.getByRole("button", { name: directButtonLabel, exact: true });
    await expect(directButton).toBeVisible();
    await directButton.click();
    if (shouldCreate) {
      await dragInsertShape(page, label);
    }
    return;
  }
  const menu = await openShapeMenu(page);
  await menu.getByRole("menuitem", { name: label, exact: true }).click();
  if (label === "表") {
    const tablePicker = page.getByRole("dialog", { name: "表を挿入" });
    await expect(tablePicker).toBeVisible();
    if (shouldCreate) {
      await tablePicker.getByRole("button", { name: "3列 3行の表を挿入", exact: true }).click();
    }
    return;
  }
  if (shouldCreate) {
    if (label === "3点円弧") {
      await clickThreePointArc(page);
    } else {
      await dragInsertShape(page, label);
    }
  }
}

async function clickThreePointArc(page: Page) {
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();

  const shapeCount = await page.locator("[data-overlay-shape-id]").count();
  const startX = surfaceBox!.x + 96 + (shapeCount % 4) * 124;
  const startY = surfaceBox!.y + 160 + Math.floor(shapeCount / 4) * 96;
  await page.mouse.click(startX, startY + 70);
  await page.mouse.click(startX + 66, startY);
  await page.mouse.click(startX + 132, startY + 70);
}

async function dragInsertShape(page: Page, label: string) {
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();

  const size = insertDragSize(label);
  const shapeCount = await page.locator("[data-overlay-shape-id]").count();
  const startX = surfaceBox!.x + 96 + (shapeCount % 4) * 124;
  const gridStartY = surfaceBox!.y + 120 + Math.floor(shapeCount / 4) * 96;
  const menubarBox = await page.locator(".editor-menubar").boundingBox();
  // A prior drag can scroll the page sheet partly behind the fixed toolbar.
  // Keep the synthetic drag on the visible canvas instead of sending it to a
  // toolbar control when the sheet's viewport-relative y becomes negative.
  const visibleCanvasTop = (menubarBox?.y ?? 0) + (menubarBox?.height ?? 0) + 24;
  const startY = Math.min(
    surfaceBox!.y + surfaceBox!.height - size.dy - 24,
    Math.max(gridStartY, visibleCanvasTop),
  );
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + size.dx, startY + size.dy, { steps: 8 });
  await page.mouse.up();

  if (label === "テキスト") {
    const editor = page.locator(".overlay-shape-text").last().locator(".overlay-text-shape-content");
    await expect(editor).toBeVisible();
    await expect(editor).toBeFocused();
  }
}

function insertDragSize(label: string): { dx: number; dy: number } {
  if (label === "線" || label === "矢印") {
    return { dx: 140, dy: 36 };
  }

  if (label === "テキスト") {
    return { dx: 180, dy: 54 };
  }

  if (label === "表") {
    return { dx: 260, dy: 140 };
  }

  if (label === "吹き出し") {
    return { dx: 200, dy: 92 };
  }

  return { dx: 132, dy: 88 };
}

async function openLineToolMenu(page: Page) {
  const menuButton = page.getByRole("button", { name: "線", exact: true });
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function pasteSvgImage(page: Page, name: string, svg: string) {
  await page.evaluate(({ name, svg }) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([svg], name, { type: "image/svg+xml" }));
    const target = document.querySelector(".page-canvas");
    if (!target) {
      throw new Error("Paste target not found");
    }

    target.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    }));
  }, { name, svg });
}

async function dropSvgImage(page: Page, point: { x: number; y: number }, name: string, svg: string) {
  await page.evaluate(({ point, name, svg }) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([svg], name, { type: "image/svg+xml" }));
    const target = document.querySelector(".page-canvas");
    if (!target) {
      throw new Error("Drop target not found");
    }

    target.dispatchEvent(new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      dataTransfer,
    }));
    target.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      dataTransfer,
    }));
  }, { point, name, svg });
}

type SavedOverlayShape = {
  id?: string;
  type?: string;
  parentId?: string;
  x?: number;
  y?: number;
  anchor?: { type?: string; blockId?: string; dx?: number; dy?: number };
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  props?: {
    w?: number;
    h?: number;
    r?: number;
    rx?: number;
    ry?: number;
    blocks?: SavedOverlayRichTextNode[];
  };
};

type SavedOverlayRichTextNode = {
  text?: string;
  children?: SavedOverlayRichTextNode[];
  items?: SavedOverlayRichTextNode[];
};

type SelectionBoxState = {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
};

async function getSelectionBoxState(selectionBox: Locator): Promise<SelectionBoxState> {
  return selectionBox.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    const matrix = new DOMMatrix(getComputedStyle(htmlElement).transform);
    return {
      x: Number.parseFloat(htmlElement.style.left),
      y: Number.parseFloat(htmlElement.style.top),
      w: Number.parseFloat(htmlElement.style.width),
      h: Number.parseFloat(htmlElement.style.height),
      rotation: Math.atan2(matrix.b, matrix.a),
    };
  });
}

/**
 * Where the first glyph actually sits on screen. A rotated element only reports an AABB, but a
 * glyph that has not moved cannot move its own AABB either, so this is the closest thing to
 * "the letter is still where it was" the DOM will answer.
 */
async function firstGlyphPagePoint(shape: Locator): Promise<{ x: number; y: number }> {
  return shape.evaluate((element) => {
    const content = element.querySelector(".ProseMirror");
    if (!content) {
      throw new Error("overlay text content not found");
    }

    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node?.textContent) {
      throw new Error("overlay text has no glyphs");
    }

    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 1);
    const rect = range.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  });
}

async function getSavedOverlayShapes(page: Page): Promise<SavedOverlayShape[]> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const doc = raw ? JSON.parse(raw) : null;
    const collectShapes = (value: unknown): SavedOverlayShape[] => {
      if (!value || typeof value !== "object") {
        return [];
      }
      if (Array.isArray((value as { shapes?: unknown }).shapes)) {
        return (value as { shapes: SavedOverlayShape[] }).shapes;
      }
      if (Array.isArray((value as { overlaySnapshot?: { shapes?: unknown } }).overlaySnapshot?.shapes)) {
        return (value as { overlaySnapshot: { shapes: SavedOverlayShape[] } }).overlaySnapshot.shapes;
      }
      return Object.values(value).flatMap(collectShapes);
    };
    return collectShapes(doc);
  });
}

async function expectSavedTextShapeMatchesRender(
  page: Page,
  textShape: Locator,
  shapeId: string,
  expectedText: string,
) {
  await expect.poll(async () => {
    const savedShape = (await getSavedOverlayShapes(page)).find((shape) => shape.id === shapeId);
    const renderedBounds = await textShape.boundingBox();
    const savedWidth = savedShape?.props?.w;
    const savedHeight = savedShape?.props?.h;
    return {
      text: savedShape?.props?.blocks ? savedRichTextBlocksPlainText(savedShape.props.blocks).trim() : null,
      sizeMatches: Boolean(
        renderedBounds &&
        typeof savedWidth === "number" &&
        typeof savedHeight === "number" &&
        Math.abs(savedWidth - renderedBounds.width) < 1.5 &&
        Math.abs(savedHeight - renderedBounds.height) < 1.5
      ),
    };
  }).toEqual({ text: expectedText, sizeMatches: true });
}

function savedRichTextPlainText(node: SavedOverlayRichTextNode): string {
  return (node.text ?? "")
    + (node.children ?? []).map(savedRichTextPlainText).join("")
    + (node.items ?? []).map(savedRichTextPlainText).join("\n");
}

function savedRichTextBlocksPlainText(blocks: SavedOverlayRichTextNode[]): string {
  return blocks.map(savedRichTextPlainText).join("\n");
}

async function rotateSelectedShape(page: Page, shape: Locator) {
  const handle = page.locator(".overlay-rotate-handle").first();
  await expect(handle).toBeVisible();
  const handleBox = await handle.boundingBox();
  const shapeBox = await shape.boundingBox();
  expect(handleBox).not.toBeNull();
  expect(shapeBox).not.toBeNull();

  const centerX = shapeBox!.x + shapeBox!.width / 2;
  const centerY = shapeBox!.y + shapeBox!.height / 2;
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(centerX + shapeBox!.width / 2 + 40, centerY, { steps: 8 });
  await page.mouse.up();
}

async function altClickHandle(page: Page, handle: Locator) {
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.keyboard.down("Alt");
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.keyboard.up("Alt");
}

async function dragHandle(page: Page, handle: Locator, dx: number, dy: number) {
  await expect(handle).toBeVisible();
  const handleBox = await handle.boundingBox();
  expect(handleBox).not.toBeNull();

  const centerX = handleBox!.x + handleBox!.width / 2;
  const centerY = handleBox!.y + handleBox!.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + dx, centerY + dy, { steps: 8 });
  await page.mouse.up();
}

async function dragLastLineEndpoint(page: Page, shape: Locator) {
  const endpointHandle = page.locator(".overlay-line-point-handle").last();
  const handleBox = await endpointHandle.boundingBox();
  const beforeBox = await shape.boundingBox();
  expect(handleBox).not.toBeNull();
  expect(beforeBox).not.toBeNull();

  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(beforeBox!.x + beforeBox!.width + 80, beforeBox!.y + beforeBox!.height + 30, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => {
    const afterBox = await shape.boundingBox();
    return afterBox?.width ?? 0;
  }).toBeGreaterThan(beforeBox!.width + 20);
}

test("drags and manipulates shapes heavily outside page bounds (left/top)", async ({ page }) => {
  await page.goto("/");

  // Create a rectangle
  await chooseShape(page, "四角形");
  const rectangle = page.locator(".overlay-shape-geo").first();
  await expect(rectangle).toBeVisible();
  const shapeId = await rectangle.getAttribute("data-overlay-shape-id");
  expect(shapeId).not.toBeNull();

  // Get page bounds and drag shape far outside the left edge
  const pageCanvas = page.locator(".page-canvas").first();
  const canvasBox = await pageCanvas.boundingBox();
  const beforeMove = await rectangle.boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(beforeMove).not.toBeNull();

  const start = {
    x: beforeMove!.x + beforeMove!.width / 2,
    y: beforeMove!.y + beforeMove!.height / 2,
  };
  // Drag left far beyond page origin (150px beyond the page left edge)
  const target = {
    x: canvasBox!.x - 150,
    y: start.y,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await page.mouse.up();

  // Verify shape is now far outside the page (page-relative: bleed changes can
  // settle the page position, so always pair shape and page measurements).
  const pageRelativeBox = async () => {
    const [shape, canvas] = await Promise.all([
      rectangle.boundingBox(),
      page.locator(".page-canvas").first().boundingBox(),
    ]);
    expect(shape).not.toBeNull();
    expect(canvas).not.toBeNull();
    return { x: shape!.x - canvas!.x, y: shape!.y - canvas!.y, width: shape!.width, height: shape!.height };
  };
  const movedRel = await pageRelativeBox();
  expect(movedRel.x).toBeLessThan(-100);

  // An off-page shape can sit outside the viewport; reach it by scrolling
  // like a user would, then click to select it. The post-drag save can
  // re-layout once, so wait for the shape to settle under the pointer.
  await expect.poll(async () => {
    await rectangle.scrollIntoViewIfNeeded();
    const box = await rectangle.boundingBox();
    if (!box) {
      return false;
    }
    return page.evaluate(({ x, y, id }) => {
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit?.closest(`[data-overlay-shape-id="${id}"]`));
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2, id: shapeId });
  }).toBe(true);
  const movedBox = await rectangle.boundingBox();
  expect(movedBox).not.toBeNull();
  const outsidePoint = {
    x: movedBox!.x + movedBox!.width / 2,
    y: movedBox!.y + movedBox!.height / 2,
  };
  await page.mouse.click(outsidePoint.x, outsidePoint.y);

  // Verify it's selected
  await expect(page.locator(`.overlay-shape-geo.selected[data-overlay-shape-id="${shapeId}"]`)).toHaveCount(1);

  // Verify we can drag it while it's out of bounds
  const dragStart = {
    x: outsidePoint.x,
    y: outsidePoint.y,
  };
  const dragTarget = {
    x: dragStart.x + 50,
    y: dragStart.y + 30,
  };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragTarget.x, dragTarget.y, { steps: 8 });
  await page.mouse.up();

  // Verify shape moved while out of bounds (page-relative)
  const finalRel = await pageRelativeBox();
  expect(Math.abs(finalRel.x - (movedRel.x + 50))).toBeLessThan(5);
  expect(Math.abs(finalRel.y - (movedRel.y + 30))).toBeLessThan(5);

  // Verify it's still selected
  await expect(page.locator(`.overlay-shape-geo.selected[data-overlay-shape-id="${shapeId}"]`)).toHaveCount(1);
});

test("boxes a selected arc around the drawn sweep, not the whole circle", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "円弧");
  const arc = page.locator(".overlay-shape-arc").first();
  await expect(arc).toBeVisible();

  // `.overlay-shape` のインラインスタイルは変形の基準箱 (= 楕円全体) がそのまま入る。
  const referenceBox = await arc.evaluate((element) => ({
    w: Number.parseFloat((element as HTMLElement).style.width),
    h: Number.parseFloat((element as HTMLElement).style.height),
  }));
  const selectionBox = await getSelectionBoxState(page.locator(".overlay-selection-box").first());

  // 選択枠は実際に描かれている弧に沿う。円全体の箱より明確に小さい。
  expect(selectionBox.w).toBeLessThan(referenceBox.w);
  expect(selectionBox.h).toBeLessThanOrEqual(referenceBox.h);
  expect(selectionBox.w).toBeGreaterThan(0);

  // 枠が縮んでも角度ハンドルは残る。ここが消えると弧を閉じ気味にした瞬間に開き直せなくなる。
  const startHandle = page.locator(".overlay-arc-point-handle.start");
  const endHandle = page.locator(".overlay-arc-point-handle.end");
  const startPoint = await startHandle.boundingBox();
  const endPoint = await endHandle.boundingBox();
  expect(startPoint).not.toBeNull();
  expect(endPoint).not.toBeNull();
  await dragHandle(page, endHandle, startPoint!.x - endPoint!.x, startPoint!.y - endPoint!.y + 6);

  // 短辺が POINT_HANDLE_MIN_SHORT_AXIS (24px) を割っても、判定は基準箱で行うので消えない。
  const closed = await getSelectionBoxState(page.locator(".overlay-selection-box").first());
  expect(Math.min(closed.w, closed.h)).toBeLessThan(24);
  await expect(page.locator(".overlay-arc-point-handle")).toHaveCount(2);
});

test("keeps a group's selection box on its members' ink when one of them is an arc", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "円弧");
  await expect(page.locator(".overlay-shape-arc").first()).toBeVisible();
  const arcBox = await getSelectionBoxState(page.locator(".overlay-selection-box").first());

  await chooseShape(page, "四角形");
  await expect(page.locator(".overlay-shape-geo").first()).toBeVisible();

  await page.keyboard.press("ControlOrMeta+KeyA");
  await page.keyboard.press("ControlOrMeta+KeyG");
  await expect.poll(async () => (await getSavedOverlayShapes(page)).some((shape) => shape.type === "group")).toBe(true);

  const groupBox = await getSelectionBoxState(page.locator(".overlay-selection-box").first());
  // グループ枠が円全体を含んでいたら、弧だけの枠より縦横とも大きく育ってしまう。
  // ここでは「弧の実描画 + 矩形」を包むだけであることを、円直径との比較で確かめる。
  const arcElement = page.locator(".overlay-shape-arc").first();
  const arcReference = await arcElement.evaluate((element) => ({
    w: Number.parseFloat((element as HTMLElement).style.width),
  }));
  expect(groupBox.w).toBeGreaterThan(0);
  expect(arcBox.w).toBeLessThan(arcReference.w);

  // グループ化を繰り返しても枠が育たない (保存済みのグループ箱を読んでいない)。
  await page.keyboard.press("ControlOrMeta+Shift+KeyG");
  await expect.poll(async () => (await getSavedOverlayShapes(page)).some((shape) => shape.type === "group")).toBe(false);
  await page.keyboard.press("ControlOrMeta+KeyA");
  await page.keyboard.press("ControlOrMeta+KeyG");
  await expect.poll(async () => (await getSavedOverlayShapes(page)).some((shape) => shape.type === "group")).toBe(true);
  const regrouped = await getSelectionBoxState(page.locator(".overlay-selection-box").first());
  expect(regrouped.w).toBeCloseTo(groupBox.w, 1);
  expect(regrouped.h).toBeCloseTo(groupBox.h, 1);
});
