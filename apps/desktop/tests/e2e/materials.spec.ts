import { expect, test, type Page } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { createBoxBlock } from "@/lib/box-blocks";
import type { SigmaBlock, SigmaDocument, ParagraphNode } from "@/types/sigma-doc";
import type { MaterialItem } from "@/types/material";

test("inserts a saved text material from a paragraph-start slash trigger", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("intro_p", "前の本文"),
    paragraph("target_p", ""),
  ]), {
    materials: [createTextMaterial()],
  });

  await page.goto("/");
  const targetParagraph = page.locator('.text-flow-editor [data-sigma-doc-id="target_p"]').first();
  await expect(targetParagraph).toBeVisible();
  await targetParagraph.click();
  await page.keyboard.type("/公式");

  const popover = page.locator(".slash-command-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("公式素材");

  await page.keyboard.press("Enter");
  await expect(page.locator(".text-flow-editor").filter({ hasText: "素材本文" })).toBeVisible();
  await expect.poll(async () => {
    const serialized = await page.evaluate(() => window.localStorage.getItem("sigma-studio:e2e-document") ?? "");
    return serialized.includes("素材本文");
  }).toBe(true);
});

test("inserts a problem from the normal text /問題 slash command", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("intro_p", "前の本文"),
    paragraph("target_p", ""),
  ]));

  await page.goto("/");
  const targetParagraph = page.locator('[data-sigma-doc-id="target_p"]').first();
  await expect(targetParagraph).toBeVisible();
  await targetParagraph.click();
  await page.keyboard.type("/問題");

  const popover = page.locator(".slash-command-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("問題文");
  await page.keyboard.press("Enter");

  await expect(page.locator('[data-problem-area="prompt"]').first()).toBeVisible();
  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) as SigmaDocument : null;
    return document?.content.map((block) => block.type) ?? [];
  })).toEqual(["paragraph", "problem", "paragraph"]);
});

test("places a figure-only material at the slash trigger origin", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("intro_p", "前の本文"),
    paragraph("target_p", ""),
  ]), {
    materials: [createFigureMaterial()],
  });

  await page.goto("/");
  const targetParagraph = page.locator('.text-flow-editor [data-sigma-doc-id="target_p"]').first();
  await expect(targetParagraph).toBeVisible();
  const expectedOrigin = await targetParagraph.evaluate((element) => {
    const canvas = element.closest<HTMLElement>(".page-canvas");
    if (!canvas) {
      return null;
    }
    const canvasRect = canvas.getBoundingClientRect();
    const paragraphRect = element.getBoundingClientRect();
    const scale = canvasRect.width / canvas.offsetWidth || 1;
    return {
      x: (paragraphRect.left - canvasRect.left) / scale,
      y: (paragraphRect.top - canvasRect.top) / scale,
    };
  });
  expect(expectedOrigin).not.toBeNull();

  await targetParagraph.click();
  await page.keyboard.type("/図形");
  await expect(page.locator(".slash-command-popover")).toContainText("図形素材");
  await page.keyboard.press("Enter");

  await expect.poll(async () => page.evaluate(() => {
    const serialized = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!serialized) {
      return null;
    }
    const document = JSON.parse(serialized) as SigmaDocument;
    const shape = document.pageLayout?.overlay?.overlaySnapshot?.shapes.find((item) => item.type === "geo");
    return shape ? {
      x: shape.x,
      y: shape.y,
      anchorType: shape.anchor?.type ?? "none",
    } : null;
  })).not.toBeNull();
  const insertedShape = await page.evaluate(() => {
    const serialized = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!serialized) {
      return null;
    }
    const document = JSON.parse(serialized) as SigmaDocument;
    const shape = document.pageLayout?.overlay?.overlaySnapshot?.shapes.find((item) => item.type === "geo");
    return shape ? {
      x: shape.x,
      y: shape.y,
      anchorType: shape.anchor?.type ?? "none",
    } : null;
  });

  expect(insertedShape?.anchorType).toBe("page");
  expect(Math.abs((insertedShape?.x ?? 0) - expectedOrigin!.x)).toBeLessThan(6);
  expect(Math.abs((insertedShape?.y ?? 0) - expectedOrigin!.y)).toBeLessThan(8);
});

