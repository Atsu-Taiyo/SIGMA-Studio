import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { normalizePageLayout } from "@/features/document";
import { createBlankDocument } from "@/lib/blank-document";
import { grabShapeFromBody } from "../e2e/body-overlay-entry";

const APP_ROOT = path.resolve(__dirname, "../..");

test("page separator overrides and text-box decoration survive saving and reopening Electron", async ({}, testInfo) => {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-page-separators-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const launch = () => electron.launch({ args: [APP_ROOT, `--user-data-dir=${profile}`], cwd: APP_ROOT, env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    });
    const source = createBlankDocument("段間の線とテキスト枠");
    source.content = [0, 1, 2, 3].map(index => ({
      type: "paragraph", id: `body-${index}`, pagination: { break: index > 0 },
      children: [{ type: "text", text: `${index + 1}段目の本文。` }],
    }));
    source.pageLayout = normalizePageLayout({ preset: "B4", orientation: "landscape", flow: {
      columnCount: 2, columnRule: { style: "solid", widthPx: 1, color: "#111111" },
    }, overlay: { overlaySnapshot: { version: 1, assets: {}, shapes: [{
      id: "decorated-text", type: "text", x: 180, y: 240, props: {
        w: 220, h: 28, color: "#111111", size: "m",
        blocks: [{ type: "paragraph", id: "text-body", children: [{ type: "text", text: "図中のテキスト" }] }],
      },
    }] } } });
    const created = await page.evaluate(document => window.desktopAPI!.storage.createFileFromDocument({ document }), source);
    const fileId = created.file.fileId;
    await page.reload();
    await page.setViewportSize({ width: 1500, height: 1000 });
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();

    await page.getByRole("button", { name: "設定", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "ページ設定", exact: true }).click();
    const setup = page.getByRole("dialog", { name: "ページ設定", exact: true });
    await expect(setup.getByTestId("page-setup-preview")).toHaveAttribute("viewBox", "0 0 364 257");
    await expect(setup.locator(".column-rule-preview")).toHaveCount(0);
    await setup.getByRole("button", { name: /^線種/ }).click();
    await page.getByRole("menuitemradio", { name: "二重線", exact: true }).click();
    await expect(setup.getByTestId("page-setup-column-rule").locator("line")).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath("page-settings.png") });
    await setup.getByRole("button", { name: "適用", exact: true }).click();

    const boundary = (await page.locator(".page-backdrop .page-column-rules > span").first().boundingBox())!;
    await page.mouse.click(boundary.x + boundary.width / 2, boundary.y + boundary.height / 2, { button: "right" });
    const separators = page.getByRole("dialog", { name: "段間の線", exact: true });
    await expect(separators).toContainText("1ページ目に適用");
    await separators.getByRole("button", { name: /^線種/ }).click();
    await page.getByRole("menuitemradio", { name: "点線", exact: true }).click();
    await separators.getByRole("button", { name: "閉じる", exact: true }).click();
    const saved = () => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
    await expect.poll(async () => (await saved())?.pageLayout?.flow.pageColumnRules)
      .toEqual([{ page: 1, rule: { style: "dotted", widthPx: 3, color: "#111111" } }]);
    const rules = page.locator(".page-backdrop .page-column-rules > span");
    await expect(rules.first()).toHaveCSS("border-left-style", "dotted");
    await expect(rules.nth(1)).toHaveCSS("border-left-style", "double");

    await grabShapeFromBody(page, page.locator('[data-overlay-shape-id="decorated-text"]').first());
    await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
    const toolbar = page.locator(".editor-menubar");
    await toolbar.getByRole("button", { name: "内部塗りつぶし", exact: true }).click();
    await page.locator(".color-popover").getByTitle("#d0d0d0", { exact: true }).first().click();
    await toolbar.getByRole("button", { name: "枠線", exact: true }).click();
    await page.locator(".color-popover").getByTitle("#3b6ef7", { exact: true }).first().click();
    const expected = { color: "#111111", size: "m", fill: "solid", fillColor: "#d0d0d0", strokeColor: "#3b6ef7", dash: "solid" };
    await expect.poll(async () => (await saved())?.pageLayout?.overlay?.overlaySnapshot?.shapes[0]?.props).toMatchObject(expected);
    await page.screenshot({ path: testInfo.outputPath("text-box.png") });

    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator('.page-backdrop .page-column-rules > span').first()).toHaveCSS("border-left-style", "dotted");
    const frame = page.locator('[data-overlay-shape-id="decorated-text"] .overlay-text-box-decoration rect').first();
    await expect(frame).toHaveAttribute("fill", "#d0d0d0");
    await expect(frame).toHaveAttribute("stroke", "#3b6ef7");
    expect((await saved())?.pageLayout?.overlay?.overlaySnapshot?.shapes[0]?.props).toMatchObject(expected);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
