import { expect, test, type Locator, type Page } from "@playwright/test";

import type { SigmaDocument } from "@/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { waitForPagedSurfaceSettled } from "./paged-surface";

const COMPREHENSIVE_DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "comprehensive_e2e_document",
  metadata: { title: "総合確認 E2E" },
  content: [{
    id: "comprehensive_body",
    type: "paragraph",
    children: [{ type: "text", text: "数学教材の本文です。" }],
  }],
  outputProfiles: { student: {}, teacher: {}, answerBook: {} },
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await installDesktopRuntimeMock(page, COMPREHENSIVE_DOCUMENT);
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("総合確認 E2E");
  await expect(page.locator(".startup-splash")).toBeHidden();
});

test("Flow 1: edits the seeded SigmaDoc body and persists the change", async ({ page }) => {
  const paragraph = page.locator('.page-flow .ProseMirror > [data-sigma-doc-id="comprehensive_body"]');
  await expect(paragraph).toHaveText("数学教材の本文です。");
  await placeCaretAtEnd(paragraph);
  await page.keyboard.insertText("追記");

  await expect(paragraph).toHaveText("数学教材の本文です。追記");
  await expect.poll(async () => readSavedParagraphText(page, "comprehensive_body"))
    .toBe("数学教材の本文です。追記");
});

test("Flow 2: inserts a graph through the current placement tool", async ({ page }) => {
  const graph = await insertGraph(page, 0);

  await expect(graph).toBeVisible();
  await expect(graph).toHaveAttribute("data-testid", "overlay-graph2d");
  await expect(graph.locator('[data-testid="graph2d-svg"]')).toBeVisible();
  await chooseGraphOrigin(page, graph);
  await expect(page.getByRole("button", { name: "関数を追加" })).toBeVisible();
});

test("Flow 3: configures graph functions, color, and ticks", async ({ page }) => {
  const graph = await insertGraph(page, 0);
  await chooseGraphOrigin(page, graph);

  await page.getByRole("button", { name: "関数を追加" }).click();
  await setMathFieldValue(page, "overlay-graph-expr-input", "\\sin(x)");
  const curves = page.locator('[data-testid="graph2d-curve"]');
  await expect(curves).toHaveCount(1);

  await page.getByRole("button", { name: "関数を追加" }).click();
  await expect(curves).toHaveCount(2);

  // `⋯` は hover で開く (graph2d.spec.ts の openGraphItemActions と同じ手順)。
  await page.locator('.graph-curve-editor:has([data-testid="overlay-graph-curve-actions"])').hover();
  await page.getByTestId("overlay-graph-curve-actions").hover();
  await expect(page.getByRole("dialog", { name: "関数 1 の操作" })).toBeVisible();
  await page.getByTestId("overlay-graph-color-select").click();
  await page.locator('.color-popover [role="option"][title="#dc2626"]').first().click();
  await expect(curves.first()).toHaveAttribute("stroke", "#dc2626");

  await expandGraphDisclosure(page, "表示範囲");
  await page.getByLabel("目盛", { exact: true }).check();
  await expect(page.locator(".graph2d-ticks")).toHaveCount(1);
  await page.getByLabel("グリッド", { exact: true }).check();
  await expect(page.locator(".graph2d-grid")).toHaveCount(1);
});

test("Flow 4: insert menu exposes graph but not the removed number line", async ({ page }) => {
  const menu = await openInsertMenu(page);
  await expect(menu.getByRole("menuitem", { name: "グラフ" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "数直線", exact: true })).toHaveCount(0);
});

