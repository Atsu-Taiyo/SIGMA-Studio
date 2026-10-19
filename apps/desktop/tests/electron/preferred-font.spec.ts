import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { grabShapeFromBody } from "../e2e/body-overlay-entry";
import { createBlankDocument } from "@/lib/blank-document";
import { DEFAULT_SERIF_BODY_FONT_FAMILY } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;

test("the last chosen font seeds empty body and shape text and survives an Electron restart", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-preferred-font-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const launch = () => electron.launch({ args: [APP_ROOT, `--user-data-dir=${profile}`], cwd: APP_ROOT, env });
  let app = await launch();
  const body = (page: Page) => page.locator(".page-flow .ProseMirror").first();
  const fontButton = (page: Page) => page.locator('button[aria-label^="フォント:"]').first();
  const chooseFont = async (page: Page, name: string) => {
    await fontButton(page).click();
    await page.getByRole("menu", { name: "フォント", exact: true }).getByRole("menuitemradio", { name, exact: true }).click();
  };
  const createBlank = async (page: Page, title: string) => {
    const document = createBlankDocument(title);
    const result = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), document);
    await page.reload();
    await expect(body(page)).toBeVisible();
    await body(page).click();
    return result.file.fileId;
  };
  try {
    let page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await expect(body(page)).toBeVisible();
    await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
    });
    await page.reload();
    await expect(body(page)).toBeVisible();
    await body(page).click();
    await chooseFont(page, "Noto Serif JP");
    await expect.poll(() => page.evaluate(() => window.desktopAPI!.app.getEditorPreferences!())).toMatchObject({ fontFamily: DEFAULT_SERIF_BODY_FONT_FAMILY });
    const fileId = await createBlank(page, "直前のフォント");
    await expect(fontButton(page)).toHaveAttribute("aria-label", "フォント: Noto Serif JP");
    await page.keyboard.insertText("引き継いだ本文");
    await expect(body(page).locator("span[style*='font-family']")).toHaveCSS("font-family", DEFAULT_SERIF_BODY_FONT_FAMILY);
    await expect.poll(() => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId)).toMatchObject({ content: [{ children: [{ text: "引き継いだ本文", fontFamily: DEFAULT_SERIF_BODY_FONT_FAMILY }] }] });
    await page.screenshot({ path: testInfo.outputPath("preferred-font-body.png") });

    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(body(page)).toBeVisible();
    await expect(body(page)).toContainText("引き継いだ本文");
    await createBlank(page, "再起動後の空欄");
    await expect(fontButton(page)).toHaveAttribute("aria-label", "フォント: Noto Serif JP");
    await page.keyboard.insertText("再起動後も明朝");

    // Seed an independent shape editor through the same host preference.
    const document = createBlankDocument("図中テキスト");
    document.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [{
      id: "preferred_shape", type: "text", x: 100, y: 220, rotation: 0,
      props: { w: 240, h: 40, color: "#111111", size: "m", blocks: [{ type: "paragraph", id: "shape_empty", children: [] }] },
    }] } };
    const shapeFile = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), document);
    await page.reload();
    const shape = page.locator('.overlay-shape-text[data-overlay-shape-id="preferred_shape"]');
    await expect(shape).toBeVisible();
    await grabShapeFromBody(page, shape);
    await shape.click();
    const shapeEditor = shape.locator(".ProseMirror");
    await expect(shapeEditor).toBeVisible();
    await shapeEditor.focus();
    await page.keyboard.insertText("図中も明朝");
    await expect(shapeEditor.locator("span[style*='font-family']")).toHaveCSS("font-family", DEFAULT_SERIF_BODY_FONT_FAMILY);
    await page.screenshot({ path: testInfo.outputPath("preferred-font-shape.png") });
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), shapeFile.file.fileId)).toMatchObject({ pageLayout: { overlay: { overlaySnapshot: { shapes: [{ props: { blocks: [{ children: [{ text: "図中も明朝", fontFamily: DEFAULT_SERIF_BODY_FONT_FAMILY }] }] } }] } } } });

    await createBlank(page, "標準フォントの選択");
    await chooseFont(page, "M PLUS 1p");
    const standardId = await createBlank(page, "標準へ戻す");
    await expect(fontButton(page)).toHaveAttribute("aria-label", "フォント: M PLUS 1p");
    await page.keyboard.insertText("標準の本文");
    await expect.poll(() => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), standardId)).toMatchObject({ content: [{ children: [{ text: "標準の本文" }] }] });
    await expect(body(page).locator("span[style*='Noto Serif JP']")).toHaveCount(0);
    await expect.poll(() => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId)).toMatchObject({ content: [{ children: [{ text: "引き継いだ本文", fontFamily: DEFAULT_SERIF_BODY_FONT_FAMILY }] }] });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