test("inserts a mixed text and figure material from one slash command", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("intro_p", "前の本文"),
    paragraph("target_p", ""),
  ]), {
    materials: [createMixedMaterial()],
  });

  await page.goto("/");
  const targetParagraph = page.locator('.text-flow-editor [data-sigma-doc-id="target_p"]').first();
  await expect(targetParagraph).toBeVisible();
  const expectedOrigin = await targetParagraph.evaluate((element) => {
    const canvas = element.closest<HTMLElement>(".page-canvas");
    if (!canvas) {
      return null;
    }
    const canvasRect = canvas.getBoundingClientRect();
    const paragraphRect = element.getBoundingClientRect();
    const scale = canvasRect.width / canvas.offsetWidth || 1;
    return {
      x: (paragraphRect.left - canvasRect.left) / scale,
      y: (paragraphRect.top - canvasRect.top) / scale,
    };
  });
  expect(expectedOrigin).not.toBeNull();

  await targetParagraph.click();
  await page.keyboard.type("/mixed");
  await expect(page.locator(".slash-command-popover")).toContainText("混在素材");
  await page.keyboard.press("Enter");

  await expect(page.locator(".text-flow-editor").filter({ hasText: "混在本文" })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => {
    const serialized = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!serialized) {
      return null;
    }
    const document = JSON.parse(serialized) as SigmaDocument;
    const shape = document.pageLayout?.overlay?.overlaySnapshot?.shapes.find((item) => item.type === "geo");
    return {
      hasText: JSON.stringify(document.content).includes("混在本文"),
      shape: shape ? {
        x: shape.x,
        y: shape.y,
        anchorType: shape.anchor?.type ?? "none",
      } : null,
    };
  })).toMatchObject({
    hasText: true,
    shape: {
      anchorType: "page",
      x: expect.any(Number),
      y: expect.any(Number),
    },
  });

  const insertedShape = await page.evaluate(() => {
    const serialized = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!serialized) {
      return null;
    }
    const document = JSON.parse(serialized) as SigmaDocument;
    const shape = document.pageLayout?.overlay?.overlaySnapshot?.shapes.find((item) => item.type === "geo");
    return shape ? { x: shape.x, y: shape.y } : null;
  });
  expect(Math.abs((insertedShape?.x ?? 0) - expectedOrigin!.x)).toBeLessThan(6);
  expect(Math.abs((insertedShape?.y ?? 0) - expectedOrigin!.y)).toBeLessThan(8);
});

test("shows material previews while hovering slash candidates", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("intro_p", "前の本文"),
    paragraph("target_p", ""),
  ]), {
    materials: [createTextMaterial(), createFigureMaterial(), createMixedMaterial()],
  });

  await page.goto("/");
  const targetParagraph = page.locator('[data-sigma-doc-id="target_p"]').first();
  await expect(targetParagraph).toBeVisible();
  await targetParagraph.click();
  await page.keyboard.type("/");

  const popover = page.locator(".slash-command-popover");
  await expect(popover).toBeVisible();
  const preview = page.locator(".slash-command-preview");

  await popover.getByRole("option", { name: /公式素材/ }).hover();
  await expect(preview).toBeVisible();
  await expect(preview.locator(".material-preview-flow-row")).toContainText("素材本文");
  await expect(preview.locator(".slash-command-preview-caption")).toContainText("公式素材");

  await popover.getByRole("option", { name: /図形素材/ }).hover();
  await expect(preview.locator(".material-library-preview-svg svg")).toBeVisible();
  await expect(preview.locator(".slash-command-preview-caption")).toContainText("図形素材");
});

test("shows saved materials as workspace-style preview cards in the material dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("intro_p", "前の本文"),
    paragraph("target_p", ""),
  ]), {
    materials: [createTextMaterial(), createFigureMaterial(), createMixedMaterial()],
  });

  await page.goto("/");
  await expect(page.locator('[data-editor-toolbar="quick"]').first()).toBeVisible();
  await page.locator('button[aria-label="素材"]').first().click();

  const dialog = page.getByRole("dialog", { name: "素材" });
  await expect(dialog).toBeVisible();
  expect(await dialog.locator(".material-library-item").count()).toBeGreaterThanOrEqual(2);
  await expect(dialog.locator(".material-library-list")).toHaveCSS("display", "grid");
  const columnCount = await dialog.locator(".material-library-list").evaluate((element) => {
    const columns = getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean);
    return columns.length;
  });
  expect(columnCount).toBeGreaterThan(1);

  const textCard = dialog.locator(".material-library-item").filter({ hasText: "公式素材" });
  await expect(textCard.locator(".material-preview-paper")).toBeVisible();
  await expect(textCard.locator(".material-preview-flow-row")).toContainText("素材本文");
  await expect(textCard.getByRole("button", { name: "公式素材 の操作" })).toBeVisible();

  const figureCard = dialog.locator(".material-library-item").filter({ hasText: "図形素材" });
  await expect(figureCard.locator(".material-preview-paper")).toBeVisible();
  await expect(figureCard.locator(".material-library-preview-svg svg")).toBeVisible();

  await dialog.getByLabel("素材を検索").fill("公式素材");
  await expect(dialog.locator(".material-library-item")).toHaveCount(1);
  await textCard.getByRole("button", { name: "公式素材 の操作" }).click();
  const actionMenu = page.getByRole("menu", { name: "公式素材 の操作" });
  await expect(actionMenu).toBeVisible();
  await expect(actionMenu.getByRole("menuitem", { name: "挿入" })).toBeVisible();
  await expect(actionMenu.getByRole("menuitem", { name: "編集" })).toBeVisible();
  await expect(actionMenu.getByRole("menuitem", { name: "削除" })).toBeVisible();
  await actionMenu.getByRole("menuitem", { name: "編集" }).click();
  const editDialog = page.getByRole("dialog", { name: "素材を編集" });
  await expect(editDialog.getByLabel("素材名")).toBeVisible();
  await editDialog.getByRole("button", { name: "閉じる" }).click();

  await dialog.getByLabel("素材を検索").fill("ノート");
  await expect(dialog.locator(".material-library-item").filter({ hasText: "tcolorbox ノート罫" })).toHaveCount(0);
  await expect(dialog.locator(".material-library-item")).toHaveCount(0);

  await dialog.getByLabel("素材を検索").fill("tcolorbox");
  await expect(dialog.locator(".material-library-item")).toHaveCount(0);
});

