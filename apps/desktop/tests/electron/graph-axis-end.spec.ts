import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");

async function readSavedAxisEnds(page: Page) {
  return page.evaluate(async () => {
    window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes"));
    await new Promise((resolve) => setTimeout(resolve, 450));
    const [file] = await window.desktopAPI!.storage.listFiles();
    const doc = await window.desktopAPI!.storage.loadDocument(file.fileId);
    const graph = doc?.pageLayout?.overlay?.overlaySnapshot?.shapes.find((shape) => shape.type === "graph2dShape");
    if (graph?.type !== "graph2dShape") return null;
    return {
      x: graph.props.spec.axes.xAxisEndStyle ?? "(unset)",
      y: graph.props.spec.axes.yAxisEndStyle ?? "(unset)",
    };
  });
}

/** What the page draws at the end of each axis: the end's name, or null when the axis has none. */
async function drawnAxisEnds(graph: Locator) {
  return graph.evaluate((element) => {
    const lines = Array.from(element.querySelectorAll(".graph2d-axes line"));
    const endOf = (line: Element | undefined) => {
      const reference = line?.getAttribute("marker-end")?.match(/^url\(#(.+)\)$/)?.[1];
      const marker = reference ? element.querySelector(`marker[id="${CSS.escape(reference)}"]`) : null;
      return marker?.getAttribute("data-axis-end") ?? null;
    };
    return {
      x: endOf(lines.find((line) => line.getAttribute("y1") === line.getAttribute("y2"))),
      y: endOf(lines.find((line) => line.getAttribute("x1") === line.getAttribute("x2"))),
      axes: lines.length,
    };
  });
}

test("the end picked for each axis in the graph settings is drawn on that axis and survives reload", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!process.env.SIGMA_STUDIO_DEV_SERVER_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-graph-axis-end-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${profile}`], cwd: APP_ROOT, env });
  try {
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

    await page.getByRole("button", { name: "挿入", exact: true }).click();
    await page.getByRole("menu", { name: "挿入", exact: true }).getByRole("menuitem", { name: "グラフ" }).click();
    const surface = (await page.locator(".overlay-canvas-editor.inserting").first().boundingBox())!;
    await page.mouse.move(surface.x + 200, surface.y + 120);
    await page.mouse.down();
    await page.mouse.move(surface.x + 600, surface.y + 400, { steps: 8 });
    await page.mouse.up();
    const graph = page.locator(".graph-shape").first();
    await expect(graph).toBeVisible();
    // 挿入した直後の最初のクリックは原点の指定になる。
    const box = (await graph.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".overlay-canvas-editor.origin-picking")).toHaveCount(0);
    await expect.poll(() => readSavedAxisEnds(page)).toEqual({ x: "(unset)", y: "(unset)" });
    // A graph that never chose an end draws the default arrow on both axes.
    expect(await drawnAxisEnds(graph)).toEqual({ x: "arrow", y: "arrow", axes: 2 });

    await page.getByRole("button", { name: "グラフの設定", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "グラフの設定", exact: true });
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "表示範囲", exact: true }).click();
    const xPicker = panel.getByRole("button", { name: "x軸の先端（現在: 矢印）" });
    await xPicker.scrollIntoViewIfNeeded();
    await xPicker.click();
    await page.getByRole("menu", { name: "x軸の先端" }).getByRole("menuitemradio", { name: "矢印（開）", exact: true }).click();

    await expect.poll(() => readSavedAxisEnds(page)).toEqual({ x: "openArrow", y: "(unset)" });
    await expect.poll(() => drawnAxisEnds(graph)).toEqual({ x: "openArrow", y: "arrow", axes: 2 });
    await expect(panel.getByRole("button", { name: "x軸の先端（現在: 矢印（開））" })).toBeVisible();

    await panel.getByRole("button", { name: "y軸の先端（現在: 矢印）" }).click();
    await page.getByRole("menu", { name: "y軸の先端" }).getByRole("menuitemradio", { name: "なし", exact: true }).click();
    await expect.poll(() => readSavedAxisEnds(page)).toEqual({ x: "openArrow", y: "none" });
    await expect.poll(() => drawnAxisEnds(graph)).toEqual({ x: "openArrow", y: null, axes: 2 });

    await panel.getByRole("button", { name: "y軸の先端（現在: なし）" }).click();
    await page.getByRole("menu", { name: "y軸の先端" }).getByRole("menuitemradio", { name: "ひし形（小）", exact: true }).click();
    await expect.poll(() => readSavedAxisEnds(page)).toEqual({ x: "openArrow", y: "diamondSmall" });

    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const reloaded = page.locator(".graph-shape").first();
    await expect(reloaded.locator(".graph2d-axes line")).toHaveCount(2);
    expect(await readSavedAxisEnds(page)).toEqual({ x: "openArrow", y: "diamondSmall" });
    expect(await drawnAxisEnds(reloaded)).toEqual({ x: "openArrow", y: "diamondSmall", axes: 2 });
    await page.screenshot({ path: testInfo.outputPath("graph-axis-end.png") });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    expect(existsSync(profile)).toBe(false);
  }
});
