import { createCanvas, loadImage } from "@napi-rs/canvas";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { BUILTIN_BOX_STYLES, createBoxBlock } from "@/lib/box-blocks";
import type { SigmaDocument } from "@/features/document";
import { waitForPagedSurfaceSettled } from "../e2e/paged-surface";

const APP_ROOT = path.resolve(__dirname, "../..");
const DEV_URL = process.env.SIGMA_STUDIO_DEV_SERVER_URL;

test("box design catalogue in the desktop editor", async ({}, testInfo) => {
  test.setTimeout(180_000);
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!DEV_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-box-design-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    if (DEV_URL) expect(new URL(page.url()).origin).toBe(new URL(DEV_URL).origin);
    const content = BUILTIN_BOX_STYLES.flatMap((style) => ["default", "small", "round", "max"].map((variant) => {
      const id = `${style.id}-${variant}`;
      const box = createBoxBlock(style.id, `${style.id}｜見出し`, {
        id, bodyId: `${id}-body`, bodyText: "本文と枠の余白・四隅・タイトルを確認します。",
      });
      if (variant !== "default") box.frame = {
        ...box.frame, cornerStyle: "round", radiusPx: variant === "small" ? 4 : variant === "max" ? 32 : 24,
        backgroundColor: "#e2e8f0", titlePosition: variant === "small" ? "c" : variant === "max" ? "r" : "l",
        ...(variant === "max" ? { borderWidthPx: 5 } : {}),
      };
      return box;
    }));
    const nested = createBoxBlock("bandbox", "外側の帯", { id: "nested", bodyId: "unused" });
    nested.blocks = [createBoxBlock("ovalbox", "内側の見出し", { id: "nested-oval", bodyId: "nested-body", bodyText: "内側のデザインを保つ" })];
    const shortPadding = createBoxBlock("bandbox", "帯と上端に隙間を作らない", { id: "small-padding", bodyId: "small-padding-body", bodyText: "上余白を小さく設定" });
    shortPadding.frame = { ...shortPadding.frame, paddingPx: { top: 4, right: 14, bottom: 12, left: 14 }, cornerStyle: "round", radiusPx: 24 };
    const notched = createBoxBlock("cornerbox", "四隅の切り抜き", { id: "notched", bodyId: "notched-body", bodyText: "色付き背景でも角を切り抜く" });
    notched.frame = { ...notched.frame, backgroundColor: "#e2e8f0" };
    const roundedTitle = createBoxBlock("titlebox", "鉄則Ⅰ", { id: "titlebox-empty-round", bodyId: "titlebox-empty-body" });
    roundedTitle.frame = { ...roundedTitle.frame, cornerStyle: "round", radiusPx: 20 };
    content.push(nested, shortPadding, notched, roundedTitle);
    const document: SigmaDocument = {
      version: "2.0", docId: "box-design-audit", metadata: { title: "Box デザイン確認" }, content,
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    };
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const created = await api.createFileFromDocument({ document });
      await api.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, document);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await expect(page.locator('.page-flow [data-sigma-doc-id="fancybox-default"]')).toBeVisible();
    await page.evaluate(async () => {
      await window.document.fonts.ready;
      window.getSelection()?.removeAllRanges();
      window.document.dispatchEvent(new Event("selectionchange"));
    });
    await page.keyboard.press("Escape");
    for (const box of content) {
      const element = page.locator(`.page-flow [data-sigma-doc-id="${box.id}"]`).first();
      await element.evaluate(el => el.scrollIntoView({ block: "center" }));
      await page.mouse.move(1400, 80);
      const bounds = await element.boundingBox();
      expect(bounds).not.toBeNull();
      const clip = { x: bounds!.x - 12, y: bounds!.y - 12, width: bounds!.width + 24, height: bounds!.height + 24 };
      const png = await page.screenshot({ path: testInfo.outputPath(`${box.id}.png`), clip, animations: "disabled" });
      // Test the painted pixels, not just the declared border radius: a square
      // child fill or inner rule can protrude beyond an otherwise rounded border.
      if (["titlebox-round", "bandbox-round", "tcolorbox-round", "doublebox-round", "tcolorbox-note-round", "notched", "titlebox-empty-round"].includes(box.id)) {
        const image = await loadImage(png);
        const canvas = createCanvas(image.width, image.height);
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        const inset = box.id === "doublebox-round" ? 5 : box.id === "notched" ? 0 : 2;
        const frameLeft = box.id === "tcolorbox-note-round" ? 20 : 0;
        for (const x of [12 + frameLeft + inset, image.width - 13 - inset]) {
          const pixel = [...context.getImageData(x, 12 + inset, 1, 1).data];
          expect.soft(pixel.slice(0, 3).every(value => value > 245), `${box.id}: square paint in the cut-out corner`).toBe(true);
        }
      }
    }
    const innerTitle = page.locator('.page-flow [data-sigma-doc-id="nested-oval"] .sigma-doc-box-title');
    await expect.soft(innerTitle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect.soft(innerTitle).toHaveCSS("color", "rgb(17, 17, 17)");
    const gap = await page.locator('.page-flow [data-sigma-doc-id="small-padding"]').evaluate(el => {
      const title = el.querySelector(".sigma-doc-box-title")!;
      return title.getBoundingClientRect().top - el.getBoundingClientRect().top;
    });
    expect.soft(gap).toBeLessThan(2);
    await page.locator('.page-flow [data-sigma-doc-id="titlebox-empty-body"]').click({ button: "right" });
    await page.locator(".page-context-menu").getByRole("menuitem", { name: "boxの設定…" }).click();
    const dialog = page.getByRole("dialog", { name: "ボックス設定" });
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("box-settings.png") });
    await page.getByTestId("box-style-picker").click();
    for (const style of BUILTIN_BOX_STYLES) {
      const button = page.getByTestId(`box-style-${style.id}`);
      await button.scrollIntoViewIfNeeded();
      const titleFits = await button.evaluate(el => {
        const title = el.querySelector(".sigma-doc-box-title")!.getBoundingClientRect();
        const button = el.getBoundingClientRect();
        return title.top >= button.top && title.bottom <= button.bottom && title.left >= button.left && title.right <= button.right;
      });
      expect.soft(titleFits, `${style.id}: preview title is clipped`).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`preview-${style.id}.png`), clip: (await button.boundingBox())! });
    }
    expect((await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))?.content).toEqual(content);
    await page.getByTestId("box-style-cornerbox").click();
    await expect(dialog.getByRole("group", { name: "角", exact: true })).toHaveCount(0);
    await page.getByTestId("box-style-titlebox").click();
    await page.getByTestId("box-style-picker").click();
    await dialog.getByRole("group", { name: "角", exact: true }).getByRole("button", { name: "角丸", exact: true }).click();
    const radius = dialog.getByRole("spinbutton", { name: "角丸半径（px）", exact: true });
    await radius.fill("99");
    await radius.press("Tab");
    await expect(radius).toHaveValue("32");
    await expect(dialog.getByRole("button", { name: "角丸半径（px）を増やす" })).toBeDisabled();
    await radius.fill("-1");
    await radius.press("Tab");
    await expect(radius).toHaveValue("0");
    await radius.fill("");
    await radius.pressSequentially("12.5");
    await radius.press("Tab");
    await dialog.getByRole("button", { name: "角丸半径（px）を増やす" }).click();
    await expect(radius).toHaveValue("13.5");
    await radius.fill("24");
    await radius.press("Tab");
    const slider = dialog.getByRole("slider", { name: "角丸半径を調整" });
    await slider.focus();
    await slider.press("ArrowRight");
    await expect(radius).toHaveValue("25");
    await expect(page.getByTestId("box-live-preview").locator(".sigma-doc-box-block")).toHaveCSS("border-top-left-radius", "25px");
    const borderStyle = page.getByTestId("box-field-borderStyle");
    await borderStyle.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("box-settings-menu.png") });
    await page.getByRole("option", { name: "破線", exact: true }).click();
    await borderStyle.focus();
    await borderStyle.press("Enter");
    await expect(page.getByRole("listbox")).toBeVisible();
    await borderStyle.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(dialog.locator("select")).toHaveCount(0);
    await expect(radius).toHaveCSS("appearance", "textfield");
    await page.screenshot({ path: testInfo.outputPath("box-settings-adjusted.png") });
    await page.setViewportSize({ width: 760, height: 960 });
    await dialog.getByRole("heading", { name: "ボックス設定" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("box-settings-compact.png") });
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await dialog.getByRole("button", { name: "閉じる" }).click();
    await expect.poll(async () => {
      const saved = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
      const box = saved?.content.find(block => block.id === "titlebox-empty-round");
      return box?.type === "boxBlock" ? { radius: box.frame?.radiusPx, border: box.frame?.borderStyle } : null;
    }).toEqual({ radius: 25, border: "dashed" });
    await page.reload();
    await expect(page.locator('.page-flow [data-sigma-doc-id="fancybox-default"]')).toBeVisible();
    await expect(page.locator('.page-flow [data-sigma-doc-id="titlebox-empty-round"]')).toHaveCSS("border-top-left-radius", "25px");
    await page.screenshot({ path: testInfo.outputPath("desktop-reloaded.png") });
    // The real desktop print route reads the saved file and uses the settled
    // PageCanvas output session, including the same corner fill and clipping.
    const printUrl = new URL(page.url());
    printUrl.pathname = printUrl.protocol === "file:" ? printUrl.pathname.replace(/index\.html$/, "print.html") : "/print";
    printUrl.search = new URLSearchParams({ fileId, profile: "teacher" }).toString();
    await page.goto(printUrl.href);
    await expect(page.locator(".paged-surface[data-paged-surface-state='ready']")).toHaveCount(1);
    await waitForPagedSurfaceSettled(page);
    const pages = page.locator(".paged-surface-page");
    for (let index = 0; index < await pages.count(); index += 1) {
      await pages.nth(index).screenshot({ path: testInfo.outputPath(`print-page-${index + 1}.png`) });
    }
    const printCorner = pages.locator('[data-sigma-doc-id="notched"]').first();
    await expect(printCorner).toBeAttached();
    const fillClip = await printCorner.evaluate(el => getComputedStyle(el, "::after").clipPath);
    expect(fillClip).toContain("polygon(");
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    expect(existsSync(profile)).toBe(false);
  }
});
