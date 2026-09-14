import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { getDefaultPageLayout, type SigmaDocument } from "@/features/document";
import { comparableDocumentValue } from "@/lib/document-equivalence";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_ELECTRON_TEST_URL;

test("empty whiteboard region comments survive real Electron storage and restart", async () => {
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Build static renderer or set SIGMA_STUDIO_ELECTRON_TEST_URL to this checkout's dev server");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-region-electron-"));
  let app: ElectronApplication | undefined;
  const launch = async () => electron.launch({
    args: [APP_ROOT, `--user-data-dir=${path.join(profile, "chromium")}`], cwd: APP_ROOT,
    env: { ...process.env, SIGMA_STUDIO_USER_DATA_DIR: path.join(profile, "sigma"),
      ...(devUrl ? { SIGMA_STUDIO_DEV_SERVER_URL: devUrl } : {}) } as Record<string, string>,
  });
  try {
    app = await launch();
    let page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(() => {
      localStorage.setItem("sigma-studio:ui-locale", "ja");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    });
    const document: SigmaDocument = {
      version: "2.0", docId: "electron_region", metadata: { title: "領域コメント実機" }, content: [],
      pageLayout: getDefaultPageLayout("whiteboard"), outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    };
    const fileId = await page.evaluate(async (document) => {
      const api = window.desktopAPI!.storage;
      const created = await api.createFileFromDocument({ document });
      await api.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, document);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const viewport = page.locator(".whiteboard-page-canvas");
    await expect(viewport).toBeVisible();
    if (devUrl) expect(page.url()).toBe(devUrl);
    expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(path.join(profile, "sigma"));
    const box = (await viewport.boundingBox())!;
    await page.mouse.move(box.x + 400, box.y + 260);
    await page.mouse.wheel(-600, -400);
    await expect.poll(() => viewport.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--whiteboard-pan-x")))).toBe(600);
    await page.mouse.move(box.x + 520, box.y + 360);
    await page.mouse.down();
    await page.mouse.move(box.x + 280, box.y + 220, { steps: 12 });
    await page.mouse.up();
    const region = page.locator('[data-retained-region="true"]');
    await expect(region).toBeVisible();
    const bounds = await region.evaluate((el: HTMLElement) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }));
    expect(bounds.x).toBeLessThan(0);
    expect(bounds.y).toBeLessThan(0);
    await page.locator('.selection-action-popover button[aria-label="コメントを追加"]').click();
    const dock = page.locator(".comment-dock");
    await dock.locator(".comment-rich-text-editor").fill("実ファイルへ保存する領域コメント");
    await dock.getByRole("button", { name: "追加", exact: true }).click();
    await expect.poll(() => page.evaluate(async (id) => (await window.desktopAPI!.storage.loadDocument(id))?.comments?.length, fileId)).toBe(1);
    const persisted = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
    expect(persisted!.comments![0].anchor).toEqual({ type: "canvasRegion", bounds, quote: "選択した領域" });
    const diskPath = path.join(profile, "sigma/data/documents", `${fileId}.sigmadoc.json`);
    expect(JSON.parse(readFileSync(diskPath, "utf8")).comments).toEqual(persisted!.comments);
    await page.screenshot({ path: test.info().outputPath("electron-region-comment.png") });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();
    await page.locator(".comment-dock-toggle").click();
    const card = page.locator(".comment-thread-card");
    await expect(card).toContainText("実ファイルへ保存する領域コメント");
    await card.locator(".comment-anchor-label").click();
    const marker = page.locator(".overlay-comment-marker");
    await expect(marker).toBeVisible();
    await expect.poll(async () => {
      const m = (await marker.boundingBox())!;
      const v = (await page.locator(".whiteboard-page-canvas").boundingBox())!;
      return Math.max(Math.abs((m.x + m.width / 2) - (v.x + v.width / 2)),
        Math.abs((m.y + m.height / 2) - (v.y + v.height / 2)));
    }).toBeLessThan(2);
    const restarted = (await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))!;
    // Mounting the drawing editor refreshes its save timestamp; its content must stay intact.
    const contentWithoutSaveTime = (document: SigmaDocument) => {
      const copy = structuredClone(document);
      if (copy.pageLayout?.overlay) delete copy.pageLayout.overlay.updatedAt;
      return comparableDocumentValue(copy);
    };
    expect(contentWithoutSaveTime(restarted)).toEqual(contentWithoutSaveTime(persisted!));
    await expect(page.locator('[data-retained-region="true"]')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("electron-region-restored.png") });
    await card.locator(".comment-thread-menu-button").click();
    await card.getByRole("menuitem", { name: "削除", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(marker).toHaveCount(0);
    await expect.poll(() => page.evaluate(async (id) => (await window.desktopAPI!.storage.loadDocument(id))?.comments ?? [], fileId)).toEqual([]);
    expect(JSON.parse(readFileSync(diskPath, "utf8")).comments ?? []).toEqual([]);
    await page.locator(".comment-dock").getByRole("button", { name: "コメントを閉じる" }).click();
    const restoredBox = (await page.locator(".whiteboard-page-canvas").boundingBox())!;
    await page.mouse.move(restoredBox.x + 280, restoredBox.y + 220);
    await page.mouse.down();
    await page.mouse.move(restoredBox.x + 520, restoredBox.y + 360, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('[data-retained-region="true"]')).toBeVisible();
    await page.getByRole("button", { name: "表", exact: true }).first().click();
    await expect(page.locator('[data-retained-region="true"]')).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "表を挿入" })).toHaveCount(0);
    await page.mouse.move(restoredBox.x + 100, restoredBox.y + 420);
    await expect(page.locator("[data-table-placement-preview] tr")).toHaveCount(2);
    await page.mouse.click(restoredBox.x + 100, restoredBox.y + 420);
    const table = page.locator(".overlay-table-shape");
    await expect(table.locator("tr")).toHaveCount(2);
    await expect(table.locator("td")).toHaveCount(4);
    await expect(table.locator("[contenteditable=true]").first()).toBeFocused();
    await page.keyboard.type("R1");
    await expect.poll(() => readFileSync(diskPath, "utf8")).toContain("R1");
    const withTable = JSON.parse(readFileSync(diskPath, "utf8")) as SigmaDocument;
    expect(withTable.content).toEqual([]);
    expect(withTable.comments ?? []).toEqual([]);
    const placedTable = withTable.pageLayout?.overlay?.overlaySnapshot?.shapes[0];
    if (placedTable?.type !== "tableShape") throw new Error("The placed table was not saved");
    expect(placedTable.props.table.rows).toHaveLength(2);
    expect(placedTable.props.table.columns).toHaveLength(2);
    await page.screenshot({ animations: "disabled", path: test.info().outputPath("electron-region-table.png") });
    await page.keyboard.press("Escape");
    await page.mouse.move(restoredBox.x + 280, restoredBox.y + 220);
    await page.mouse.down();
    await page.mouse.move(restoredBox.x + 520, restoredBox.y + 360, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('[data-retained-region="true"]')).toBeVisible();
    await page.locator('.selection-action-popover button[aria-label="AIに追加"]').click();
    // This real profile has no provider credentials. Browser bridge tests cover authenticated sends.
    await expect(page.getByText("AI編集の参照対象をセットしました", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "ChatGPTでログインしてAIを使う" })).toBeVisible();
    await page.screenshot({ animations: "disabled", path: test.info().outputPath("electron-region-ai-login.png") });
  } finally {
    await app?.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
