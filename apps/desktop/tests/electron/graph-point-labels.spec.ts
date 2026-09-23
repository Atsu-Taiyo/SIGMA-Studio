import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SelectedOverlayGraph } from "@/components/editor/EditorSettings";
import { _electron as electron, expect, test } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");

test("point names synchronize in both directions and survive reload", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!process.env.SIGMA_STUDIO_DEV_SERVER_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-point-label-"));
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
    await page.keyboard.press("Escape");
    const box = (await graph.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.48, { button: "right" });
    await page.locator(".overlay-shape-context-menu").getByRole("menuitem", { name: "グラフの設定…" }).click();
    const panel = page.getByRole("dialog", { name: "グラフの設定" });
    await panel.getByRole("button", { name: "点を追加", exact: true }).click();
    const readLabels = () => page.evaluate(async () => {
      const [file] = await window.desktopAPI!.storage.listFiles();
      const doc = await window.desktopAPI!.storage.loadDocument(file.fileId);
      return JSON.stringify(doc?.pageLayout?.overlay?.overlaySnapshot);
    });
    const name = page.getByTestId("overlay-graph-point-label");
    const inputGeometry = () => panel.locator(".math-expression-input").last().evaluate((shell) => {
      const rect = (element: Element | null) => element?.getBoundingClientRect().toJSON();
      const field = shell.querySelector("math-field");
      return { shell: rect(shell), preview: rect(shell.querySelector(".ML__latex")), field: rect(field), content: rect(field?.shadowRoot?.querySelector('[part="content"]') ?? null) };
    });
    const previewGeometry = await inputGeometry();
    await page.screenshot({ path: testInfo.outputPath("name-preview.png"), clip: previewGeometry.shell });
    await name.click();
    const editGeometry = await inputGeometry();
    expect(editGeometry.shell!.height).toBe(previewGeometry.shell!.height);
    expect(editGeometry.content!.x).toBeCloseTo(previewGeometry.preview!.x, 1);
    expect(editGeometry.content!.y).toBeCloseTo(previewGeometry.preview!.y, 1);
    expect(editGeometry.content!.height).toBeCloseTo(previewGeometry.preview!.height, 1);
    await page.screenshot({ path: testInfo.outputPath("name-editing.png"), clip: editGeometry.shell });
    const field = panel.locator("math-field");
    await field.evaluate((element) => {
      (element as HTMLElement & { value: string }).value = "Q";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await field.press("Enter");
    // Clearing a name must leave a clickable control.
    await name.click();
    await field.evaluate((element) => {
      (element as HTMLElement & { value: string }).value = "";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await field.press("Enter");
    await expect(name).toBeVisible();
    expect((await name.boundingBox())!.height).toBeGreaterThanOrEqual(20);
    await expect.poll(readLabels).not.toContain('"Q"');
    await name.click();
    await field.pressSequentially("Q");
    await field.press("Enter");
    const label = page.locator(".overlay-shape-text").filter({ has: page.locator('[data-tex="Q"]') });
    await expect(label).toHaveCount(1);
    await expect.poll(readLabels).toContain('"Q"');
    await page.screenshot({ path: testInfo.outputPath("point-label.png") });
    await page.reload();
    await expect(label).toHaveCount(1);
    const labelId = await label.getAttribute("data-overlay-shape-id");
    await expect(page.locator(".startup-splash")).toBeHidden();
    await page.bringToFront();
    // The text shape can retain a wider layout box than its rendered glyph.
    // Click the visible math label, as a user does, after fonts settle.
    await page.evaluate(() => document.fonts.ready);
    const labelBox = (await label.locator('[data-tex="Q"]').boundingBox())!;
    await page.mouse.click(labelBox.x + labelBox.width / 2, labelBox.y + labelBox.height / 2);
    await expect(page.locator(".overlay-selection-box")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("small-text-handles.png") });
    await page.mouse.dblclick(labelBox.x + labelBox.width / 2, labelBox.y + labelBox.height / 2);
    const editor = page.locator(`[data-overlay-shape-id="${labelId}"] .overlay-text-shape-content`);
    await expect(editor).toBeFocused();
    await page.keyboard.press("Meta+A");
    await page.keyboard.type("R");
    await page.keyboard.press("Escape");
    await expect.poll(readLabels).toContain('"R"');
    await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.48, { button: "right" });
    await page.locator(".overlay-shape-context-menu").getByRole("menuitem", { name: "グラフの設定…" }).click();
    await expect(name).toContainText("R");
    await page.screenshot({ path: testInfo.outputPath("point-label-reverse.png") });
    await page.evaluate(() => {
      window.addEventListener("sigma-studio:select-overlay-graph", (event) => {
        const detail = (event as CustomEvent<SelectedOverlayGraph | null>).detail;
        if (detail) (window as Window & { graphTestDetail?: SelectedOverlayGraph }).graphTestDetail = detail;
      });
    });
    await panel.getByRole("button", { name: "点を追加", exact: true }).click();
    await page.evaluate(() => {
      const detail = (window as Window & { graphTestDetail?: SelectedOverlayGraph }).graphTestDetail!;
      detail.onSpecChange({ ...detail.spec,
        viewBox: { xMin: "-2", xMax: "2", yMin: "-2", yMax: "2" },
        graphViewBox: undefined,
        curves: [{ id: "circle", mode: "implicit", expr: "x^2+y^2-1", color: "#0d0d0d" }],
        fills: [{ id: "inside", x: "0.3", y: "0.3", color: "#d1d5db", opacity: 0.5 }],
      });
    });
    const fill = page.getByTestId("graph2d-fill-region");
    await expect(fill).toHaveCount(1);
    await expect.poll(() => fill.getAttribute("d")).toMatch(/^M/);
    await page.screenshot({ path: testInfo.outputPath("implicit-fill.png") });
    await expect.poll(readLabels).toContain('"inside"');
    await page.reload();
    await expect(fill).toHaveCount(1);


  } catch (error) {
    await app.windows()[0]?.screenshot({ path: testInfo.outputPath("failure.png") });
    throw error;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
    expect(existsSync(profile)).toBe(false);
  }
});
