import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createBlankDocument } from "@/lib/blank-document";
import { customPageSetupDocument } from "../helpers/template-fixtures";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;
const PREPARED = Boolean(devUrl) || (existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")) && existsSync(path.join(APP_ROOT, "out/index.html")));

const templatePageSetup = {
  preset: "B5",
  orientation: "landscape",
  pageSize: { widthMm: 257, heightMm: 182 },
  marginsMm: { top: 16, right: 10, bottom: 15, left: 10 },
  flow: { columnCount: 2, columnGapMm: 6 },
  header: { enabled: true, blocks: [{ children: [{ text: "○○高校 数学科" }] }] },
};

async function launch(env: Record<string, string>) {
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
  await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
  return { app, page };
}

const listFiles = (page: Page) => page.evaluate(() => window.desktopAPI!.storage.listFiles());
const loadDocument = (page: Page, fileId: string) => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);

/**
 * 「テンプレートから新規」: エディタのメニューから、テンプレートを保存したときの用紙設定・余白・ヘッダー・図形ごと
 * 新しいファイルを作る (開いている教材には触れない)。ファイルは本物の保存先に書かれ、再起動後も同じ。
 * 「テンプレートを挿入」は従来どおり開いている教材の本文へ入れるだけで、ファイルを増やさない。
 */
test("new from template in the editor writes a new file with the template's page setup, also after a restart", async () => {
  test.skip(!PREPARED, "Build Electron and the static renderer first, or point SIGMA_STUDIO_E2E_BASE_URL at a dev server.");
  test.setTimeout(240_000);
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-template-new-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  Object.assign(env, { SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_COLLABORATION_URL: "", SIGMA_SUPABASE_URL: "", SIGMA_SUPABASE_ANON_KEY: "" });
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  let session: { app: ElectronApplication; page: Page } | undefined = await launch(env);
  try {
    let page = session.page;
    const open = createBlankDocument("開いている教材");
    open.content = [{ type: "paragraph", id: "open_p", children: [{ type: "text", text: "前の本文" }] }];
    const template = customPageSetupDocument();
    const fixture = await page.evaluate(async ({ open, template }) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document: open });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      await window.desktopAPI!.templates.createTemplate({ workspaceId: created.file.workspaceId, name: "B5横プリント", document: template });
      return { fileId: created.file.fileId };
    }, { open, template });
    await page.reload();
    await expect(page.getByText("前の本文").first()).toBeVisible({ timeout: 60_000 });
    const originalBefore = await loadDocument(page, fixture.fileId);
    expect(originalBefore?.pageLayout).toMatchObject({ preset: "A4", orientation: "portrait", header: { enabled: false } });
    const filesBefore = await listFiles(page);

    // 「テンプレートを挿入」: 開いている教材の本文に入り、ファイルは増えず、用紙設定は A4 のまま。
    const newMaterial = page.getByRole("button", { name: "新規教材", exact: true });
    await newMaterial.hover();
    await page.getByRole("menuitem", { name: "テンプレートを挿入" }).click();
    const gallery = page.locator(".template-gallery-dialog");
    await gallery.locator(".template-gallery-card", { hasText: "B5横プリント" }).locator(".template-gallery-card-apply").click();
    await expect(gallery).toBeHidden();
    await expect(page.getByText("テンプレの本文").first()).toBeVisible();
    expect(await listFiles(page)).toHaveLength(filesBefore.length);
    await expect.poll(async () => JSON.stringify(await loadDocument(page, fixture.fileId)), { timeout: 30_000 }).toContain("テンプレの本文");
    expect((await loadDocument(page, fixture.fileId))?.pageLayout).toMatchObject({ preset: "A4", orientation: "portrait" });

    // 「テンプレートから新規」: 新しいファイルが増え、新しいタブで開く。
    await newMaterial.hover();
    await page.getByRole("menuitem", { name: "テンプレートから新規" }).click();
    await gallery.locator(".template-gallery-card", { hasText: "B5横プリント" }).locator(".template-gallery-card-apply").click();
    await expect(gallery).toBeHidden();
    await expect.poll(async () => (await listFiles(page)).length).toBe(filesBefore.length + 1);
    const created = (await listFiles(page)).find((file) => !filesBefore.some((item) => item.fileId === file.fileId))!;
    expect(created.title).toBe("B5横プリント");
    await expect(page.getByRole("dialog", { name: /を作成しました$/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tab", { name: /B5横プリント/ })).toBeVisible();
    await expect(page.locator(".page-running-region").filter({ hasText: "○○高校 数学科" }).first()).toBeVisible();
    const createdDocument = await loadDocument(page, created.fileId);
    expect(createdDocument).toMatchObject({ metadata: { title: "B5横プリント" }, pageLayout: templatePageSetup });
    expect(createdDocument?.pageLayout?.overlay?.overlaySnapshot?.shapes).toHaveLength(1);
    expect(createdDocument?.docId).not.toBe(template.docId);
    // 開いていた教材は、用紙設定もそのまま (挿入した本文は残る)。
    expect((await loadDocument(page, fixture.fileId))?.pageLayout).toMatchObject({ preset: "A4", orientation: "portrait" });

    // 再起動しても、ファイルの中身もタブも同じ。
    await session.app.close();
    session = undefined;
    session = await launch(env);
    page = session.page;
    const reloaded = await loadDocument(page, created.fileId);
    expect(reloaded).toMatchObject({ metadata: { title: "B5横プリント" }, pageLayout: templatePageSetup });
    expect(reloaded?.pageLayout?.overlay?.overlaySnapshot?.shapes).toHaveLength(1);
    await expect(page.getByRole("tab", { name: /B5横プリント/ })).toBeVisible();
    await expect(page.locator(".page-running-region").filter({ hasText: "○○高校 数学科" }).first()).toBeVisible();
  } finally {
    await session?.app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
