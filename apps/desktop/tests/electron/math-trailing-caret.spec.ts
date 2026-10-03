import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

import type { ParagraphNode, SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const TEX = String.raw`I_n=\int_0^{\frac{\pi}{2}}(x\cos x)^n\,dx`;
const ROWS = ["plain", "sized", "break", "framed"];

function fixture(): SigmaDocument {
  const paragraph = (id: string): ParagraphNode => ({
    type: "paragraph", id, align: id === "sized" || id === "framed" ? "center" : "left",
    children: [
      { type: "mathInline", id: `m_${id}`, tex: TEX, display: "inline", ...(id !== "plain" ? { fontSize: 11 } : {}) },
      ...(id === "break" ? [{ type: "text" as const, text: "\n次の行" }] : []),
    ],
  });
  return {
    version: "2.0", docId: "math_trailing_caret",
    metadata: { title: "数式と改行の間のキャレット", mathFractionSizing: "texDefault", styleUnits: { fontSize: "pt" } },
    content: [
      ...ROWS.slice(0, 3).map(paragraph),
      { type: "problem", id: "problem", lead: [], tags: [], solution: [], hints: [], prompt: [paragraph("framed")] },
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
}

// DOM Range の高さはこの境目では 0 でも描画される。実際のキャレットのピクセルを調べる。
async function paintedCaretPixels(app: ElectronApplication, page: Page, clip: { x: number; y: number; width: number; height: number }) {
  const screenshot = await page.screenshot({ clip, caret: "initial" });
  return app.evaluate(({ nativeImage }, png) => {
    const bitmap = nativeImage.createFromBuffer(Buffer.from(png, "base64")).toBitmap();
    let red = 0;
    for (let i = 0; i < bitmap.length; i += 4) {
      if (bitmap[i + 2] > 180 && bitmap[i + 1] < 80 && bitmap[i] < 80) red++;
    }
    return red;
  }, screenshot.toString("base64"));
}

async function clickAfterMath(page: Page, id: string) {
  const math = page.locator(`.page-flow [data-sigma-doc-id="${id}"] .inline-math-node`).first();
  await expect(math).toBeVisible();
  const box = (await math.boundingBox())!;
  await page.mouse.click(box.x + box.width + 5, box.y + box.height / 2);
  return { x: Math.floor(box.x + box.width - 5), y: Math.floor(box.y - 8), width: 25, height: Math.ceil(box.height + 16) };
}

test("styled math before paragraph and hard breaks paints a caret and preserves native editing and saved content", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!process.env.SIGMA_STUDIO_E2E_BASE_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-math-caret-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const launch = () => electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      const storage = window.desktopAPI!.storage;
      const { file } = await storage.createFileFromDocument({ document });
      await storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
      return file.fileId;
    }, fixture());
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await page.addStyleTag({ content: ".ProseMirror, .ProseMirror * { caret-color: red !important; caret-animation: manual; }" });
    for (const id of ROWS) {
      const clip = await clickAfterMath(page, id);
      await expect.poll(() => paintedCaretPixels(app, page, clip)).toBeGreaterThan(6);
      await testInfo.attach(`caret-${id}`, { body: await page.screenshot({ clip, caret: "initial" }), contentType: "image/png" });
      if (id === "sized") {
        // 補助要素を含む選択でも OS クリップボードへは本文だけを渡す。
        await page.evaluate(() => {
          const paragraph = window.document.querySelector('.page-flow [data-sigma-doc-id="sized"]')!;
          window.getSelection()!.selectAllChildren(paragraph);
        });
        await page.keyboard.press("ControlOrMeta+c");
        const copied = await app.evaluate(async ({ clipboard }) => {
          const items = await clipboard.read();
          const htmlItem = items.find(item => item.types.includes("text/html"));
          return { text: await clipboard.readText(), html: htmlItem ? await (await htmlItem.getType("text/html")).text() : "" };
        });
        expect(copied.text).toContain(TEX);
        expect(copied.text).not.toContain("\u200b");
        expect(copied.html).not.toContain("data-math-caret-buffer");
        await clickAfterMath(page, id);
      }
      await page.keyboard.type("Z");
      await page.keyboard.press("Backspace");
      // 入力→削除後にも同じ境目のキャレットが戻る。
      await expect.poll(() => paintedCaretPixels(app, page, clip)).toBeGreaterThan(6);
      await page.keyboard.insertText("追記");
    }
    const saved = () => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
    const rows = (doc: SigmaDocument | null) => doc?.content.flatMap(block => block.type === "problem" ? block.prompt : [block]);
    await expect.poll(async () => (rows(await saved()) ?? []).filter(row => row.type === "paragraph").map(row => row.children.filter(child => child.type === "text").map(child => child.text).join(""))).toEqual(["追記", "追記", "追記\n次の行", "追記"]);
    const document = (await saved())!;
    for (const row of rows(document) ?? []) {
      expect(row.type).toBe("paragraph");
      if (row.type !== "paragraph") continue;
      expect(row.children[0]).toMatchObject({ type: "mathInline", tex: TEX });
      expect(row.children.filter(child => child.type === "text").map(child => child.text).join("")).toBe(row.id === "break" ? "追記\n次の行" : "追記");
    }
    expect(JSON.stringify(document)).not.toMatch(/mathCaretBuffer|ProseMirror-separator|\u200b/);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator('.page-flow [data-sigma-doc-id="sized"]').first()).toBeVisible();
    expect(rows(await saved())).toEqual(rows(document));
    expect(await page.locator("[data-math-caret-buffer]").count()).toBe(0);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
