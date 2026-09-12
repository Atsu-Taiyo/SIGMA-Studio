import { expect, test, type Page } from "@playwright/test";

import type { ParagraphNode, SigmaDocument } from "@/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { waitForPagedSurfaceSettled } from "./paged-surface";

test("anchors problem-area overlay shapes and filters them by output profile", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await installDesktopRuntimeMock(page, createProblemAreaOverlayDocument());

  await page.goto(appUrl("/"));
  await expect(page.locator('[data-problem-area="prompt"]').filter({ hasText: "問題文内の図形" })).toBeVisible();
  await expect(page.locator('[data-problem-area="solution"]')).toBeVisible();

  await chooseShapeTool(page, "四角形");
  await dragInsideProblemArea(page, "prompt", { dx: 130, dy: 82 });
  const promptShape = page.locator(".overlay-shape-geo").first();
  await expect(promptShape).toBeVisible();
  await expect(promptShape).toHaveClass(/selected/);
  await expect(page.locator(".overlay-anchor-handle").first())
    .toHaveAttribute("data-anchor-block-id", "prompt_area_e2e");

  const imageInput = page.locator('input[accept="image/png,image/jpeg,image/webp,image/svg+xml"]');
  await imageInput.setInputFiles({
    name: "solution-area-image.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#16a34a"/><circle cx="60" cy="40" r="24" fill="#ffffff"/></svg>'),
  });
  const imageShape = page.locator(".overlay-shape-image").first();
  await expect(imageShape).toBeVisible();
  await dragShapeToProblemArea(page, imageShape, "solution");
  await expect(imageShape).toHaveClass(/selected/);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  await expect.poll(async () => getSavedOverlayShapeAnchorSummary(page)).toEqual({
    geoBlockId: "prompt_area_e2e",
    imageAnchoredToCreatedSolutionBlock: true,
    solutionBlockCount: 1,
  });

  await page.getByRole("button", { name: "ファイル", exact: true }).click();
  await page.getByRole("menuitem", { name: "エクスポート" }).hover();
  await page.getByRole("menuitem", { name: "PDFを書き出し" }).click();
  const dialog = page.getByRole("dialog", { name: "PDFプレビュー" });
  await expect(dialog).toBeVisible();

  await expectOverlayCounts(dialog, { rects: 1, images: 1 });
  await dialog.locator("select").first().selectOption("student");
  await expectOverlayCounts(dialog, { rects: 1, images: 0 });
  await dialog.locator("select").first().selectOption("answerBook");
  await expectOverlayCounts(dialog, { rects: 0, images: 1 });
});

function appUrl(path: string): string {
  return process.env.SIGMA_STUDIO_E2E_BASE_URL ? new URL(path, process.env.SIGMA_STUDIO_E2E_BASE_URL).toString() : path;
}

function createProblemAreaOverlayDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_problem_area_overlay_e2e",
    metadata: { title: "問題エリア内図形 E2E" },
    content: [{
      type: "problem",
      id: "problem_area_overlay_e2e",
      tags: [],
      lead: [],
      prompt: [paragraph("prompt_area_e2e", "問題文内の図形を選択できることを確認する。")],
      solution: [],
      hints: [],
      areaLayout: {
        prompt: { minHeightMm: 42 },
        solution: { minHeightMm: 52 },
      },
      numbering: { enabled: true, value: 1 },
    }],
    outputProfiles: {
      student: { showSolutions: false, showHints: false },
      teacher: { showSolutions: true, showHints: true },
      answerBook: { onlySolutions: true, includeAnswers: true },
    },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 16, right: 18, bottom: 16, left: 18 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
      overlay: {
        overlaySnapshot: {
          version: 1,
          shapes: [],
          assets: {},
        },
      },
    },
  };
}

function paragraph(id: string, text: string): ParagraphNode {
  return {
    type: "paragraph",
    id,
    lineHeight: "1.5",
    children: [{ type: "text", text }],
  };
}

async function chooseShapeTool(page: Page, label: string): Promise<void> {
  const menuButton = page.getByRole("button", { name: "図形", exact: true });
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: label, exact: true }).click();
}

async function dragInsideProblemArea(
  page: Page,
  area: "prompt" | "solution",
  size: { dx: number; dy: number },
): Promise<void> {
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const areaBox = await page.locator(`[data-problem-area="${area}"]`).boundingBox();
  expect(areaBox).not.toBeNull();

  const startX = areaBox!.x + 96;
  const startY = areaBox!.y + 62;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + size.dx, startY + size.dy, { steps: 8 });
  await page.mouse.up();
}

async function dragShapeToProblemArea(
  page: Page,
  shape: ReturnType<Page["locator"]>,
  area: "prompt" | "solution",
): Promise<void> {
  const shapeBox = await shape.boundingBox();
  const areaBox = await page.locator(`[data-problem-area="${area}"]`).boundingBox();
  expect(shapeBox).not.toBeNull();
  expect(areaBox).not.toBeNull();

  const startX = shapeBox!.x + shapeBox!.width / 2;
  const startY = shapeBox!.y + shapeBox!.height / 2;
  const targetX = areaBox!.x + Math.min(areaBox!.width - 60, 260);
  const targetY = areaBox!.y + Math.min(areaBox!.height - 40, 150);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(targetX, targetY, { steps: 10 });
  await page.mouse.up();
}

async function getSavedOverlayShapeAnchorSummary(page: Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    const shapes = document?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const geo = shapes.find((shape: { type?: string }) => shape.type === "geo");
    const image = shapes.find((shape: { type?: string }) => shape.type === "image");
    const solutionBlocks = document?.content?.[0]?.solution ?? [];
    const solutionBlockIds = new Set(solutionBlocks.map((block: { id?: string }) => block.id).filter(Boolean));
    const imageBlockId = image?.anchor?.type === "block" ? image.anchor.blockId : null;
    return {
      geoBlockId: geo?.anchor?.type === "block" ? geo.anchor.blockId : null,
      imageAnchoredToCreatedSolutionBlock: typeof imageBlockId === "string" &&
        imageBlockId.startsWith("answer_") &&
        solutionBlockIds.has(imageBlockId),
      solutionBlockCount: solutionBlocks.length,
    };
  });
}

async function expectOverlayCounts(
  dialog: ReturnType<Page["getByRole"]>,
  expected: { rects: number; images: number },
): Promise<void> {
  // `.print-page-overlay-layer.foreground` was the SVG layer the old print renderer emitted. The
  // PDF preview is `PagedRenderSurface` since the PDF-parity rewrite: it cuts pages out of the
  // editor's own canvas, so the shapes are the same overlay components (`.overlay-shape-geo`, and
  // an `<img>` rather than an SVG `<image>` for pictures). `.page-overlay-layer` keeps the old
  // `.foreground` scoping — background-stacked shapes live under the sibling
  // `.page-overlay-background-layer` — and `[data-overlay-shape-id]` keeps the count document-wide
  // because page ownership strips that attribute from windows that do not own the shape.
  await waitForPagedSurfaceSettled(dialog.page());
  const printedForeground = dialog.locator(".paged-surface-page .page-overlay-layer");
  await expect(printedForeground.locator(".overlay-shape-geo[data-overlay-shape-id]"))
    .toHaveCount(expected.rects);
  await expect(printedForeground.locator(".overlay-shape-image[data-overlay-shape-id]"))
    .toHaveCount(expected.images);
}
