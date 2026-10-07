import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");

interface SavedGraph {
  x: number;
  y: number;
  w: number;
  h: number;
  spec: { width: number; viewBox: { xMin: string; xMax: string } };
}

/**
 * 実機でないと再現しない不具合の回帰テスト。ブラウザ e2e のモックは、ドラッグ中に書かれた途中の保存も、
 * 本文のクリックで編集面が外れる順序も、実機と同じには再現しない。
 *
 * 1. 切り取りのドラッグ中に、範囲 (viewBox) だけ切り取り後で幅は元のままの途中経過が文書へ保存された。
 * 2. 確定が `setShapes` の更新関数だけだったので、本文のクリックで編集面が先に外れると確定が消え、
 *    1 の途中経過だけが残って「切り取った範囲が元の横幅まで引き伸ばされた」。
 */
async function launch(): Promise<{ app: ElectronApplication; page: Page; cleanup: () => void }> {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-graph-crop-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${profile}`], cwd: APP_ROOT, env });
  const page = await app.firstWindow();
  if (env.SIGMA_STUDIO_DEV_SERVER_URL) {
    await expect.poll(() => new URL(page.url()).origin).toBe(new URL(env.SIGMA_STUDIO_DEV_SERVER_URL).origin);
  }
  await page.waitForFunction(() => Boolean(window.desktopAPI));
  await page.evaluate(async () => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    await window.desktopAPI!.settings!.setUiLocale!("ja");
  });
  await page.reload();
  await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();
  return {
    app,
    page,
    cleanup: () => rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

async function insertGraph(page: Page) {
  await page.getByRole("button", { name: "挿入", exact: true }).click();
  await page.getByRole("menu", { name: "挿入", exact: true }).getByRole("menuitem", { name: "グラフ" }).click();
  const surface = (await page.locator(".overlay-canvas-editor.inserting").first().boundingBox())!;
  await page.mouse.move(surface.x + 200, surface.y + 120);
  await page.mouse.down();
  await page.mouse.move(surface.x + 600, surface.y + 340, { steps: 8 });
  await page.mouse.up();
  const graph = page.locator(".graph-shape").first();
  await expect(graph).toBeVisible();
  // 挿入が文書へ保存されるまで待つ (読み出しのたびに保存待ちを流している)。
  await expect.poll(() => readSaved(page)).not.toBeNull();
  return graph;
}

async function readSaved(page: Page): Promise<SavedGraph | null> {
  return page.evaluate(async () => {
    window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes"));
    await new Promise((resolve) => setTimeout(resolve, 450));
    const [file] = await window.desktopAPI!.storage.listFiles();
    const doc = await window.desktopAPI!.storage.loadDocument(file.fileId);
    const graph = doc?.pageLayout?.overlay?.overlaySnapshot?.shapes.find((shape) => shape.type === "graph2dShape");
    return graph?.type === "graph2dShape"
      ? { x: graph.x, y: graph.y, w: graph.props.w, h: graph.props.h, spec: graph.props.spec as SavedGraph["spec"] }
      : null;
  });
}

async function enterCrop(page: Page) {
  const graph = page.locator(".graph-shape").first();
  const box = (await graph.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".graph2d-container.cropping")).toHaveCount(1);
  return box;
}

async function dragHandle(page: Page, handle: "l" | "r" | "t" | "b", dx: number, dy: number, alt = false) {
  const order = ["tl", "tr", "bl", "br", "t", "b", "l", "r"];
  const grip = (await page.locator(".graph2d-container.cropping circle[fill='transparent']").nth(order.indexOf(handle)).boundingBox())!;
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
}

/** ページ本文の空白を押す: 切り取りを確定し、編集面ごと外れる経路。 */
async function finishByClickingPage(page: Page, box: { x: number; y: number; height: number }) {
  await page.mouse.click(box.x - 60, box.y + box.height + 260);
  await expect(page.locator(".graph2d-container.cropping")).toHaveCount(0);
}

test.describe("graph crop in the desktop app", () => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!process.env.SIGMA_STUDIO_DEV_SERVER_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");

  test("a dragged crop ends at the cropped width, is never saved half-done, and survives reload", async () => {
    const { app, page, cleanup } = await launch();
    try {
      await insertGraph(page);
      const box = await enterCrop(page);
      // 選択したときに縦横の単位長が 1:1 へ補正されるので、基準は切り取りに入ったあとで取る。
      const before = (await readSaved(page))!;

      await dragHandle(page, "r", -150, 0);
      // ドラッグ中は文書に何も書かない。
      const during = (await readSaved(page))!;
      expect(during.w).toBeCloseTo(before.w, 1);
      expect(during.spec.viewBox).toEqual(before.spec.viewBox);

      await finishByClickingPage(page, box);
      await expect.poll(async () => (await readSaved(page))?.w ?? before.w).toBeCloseTo(before.w - 150, 0);
      const after = (await readSaved(page))!;
      expect(after.spec.width).toBeCloseTo(after.w + 64, 1);
      expect(after.x).toBeCloseTo(before.x, 1);
      expect(Number(after.spec.viewBox.xMax)).toBeLessThan(Number(before.spec.viewBox.xMax));
      const drawn = (await page.locator(".graph-shape .graph2d-svg").first().boundingBox())!;
      expect(drawn.width).toBeCloseTo(after.spec.width, 0);

      await page.reload();
      await expect(page.locator(".graph-shape .graph2d-svg").first()).toBeVisible();
      const reloaded = (await page.locator(".graph-shape .graph2d-svg").first().boundingBox())!;
      expect(reloaded.width).toBeCloseTo(after.spec.width, 0);
    } finally {
      await app.close();
      cleanup();
    }
  });

  test("holding Alt while dragging a handle widens the drawing range and grows the graph", async () => {
    const { app, page, cleanup } = await launch();
    try {
      await insertGraph(page);
      const box = await enterCrop(page);
      const before = (await readSaved(page))!;

      await dragHandle(page, "r", 120, 0, true);
      await dragHandle(page, "l", -60, 0, true);
      await expect(page.getByTestId("graph2d-crop-expansion")).toHaveCount(1);
      // 広げた枠は元の図形の外へはみ出す。図形の切り抜きに隠されない。
      const hint = page.locator(".graph2d-crop-hint");
      await expect(hint).toBeVisible();
      const outside = await page.evaluate(() => {
        const shape = document.querySelector(".graph-shape");
        return shape ? getComputedStyle(shape).overflow : null;
      });
      expect(outside).toBe("visible");

      await finishByClickingPage(page, box);
      await expect.poll(async () => (await readSaved(page))?.w ?? before.w).toBeCloseTo(before.w + 180, 0);
      const after = (await readSaved(page))!;
      expect(after.x).toBeCloseTo(before.x - 60, 0);
      expect(after.h).toBeCloseTo(before.h, 0);
      const perPx = (Number(before.spec.viewBox.xMax) - Number(before.spec.viewBox.xMin)) / before.w;
      expect(Number(after.spec.viewBox.xMin)).toBeCloseTo(Number(before.spec.viewBox.xMin) - 60 * perPx, 3);
      expect(Number(after.spec.viewBox.xMax)).toBeCloseTo(Number(before.spec.viewBox.xMax) + 120 * perPx, 3);

      await page.reload();
      await expect(page.locator(".graph-shape .graph2d-svg").first()).toBeVisible();
      const reloaded = (await page.locator(".graph-shape .graph2d-svg").first().boundingBox())!;
      expect(reloaded.width).toBeCloseTo(after.spec.width, 0);
    } finally {
      await app.close();
      cleanup();
    }
  });
});
