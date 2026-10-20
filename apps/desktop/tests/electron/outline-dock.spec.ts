import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { createBlankDocument } from "@/lib/blank-document";
import type { SigmaDocument } from "@/types/sigma-doc";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;

/**
 * アウトラインは、メニューやダイアログではなく、キャンバス左上の AI タスクの入口の真下の丸いアイコンから
 * 開くカード。
 * - 見出しのある教材では AI タスクの入口の下にアイコンが出て、ホバーで見出しの一覧が開く
 * - 項目を押すとその見出しへ移って選択し (選択はすぐ消えない)、カードは閉じる
 * - 「設定」メニューにアウトラインは無く、コマンドパレットの「アウトラインを表示」で同じカードが開く
 * - 見出しも問題も無い教材では入口自体が出ない
 */
function materialWithHeadings(): SigmaDocument {
  const document = createBlankDocument("アウトラインの検証");
  const filler = "二次関数のグラフと平方完成について、順を追って確認します。".repeat(4);
  const content: SigmaDocument["content"] = [];
  for (let index = 1; index <= 4; index += 1) {
    content.push({ type: "heading", id: `h_${index}`, level: 1, children: [{ type: "text", text: `第${index}節 見出し` }] });
    content.push({ type: "heading", id: `h_${index}_sub`, level: 2, children: [{ type: "text", text: `小見出し ${index}` }] });
    for (let line = 0; line < 8; line += 1) {
      content.push({ type: "paragraph", id: `p_${index}_${line}`, children: [{ type: "text", text: filler }] });
    }
  }
  return { ...document, content };
}

/** 教材を 1 つ作って開いた状態の Electron を起こし、`run` に渡す。終わったら閉じて profile を消す。 */
async function withMaterial(document: SigmaDocument, run: (page: Page) => Promise<void>): Promise<void> {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-outline-dock-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${profile}`], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    const body = page.locator(".page-flow .ProseMirror").first();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await expect(body).toBeVisible();
    await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
    });
    await page.evaluate((next) => window.desktopAPI!.storage.createFileFromDocument({ document: next }), document);
    await page.reload();
    await expect(body).toBeVisible();
    await page.locator(".startup-splash").waitFor({ state: "hidden" }).catch(() => undefined);
    await run(page);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

test.beforeEach(() => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
});

test("outline card opens from the icon under the AI task entry, jumps to a heading and keeps it selected", async ({}, testInfo) => {
  await withMaterial(materialWithHeadings(), async (page) => {
    const dock = page.locator("[data-outline-dock]");
    const toggle = dock.locator("button[aria-expanded]");
    await expect(toggle).toBeVisible();

    // AI タスクの入口の真下 (32px のアイコン + 8px の間隔)。
    const aiBox = (await page.locator(".ai-task-dock-toggle").boundingBox())!;
    const outlineBox = (await toggle.boundingBox())!;
    expect(outlineBox.x).toBeCloseTo(aiBox.x, 0);
    expect(outlineBox.y - (aiBox.y + aiBox.height)).toBeCloseTo(8, 0);

    await toggle.hover();
    const card = dock.getByRole("region", { name: "アウトライン", exact: true });
    await expect(card).toBeVisible();
    await expect(card.getByRole("button")).toContainText(["第1節 見出し", "小見出し 1", "第2節 見出し", "小見出し 2", "第3節 見出し", "小見出し 3", "第4節 見出し", "小見出し 4"]);
    // H2 は H1 より一段下がる。
    expect(await card.locator("nav button").evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).dataset.depth))).toEqual(["0", "1", "0", "1", "0", "1", "0", "1"]);
    await page.screenshot({ path: testInfo.outputPath("outline-card.png") });

    // 項目を押すと、その見出しが見える位置へ移って選択され、カードは閉じる。
    await card.getByRole("button", { name: "第3節 見出し" }).click();
    const heading = page.locator("#h_3, [data-sigma-doc-id='h_3']").first();
    await expect.poll(async () => {
      const box = await heading.boundingBox();
      const viewportHeight = await page.evaluate(() => window.innerHeight);
      return box !== null && box.y > 120 && box.y + box.height < viewportHeight;
    }).toBe(true);
    await page.mouse.move(900, 600);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.hover();
    await expect(card.locator("[aria-current='location']")).toHaveText("第3節 見出し");
    await page.screenshot({ path: testInfo.outputPath("outline-after-jump.png") });
    await page.mouse.move(900, 600);

    // 設定メニューにアウトラインは無い。
    await page.getByRole("button", { name: "設定", exact: true }).first().click();
    await expect(page.getByRole("menuitem", { name: "アウトラインを表示" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // コマンドパレットからは同じカードが開き、キーボードで閉じられる。
    await page.mouse.click(900, 700);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+P" : "Control+P");
    await page.getByRole("combobox").fill("アウトライン");
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(card).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest("[data-outline-dock]")))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

test("no outline entry for a material without headings or problems", async () => {
  const material = { ...createBlankDocument("見出しなし"), content: [{ type: "paragraph", id: "p_only", children: [{ type: "text", text: "本文だけ" }] }] } as SigmaDocument;
  await withMaterial(material, async (page) => {
    await expect(page.locator(".ai-task-dock-toggle")).toBeVisible();
    await expect(page.locator("[data-outline-dock]")).toHaveCount(0);
  });
});