test("edits saved material content in the reusable material editor surface", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("intro_p", "前の本文"),
    paragraph("target_p", ""),
  ]), {
    materials: [createTextMaterial(), createFigureMaterial(), createMixedMaterial()],
  });

  await page.goto("/");
  await page.locator('button[aria-label="素材"]').first().click();

  const libraryDialog = page.getByRole("dialog", { name: "素材" });
  const textCard = libraryDialog.locator(".material-library-item").filter({ hasText: "公式素材" });
  await textCard.getByRole("button", { name: "公式素材 の操作" }).click();
  await page.getByRole("menu", { name: "公式素材 の操作" }).getByRole("menuitem", { name: "編集" }).click();

  const editDialog = page.getByRole("dialog", { name: "素材を編集" });
  const editToolbar = editDialog.locator('[data-editor-toolbar="quick"]');
  await expect(editToolbar).toBeVisible();
  await expect(editDialog.locator(".material-edit-menubar")).toHaveCount(0);
  await expect(editToolbar.locator(".toolbar-group.flat").first()).toBeVisible();
  await expect(editDialog.locator(".text-flow-editor")).toContainText("素材本文");
  await editDialog.locator('[data-sigma-doc-id="material_p"]').first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" 編集済み");
  await editDialog.getByRole("button", { name: "保存" }).click();

  await expect.poll(async () => page.evaluate(async () => {
    const api = (window as unknown as {
      desktopAPI: {
        materials: {
          listMaterials: () => Promise<Array<{ name: string; content: unknown }>>;
        };
      };
    }).desktopAPI;
    const materials = await api.materials.listMaterials();
    return JSON.stringify(materials.find((material) => material.name === "公式素材")?.content ?? null);
  })).toContain("編集済み");

  await libraryDialog.getByLabel("素材を検索").fill("図形素材");
  const figureCard = libraryDialog.locator(".material-library-item").filter({ hasText: "図形素材" });
  await figureCard.getByRole("button", { name: "図形素材 の操作" }).click();
  await page.getByRole("menu", { name: "図形素材 の操作" }).getByRole("menuitem", { name: "編集" }).click();

  const figureEditDialog = page.getByRole("dialog", { name: "素材を編集" });
  const figureToolbar = figureEditDialog.locator('[data-editor-toolbar="quick"]');
  await expect(figureToolbar.locator(".toolbar-splitter")).toHaveCount(2);
  // The overflow container has no box; assert the visible figure itself.
  await expect(figureEditDialog.locator(".material-edit-overlay-layer .overlay-shape-geo")).toBeVisible();
  await expect(figureEditDialog.getByRole("button", { name: "選択図形を削除" })).toBeDisabled();
  const shapeRow = figureEditDialog.locator(".material-edit-shape-row").filter({ hasText: "四角形" });
  await expect(shapeRow).toBeVisible();
  await shapeRow.click();
  await expect(figureToolbar.getByRole("button", { name: "選択", exact: true })).toHaveClass(/active/);
  await expect(figureEditDialog.getByRole("button", { name: "選択図形を削除" })).toBeEnabled();
  await figureEditDialog.getByLabel("X", { exact: true }).fill("384");
  await figureEditDialog.getByLabel("幅", { exact: true }).fill("112");
  await expect(figureEditDialog.locator(".overlay-shape-geo")).toHaveCSS("width", "112px");
  await figureEditDialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(figureEditDialog).toBeHidden();

  const storedMaterials = await page.evaluate(async () => {
    const api = (window as unknown as { desktopAPI: { materials: { listMaterials(): Promise<MaterialItem[]> } } }).desktopAPI;
    return api.materials.listMaterials();
  });
  expect(storedMaterials.find((material) => material.id === "material_figure")?.content.overlaySnapshot.shapes[0]).toMatchObject({
    x: 384, props: { w: 112 },
  });

  await libraryDialog.getByLabel("素材を検索").fill("mixed");
  const mixedCard = libraryDialog.locator(".material-library-item").filter({ hasText: "混在素材" });
  await mixedCard.getByRole("button", { name: "混在素材 の操作" }).click();
  await page.getByRole("menu", { name: "混在素材 の操作" }).getByRole("menuitem", { name: "編集" }).click();

  const mixedEditDialog = page.getByRole("dialog", { name: "素材を編集" });
  const composite = mixedEditDialog.locator(".material-edit-composite");
  await expect(composite.locator('[data-sigma-doc-id="material_mixed_p"]')).toContainText("混在本文");
  await expect(composite.locator(".overlay-shape-geo")).toBeVisible();
  await expect(mixedEditDialog.locator(".material-edit-figure")).toHaveCount(0);

  // The desktop mock resets on navigation, so rehydrate a fresh renderer from the
  // repository result returned by the save above.
  const reloadedPage = await page.context().newPage();
  await installDesktopRuntimeMock(reloadedPage, createDocument([
    paragraph("intro_p", "前の本文"), paragraph("target_p", ""),
  ]), { materials: storedMaterials });
  await page.close();
  await reloadedPage.goto("/");
  await reloadedPage.locator('button[aria-label="素材"]').first().click();
  const reloadedLibrary = reloadedPage.getByRole("dialog", { name: "素材" });
  const reloadedText = reloadedLibrary.locator(".material-library-item").filter({ hasText: "公式素材" });
  await expect(reloadedText.locator(".material-preview-flow-row")).toContainText("編集済み");
  const reloadedFigure = reloadedLibrary.locator(".material-library-item").filter({ hasText: "図形素材" });
  await reloadedFigure.getByRole("button", { name: "図形素材 の操作" }).click();
  await reloadedPage.getByRole("menu", { name: "図形素材 の操作" }).getByRole("menuitem", { name: "編集" }).click();
  const reloadedEdit = reloadedPage.getByRole("dialog", { name: "素材を編集" });
  await expect(reloadedEdit.locator(".overlay-shape-geo")).toBeVisible();
  await expect(reloadedEdit.locator(".overlay-shape-geo")).toHaveCSS("width", "112px");
  await reloadedEdit.locator(".material-edit-shape-row").filter({ hasText: "四角形" }).click();
  await expect(reloadedEdit.getByLabel("X", { exact: true })).toHaveValue("384");
  await expect(reloadedEdit.getByLabel("幅", { exact: true })).toHaveValue("112");
  await reloadedPage.close();
});

