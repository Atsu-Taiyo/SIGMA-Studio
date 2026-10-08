import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import { ensurePageLayout, type OverlayShape, type SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;

function paragraph(id: string, text: string) {
  return { type: "paragraph" as const, id, children: [{ type: "text" as const, text }] };
}

function block(id: string, blockId: string): OverlayShape {
  return {
    id,
    type: "geo",
    x: 80,
    y: 200,
    rotation: 0,
    anchor: { type: "block", blockId, dy: 6 },
    props: { w: 60, h: 36, geo: "rectangle", fill: "solid", color: "#1133cc", labelColor: "#111111", dash: "solid", size: "m" },
  };
}

function sourceDocument(): SigmaDocument {
  const source = ensurePageLayout({
    ...sampleDocument,
    version: "2.0",
    docId: "electron_problem_display",
    metadata: { title: "表示の絞り込み 実機検証" },
    content: [
      paragraph("body_intro", "本文GOLF"),
      {
        type: "problem", id: "q1", tags: [],
        lead: [paragraph("q1_lead", "導入ALPHA")],
        prompt: [paragraph("q1_prompt", "問題文BRAVO")],
        hints: [paragraph("q1_hint", "コメントCHARLIE")],
        solution: [paragraph("q1_solution", "解答DELTA")],
      },
      {
        type: "problem", id: "q2", tags: [],
        lead: [],
        prompt: [paragraph("q2_prompt", "問題文ECHO")],
        hints: [],
        solution: [paragraph("q2_solution", "解答FOXTROT")],
      },
    ],
  });
  source.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [
    block("shape_in_prompt", "q1_prompt"),
    block("shape_in_solution", "q1_solution"),
  ] } };
  return source;
}

async function prepare(page: Page) {
  await page.waitForFunction(() => Boolean(window.desktopAPI));
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.evaluate(async () => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    await window.desktopAPI!.settings!.setUiLocale!("ja");
  });
  await page.reload();
  await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();
}

/** 設定 > 表示 を開く。表示サブメニューの中身は hover で出る。 */
async function openDisplayMenu(page: Page) {
  const settings = page.locator(".editor-menubar").getByRole("button", { name: "設定", exact: true });
  if ((await settings.getAttribute("aria-expanded")) !== "true") await settings.click();
  const trigger = page.getByRole("menuitem", { name: "表示", exact: true });
  await trigger.hover();
  return {
    problem: page.getByRole("menuitemcheckbox", { name: "問題", exact: true }),
    solution: page.getByRole("menuitemcheckbox", { name: "解答", exact: true }),
    hints: page.getByRole("menuitemcheckbox", { name: "コメント", exact: true }),
  };
}

async function closeMenu(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "設定" })).toHaveCount(0);
}

const surfacePages = (page: Page): Locator => page.locator("[data-problem-display-view] .paged-surface-pages");

