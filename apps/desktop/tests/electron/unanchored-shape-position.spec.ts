import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import type { OverlayShape } from "@/features/document";

const root = path.resolve(__dirname, "../..");
const rect = (id: string, x: number, y: number): OverlayShape => ({
  id, type: "geo", x, y,
  props: { w: 80, h: 50, geo: "rectangle", fill: "solid", color: "black", labelColor: "black", dash: "solid", size: "m" },
});
const shape = (page: Page, id: string) => page.locator(`.page-stack .overlay-shape[data-overlay-shape-id="${id}"]`);
async function positions(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector(".page-canvas")!.getBoundingClientRect();
    return Object.fromEntries(["anchored", "missing", "loose"].map(id => {
      const rect = document.querySelector(`.page-stack .overlay-shape[data-overlay-shape-id="${id}"]`)!.getBoundingClientRect();
      return [id, { x: rect.x - canvas.x, y: rect.y - canvas.y }];
    }));
  });
}

test("missing anchors preserve positions across reading, selection, external updates and reopening", async ({}, testInfo) => {
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-unanchored-position-"));
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
    source.docId = "unanchored_position";
    source.metadata = { title: "アンカー補完と選択の位置" };
    source.content = [{ type: "paragraph", id: "body", children: [{ type: "text", text: "AIの図形にアンカーがなくても、表示と選択で位置を保つ。" }] }];
    const anchor = { type: "block", blockId: "body", dx: 80, dy: 180 } as const;
    source.pageLayout = { ...source.pageLayout!, overlay: { overlaySnapshot: { version: 1, assets: {}, shapes: [
      { id: "group", type: "group", x: 0, y: 0, anchor, props: { w: 390, h: 330 } },
      // Cached x/y deliberately predate body layout. The reading view uses the explicit anchor.
      { ...rect("anchored", 0, 0), parentId: "group", anchor },
      { ...rect("missing", 310, 280), parentId: "group" },
      rect("loose", 170, 400),
    ] } } };
    const fileId = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, source);
    const load = () => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(shape(page, "loose")).toBeVisible();
    await expect.poll(async () => (await load())!.pageLayout!.overlay!.overlaySnapshot!.shapes.find(item => item.id === "loose")!.anchor?.type).toBe("block");
    const body = await page.locator('.page-flow [data-sigma-doc-id="body"]').first().boundingBox();
    const canvas = (await page.locator(".page-canvas").boundingBox())!;
    const before = await positions(page);
    expect(Math.abs(before.anchored.y - (body!.y - canvas.y + 180))).toBeLessThan(0.1);
    expect(before.missing).toEqual({ x: 310, y: 280 });
    expect(before.loose).toEqual({ x: 170, y: 400 });
    const same = async () => {
      const actual = await positions(page);
      for (const id of Object.keys(before)) {
        expect(Math.abs(actual[id].x - before[id].x), `${id}: x`).toBeLessThan(0.1);
        expect(Math.abs(actual[id].y - before[id].y), `${id}: y`).toBeLessThan(0.1);
      }
    };
    await page.keyboard.down("ControlOrMeta");
    await page.mouse.click(canvas.x + 20, canvas.y + 420);
    await page.keyboard.up("ControlOrMeta");
    await expect(page.locator(".overlay-canvas-editor")).toBeVisible();
    await same();
    await shape(page, "missing").dblclick();
    await expect(shape(page, "missing")).toHaveClass(/selected/);
    await same();

    // An external file update reaches the already-mounted editing surface through the real
    // main-process watcher. The body geometry stays unchanged while the snapshot is replaced.
    const current = (await load())!;
    for (const item of current.pageLayout!.overlay!.overlaySnapshot!.shapes) {
      if (item.id === "anchored") { item.x = 0; item.y = 0; }
      if (item.id === "loose") delete item.anchor;
    }
    const documentPath = path.join(profile, "data", "documents", `${fileId}.sigmadoc.json`);
    const replacementPath = `${documentPath}.external`;
    await writeFile(replacementPath, JSON.stringify(current));
    await rename(replacementPath, documentPath);
    await expect.poll(async () => (await load())!.pageLayout!.overlay!.overlaySnapshot!.shapes.find(item => item.id === "loose")!.anchor?.type).toBe("block");
    await same();
    await page.screenshot({ path: testInfo.outputPath("unanchored-member-selected.png") });
    await page.keyboard.press("ControlOrMeta+s");
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(shape(page, "missing")).toBeVisible();
    await same();
    const saved = (await load())!.pageLayout!.overlay!.overlaySnapshot!.shapes;
    expect(saved.find(item => item.id === "anchored")!.anchor).toMatchObject(anchor);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
