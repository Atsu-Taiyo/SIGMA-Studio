import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { ensurePageLayout } from "@/features/document";
import type { BoxBlockNode, ParagraphNode, SigmaDocument } from "@/types/sigma-doc";

const APP_ROOT = path.resolve(__dirname, "../..");
const BOX_ID = "box_custom_frame";
const FRAME_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100"><rect x="3" y="3" width="154" height="94" fill="none" stroke="#1d4ed8" stroke-width="4"/></svg>';

/**
 * A box framed by the user's own drawing has to survive what a unit test cannot exercise: the real
 * bridge saving the file, the file being read back, and the frame being drawn again after a reload.
 * The drawing is made with the same frame editor the problem settings use, and lands on the shared
 * shelf, from which the `/` command inserts another box with it.
 */
test("a hand-drawn box frame is saved with the file, drawn again after reload, and offered by the / command", async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-box-custom-frame-"));
  const app = await launch(profile);
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    // Finish the initial empty workspace bootstrap before installing the fixture.
    await expect(page.locator(".text-flow-editor").first()).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const created = await page.evaluate(
      (document) => window.desktopAPI!.storage.createFileFromDocument({ document }),
      createDocument(),
    );
    await page.reload();
    const box = page.locator(`section[data-sigma-doc-type="boxBlock"][data-sigma-doc-id="${BOX_ID}"]`).first();
    await expect(box).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();

    await box.hover();
    await box.getByRole("button", { name: "box操作" }).click();
    await page.getByRole("dialog", { name: "box操作" }).getByRole("button", { name: "boxの設定…" }).click();
    await page.getByTestId("box-style-picker").click();
    await page.getByTestId("box-frame-new").click();
    await page.getByTestId("custom-frame-preset-double-diamond").click();
    await page.getByTestId("custom-frame-thickness").fill("22");
    await expect(box).toHaveClass(/box-frame--custom/);
    await expect.poll(() => frameMetrics(page, BOX_ID)).toMatchObject({ imageDrawn: true, borderLeft: 22, borderTop: 22 });

    // Saved by the real bridge: the drawing is in the file, and the title is still the box's.
    await expect.poll(async () => {
      const saved = await page.evaluate((fileId) => window.desktopAPI!.storage.loadDocument(fileId), created.file.fileId);
      const savedBox = saved?.content.find((block): block is BoxBlockNode => block.type === "boxBlock" && block.id === BOX_ID);
      return {
        styleId: savedBox?.styleId,
        borderPx: savedBox?.frame?.custom?.borderPx,
        hasSvg: Boolean(savedBox?.frame?.custom?.svg),
        title: savedBox?.title,
      };
    }, { timeout: 15_000 }).toEqual({ styleId: "custom", borderPx: 22, hasSvg: true, title: [{ type: "text", text: "定理" }] });
    // The frame is on the shelf the problem settings share.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:problem-frame-library") ?? "[]").map((entry: { name: string }) => entry.name)))
      .toEqual(["二重線とひし形"]);

    await page.keyboard.press("Escape");
    await page.reload();
    await expect(box).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(box).toHaveClass(/box-frame--custom/);
    await expect.poll(() => frameMetrics(page, BOX_ID)).toMatchObject({ imageDrawn: true, borderLeft: 22, borderTop: 22 });

    // The `/` command offers the shelf frame and inserts a box drawn with it.
    const empty = page.locator('[data-sigma-doc-id="after_box"]').first();
    await empty.click();
    await page.keyboard.type("/二重線");
    const option = page.locator('.slash-command-option[data-command-kind="frameBox"]').first();
    await expect(option).toContainText("/二重線とひし形");
    await option.dispatchEvent("mousedown");
    await expect.poll(async () => {
      const saved = await page.evaluate((fileId) => window.desktopAPI!.storage.loadDocument(fileId), created.file.fileId);
      return saved?.content.filter((block) => block.type === "boxBlock" && block.styleId === "custom").length;
    }, { timeout: 15_000 }).toBe(2);
    await expect(page.locator('section[data-sigma-doc-type="boxBlock"].box-frame--custom')).toHaveCount(2);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

/**
 * The AI chat is the one the problem settings use; for a box it says so to the AI and offers the
 * finished drawing to the box. Only the AI itself is replaced, as in `problem-frame-ai-chat.spec.ts`.
 */
test("the AI frame chat draws a box's frame, keeps going after the dialog is closed, and offers it to the box", async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-box-frame-ai-"));
  const app = await launch(profile);
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await app.evaluate(({ ipcMain }, drawing) => {
      ipcMain.removeHandler("claude:get-status");
      ipcMain.handle("claude:get-status", () => ({
        available: true, running: false, loggedIn: true, claudeBin: "claude", configuredClaudeBin: null,
        account: { apiKeySource: "none" }, error: null,
      }));
      const calls: unknown[] = [];
      (globalThis as { __frameAiCalls?: unknown[] }).__frameAiCalls = calls;
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      ipcMain.removeHandler("ai-skill-draft:generate");
      ipcMain.handle("ai-skill-draft:generate", async (event, runId: string, payload: unknown) => {
        calls.push(payload);
        event.sender.send(`ai-skill-draft:event:${runId}`, { kind: "reasoning", text: "四隅を少し太くします。" });
        await sleep(1500);
        return { ok: true, text: drawing, message: "青い枠にしました。" };
      });
    }, FRAME_SVG);
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    await expect(page.locator(".startup-splash")).toBeHidden();
    const created = await page.evaluate(
      (document) => window.desktopAPI!.storage.createFileFromDocument({ document }),
      createDocument(),
    );
    await page.reload();
    const box = page.locator(`section[data-sigma-doc-type="boxBlock"][data-sigma-doc-id="${BOX_ID}"]`).first();
    await expect(box).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();

    await box.hover();
    await box.getByRole("button", { name: "box操作" }).click();
    await page.getByRole("dialog", { name: "box操作" }).getByRole("button", { name: "boxの設定…" }).click();
    const settings = page.getByRole("dialog", { name: "ボックス設定" });
    await settings.getByTestId("box-style-picker").click();
    await settings.getByTestId("box-frame-new").click();
    await settings.getByRole("tab", { name: "AIで描く" }).click();
    await expect(settings.getByTestId("custom-frame-ai-greeting")).toContainText("どんな枠線にしますか？");
    await settings.getByTestId("custom-frame-ai-prompt").fill("青い枠");
    await settings.getByTestId("custom-frame-ai-prompt").press("Enter");
    await expect(settings.getByTestId("custom-frame-ai-reasoning")).toContainText("四隅を少し太くします。");
    await settings.getByRole("button", { name: "閉じる" }).click();
    await expect(settings).toBeHidden();

    const calls = await app.evaluate(() => (globalThis as { __frameAiCalls?: Array<{ purpose: string; frameTarget?: string }> }).__frameAiCalls);
    expect(calls?.[0]).toMatchObject({ purpose: "frameDrawing", frameTarget: "box" });

    const notice = page.getByRole("dialog", { name: "枠を描き終えました" });
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText("この箱に使いますか？");
    await expect(box).not.toHaveClass(/box-frame--custom/);
    await notice.getByRole("button", { name: "この箱に使う" }).click();
    await expect(notice).toBeHidden();
    await expect(box).toHaveClass(/box-frame--custom/);
    await expect.poll(async () => {
      const saved = await page.evaluate((fileId) => window.desktopAPI!.storage.loadDocument(fileId), created.file.fileId);
      const savedBox = saved?.content.find((block): block is BoxBlockNode => block.type === "boxBlock" && block.id === BOX_ID);
      return { styleId: savedBox?.styleId, width: savedBox?.frame?.custom?.width, title: savedBox?.title };
    }, { timeout: 15_000 }).toEqual({ styleId: "custom", width: 160, title: [{ type: "text", text: "定理" }] });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

async function launch(profile: string): Promise<ElectronApplication> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  return electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
}

async function frameMetrics(page: Page, boxId: string): Promise<{ imageDrawn: boolean; borderLeft: number; borderTop: number }> {
  return page.evaluate((id) => {
    const box = document.querySelector<HTMLElement>(`section[data-sigma-doc-type="boxBlock"][data-sigma-doc-id="${id}"]`);
    if (!box) throw new Error("box not found");
    const style = getComputedStyle(box);
    return {
      imageDrawn: style.borderImageSource.startsWith("url("),
      borderLeft: Number.parseFloat(style.borderLeftWidth),
      borderTop: Number.parseFloat(style.borderTopWidth),
    };
  }, boxId);
}

function createDocument(): SigmaDocument {
  const box: BoxBlockNode = {
    type: "boxBlock",
    id: BOX_ID,
    styleId: "tcolorbox",
    title: [{ type: "text", text: "定理" }],
    blocks: [paragraph("box_custom_frame_body", "a > 0, b > 0 のとき (a + b) / 2 ≥ √(ab)")],
  };
  return ensurePageLayout({
    version: "2.0",
    docId: "box_custom_frame_doc",
    metadata: { title: "自作の枠の箱" },
    content: [paragraph("before_box", "相加平均と相乗平均"), box, paragraph("after_box", "")],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  });
}

function paragraph(id: string, text: string): ParagraphNode {
  return { id, type: "paragraph", children: text ? [{ type: "text", text }] : [] };
}