test("設定 > 表示 で 問題 / 解答 / コメント を絞って見られ、教材は変わらない (実機)", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const userData = mkdtempSync(path.join(tmpdir(), "sigma-problem-display-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = userData;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${userData}`], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await prepare(page);
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), sourceDocument());
    await page.reload();
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="q1_solution"]')).toBeVisible();
    const fileId = created.file.fileId;
    const saved = () => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
    const before = await saved();

    // ふだんの表示: 3つともチェックが付いている。
    let menu = await openDisplayMenu(page);
    await expect(menu.problem).toHaveAttribute("aria-checked", "true");
    await expect(menu.solution).toHaveAttribute("aria-checked", "true");
    await expect(menu.hints).toHaveAttribute("aria-checked", "true");
    // メニューが開く動き (120ms) が終わってから撮る。
    await page.waitForTimeout(300);
    await page.screenshot({ path: testInfo.outputPath("01-menu-all-checked.png") });

    // 解答を外す = 問題 + コメント。メニューは開いたまま。
    await menu.solution.click();
    await expect(menu.solution).toHaveAttribute("aria-checked", "false");
    await expect(page.locator("[data-problem-display-view]")).toBeVisible();
    await expect(page.locator("[data-problem-display-view] [role=status]")).toContainText("問題・コメントだけを表示中");
    // チップは紙面を押し下げない (段を持たず、上部の真ん中に重なる)。
    const preview = page.locator("[data-problem-display-view]");
    const previewBox = (await preview.boundingBox())!;
    const scrollBox = (await preview.locator(".version-history-preview-scroll").boundingBox())!;
    const chipBox = (await preview.locator(".problem-display-chip").boundingBox())!;
    expect(scrollBox.y).toBeCloseTo(previewBox.y, 0);
    expect(chipBox.y + chipBox.height).toBeLessThan(previewBox.y + 48);
    expect(chipBox.x + chipBox.width / 2).toBeCloseTo(previewBox.x + previewBox.width / 2, 0);
    await expect(surfacePages(page)).toContainText("問題文BRAVO");
    await expect(surfacePages(page)).toContainText("コメントCHARLIE");
    await expect(surfacePages(page)).toContainText("本文GOLF");
    await expect(surfacePages(page)).not.toContainText("解答DELTA");
    await expect(surfacePages(page)).not.toContainText("解答FOXTROT");
    // 解答に錨を下ろした図は、解答と一緒に隠れる。問題文の図は残る。
    await expect(surfacePages(page).locator('[data-overlay-shape-id="shape_in_prompt"]')).not.toHaveCount(0);
    await expect(surfacePages(page).locator('[data-overlay-shape-id="shape_in_solution"]')).toHaveCount(0);
    await closeMenu(page);
    await page.screenshot({ path: testInfo.outputPath("02-problem-and-comment.png") });

    // 問題だけ: 最後の1つ (問題) は外せない。
    menu = await openDisplayMenu(page);
    await menu.hints.click();
    await expect(page.locator("[data-problem-display-view] [role=status]")).toContainText("問題だけを表示中");
    await expect(surfacePages(page)).not.toContainText("コメントCHARLIE");
    await expect(menu.problem).toBeDisabled();
    await closeMenu(page);
    await page.screenshot({ path: testInfo.outputPath("03-problem-only.png") });

    // 書き出しは絞り込みに従わない: PDF は出力プロファイルで決まり、画面の絞り込みでは減らない。
    await page.locator(".editor-menubar").getByRole("button", { name: "ファイル", exact: true }).click();
    await page.getByRole("menuitem", { name: "エクスポート", exact: true }).hover();
    await page.getByRole("menuitem", { name: "PDFを書き出し", exact: true }).click();
    const drawer = page.locator(".preview-drawer");
    await expect(drawer.locator(".paged-surface-pages")).toContainText("解答DELTA");
    await expect(drawer.locator(".paged-surface-pages")).toContainText("コメントCHARLIE");
    await drawer.getByRole("button", { name: "閉じる" }).click();
    await expect(drawer).toHaveCount(0);

    // 解答だけ: 問題の導入文・問題文は消え、解答が残る。番号は先頭の領域(解答)に付く。
    menu = await openDisplayMenu(page);
    await menu.solution.click();
    await menu.problem.click();
    await expect(menu.problem).toHaveAttribute("aria-checked", "false");
    await expect(page.locator("[data-problem-display-view] [role=status]")).toContainText("解答だけを表示中");
    await expect(surfacePages(page)).toContainText("解答DELTA");
    await expect(surfacePages(page)).toContainText("解答FOXTROT");
    await expect(surfacePages(page)).not.toContainText("導入ALPHA");
    await expect(surfacePages(page)).not.toContainText("問題文BRAVO");
    await expect(surfacePages(page)).not.toContainText("問題文ECHO");
    await expect(surfacePages(page).locator('[data-overlay-shape-id="shape_in_solution"]')).not.toHaveCount(0);
    await expect(surfacePages(page).locator('[data-overlay-shape-id="shape_in_prompt"]')).toHaveCount(0);
    await expect(surfacePages(page).locator(".problem-number-marker")).toHaveCount(2);
    await closeMenu(page);
    await page.screenshot({ path: testInfo.outputPath("04-solution-only.png") });

    // 絞り込み中は教材を書き換えない (読み取り専用)。
    expect((await saved())?.content).toEqual(before?.content);
    expect((await saved())?.pageLayout?.overlay).toEqual(before?.pageLayout?.overlay);

    // バナーのボタンで元に戻す。編集面が戻り、3つともチェックが付く。
    await page.locator("[data-problem-display-view]").getByRole("button", { name: "すべて表示に戻す" }).click();
    await expect(page.locator("[data-problem-display-view]")).toHaveCount(0);
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="q1_prompt"]')).toBeVisible();
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="q1_solution"]')).toBeVisible();
    menu = await openDisplayMenu(page);
    await expect(menu.problem).toHaveAttribute("aria-checked", "true");
    await expect(menu.solution).toHaveAttribute("aria-checked", "true");
    await expect(menu.hints).toHaveAttribute("aria-checked", "true");
    await closeMenu(page);
    await page.screenshot({ path: testInfo.outputPath("05-back-to-all.png") });

    // 戻したあとも、教材はまるごと同じ。再読み込みしてもふつうの表示 (絞り込みは保存しない)。
    expect((await saved())?.content).toEqual(before?.content);
    menu = await openDisplayMenu(page);
    await menu.problem.click();
    await expect(page.locator("[data-problem-display-view]")).toBeVisible();

    // 絞り込みは教材 (タブ) ごと: 新しい教材はふつうの表示で、元の教材へ戻ると絞ったまま。
    await page.getByRole("button", { name: "新規教材", exact: true }).click();
    await expect(page.locator(".document-tab")).toHaveCount(2);
    await expect(page.locator("[data-problem-display-view]")).toHaveCount(0);
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
    await page.locator(".document-tab-main").first().click();
    await expect(page.locator("[data-problem-display-view] [role=status]")).toContainText("解答・コメントだけを表示中");
    await page.reload();
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
    await expect(page.locator("[data-problem-display-view]")).toHaveCount(0);
    expect((await saved())?.content).toEqual(before?.content);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
