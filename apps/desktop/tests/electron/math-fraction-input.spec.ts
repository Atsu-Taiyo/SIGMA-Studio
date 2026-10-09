import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { MathfieldElement } from "mathlive";
import type { SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");

for (const entry of ["body", "math", "placeholder"] as const) {
  test(`fraction input from ${entry} keeps its frame, cursor and viewport through save/reload`, async ({}, testInfo) => {
    const profile = mkdtempSync(path.join(tmpdir(), "sigma-fraction-input-"));
    const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.SIGMA_STUDIO_DEV_SERVER_URL;
    env.SIGMA_STUDIO_USER_DATA_DIR = profile;
    if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
    const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
    try {
      const page = await app.firstWindow();
      await (await app.browserWindow(page)).evaluate(window => window.setContentSize(1200, 850));
      await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
      const source: SigmaDocument = {
        version: "2.0", docId: "fraction_input",
        metadata: { title: "分数入力", mathFractionSizing: "texDefault", styleUnits: { fontSize: "pt" } },
        content: Array.from({ length: 60 }, (_, index) => ({
          type: "paragraph", id: `p${index}`, children: index === 30 && entry !== "body"
            ? [{ type: "mathInline", id: "formula", tex: entry === "math" ? "x=" : String.raw`\dfrac{\placeholder{}}{\placeholder{}}`, fontSize: 24, display: "inline" }]
            : [{ type: "text", text: `段落 ${index} 分数入力のスクロール確認` }],
        })),
        outputProfiles: { student: {}, teacher: {}, answerBook: {} },
      };
      const fileId = await page.evaluate(async document => {
        localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
        localStorage.setItem("sigma-studio:inline-math-input-mode", "mathlive");
        await window.desktopAPI!.settings!.setUiLocale!("ja");
        const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
        await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
        return file.fileId;
      }, source);
      await page.reload();
      await expect(page.locator(".startup-splash")).toBeHidden();
      const paragraph = page.locator('.page-flow [data-sigma-doc-id="p30"]').first();
      await expect(paragraph).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await paragraph.scrollIntoViewIfNeeded();
      await paragraph.evaluate(el => {
        const canvas = el.closest(".editor-canvas")!;
        const viewport = canvas.getBoundingClientRect();
        const target = el.getBoundingClientRect();
        canvas.scrollTop += (target.top + target.bottom - viewport.top - viewport.bottom) / 2;
      });
      if (entry === "body") {
        await paragraph.click();
        await page.keyboard.press("Meta+ArrowRight");
        await page.keyboard.press("Control+/");
      } else if (entry === "math") {
        await paragraph.locator(".inline-math-node").click();
        await expect(paragraph.locator("math-field")).toBeFocused();
        await page.keyboard.press("Control+/");
      } else {
        const prompt = (await paragraph.locator(".ML__prompt-atom").first().boundingBox())!;
        await page.mouse.click(prompt.x + prompt.width / 2, prompt.y + prompt.height / 2);
      }
      const node = paragraph.locator(".inline-math-node");
      const field = node.locator("math-field");
      await expect(field).toBeFocused();
      const scroller = page.locator(".editor-canvas");
      const scrollBefore = await scroller.evaluate(el => ({ top: el.scrollTop, left: el.scrollLeft }));
      expect(scrollBefore.top).toBeGreaterThan(400);
      await expect.poll(() => frameOverflow(node)).toBeLessThanOrEqual(1);
      await page.keyboard.type("12");
      await expect.poll(() => fractionTex(field)).toMatch(/\\(?:d?frac)\{12\}/);
      await expect.poll(() => scroller.evaluate((el, top) => Math.abs(el.scrollTop - top), scrollBefore.top)).toBeLessThan(3);
      await page.keyboard.press("Tab");
      await page.keyboard.type("34");
      await expect.poll(() => fractionTex(field)).toMatch(/\\(?:d?frac)\{12\}\{34\}/);
      await expect.poll(() => frameOverflow(node)).toBeLessThanOrEqual(1);
      await expect.poll(() => scroller.evaluate((el, top) => Math.abs(el.scrollTop - top), scrollBefore.top)).toBeLessThan(3);
      expect(await scroller.evaluate(el => el.scrollLeft)).toBe(scrollBefore.left);
      await field.screenshot({ path: testInfo.outputPath("fraction-editing.png") });
      const edited = await field.evaluate(el => (el as MathfieldElement).value.replace(/\\placeholder\[sigma-click-\d+\]/g, "\\placeholder"));
      await assertCaretAboveFrame(app, page, field, testInfo.outputPath("caret-above-frame.png"));
      await page.keyboard.press("Enter");
      await expect(field).toHaveCount(0);
      await page.keyboard.press("Meta+s");
      await expect.poll(async () => {
        const saved = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
        const body = saved?.content.find(block => block.id === "p30");
        return body?.type === "paragraph" ? body.children.find(run => run.type === "mathInline")?.tex : undefined;
      }).toBe(edited);
      await page.reload();
      await expect(node).toHaveAttribute("data-tex", edited);
      await node.click();
      await expect(field).toBeFocused();
      await expect.poll(() => field.evaluate(el => (el as MathfieldElement).value.replace(/\\placeholder\[sigma-click-\d+\]/g, "\\placeholder"))).toBe(edited);
      await expect.poll(() => frameOverflow(node)).toBeLessThanOrEqual(1);
      await page.keyboard.press("Enter");
      await expect(field).toHaveCount(0);
    } finally {
      await app.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });
}

async function assertCaretAboveFrame(app: ElectronApplication, page: Page, field: Locator, screenshotPath: string) {
  const clip = await field.evaluate(async el => {
    const node = el.parentElement!.parentElement! as HTMLElement;
    node.style.setProperty("--accent", "rgb(0, 0, 255)");
    const input = el as MathfieldElement;
    input.style.setProperty("--caret-color", "rgb(255, 0, 0)");
    input.executeCommand("moveToMathfieldStart");
    const style = document.createElement("style");
    // Freeze blinking for pixel inspection; keep the production caret geometry.
    style.textContent = ".ML__caret::after { animation: none !important; }";
    input.shadowRoot!.append(style);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const bounds = node.getBoundingClientRect();
    return { x: Math.floor(bounds.left) - 2, y: Math.floor(bounds.top), width: 5, height: Math.ceil(bounds.height) };
  });
  const png = await page.screenshot({ path: screenshotPath, clip, caret: "initial" });
  const pixels = await app.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap();
    const columns = Array.from({ length: width }, () => ({ blue: 0, red: 0 }));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        if (bitmap[offset] > 150 && bitmap[offset + 1] < 120 && bitmap[offset + 2] < 120) columns[x].blue++;
        if (bitmap[offset + 2] > 150 && bitmap[offset] < 120 && bitmap[offset + 1] < 120) columns[x].red++;
      }
    }
    // Fractional frame coordinates can put the outline in either adjacent
    // pixel column. Inspect the painted blue line rather than assuming x=1.
    return columns.reduce((outline, column) => column.blue > outline.blue ? column : outline);
  }, png.toString("base64"));
  expect(pixels.blue).toBeGreaterThan(3);
  expect(pixels.red).toBeGreaterThan(3);
}

async function fractionTex(field: Locator) {
  return field.evaluate(el => (el as MathfieldElement).value.replace(/\\placeholder(?:\[[^\]]*\])?\{([^{}]*)\}/g, "$1"));
}

async function frameOverflow(node: Locator) {
  return node.evaluate(el => {
    const frame = el.getBoundingClientRect();
    const field = el.querySelector("math-field")!;
    const content = field.shadowRoot!.querySelector('[part="content"]')!.getBoundingClientRect();
    return Math.max(frame.top - content.top, content.bottom - frame.bottom, frame.left - content.left, content.right - frame.right);
  });
}