test("inserts a slash box command as a native box block", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("intro_p", "前の本文"),
    paragraph("target_p", ""),
  ]));

  await page.goto("/");
  const targetParagraph = page.locator('[data-sigma-doc-id="target_p"]').first();
  await expect(targetParagraph).toBeVisible();
  await targetParagraph.click();
  await page.keyboard.type("/itembox");

  const popover = page.locator(".slash-command-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("itembox");
  await page.keyboard.press("Enter");

  await expect(page.locator('.sigma-doc-box-block[data-box-style="itembox"]').filter({ hasText: "ポイント" })).toBeVisible();

  await expect.poll(async () => page.evaluate(() => {
    const serialized = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!serialized) {
      return null;
    }
    const document = JSON.parse(serialized) as SigmaDocument;
    const box = document.content.find((block) => block.type === "boxBlock");
    const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    return {
      boxType: box?.type ?? null,
      boxStyle: box?.type === "boxBlock" ? box.styleId : null,
      shapeCount: shapes.length,
    };
  })).toMatchObject({ boxType: "boxBlock", boxStyle: "itembox", shapeCount: 0 });
});

test("inserts the notebook tcolorbox as a native box block", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("intro_p", "前の本文"),
    paragraph("target_p", ""),
  ]));

  await page.goto("/");
  const targetParagraph = page.locator('[data-sigma-doc-id="target_p"]').first();
  await expect(targetParagraph).toBeVisible();
  await targetParagraph.click();
  await page.keyboard.type("/ノート");

  const popover = page.locator(".slash-command-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("tcolorbox-note");
  await page.keyboard.press("Enter");

  const box = page.locator('.sigma-doc-box-block[data-box-style="tcolorbox-note"]').first();
  await expect(box).toBeVisible();
  await expect(box).toHaveAttribute("data-box-notebook-rules", "true");
  const bodyParagraph = box.locator(".sigma-doc-box-body [data-sigma-doc-id]").first();
  await expect(bodyParagraph).toBeVisible();

  const metrics = await notebookBoxRenderMetrics(page, '.sigma-doc-box-block[data-box-style="tcolorbox-note"]');
  expect(metrics.minHeightPx).toBeCloseTo(57.35, 1);
  expect(metrics.borderTopWidthPx).toBe(0);
  expect(metrics.afterLeftPx).toBeCloseTo(20, 0);
  expect(metrics.afterBorderLeftColor).toBe("rgba(156, 163, 175, 0.85)");
  expect(metrics.beforeLeftPx).toBeCloseTo(6, 0);
  expect(metrics.beforeWidthPx).toBeCloseTo(38, 0);
  expect(metrics.beforeHeightPx).toBeGreaterThanOrEqual(metrics.minHeightPx);
  expect(metrics.beforeHeightPx).toBeLessThan(70);
  expect(metrics.beforeBackgroundRepeat).toContain("round");
  expect(metrics.beforeBackgroundImage).toContain("data:image/svg+xml");
  expect(metrics.beforeBackgroundImage).not.toContain("radial-gradient");

  await expect.poll(async () => page.evaluate(() => {
    const serialized = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!serialized) {
      return null;
    }
    const document = JSON.parse(serialized) as SigmaDocument;
    const boxBlock = document.content.find((block) => block.type === "boxBlock");
    const firstBodyBlock = boxBlock?.type === "boxBlock" ? boxBlock.blocks[0] : null;
    const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    return {
      boxType: boxBlock?.type ?? null,
      boxStyle: boxBlock?.type === "boxBlock" ? boxBlock.styleId : null,
      decorationType: boxBlock?.type === "boxBlock" ? boxBlock.frame?.decorations?.[0]?.type : null,
      bodyChildren: firstBodyBlock && (firstBodyBlock.type === "paragraph" || firstBodyBlock.type === "heading") ? firstBodyBlock.children.length : null,
      shapeCount: shapes.length,
    };
  })).toMatchObject({
    boxType: "boxBlock",
    boxStyle: "tcolorbox-note",
    decorationType: "notebookRules",
    bodyChildren: 0,
    shapeCount: 0,
  });
});