test("Flow 5: inserts and commits an inline formula from the Insert menu", async ({ page }) => {
  const paragraph = page.locator('.page-flow .ProseMirror > [data-sigma-doc-id="comprehensive_body"]');
  await placeCaretAtEnd(paragraph);
  const menu = await openInsertMenu(page);
  await menu.getByRole("menuitem", { name: "数式" }).click();

  const inlineMath = page.locator(".text-flow-editor .inline-math-node.editing");
  await expect(inlineMath).toBeVisible();
  const field = inlineMath.locator("math-field.inline-math-field");
  await field.evaluate(async () => {
    await customElements.whenDefined("math-field");
  });
  await field.evaluate((element) => {
    const mathField = element as HTMLElement & { value: string };
    mathField.value = "x^2";
    mathField.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await field.press("Enter");

  const committed = page.locator('.text-flow-editor .inline-math-node[data-tex="x^2"]');
  await expect(committed).toBeVisible();
  await expect(page.locator(".text-flow-editor .inline-math-node.editing")).toHaveCount(0);
  await expect.poll(async () => readSavedInlineMathTex(page, "comprehensive_body")).toBe("x^2");
});

test("Flow 6: print preview renders the inserted graph and body", async ({ page }) => {
  const graph = await insertGraph(page, 0);
  await chooseGraphOrigin(page, graph);
  await page.getByRole("button", { name: "関数を追加" }).click();
  await setMathFieldValue(page, "overlay-graph-expr-input", "x^2");

  await openPdfPreview(page);
  const dialog = page.getByRole("dialog", { name: "PDFプレビュー" });
  // `.print-page-overlay-layer` belonged to the separate print renderer the PDF path used before
  // the PDF-parity rewrite; the preview is `PagedRenderSurface` now and draws the graph through
  // the same overlay components as the canvas. Assert on `.paged-surface-page` — those windows are
  // the printed output, while `.paged-surface-stage` is only the off-screen source canvas. Reach
  // the graph through `[data-overlay-shape-id]`, which page ownership keeps unique per window
  // (`print/paged-render/page-windows.ts`).
  await expect(dialog.locator(".paged-surface-page [data-overlay-shape-id] .graph2d-svg")).toHaveCount(1);
  await expect(dialog.locator(".paged-surface-page")).toContainText("数学教材の本文です。");
});

test("Flow 7: drags a placed graph and persists its new position", async ({ page }) => {
  const graph = await insertGraph(page, 0);
  await chooseGraphOrigin(page, graph);
  const before = await graph.boundingBox();
  expect(before).not.toBeNull();

  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await page.mouse.move(before!.x + before!.width / 2 + 100, before!.y + before!.height / 2 + 70, { steps: 10 });
  await page.mouse.up();

  await expect.poll(async () => (await graph.boundingBox())?.x ?? before!.x)
    .toBeGreaterThan(before!.x + 50);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  await expect.poll(async () => (await readSavedGraphPositions(page))[0]?.x ?? 0)
    .toBeGreaterThan(120);
  await expect.poll(async () => (await readSavedGraphPositions(page))[0]?.y ?? 0)
    .toBeGreaterThan(120);
  const [saved] = await readSavedGraphPositions(page);
  expect(saved.x).toBeGreaterThan(120);
  expect(saved.y).toBeGreaterThan(120);
});

test("Flow 8: keeps two independently placed graphs in editor and print output", async ({ page }) => {
  const first = await insertGraph(page, 0);
  await chooseGraphOrigin(page, first);
  await page.getByRole("button", { name: "関数を追加" }).click();
  await setMathFieldValue(page, "overlay-graph-expr-input", "\\cos(x)");

  const second = await insertGraph(page, 1);
  await chooseGraphOrigin(page, second);
  await expect(page.locator(".graph-shape")).toHaveCount(2);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  await expect.poll(async () => (await readSavedGraphPositions(page)).length).toBe(2);

  await openPdfPreview(page);
  // Scoped to the page windows for the same reason as Flow 6 above.
  await expect(page.locator(".paged-surface-page [data-overlay-shape-id] .graph2d-svg")).toHaveCount(2);
});

async function openInsertMenu(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "挿入", exact: true }).click();
  const menu = page.getByRole("menu", { name: "挿入", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

async function insertGraph(page: Page, index: number): Promise<Locator> {
  const menu = await openInsertMenu(page);
  // The accessible name includes the shortcut rendered at the right edge.
  await menu.getByRole("menuitem", { name: "グラフ" }).click();
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  const startX = box!.x + 120 + index * 38;
  const startY = box!.y + 120 + index * 220;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 300, startY + 170, { steps: 8 });
  await expect(page.locator(".overlay-insert-preview-shape .graph2d-svg")).toBeVisible();
  await page.mouse.up();
  const graphs = page.locator(".graph-shape");
  await expect(graphs).toHaveCount(index + 1);
  return graphs.nth(index);
}

async function chooseGraphOrigin(page: Page, graph: Locator): Promise<void> {
  const box = await graph.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width * 0.3, box!.y + box!.height * 0.38);
  // 設定は挿入では開かない。原点を決めたあと右クリックから開く (非モーダル浮遊パネル)。
  await page.mouse.click(box!.x + box!.width * 0.42, box!.y + box!.height * 0.48, { button: "right" });
  await page.locator(".overlay-shape-context-menu").getByRole("menuitem", { name: "グラフの設定…" }).click();
  await expect(page.getByRole("dialog", { name: "グラフの設定" })).toBeVisible();
  await expect(page.getByRole("button", { name: "原点をクリックで指定" })).toBeVisible();
}

async function expandGraphDisclosure(page: Page, name: string): Promise<void> {
  const trigger = page.getByRole("button", { name, exact: true });
  await expect(trigger).toBeVisible();
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

async function openMathField(page: Page, testId: string): Promise<Locator> {
  await page.getByTestId(testId).click();
  const field = page.getByTestId(`${testId}-field`);
  await expect(field).toBeVisible();
  await field.evaluate(async () => {
    await customElements.whenDefined("math-field");
  });
  return field;
}

async function setMathFieldValue(page: Page, testId: string, tex: string): Promise<void> {
  const field = await openMathField(page, testId);
  await field.evaluate((element, value) => {
    const mathField = element as HTMLElement & { value: string };
    mathField.value = value;
    mathField.dispatchEvent(new Event("input", { bubbles: true }));
  }, tex);
  await field.press("Enter");
  await expect(page.getByTestId(`${testId}-field`)).toHaveCount(0);
}

async function openPdfPreview(page: Page): Promise<void> {
  await page.getByRole("button", { name: "ファイル", exact: true }).click();
  await page.getByRole("menuitem", { name: "エクスポート" }).hover();
  await page.getByRole("menuitem", { name: "PDFを書き出し" }).click();
  await expect(page.getByRole("dialog", { name: "PDFプレビュー" })).toBeVisible();
  await waitForPagedSurfaceSettled(page);
}

async function placeCaretAtEnd(locator: Locator): Promise<void> {
  await locator.evaluate((element) => {
    element.closest<HTMLElement>('[contenteditable="true"]')?.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function readSavedParagraphText(page: Page, blockId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    const block = document?.content?.find((item: { id?: string }) => item.id === id);
    return block?.children?.map((child: { text?: string }) => child.text ?? "").join("") ?? null;
  }, blockId);
}

async function readSavedInlineMathTex(page: Page, blockId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    const block = document?.content?.find((item: { id?: string }) => item.id === id);
    const math = block?.children?.find((child: { type?: string }) => child.type === "mathInline");
    return typeof math?.tex === "string" ? math.tex : null;
  }, blockId);
}

async function readSavedGraphPositions(page: Page): Promise<Array<{ x: number; y: number }>> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    const shapes = document?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    return shapes
      .filter((shape: { type?: string }) => shape.type === "graph2dShape")
      .map((shape: { x: number; y: number }) => ({ x: shape.x, y: shape.y }));
  });
}
