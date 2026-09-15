import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");

test("initial graph origin follows the click and survives reload", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!process.env.SIGMA_STUDIO_DEV_SERVER_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-graph-origin-"));
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
    const surface = await page.locator(".overlay-canvas-editor.inserting").first().boundingBox();
    expect(surface).not.toBeNull();
    await page.mouse.move(surface!.x + 120, surface!.y + 120);
    await page.mouse.down();
    await page.mouse.move(surface!.x + 420, surface!.y + 320, { steps: 8 });
    await page.mouse.up();
    const graph = page.locator(".graph-shape").first();
    await expect(graph).toBeVisible();
    const box = (await page.locator(".overlay-shape").filter({ has: graph }).boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.75);
    await expect(page.getByTestId("overlay-graph-origin-preview")).toBeVisible();
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.75);
    const readSpec = () => page.evaluate(async () => {
      const [file] = await window.desktopAPI!.storage.listFiles();
      const doc = await window.desktopAPI!.storage.loadDocument(file.fileId);
      const graph = doc?.pageLayout?.overlay?.overlaySnapshot?.shapes.find(s => s.type === "graph2dShape");
      return graph?.type === "graph2dShape" ? graph.props.spec : null;
    });
    await expect.poll(async () => {
      const spec = await readSpec();
      if (!spec) return null;
      const v = spec.viewBox;
      return -Number(v.xMin) / (Number(v.xMax) - Number(v.xMin));
    }).toBeCloseTo(0.25, 2);
    const saved = await readSpec();
    const v = saved!.viewBox;
    expect(Number(v.yMax) / (Number(v.yMax) - Number(v.yMin))).toBeCloseTo(0.75, 2);
    await page.reload();
    await expect(graph.locator(".graph2d-axes line")).toHaveCount(2);
    expect(await readSpec()).toEqual(saved);
    await page.screenshot({ path: testInfo.outputPath("graph-origin.png") });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
    expect(existsSync(profile)).toBe(false);
  }
});