test("renders the notebook tcolorbox in print preview with the same frame geometry", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    createBoxBlock("tcolorbox-note", "", {
      id: "print_note_box",
      bodyId: "print_note_body",
    }),
  ]));

  await page.goto("/print?fileId=file_e2e_document");
  const box = page.locator('.print-box-block[data-box-style="tcolorbox-note"]').first();
  await expect(box).toBeVisible();
  await expect(box).toHaveAttribute("data-box-notebook-rules", "true");

  const metrics = await notebookBoxRenderMetrics(page, '.print-box-block[data-box-style="tcolorbox-note"]');
  expect(metrics.minHeightPx).toBeCloseTo(57.35, 1);
  expect(metrics.borderTopWidthPx).toBe(0);
  expect(metrics.afterLeftPx).toBeCloseTo(20, 0);
  expect(metrics.afterBorderLeftColor).toBe("rgba(156, 163, 175, 0.85)");
  expect(metrics.beforeLeftPx).toBeCloseTo(6, 0);
  expect(metrics.beforeWidthPx).toBeCloseTo(38, 0);
  expect(metrics.beforeHeightPx).toBeGreaterThanOrEqual(metrics.minHeightPx);
  expect(metrics.beforeHeightPx).toBeLessThan(70);
  expect(metrics.beforeBackgroundRepeat).toContain("round");
  expect(metrics.beforeBackgroundImage).toContain("data:image/svg+xml");
  expect(metrics.beforeBackgroundImage).not.toContain("radial-gradient");
});

test("extends notebook rings when the box grows taller", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const tallBox = createBoxBlock("tcolorbox-note", "", {
    id: "tall_note_box",
    bodyId: "tall_note_body_1",
  });
  tallBox.blocks = Array.from({ length: 26 }, (_, index) => paragraph(`tall_note_body_${index + 1}`, `本文 ${index + 1}`));
  await installDesktopRuntimeMock(page, createDocument([tallBox]));

  await page.goto("/");
  const box = page.locator('.sigma-doc-box-block[data-box-style="tcolorbox-note"]').first();
  await expect(box).toBeVisible();

  const metrics = await notebookBoxRenderMetrics(page, '.sigma-doc-box-block[data-box-style="tcolorbox-note"]');
  expect(metrics.boxHeightPx).toBeGreaterThan(500);
  expect(metrics.beforeHeightPx).toBeCloseTo(metrics.boxHeightPx, 0);
  expect(metrics.beforeBackgroundRepeat).toContain("round");
  expect(metrics.beforeBackgroundImage).toContain("data:image/svg+xml");
  expect(metrics.beforeBackgroundImage).not.toContain("radial-gradient");
});

test("splits notebook tcolorbox fragments across print pages", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const splitBox = createBoxBlock("tcolorbox-note", "", {
    id: "split_note_box",
    bodyId: "split_note_body_1",
  });
  splitBox.blocks = Array.from({ length: 20 }, (_, index) => paragraph(`split_note_body_${index + 1}`, `ノート本文 ${index + 1}`));
  const splitDocument = createDocument([splitBox]);
  splitDocument.pageLayout = {
    preset: "custom",
    orientation: "portrait",
    pageSize: { widthMm: 96, heightMm: 72 },
    marginsMm: { top: 8, right: 8, bottom: 8, left: 8 },
    flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
  };
  await installDesktopRuntimeMock(page, splitDocument);

  await page.goto("/print?fileId=file_e2e_document");
  await expect(page.locator('.print-box-block[data-box-source-id="split_note_box"]').first()).toBeVisible();

  await expect.poll(async () => page.evaluate(() => {
    const pages = Array.from(document.querySelectorAll<HTMLElement>(".paged-surface-page"));
    const fragments = Array.from(document.querySelectorAll<HTMLElement>('.print-box-block[data-box-source-id="split_note_box"]'));
    const roles = fragments.map((fragment) => fragment.getAttribute("data-box-fragment"));
    const bodyIds = pages.map((printPage) => (
      Array.from(printPage.querySelectorAll<HTMLElement>('[data-sigma-doc-id^="split_note_body_"]'))
        .map((element) => element.getAttribute("data-sigma-doc-id"))
    ));
    return {
      hasMultiplePages: pages.length > 1,
      hasMultipleFragments: fragments.length > 1,
      roles,
      bodyIds,
    };
  })).toMatchObject({
    hasMultiplePages: true,
    hasMultipleFragments: true,
    roles: expect.arrayContaining(["first", "last"]),
    bodyIds: expect.arrayContaining([
      expect.arrayContaining(["split_note_body_1"]),
      expect.arrayContaining(["split_note_body_20"]),
    ]),
  });
});

