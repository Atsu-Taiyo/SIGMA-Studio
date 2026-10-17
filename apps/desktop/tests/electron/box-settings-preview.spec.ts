import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { BUILTIN_BOX_STYLES, createBoxBlock } from "@/lib/box-blocks";
import type { BoxBlockNode, SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const DEV_URL = process.env.SIGMA_STUDIO_DEV_SERVER_URL;

/**
 * 箱の設定のプレビューが「紙面の箱を縮めたもの」になっているか。全スタイルについて、紙面の箱と
 * プレビューの箱の縦横比・中身・読める大きさを比べ、設定の変更が紙面・保存・再読み込みまで同じ形で
 * 残ることを見る (#208)。
 */
test("box settings preview shows the box as it is drawn on the page", async ({}, testInfo) => {
  test.setTimeout(240_000);
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!DEV_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-box-preview-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    if (DEV_URL) expect(new URL(page.url()).origin).toBe(new URL(DEV_URL).origin);
    const content: BoxBlockNode[] = BUILTIN_BOX_STYLES.map((style) => createBoxBlock(style.id, `${style.id} の見出し`, {
      id: style.id, bodyId: `${style.id}-body`, bodyText: "本文の1行目です。枠の余白・角・線の太さを確かめます。",
    }));
    const styled = createBoxBlock("titlebox", "色と角を変えた箱", { id: "styled", bodyId: "styled-body", bodyText: "赤い本文" });
    styled.frame = {
      ...styled.frame, cornerStyle: "round", radiusPx: 16, borderWidthPx: 3,
      backgroundColor: "#fef3c7", titleBackgroundColor: "#1d4ed8", titleColor: "#ffffff", bodyColor: "#b91c1c",
      titlePosition: "c", paddingPx: { top: 30, right: 40, bottom: 24, left: 40 },
    };
    content.push(styled);
    const numbered = createBoxBlock("fancybox", "numbered の見出し", { id: "numbered", bodyId: "numbered-body", bodyText: "本文の1行目です。番号を確認します。" });
    numbered.blocks.push({ type: "problem", id: "numbered-problem", tags: [], numbering: { value: 7 }, lead: [], prompt: [{ type: "paragraph", id: "numbered-prompt", children: [{ type: "text", text: "箱の中の問題" }] }], solution: [], hints: [] });
    content.push(numbered);
    const document: SigmaDocument = {
      version: "2.0", docId: "box-settings-preview", metadata: { title: "箱の設定のプレビュー" }, content,
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    };
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const created = await api.createFileFromDocument({ document });
      await api.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, document);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await expect(page.locator('.page-flow [data-sigma-doc-id="fancybox"]')).toBeVisible();
    await page.evaluate(async () => { await window.document.fonts.ready; });

    const dialog = page.getByRole("dialog", { name: "ボックス設定" });
    const previewBox = dialog.getByTestId("box-live-preview").locator(".print-box-block");
    for (const box of content) {
      const paperBox = await openSettings(page, box.id);
      await expect(previewBox).toBeVisible();
      await expect(previewBox.locator(".print-box-title:not(.print-box-subtitle)")).toHaveText(box.id === "styled" ? "色と角を変えた箱" : `${box.id} の見出し`);
      await expect(previewBox.locator(".print-box-body")).toContainText(box.id === "styled" ? "赤い本文" : "本文の1行目です。");
      if (box.id === "numbered") {
        await expect(previewBox.locator(".print-problem-number")).toHaveText("7");
        await expect(page.locator('.page-flow [data-sigma-doc-id="numbered"]').first()).toContainText("7");
      }
      await dialog.getByTestId("box-live-preview").screenshot({ path: testInfo.outputPath(`${box.id}-preview.png`) });
      const preview = (await previewBox.boundingBox())!;
      // 同じ描画を同じ組版幅で組んで縮めただけなら、縦横比は紙面の箱と同じになる。
      const widthRatio = preview.width / paperBox.width;
      const heightRatio = preview.height / paperBox.height;
      expect.soft(Math.abs(widthRatio - heightRatio), `${box.id}: preview proportions differ from the page`).toBeLessThan(0.03);
      // 等倍近くで見せる (縮めすぎて線の太さや角丸が見分けられない、を戻さない)。
      expect.soft(widthRatio, `${box.id}: preview is too small to judge`).toBeGreaterThan(0.85);
      await dialog.getByRole("button", { name: "閉じる" }).click();
      await expect(dialog).toBeHidden();
    }

    // 設定を変えると、プレビューと紙面が同じ値で変わり、保存・再読み込み後も残る。
    await openSettings(page, "fancybox");
    await dialog.getByRole("group", { name: "角", exact: true }).getByRole("button", { name: "角丸", exact: true }).click();
    const radius = dialog.getByRole("spinbutton", { name: "角丸半径（px）", exact: true });
    await radius.fill("12");
    await radius.press("Tab");
    await dialog.getByRole("group", { name: "タイトル位置", exact: true }).getByRole("button", { name: "中央", exact: true }).click();
    await expect(previewBox).toHaveCSS("border-top-left-radius", "12px");
    await expect(previewBox.locator(".print-box-title").first()).toHaveCSS("text-align", "center");
    await page.screenshot({ path: testInfo.outputPath("dialog-adjusted.png") });
    await dialog.getByRole("button", { name: "閉じる" }).click();
    const paperFancybox = page.locator('.page-flow [data-sigma-doc-id="fancybox"]').first();
    await expect(paperFancybox).toHaveCSS("border-top-left-radius", "12px");
    await expect(paperFancybox.locator(".sigma-doc-box-title")).toHaveCSS("text-align", "center");
    await expect.poll(async () => {
      const saved = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
      const box = saved?.content.find((block) => block.id === "fancybox");
      return box?.type === "boxBlock" ? { corner: box.frame?.cornerStyle, radius: box.frame?.radiusPx, title: box.frame?.titlePosition } : null;
    }).toEqual({ corner: "round", radius: 12, title: "c" });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await expect(paperFancybox).toHaveCSS("border-top-left-radius", "12px");
    await openSettings(page, "fancybox");
    await expect(previewBox).toHaveCSS("border-top-left-radius", "12px");
    await page.screenshot({ path: testInfo.outputPath("dialog-reloaded.png") });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function openSettings(page: Page, boxId: string) {
  const element = page.locator(`.page-flow [data-sigma-doc-id="${boxId}"]`).first();
  await element.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const bounds = (await element.boundingBox())!;
  await page.locator(`.page-flow [data-sigma-doc-id="${boxId}"] .sigma-doc-box-body p`).first().click({ button: "right" });
  await page.locator(".page-context-menu").getByRole("menuitem", { name: "boxの設定…" }).click();
  await expect(page.getByRole("dialog", { name: "ボックス設定" })).toBeVisible();
  return bounds;
}
