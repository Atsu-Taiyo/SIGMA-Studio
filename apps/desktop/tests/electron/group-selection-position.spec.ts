import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import type { OverlayShape } from "@/features/document";

const root = path.resolve(__dirname, "../..");
const ids = ["a", "b", "nearby"];
const rect = (id: string, x: number, y: number): OverlayShape => ({
  id, type: "geo", x, y, anchor: { type: "page" },
  props: { w: 90, h: 55, geo: "rectangle", fill: "solid", color: "black", labelColor: "black", dash: "solid", size: "m" },
});
const shape = (page: Page, id: string) => page.locator(`.page-stack .overlay-shape[data-overlay-shape-id="${id}"]`);
async function positions(page: Page) {
  return page.evaluate((trackedIds) => {
    const canvas = document.querySelector(".page-canvas")!.getBoundingClientRect();
    return Object.fromEntries(trackedIds.map(id => {
      const bounds = document.querySelector(`.page-stack .overlay-shape[data-overlay-shape-id="${id}"]`)!.getBoundingClientRect();
      return [id, { x: bounds.x - canvas.x, y: bounds.y - canvas.y }];
    }));
  }, ids);
}

// The 6px gap in x is within the 8px snapping range. A click with a 1px wobble used to move
// the selected member (and sometimes the entire group) to that alignment and persist it.
test("grouping and selecting members preserve display and saved positions near snap targets", async ({}, testInfo) => {
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-group-selection-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [root, `--user-data-dir=${profile}`], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await (await app.browserWindow(page)).evaluate(win => win.setContentSize(1400, 900));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const source = structuredClone(sampleDocument);
    source.docId = "group_selection_position";
    source.metadata = { title: "グループ選択の座標" };
    source.content = [{ type: "paragraph", id: "p", children: [{ type: "text", text: "グループ内の図形を選択しても位置を保つ。" }] }];
    source.pageLayout = { ...source.pageLayout!, overlay: { overlaySnapshot: { version: 1, assets: {}, shapes: [rect("a", 160, 180), rect("b", 310, 280), rect("nearby", 166, 400)] } } };
    const fileId = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, source);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(shape(page, "a")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const before = await positions(page);
    const assertPositions = async () => {
      const actual = await positions(page);
      for (const id of ids) {
        expect(Math.abs(actual[id].x - before[id].x), `${id}: x`).toBeLessThan(0.1);
        expect(Math.abs(actual[id].y - before[id].y), `${id}: y`).toBeLessThan(0.1);
      }
    };
    const canvas = (await page.locator(".page-canvas").boundingBox())!;
    await page.keyboard.down("ControlOrMeta");
    await page.mouse.click(canvas.x + 20, canvas.y + 420);
    await page.keyboard.up("ControlOrMeta");
    await page.screenshot({ path: testInfo.outputPath("before-group.png") });
    await expect(page.locator(".overlay-canvas-editor")).toBeVisible();
    await shape(page, "a").click();
    await shape(page, "b").click({ modifiers: ["Shift"] });
    await expect(page.locator(".overlay-shape.selected")).toHaveCount(2);
    await page.keyboard.press("ControlOrMeta+g");
    const loadShapes = async () => (await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId))!.pageLayout!.overlay!.overlaySnapshot!.shapes;
    await expect.poll(async () => (await loadShapes()).filter(item => item.type === "group").length).toBe(1);
    const grouped = await loadShapes();
    await assertPositions();

    const jitterClick = async () => {
      const box = (await shape(page, "a").boundingBox())!;
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x + 1, point.y + 1);
      // Check the live preview before releasing as well as the resulting document.
      await assertPositions();
      await page.mouse.up();
      await assertPositions();
    };
    await jitterClick(); // outer group selection
    await shape(page, "a").dblclick(); // focus group and select the member
    await expect(shape(page, "a")).toHaveClass(/selected/);
    for (let repeat = 0; repeat < 3; repeat += 1) await jitterClick();
    await page.screenshot({ path: testInfo.outputPath("group-member-selected.png") });
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(loadShapes).toEqual(grouped);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(shape(page, "a")).toBeVisible();
    await assertPositions();
    expect(await loadShapes()).toEqual(grouped);

    // A deliberate drag still moves and persists the member, then survives reopening.
    await page.keyboard.down("ControlOrMeta");
    await page.mouse.click(canvas.x + 20, canvas.y + 420);
    await page.keyboard.up("ControlOrMeta");
    await shape(page, "a").dblclick();
    await expect(shape(page, "a")).toHaveClass(/selected/);
    const box = (await shape(page, "a").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2 + 15, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await loadShapes()).find(item => item.id === "a")!.x).not.toBe(160);
    const moved = await positions(page);
    expect(moved.a.x - before.a.x).toBeGreaterThan(15);
    expect(moved.b).toEqual(before.b);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(shape(page, "a")).toBeVisible();
    const reopened = await positions(page);
    expect(Math.abs(reopened.a.x - moved.a.x)).toBeLessThan(0.1);
    expect(Math.abs(reopened.a.y - moved.a.y)).toBeLessThan(0.1);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
