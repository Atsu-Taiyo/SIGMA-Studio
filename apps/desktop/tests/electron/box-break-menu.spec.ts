import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

import type { SigmaDocument } from "@/features/document";
import { createBoxBlock } from "@/lib/box-blocks";

const APP_ROOT = path.resolve(__dirname, "../..");

test("a box body cannot remove a preceding outside page break", async () => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!process.env.SIGMA_STUDIO_E2E_BASE_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-box-break-menu-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) {
    env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  }
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    const source: SigmaDocument = {
      version: "2.0",
      docId: "box_break_menu",
      metadata: { title: "箱の改ページメニュー確認" },
      content: [
        { type: "paragraph", id: "prelude", children: [{ type: "text", text: "前文" }] },
        { type: "paragraph", id: "outside_break", children: [{ type: "text", text: "改ページ付き段落" }], pagination: { break: true } },
        createBoxBlock("fancybox", "箱", { id: "box", bodyId: "inside", bodyText: "箱の本文" }),
      ],
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    };
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, source);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".startup-splash")).toBeHidden();

    await page.locator('.page-flow [data-sigma-doc-id="outside_break"]').click({ button: "right" });
    await expect(page.locator(".page-context-menu").getByRole("menuitem", { name: "改ページを解除" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.locator('.page-flow [data-sigma-doc-id="inside"]').click({ button: "right" });
    const menu = page.locator(".page-context-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "改ページを解除" })).toHaveCount(0);
    expect((await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))?.content[1])
      .toMatchObject({ id: "outside_break", pagination: { break: true } });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
