import { expect, test, type Page } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import type { SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

// A graph's axis / point / formula labels are separate overlay text shapes that
// the graph merely references by id, so reserving the graph for an AI run used
// to leave its labels freely draggable -- and a label nudged mid-run was lost
// the moment the graph proposal was applied, since applying re-lays out the
// graph's own labels. Locking a graph must lock what belongs to it.

test.describe.configure({ timeout: 120_000 });

function paragraph(id: string, text: string): SigmaBlock {
  return {
    id,
    type: "paragraph",
    children: [{ type: "text", text }],
  } as SigmaBlock;
}

function createDocument(): SigmaDocument {
  const content: SigmaBlock[] = [paragraph("para_a", "グラフのラベルとAI編集ロックの確認。")];
  // The runtime mock synthesizes its `e2e_shape_1` rectangle anchored to the
  // LAST paragraph; these filler paragraphs keep it clear of the area where
  // this spec inserts its graph. That rectangle doubles as the control shape
  // for "an unrelated shape stays the human's during the run".
  for (let index = 0; index < 6; index += 1) {
    content.push(paragraph(`para_pad_${index}`, `本文を縦に伸ばすための段落 ${index + 1} です。`));
  }
  return {
    version: "2.0",
    docId: "ai_graph_label_lock_e2e_doc",
    metadata: { title: "AIグラフラベルロックE2E" },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  } as unknown as SigmaDocument;
}

async function setup(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 950 });
  await installDesktopRuntimeMock(page, createDocument(), { ai: { enabled: true } });
  await page.goto("/");
  await expect(page.locator(".text-flow-editor").first()).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();
}

async function insertGraphWithAxisLabel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "挿入", exact: true }).click();
  const insertMenu = page.getByRole("menu", { name: "挿入", exact: true });
  await expect(insertMenu).toBeVisible();
  await insertMenu.getByRole("menuitem", { name: "グラフ" }).click();

  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  const startX = surfaceBox!.x + 120;
  const startY = surfaceBox!.y + 120;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 300, startY + 170, { steps: 8 });
  await page.mouse.up();

  const graph = page.locator(".graph-shape").first();
  await expect(graph).toBeVisible();
  const graphBox = await graph.boundingBox();
  expect(graphBox).not.toBeNull();
  await page.mouse.click(graphBox!.x + graphBox!.width * 0.3, graphBox!.y + graphBox!.height * 0.6);
  await page.mouse.click(
    graphBox!.x + graphBox!.width * 0.42,
    graphBox!.y + graphBox!.height * 0.48,
    { button: "right" },
  );
  const graphMenu = page.locator(".overlay-shape-context-menu");
  await expect(graphMenu).toBeVisible();
  await graphMenu.getByRole("menuitem", { name: "グラフの設定…" }).click();
  await expect(page.getByRole("dialog", { name: "グラフの設定" })).toBeVisible();
  await expect(page.getByRole("button", { name: "原点をクリックで指定" })).toBeVisible();

  // Turning an axis name on materializes it as a graph-owned text shape.
  const axisNameSection = page.getByRole("button", { name: "軸名", exact: true });
  if ((await axisNameSection.getAttribute("aria-expanded")) !== "true") {
    await axisNameSection.click();
  }
  await page.getByTestId("overlay-graph-axis-label-x").check();
  await expect(page.locator(".overlay-shape-text")).toHaveCount(1);
  const settingsDialog = page.getByRole("dialog", { name: "グラフの設定" });
  await settingsDialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(settingsDialog).toHaveCount(0);
}

async function dragShape(
  page: Page,
  shape: ReturnType<Page["locator"]>,
  dx: number,
  dy: number,
): Promise<{ before: { x: number; y: number }; after: { x: number; y: number } }> {
  const box = await shape.boundingBox();
  expect(box).not.toBeNull();
  const centerX = box!.x + box!.width / 2;
  const centerY = box!.y + box!.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + dx / 2, centerY + dy / 2, { steps: 4 });
  await page.mouse.move(centerX + dx, centerY + dy, { steps: 4 });
  await page.mouse.up();
  const nextBox = await shape.boundingBox();
  expect(nextBox).not.toBeNull();
  return {
    before: { x: box!.x, y: box!.y },
    after: { x: nextBox!.x, y: nextBox!.y },
  };
}

async function startShapeRun(page: Page, shape: ReturnType<Page["locator"]>, instruction: string): Promise<void> {
  await shape.click();
  const aiButton = page.locator('.selection-action-popover button[aria-label="AIに追加"]');
  await expect(aiButton).toBeVisible();
  await aiButton.click();

  const composer = page.locator(".ai-chat-composer--inline");
  await expect(composer).toBeVisible();
  await composer.locator("textarea").fill(instruction);
  await composer.locator(".ai-chat-send-button").click();

  // The composer's click-away catcher would swallow the first canvas click.
  const catcher = page.locator(".ai-inline-catcher");
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".ai-inline-catcher")?.click();
  });
  await expect(catcher).toHaveCount(0);
}

test("an AI run on a graph locks the labels the graph owns", async ({ page }) => {
  await setup(page);
  await insertGraphWithAxisLabel(page);

  const graphShape = page.locator(".overlay-shape.overlay-shape-graph2dShape").first();
  const labelShape = page.locator(".overlay-shape.overlay-shape-text").first();
  await expect(graphShape).toBeVisible();
  await expect(labelShape).toBeVisible();

  // Baseline: the label is an ordinary draggable shape before AI owns the graph.
  const freeDrag = await dragShape(page, labelShape, 60, 40);
  expect(Math.abs(freeDrag.after.x - freeDrag.before.x)).toBeGreaterThan(20);

  // グラフ本体の Hover には詳細操作を出さない。関数・塗りの操作は設定パネル内に限定する。
  await graphShape.hover();
  await expect(page.getByRole("button", { name: "グラフ操作" })).toHaveCount(0);

  await startShapeRun(page, graphShape, "SLOW このグラフを整えてください");

  // The run's anchor is the graph, and its labels come with it.
  await expect(graphShape).toHaveClass(/ai-edit-locked-shape/);
  await expect(labelShape).toHaveClass(/ai-edit-locked-shape/);
  // Labels share the graph's "AI is working here" veil, but not a second stop
  // button -- the graph carries the one that stops the run.
  await expect(labelShape.locator(".ai-edit-lock-shape-veil")).toHaveCount(1);
  await expect(labelShape.locator(".ai-edit-lock-shape-stop-button")).toHaveCount(0);

  // AI 実行中もキャンバス上に詳細操作は増やさない。
  await graphShape.hover();
  await expect(page.getByRole("button", { name: "グラフ操作" })).toHaveCount(0);

  const lockedDrag = await dragShape(page, labelShape, 80, 50);
  expect(Math.abs(lockedDrag.after.x - lockedDrag.before.x)).toBeLessThan(1);
  expect(Math.abs(lockedDrag.after.y - lockedDrag.before.y)).toBeLessThan(1);
  await expect(page.locator(".overlay-ai-lock-notice")).toBeVisible();

  // An unrelated shape is still the human's: per-target locking, unchanged.
  const unrelatedShape = page.locator('.overlay-shape[data-overlay-shape-id="e2e_shape_1"]').first();
  const unrelatedDrag = await dragShape(page, unrelatedShape, 60, 0);
  expect(Math.abs(unrelatedDrag.after.x - unrelatedDrag.before.x)).toBeGreaterThan(20);
});
