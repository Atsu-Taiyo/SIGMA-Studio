import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { SigmaDocument } from "@/features/document";
import { exerciseFormulaLabels, expectFormulaOnCanvas, savedFormula } from "../helpers/graph-formula-labels";

const APP_ROOT = path.resolve(__dirname, "../..");
const DEV_URL = process.env.SIGMA_STUDIO_DEV_SERVER_URL;
const PREPARED = existsSync(path.join(APP_ROOT, "dist-electron/main.cjs"))
  && (Boolean(DEV_URL) || existsSync(path.join(APP_ROOT, "out/index.html")));

test("persists graph display labels through real Electron save and restart", async ({}, testInfo) => {
  test.skip(!PREPARED, "Run electron:build and provide SIGMA_STUDIO_DEV_SERVER_URL, or prepare the static renderer.");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-graph-labels-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  const launch = async () => {
    app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${profile}`, "--lang=ja"], cwd: APP_ROOT, env });
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.waitForLoadState("domcontentloaded");
    if (DEV_URL) expect(new URL(page.url()).origin).toBe(new URL(DEV_URL).origin);
    await expect.poll(() => page.evaluate(() => Boolean(window.desktopAPI?.storage))).toBe(true);
    return page;
  };

  try {
    const page = await launch();
    await expect(page.getByText("準備完了", { exact: true })).toBeVisible();
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
    const readDocument = () => page.evaluate(async () => {
      const storage = window.desktopAPI!.storage!;
      const [file] = await storage.listFiles();
      return file ? storage.loadDocument(file.fileId) : null;
    });
    const curvePath = await exerciseFormulaLabels(page, readDocument);
    const [metadata] = await page.evaluate(() => window.desktopAPI!.storage!.listFiles());
    expect(metadata.documentPath).toBeTruthy();
    const documentPath = path.resolve(profile, "data", metadata.documentPath!);
    expect(path.relative(profile, documentPath).startsWith("..")).toBe(false);
    const diskDocument = JSON.parse(readFileSync(documentPath, "utf8")) as SigmaDocument;
    expect(savedFormula(diskDocument)).toMatchObject({
      curve: { expr: "s*x", exprTex: "sx" }, parameters: [{ name: "s", value: 0.5 }], tex: "y = sx",
    });
    await testInfo.attach("saved-sigmadoc", { body: JSON.stringify(diskDocument, null, 2), contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath("graph-label-before-restart.png") });
    await app!.close();
    app = undefined;
    const restored = await launch();
    await expectFormulaOnCanvas(restored, "y = sx");
    await expect(restored.getByTestId("graph2d-curve").first()).toHaveAttribute("d", curvePath);
    const restoredDocument = await restored.evaluate((fileId) => window.desktopAPI!.storage!.loadDocument(fileId), metadata.fileId);
    expect(savedFormula(restoredDocument)).toEqual(savedFormula(diskDocument));
    await restored.screenshot({ path: testInfo.outputPath("graph-label-after-restart.png") });
    await testInfo.attach("renderer-diagnostics", { body: JSON.stringify(errors, null, 2), contentType: "application/json" });
    // Chromium can defer resize notifications during layout; retain them in diagnostics.
    expect(errors.filter((message) => message !== "ResizeObserver loop completed with undelivered notifications.")).toEqual([]);
  } catch (error) {
    await app?.windows()[0]?.screenshot({ path: testInfo.outputPath("graph-label-failure.png") });
    throw error;
  } finally {
    await app?.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    expect(existsSync(profile)).toBe(false);
  }
});