test("splits notebook tcolorbox fragments across editor pages", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const splitBox = createBoxBlock("tcolorbox-note", "", {
    id: "editor_split_note_box",
    bodyId: "editor_split_note_body_1",
  });
  splitBox.blocks = Array.from({ length: 20 }, (_, index) => paragraph(`editor_split_note_body_${index + 1}`, `編集ノート本文 ${index + 1}`));
  const splitDocument = createDocument([splitBox]);
  splitDocument.pageLayout = {
    preset: "custom",
    orientation: "portrait",
    pageSize: { widthMm: 96, heightMm: 72 },
    marginsMm: { top: 8, right: 8, bottom: 8, left: 8 },
    flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
  };
  await installDesktopRuntimeMock(page, splitDocument);

  await page.goto("/");
  const sourceBox = page.locator('.sigma-doc-box-block[data-sigma-doc-id="editor_split_note_box"]').first();
  await expect(sourceBox).toBeVisible();
  await expect(page.locator('.editor-box-fragment-viewport[data-box-source-id="editor_split_note_box"]').first()).toBeVisible();

  const splitMetrics = await page.evaluate(() => {
    const source = document.querySelector<HTMLElement>('.sigma-doc-box-block[data-sigma-doc-id="editor_split_note_box"]');
    const fragments = Array.from(document.querySelectorAll<HTMLElement>('.editor-box-fragment-viewport[data-box-source-id="editor_split_note_box"]'));
    const pageCount = document.querySelectorAll(".a4-page-sheet").length;
    const sourceRect = source?.getBoundingClientRect();
    const firstFragmentRect = fragments[0]?.getBoundingClientRect();
    return {
      pageCount,
      fragmentCount: fragments.length,
      sourceClipPath: source ? getComputedStyle(source).clipPath : "",
      cloneHasNotebookRules: fragments.some((fragment) => (
        fragment.querySelector('.editor-box-fragment-editor .sigma-doc-box-block[data-box-notebook-rules="true"]')
      )),
      firstFragmentBelowSource: Boolean(sourceRect && firstFragmentRect && firstFragmentRect.top > sourceRect.top),
    };
  });

  expect(splitMetrics.pageCount).toBeGreaterThan(1);
  expect(splitMetrics.fragmentCount).toBeGreaterThan(0);
  expect(splitMetrics.sourceClipPath).toContain("inset");
  expect(splitMetrics.cloneHasNotebookRules).toBe(true);
  expect(splitMetrics.firstFragmentBelowSource).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator(".startup-splash")).toBeHidden();
  const continuationFragment = page
    .locator('.editor-box-fragment-viewport[data-box-source-id="editor_split_note_box"]')
    .last();
  await continuationFragment.click({ position: { x: 12, y: 12 } });
  await expect.poll(async () => page.evaluate(() => (
    document.activeElement instanceof HTMLElement &&
    document.activeElement.classList.contains("ProseMirror")
  ))).toBe(true);
  await page.keyboard.type("FRAG");
  await expect.poll(async () => page.evaluate(() => {
    const serialized = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!serialized) {
      return false;
    }
    const document = JSON.parse(serialized) as SigmaDocument;
    const boxBlock = document.content.find((block) => block.type === "boxBlock" && block.id === "editor_split_note_box");
    return boxBlock?.type === "boxBlock" && boxBlock.blocks.some((block) => (
      block.type === "paragraph" &&
      block.children.some((child) => child.type === "text" && child.text.includes("FRAG"))
    ));
  })).toBe(true);
});

test("starts a tall box on the page where it is inserted in print instead of pushing it", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const fillBox = createBoxBlock("tcolorbox-note", "", { id: "fill_note_box", bodyId: "fill_note_body_1" });
  fillBox.blocks = Array.from({ length: 24 }, (_, index) => paragraph(`fill_note_body_${index + 1}`, `ノート本文 ${index + 1}`));
  const fillDocument = createDocument([paragraph("fill_intro", "導入の段落"), fillBox]);
  fillDocument.pageLayout = {
    preset: "custom",
    orientation: "portrait",
    pageSize: { widthMm: 96, heightMm: 72 },
    marginsMm: { top: 8, right: 8, bottom: 8, left: 8 },
    flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
  };
  await installDesktopRuntimeMock(page, fillDocument);

  await page.goto("/print?fileId=file_e2e_document");
  await expect(page.locator('.print-box-block[data-box-source-id="fill_note_box"]').first()).toBeVisible();

  const layout = await page.evaluate(() => {
    const pages = Array.from(document.querySelectorAll<HTMLElement>(".paged-surface-page"));
    const pageIndexOf = (id: string) => pages.findIndex((printPage) => printPage.querySelector(`[data-sigma-doc-id="${id}"]`));
    const bodyIds = Array.from({ length: 24 }, (_, index) => `fill_note_body_${index + 1}`);
    const seen = new Set(pages.flatMap((printPage) => (
      Array.from(printPage.querySelectorAll<HTMLElement>('[data-sigma-doc-id^="fill_note_body_"]'))
        .map((element) => element.getAttribute("data-sigma-doc-id"))
    )));
    return {
      pageCount: pages.length,
      introPage: pageIndexOf("fill_intro"),
      firstBodyPage: pageIndexOf("fill_note_body_1"),
      lastBodyPage: pageIndexOf("fill_note_body_24"),
      missing: bodyIds.filter((id) => !seen.has(id)),
    };
  });

  expect(layout.introPage).toBe(0);
  // The box flows like body text: its first line is on the very page it was inserted
  // on (with the intro), not pushed wholesale to a fresh page.
  expect(layout.firstBodyPage).toBe(layout.introPage);
  // ...and it still continues onto a later page, losing no content.
  expect(layout.lastBodyPage).toBeGreaterThan(layout.firstBodyPage);
  expect(layout.missing).toEqual([]);
});

