import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createBlankDocument } from "@/lib/blank-document";
import type { BoxBlockNode, ProblemNode } from "@/types/sigma-doc";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;
const PREPARED = Boolean(devUrl) || (existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")) && existsSync(path.join(APP_ROOT, "out/index.html")));

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
 * 公式テンプレート: ギャラリーの「公式」タブに同梱の紙面 (青・赤チャート、Focus Gold、共通テスト、東大) が並び、
 * 名前の変更・削除はできない。選ぶと用紙 (A5 など) ごと新しい教材ができ、再起動後も同じ。
 * 部品は公式素材として `/` から挿せる。
 */
test("official templates create materials with their page setup, and their parts are offered by the / command", async () => {
  test.skip(!PREPARED, "Build Electron and the static renderer first, or point SIGMA_STUDIO_E2E_BASE_URL at a dev server.");
  test.setTimeout(240_000);
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-official-templates-"));
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
    const fixture = await page.evaluate(async (open) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document: open });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return { fileId: created.file.fileId };
    }, open);
    await page.reload();
    await expect(page.getByText("前の本文").first()).toBeVisible({ timeout: 60_000 });
    const filesBefore = await listFiles(page);

    const newMaterial = page.getByRole("button", { name: "新規教材", exact: true });
    await newMaterial.hover();
    await page.getByRole("menuitem", { name: "テンプレートから新規" }).click();
    const gallery = page.locator(".template-gallery-dialog");
    await gallery.getByRole("tab", { name: "公式" }).click();
    const cards = gallery.locator(".template-gallery-card");
    await expect(cards).toHaveCount(5);
    for (const name of ["青チャート型 例題ページ", "赤チャート型 例題ページ", "Focus Gold型 例題ページ", "共通テスト型 数学Ⅰ，数学A", "東大型 数学 問題冊子"]) {
      await expect(cards.filter({ hasText: name })).toHaveCount(1);
    }
    // 同梱品なので、名前の変更・削除の操作は出ない。保存先にも選べない。
    await expect(gallery.locator(".template-gallery-card-actions")).toHaveCount(0);
    await expect(gallery.getByRole("button", { name: "現在の文書を保存" })).toHaveCount(0);
    await gallery.getByRole("tab", { name: "マイ教材" }).click();
    await expect(gallery.getByRole("button", { name: "現在の文書を保存" })).toBeVisible();
    await gallery.getByRole("tab", { name: "公式" }).click();
    // サムネイルが描き上がる (紙面の描画が失敗していない)。
    await expect(cards.first().locator("img.template-gallery-card-image")).toBeVisible({ timeout: 60_000 });
    await cards.filter({ hasText: "赤チャート型 例題ページ" }).locator(".template-gallery-card-apply").click();
    await expect(gallery).toBeHidden();
    await expect.poll(async () => (await listFiles(page)).length).toBe(filesBefore.length + 1);
    const created = (await listFiles(page)).find((file) => !filesBefore.some((item) => item.fileId === file.fileId))!;
    expect(created.title).toMatch(/^赤チャート型.例題ページ$/);
    await page.keyboard.press("Escape");
    await expect(page.getByText("条件つきの最大・最小").first()).toBeVisible();
    const createdDocument = await loadDocument(page, created.fileId);
    expect(createdDocument?.pageLayout).toMatchObject({ pageSize: { widthMm: 148, heightMm: 210 } });
    const firstProblem = createdDocument?.content[0] as ProblemNode;
    expect(firstProblem.type).toBe("problem");
    expect((firstProblem.prompt[0] as BoxBlockNode).subtitle?.[0]).toMatchObject({ text: "例" });

    // 再起動しても同じ。
    await session.app.close();
    session = undefined;
    session = await launch(env);
    page = session.page;
    const reloaded = await loadDocument(page, created.fileId);
    expect(reloaded?.pageLayout).toMatchObject({ pageSize: { widthMm: 148, heightMm: 210 } });
    expect(reloaded?.content).toEqual(createdDocument?.content);

    // 公式素材: 元の教材で `/` から「共通テスト型 解答群」を挿す。
    await page.getByRole("tab", { name: /開いている教材/ }).click();
    const paragraph = page.getByText("前の本文").first();
    await paragraph.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/共通テスト型");
    const option = page.locator('.slash-command-option[data-command-kind="material"]', { hasText: "共通テスト型 解答群" }).first();
    await expect(option).toBeVisible();
    await option.click();
    await expect.poll(async () => JSON.stringify(await loadDocument(page, fixture.fileId)), { timeout: 30_000 }).toContain("⓪");

    // 参考書型の箱: `/` から「重要例題（赤チャート型）」を挿すと、★の難易度が見出し帯の右端に来て、そのまま保存される。
    await page.getByText("前の本文").first().click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/重要例題（赤");
    const boxOption = page.locator('.slash-command-option[data-command-kind="box"]', { hasText: "/chart-red-juyo" }).first();

    await expect(boxOption).toBeVisible();
    await boxOption.click();
    const inserted = page.locator('section[data-sigma-doc-type="boxBlock"].box-frame--title-ends').first();
    await expect(inserted).toBeVisible();
    const ends = await inserted.evaluate((box) => {
      const title = box.querySelector(".sigma-doc-box-title:not(.sigma-doc-box-subtitle)")!;
      const marks = Array.from(title.querySelectorAll<HTMLElement>("[style*='SigmaMarks']"));
      const titleRight = title.getBoundingClientRect().right - parseFloat(getComputedStyle(title).paddingRight);
      return { count: marks.length, gap: Math.round(titleRight - marks[marks.length - 1]!.getBoundingClientRect().right) };
    });
    expect(ends.count).toBe(2);
    expect(Math.abs(ends.gap)).toBeLessThanOrEqual(2);
    await expect.poll(async () => JSON.stringify(await loadDocument(page, fixture.fileId)), { timeout: 30_000 }).toContain('"styleId":"chart-red-juyo"');
  } finally {
    await session?.app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
