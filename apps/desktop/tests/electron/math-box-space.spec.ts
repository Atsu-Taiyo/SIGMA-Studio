import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import type { MathfieldElement } from "mathlive";
import type { SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");

for (const input of ["raw", "text", "typed"] as const) {
  test(`spaces after Japanese text (${input}) widen a radical box through editing, saving and reload`, async ({}, testInfo) => {
    const profile = mkdtempSync(path.join(tmpdir(), "sigma-box-space-"));
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.SIGMA_STUDIO_DEV_SERVER_URL;
    env.SIGMA_STUDIO_USER_DATA_DIR = profile;
    if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
    const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
      const source: SigmaDocument = {
        version: "2.0", docId: "box_space", metadata: { title: "数式の空白", styleUnits: { fontSize: "pt" } },
        content: [{ type: "paragraph", id: "body", children: [
          { type: "mathInline", id: "formula", tex: input === "typed" ? String.raw`\sqrt{\boxed{x}}` : input === "text" ? String.raw`\sqrt{\boxed{\text{あ}}}` : String.raw`\sqrt{\boxed{あ}}`, fontSize: 24, display: "inline" },
        ] }],
        outputProfiles: { student: {}, teacher: {}, answerBook: {} },
      };
      const fileId = await page.evaluate(async document => {
        localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
        await window.desktopAPI!.settings!.setUiLocale!("ja");
        const storage = window.desktopAPI!.storage;
        const { file } = await storage.createFileFromDocument({ document });
        await storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
        return file.fileId;
      }, source);
      await page.reload();
      const node = page.locator('.page-flow .inline-math-node[data-id="formula"]');
      await expect(node).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const staticBefore = await boxWidth(node);
      await node.click();
      const field = node.locator("math-field");
      await expect(field).toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      if (input === "typed") {
        await page.keyboard.press("Shift+ArrowLeft");
        await page.keyboard.insertText("あ");
        await expect.poll(() => field.evaluate(el => (el as MathfieldElement).value)).toBe(String.raw`\sqrt{\boxed{\text{あ}}}`);
      }
      const before = await boxWidth(field);
      await page.keyboard.press("Space");
      await expect.poll(() => boxWidth(field)).toBeGreaterThan(before + 2);
      const afterFirst = await boxWidth(field);
      await page.keyboard.press("Space");
      await expect.poll(() => boxWidth(field)).toBeGreaterThan(afterFirst + 2);
      const afterSecond = await boxWidth(field);
      await page.keyboard.press("Backspace");
      await expect.poll(() => boxWidth(field)).toBeLessThan(afterSecond - 2);
      await page.keyboard.press("Space");
      await expect.poll(() => boxWidth(field)).toBeGreaterThan(afterFirst + 2);
      await field.screenshot({ path: testInfo.outputPath("editing.png") });
      const edited = await field.evaluate(el => (el as MathfieldElement).value);
      expect(edited).toBe(String.raw`\sqrt{\boxed{\text{あ  }}}`);
      await page.keyboard.press("Enter");
      await expect(field).toHaveCount(0);
      await expect.poll(() => boxWidth(node)).toBeGreaterThan(staticBefore + 4);
      await page.keyboard.press("Meta+s");
      await expect.poll(async () => {
        const saved = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
        const paragraph = saved?.content[0];
        return paragraph?.type === "paragraph" ? paragraph.children.find(run => run.type === "mathInline")?.tex : undefined;
      }).toBe(edited);
      const saved = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
      await page.reload();
      await expect(node).toBeVisible();
      await expect.poll(() => boxWidth(node)).toBeGreaterThan(staticBefore + 4);
      expect((await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId))?.content).toEqual(saved?.content);
      await node.click();
      await expect(field).toBeFocused();
      await expect.poll(() => boxWidth(field)).toBeGreaterThan(before + 4);
      await page.keyboard.press("Enter");
    } finally {
      await app.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });
}

async function boxWidth(node: Locator) {
  return node.evaluate(el => (el.shadowRoot ?? el).querySelector(".ML__box")!.getBoundingClientRect().width);
}