test("starts a tall box on the page where it is inserted in the editor instead of pushing it", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const fillBox = createBoxBlock("tcolorbox-note", "", { id: "fill_editor_box", bodyId: "fill_editor_body_1" });
  fillBox.blocks = Array.from({ length: 24 }, (_, index) => paragraph(`fill_editor_body_${index + 1}`, `編集ノート本文 ${index + 1}`));
  const fillDocument = createDocument([paragraph("fill_editor_intro", "導入の段落"), fillBox]);
  fillDocument.pageLayout = {
    preset: "custom",
    orientation: "portrait",
    pageSize: { widthMm: 96, heightMm: 72 },
    marginsMm: { top: 8, right: 8, bottom: 8, left: 8 },
    flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
  };
  await installDesktopRuntimeMock(page, fillDocument);

  await page.goto("/");
  await expect(page.locator('.sigma-doc-box-block[data-sigma-doc-id="fill_editor_box"]').first()).toBeVisible();
  await expect(page.locator('.editor-box-fragment-viewport[data-box-source-id="fill_editor_box"]').first()).toBeVisible();

  const geo = await page.evaluate(() => {
    const sheets = Array.from(document.querySelectorAll<HTMLElement>(".a4-page-sheet")).map((sheet) => sheet.getBoundingClientRect());
    const pageOf = (y: number) => sheets.findIndex((rect) => y >= rect.top - 1 && y <= rect.bottom + 1);
    const intro = document.querySelector<HTMLElement>('[data-sigma-doc-id="fill_editor_intro"]')?.getBoundingClientRect();
    const box = document.querySelector<HTMLElement>('.sigma-doc-box-block[data-sigma-doc-id="fill_editor_box"]')?.getBoundingClientRect();
    return {
      sheetCount: sheets.length,
      introPage: intro ? pageOf(intro.top) : -1,
      boxPage: box ? pageOf(box.top) : -1,
    };
  });

  expect(geo.sheetCount).toBeGreaterThan(1);
  expect(geo.introPage).toBe(0);
  // The source box starts on the same page as the intro paragraph rather than being
  // pushed onto the next page (which would leave the first page half empty).
  expect(geo.boxPage).toBe(geo.introPage);
});

test("saves a selected paragraph as a material from the right-click dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("intro_p", "右クリック本文"),
    paragraph("target_p", ""),
  ]));

  await page.goto("/");
  const sourceParagraph = page.locator('.text-flow-editor [data-sigma-doc-id="intro_p"]').first();
  await expect(sourceParagraph).toBeVisible();
  await sourceParagraph.click();
  await expect(page.locator(".text-flow-selected-line")).toBeVisible();
  const sourceBox = await sourceParagraph.boundingBox();
  expect(sourceBox).not.toBeNull();
  await page.mouse.click(sourceBox!.x + 8, sourceBox!.y + sourceBox!.height / 2, { button: "right" });
  const contextMenu = page.locator(".page-context-menu");
  await expect(contextMenu).toBeVisible();
  await contextMenu.getByRole("menuitem", { name: "素材に追加", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "素材に追加" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".material-library-preview")).toContainText("右クリック本文");
  await dialog.getByLabel("素材名").fill("右クリック素材");
  await dialog.getByRole("button", { name: "素材に追加" }).click();

  await expect(dialog).toBeHidden();
  await expect.poll(async () => page.evaluate(async () => {
    const api = (window as unknown as {
      desktopAPI: {
        materials: {
          listMaterials: () => Promise<Array<{ name: string; content: unknown }>>;
        };
      };
    }).desktopAPI;
    return (await api.materials.listMaterials()).map((material) => ({
      name: material.name,
      content: JSON.stringify(material.content),
    }));
  })).toContainEqual(expect.objectContaining({
    name: "右クリック素材",
    content: expect.stringContaining("右クリック本文"),
  }));
});

