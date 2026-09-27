import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import { normalizePageLayout } from "@/lib/page-layout";

test("right-column text remains selectable when the same editor has left-column text at the same height", async () => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-column-selection-"));
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    SIGMA_STUDIO_USER_DATA_DIR: profile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    const mainWindow = await app.browserWindow(page);
    await mainWindow.evaluate((nativeWindow) => nativeWindow.setContentSize(1280, 720));
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator(".workspace-tab-group")).toHaveCount(1);
    const document = structuredClone(sampleDocument);
    document.docId = "column_selection";
    document.metadata = { title: "右段の選択確認" };
    document.comments = [];
    document.content = Array.from({ length: 30 }, (_, i) => ({
      type: "paragraph", id: `p${i}`,
      children: [{ type: "text", text: `UNIQUE_${i} ${"二段組の本文です。".repeat(5)}` }],
    }));
    const layout = normalizePageLayout(document.pageLayout);
    layout.flow = { type: "columns", columnCount: 2, columnGapMm: 8 };
    layout.overlay = undefined;
    document.pageLayout = layout;
    await page.evaluate(async (source) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document: source });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
    }, document);
    // Opening and reopening both use the real Electron file bridge.
    for (let reopen = 0; reopen < 2; reopen += 1) {
      await page.reload();
      await expect(page.locator(".startup-splash")).toBeHidden();
      const target = page.locator('.page-flow [data-sigma-doc-id="p20"]').first();
      await expect(target).toBeVisible();
      await page.evaluate(() => window.document.fonts.ready);
      await target.scrollIntoViewIfNeeded();
      const point = await target.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const y = rect.top + 40;
        const leftPeer = Array.from(element.parentElement!.children).some((child) => {
          const peer = child.getBoundingClientRect();
          return peer.right < rect.left && peer.top <= y && peer.bottom >= y;
        });
        return { x: rect.left + 25, y, leftPeer };
      });
      expect(point.leftPeer).toBe(true);
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x + 125, point.y + 10, { steps: 12 });
      await page.mouse.up();
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toBe("");
      const endpoints = await page.evaluate(() => {
        const selection = window.getSelection();
        return [selection?.anchorNode, selection?.focusNode].map((node) =>
          node?.parentElement?.closest("[data-sigma-doc-id]")?.getAttribute("data-sigma-doc-id"));
      });
      expect(endpoints).toEqual(["p20", "p20"]);
    }
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
