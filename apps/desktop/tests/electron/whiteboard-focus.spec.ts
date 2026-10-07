import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { getDefaultPageLayout, type SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");

test("the whiteboard drawing surface has no native focus outline, including after reload", async ({}, testInfo) => {
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-whiteboard-focus-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    const document: SigmaDocument = { version: "2.0", docId: "focus_outline", metadata: { title: "ホワイトボードのフォーカス" }, content: [],
      pageLayout: getDefaultPageLayout("whiteboard"), outputProfiles: { student: {}, teacher: {}, answerBook: {} } };
    await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
    }, document);
    for (let iteration = 0; iteration < 2; iteration += 1) {
      await page.reload();
      const surface = page.locator(".whiteboard-canvas > .overlay-canvas-bleed-surface");
      await expect(surface).toBeVisible();
      await page.keyboard.press("Shift");
      await surface.evaluate((element) => (element as HTMLElement).focus());
      await expect(surface).toBeFocused();
      expect(await surface.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      await expect(surface).toHaveCSS("outline-style", "none");
    }
    await page.screenshot({ path: testInfo.outputPath("whiteboard-keyboard-focus.png") });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