test("saves selected body text and selected figure together as a material", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("intro_p", "本文と図形をまとめる"),
    paragraph("target_p", ""),
  ]));

  await page.goto("/");
  const sourceParagraph = page.locator('[data-sigma-doc-id="intro_p"]').first();
  await expect(sourceParagraph).toBeVisible();
  await sourceParagraph.click();

  await insertRectangleShape(page);
  const rectangle = page.locator(".overlay-shape-geo").first();
  await expect(rectangle).toBeVisible();
  await expect(rectangle).toHaveClass(/selected/);
  await rectangle.click({ button: "right" });
  await page.locator(".overlay-shape-context-menu").getByRole("menuitem", { name: "素材に追加" }).click();

  const dialog = page.getByRole("dialog", { name: "素材に追加" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("素材名").fill("混在素材");
  await dialog.getByRole("button", { name: "素材に追加" }).click();

  await expect(dialog).toBeHidden();
  await expect.poll(async () => page.evaluate(async () => {
    const api = (window as unknown as {
      desktopAPI: {
        materials: {
          listMaterials: () => Promise<Array<{
            name: string;
            content: {
              blocks: unknown[];
              overlaySnapshot: { shapes: unknown[] };
            };
          }>>;
        };
      };
    }).desktopAPI;
    const material = (await api.materials.listMaterials()).find((item) => item.name === "混在素材");
    return material ? {
      blockCount: material.content.blocks.length,
      shapeCount: material.content.overlaySnapshot.shapes.length,
      content: JSON.stringify(material.content),
    } : null;
  })).toEqual(expect.objectContaining({
    blockCount: 1,
    shapeCount: 1,
    content: expect.stringContaining("本文と図形をまとめる"),
  }));
});

function createTextMaterial(): MaterialItem {
  return {
    version: 1,
    id: "material_formula",
    name: "公式素材",
    content: {
      blocks: [paragraph("material_p", "素材本文")],
      overlaySnapshot: {
        version: 1,
        shapes: [],
        assets: {},
      },
    },
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

function createFigureMaterial(): MaterialItem {
  return {
    version: 1,
    id: "material_figure",
    name: "図形素材",
    content: {
      blocks: [],
      overlaySnapshot: {
        version: 1,
        shapes: [
          {
            id: "material_shape",
            type: "geo",
            x: 360,
            y: 420,
            anchor: { type: "page" },
            props: {
              w: 80,
              h: 44,
              geo: "rectangle",
              fill: "solid",
              color: "#111111",
              fillColor: "#dbeafe",
              labelColor: "#111111",
              dash: "solid",
              size: "m",
            },
          },
        ],
        assets: {},
      },
    },
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

function createMixedMaterial(): MaterialItem {
  return {
    version: 1,
    id: "material_mixed",
    name: "混在素材",
    description: "mixed reusable text and figure",
    tags: ["mixed"],
    usage: {
      aliases: ["mixed"],
    },
    content: {
      blocks: [paragraph("material_mixed_p", "混在本文")],
      overlaySnapshot: {
        version: 1,
        shapes: [
          {
            id: "material_mixed_shape",
            type: "geo",
            x: 24,
            y: 18,
            anchor: { type: "page" },
            props: {
              w: 120,
              h: 48,
              geo: "rectangle",
              fill: "solid",
              color: "#111111",
              fillColor: "#fef3c7",
              labelColor: "#111111",
              dash: "solid",
              size: "m",
            },
          },
        ],
        assets: {},
      },
    },
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

async function notebookBoxRenderMetrics(page: Page, selector: string): Promise<{
  afterBorderLeftColor: string;
  afterLeftPx: number;
  boxHeightPx: number;
  beforeBackgroundImage: string;
  beforeBackgroundRepeat: string;
  beforeHeightPx: number;
  beforeLeftPx: number;
  beforeWidthPx: number;
  borderTopWidthPx: number;
  minHeightPx: number;
}> {
  return page.evaluate((targetSelector) => {
    const box = document.querySelector<HTMLElement>(targetSelector);
    if (!box) {
      throw new Error(`notebook box not found: ${targetSelector}`);
    }

    const boxStyle = getComputedStyle(box);
    const beforeStyle = getComputedStyle(box, "::before");
    const afterStyle = getComputedStyle(box, "::after");
    return {
      afterBorderLeftColor: afterStyle.borderLeftColor,
      afterLeftPx: Number.parseFloat(afterStyle.left) || 0,
      boxHeightPx: Number.parseFloat(boxStyle.height) || 0,
      beforeBackgroundImage: beforeStyle.backgroundImage,
      beforeBackgroundRepeat: beforeStyle.backgroundRepeat,
      beforeHeightPx: Number.parseFloat(beforeStyle.height) || 0,
      beforeLeftPx: Number.parseFloat(beforeStyle.left) || 0,
      beforeWidthPx: Number.parseFloat(beforeStyle.width) || 0,
      borderTopWidthPx: Number.parseFloat(boxStyle.borderTopWidth) || 0,
      minHeightPx: Number.parseFloat(boxStyle.minHeight) || 0,
    };
  }, selector);
}

async function insertRectangleShape(page: Page): Promise<void> {
  await page.locator('button.shape-menu-button[aria-label="図形"]').click();
  await page.getByRole("menuitem", { name: "四角形", exact: true }).click();
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();

  const startX = surfaceBox!.x + 120;
  const startY = surfaceBox!.y + 140;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 90, startY + 54, { steps: 8 });
  await page.mouse.up();
}

function paragraph(id: string, text: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    children: text ? [{ type: "text", text }] : [],
  };
}

function createDocument(content: SigmaBlock[]): SigmaDocument {
  return {
    version: "2.0",
    docId: "materials_e2e_doc",
    metadata: { title: "素材E2E" },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}
