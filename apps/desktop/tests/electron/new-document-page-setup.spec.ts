import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { createBlankDocument } from "@/lib/blank-document";
import type { SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;

/** 前の教材: B5 横・2 段・狭い余白・学校名のヘッダー・見出し番号。本文の図形は引き継がれてはいけない。 */
function previousMaterial(): SigmaDocument {
  const blank = createBlankDocument("前の教材");
  return {
    ...blank,
    metadata: { ...blank.metadata, headingNumbering: { enabled: true, style: "chapterJa", depth: 2 } },
    content: [{ type: "paragraph", id: "p_previous", children: [{ type: "text", text: "前の教材の本文" }] }],
    pageLayout: {
      ...blank.pageLayout!,
      preset: "B5",
      orientation: "landscape",
      pageSize: { widthMm: 257, heightMm: 182 },
      marginsMm: { top: 16, right: 10, bottom: 15, left: 10 },
      flow: { type: "columns", columnCount: 2, columnGapMm: 6 },
      header: {
        enabled: true, heightMm: 8, offsetMm: 5, showOnFirstPage: true,
        blocks: [{ type: "paragraph", id: "school", children: [{ type: "text", text: "○○高校 数学科" }] }],
      },
      overlay: { overlaySnapshot: { version: 1, assets: {}, shapes: [{
        id: "body_note", type: "text", x: 80, y: 200, rotation: 0,
        props: { w: 200, h: 40, color: "#111111", size: "m", blocks: [{ type: "paragraph", id: "note", children: [{ type: "text", text: "本文の図形" }] }] },
      }] } },
    },
  };
}

const inherited = {
  preset: "B5",
  orientation: "landscape",
  pageSize: { widthMm: 257, heightMm: 182 },
  marginsMm: { top: 16, right: 10, bottom: 15, left: 10 },
  flow: { columnCount: 2, columnGapMm: 6 },
  header: { enabled: true, blocks: [{ children: [{ text: "○○高校 数学科" }] }] },
};

test("a new blank material starts with the page setup of the material opened before it, also after a restart", async () => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-new-document-page-setup-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const launch = () => electron.launch({ args: [APP_ROOT, `--user-data-dir=${profile}`], cwd: APP_ROOT, env });
  const body = (page: Page) => page.locator(".page-flow .ProseMirror").first();
  const fileIds = (page: Page) => page.evaluate(async () => (await window.desktopAPI!.storage.listFiles()).map((file) => file.fileId));
  const load = (page: Page, fileId: string) => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await expect(body(page)).toBeVisible();
    await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
    });
    const previous = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), previousMaterial());
    await page.reload();
    await expect(page.getByText("前の教材の本文").first()).toBeVisible();

    // The real "新規教材" button. The previous material's paper is handed over before the file is made.
    const before = new Set(await fileIds(page));
    await page.getByRole("button", { name: "新規教材", exact: true }).first().click();
    await expect.poll(async () => (await fileIds(page)).filter((id) => !before.has(id))).toHaveLength(1);
    const created = (await fileIds(page)).find((id) => !before.has(id))!;
    await expect.poll(() => load(page, created)).toMatchObject({ pageLayout: inherited, metadata: { headingNumbering: { enabled: true, style: "chapterJa", depth: 2 } } });
    const createdDocument = await load(page, created);
    expect(createdDocument).toMatchObject({ pageLayout: inherited, metadata: { headingNumbering: { enabled: true, style: "chapterJa", depth: 2 } } });
    expect(createdDocument?.pageLayout?.overlay).toBeUndefined();
    expect(createdDocument?.content).toHaveLength(1);

    // A duplicate or an imported document keeps its own paper.
    const imported = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), createBlankDocument("取り込んだA4"));
    expect((await load(page, imported.file.fileId))?.pageLayout).toMatchObject({ preset: "A4", orientation: "portrait", header: { enabled: false } });
    const duplicate = await page.evaluate((id) => window.desktopAPI!.storage.duplicateFile(id), previous.file.fileId);
    expect((await load(page, duplicate.file.fileId))?.pageLayout?.overlay?.overlaySnapshot?.shapes).toHaveLength(1);

    // After a restart the workspace screen's path (library.createDocument) still inherits it.
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    const fromHome = await page.evaluate(() => window.desktopAPI!.storage.createDocument({ title: "ホームから" }));
    expect(fromHome.document).toMatchObject({ pageLayout: inherited });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
