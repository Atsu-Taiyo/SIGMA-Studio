import { expect, test, type Locator, type Page } from "@playwright/test";

import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 3D教材のUIが英語ロケールで英語になることの実測。
 *
 * 辞書側の検査 (`shape-resolution` / `english-no-japanese`) は「キーが英語で解決する」
 * ことしか見ない。ここは逆向きに、**実際に描かれた3D設定パネルとひな形選択に
 * 日本語が1文字も出ない**ことを面で固定する (graph3dはWI後に日本語直書きで
 * 作られ、ゲートを304違反まで溜めた前科があるため)。
 */
const GRAPH3D_ENGLISH_DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_e2e_graph3d_english",
  metadata: { title: "3D english e2e" },
  content: [
    {
      type: "paragraph",
      id: "p_e2e_graph3d_english_intro",
      children: [{ type: "text", text: "3D english locale check" }],
    },
  ],
  outputProfiles: {
    student: {},
    teacher: { showSolutions: true, showHints: true },
    answerBook: { includeAnswers: true, onlySolutions: true },
  },
};

const JAPANESE = /[぀-ヿ㐀-鿿]/u;

test.beforeEach(async ({ page }) => {
  await installDesktopRuntimeMock(page, GRAPH3D_ENGLISH_DOCUMENT);
  // 保存値はブラウザロケールより優先される。アプリのスクリプトが動く前に仕込む。
  await page.addInitScript(() => {
    window.localStorage.setItem("sigma-studio:ui-locale", "en");
  });
  await page.setViewportSize({ width: 1440, height: 960 });
});

test("renders the 3D settings panel in English without any Japanese", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Ready")).toBeVisible();

  const graph = await insertGraph3D(page);
  await expect(graph.getByTestId("graph3d-preview")).toBeVisible();

  const panel = page.getByRole("dialog", { name: "3D figure settings" });
  await expect(panel).toBeVisible();

  // ひな形の選択肢・オブジェクト一覧・表示セクションまで英語で揃っていること。
  await expect(panel.getByText("Templates")).toBeVisible();
  await expect(panel.getByText("Parameters & animation")).toBeVisible();
  await expect(panel.getByText("3D objects")).toBeVisible();

  const panelText = (await panel.innerText()).replace(/\s+/g, " ");
  expect(panelText.match(JAPANESE)?.[0] ?? "").toBe("");
});

async function insertGraph3D(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Insert", exact: true }).click();
  const insertMenu = page.getByRole("menu", { name: "Insert", exact: true });
  await expect(insertMenu).toBeVisible();
  await insertMenu.getByRole("menuitem", { name: "3D figure" }).click();

  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  const startX = surfaceBox!.x + 120;
  const startY = surfaceBox!.y + 150;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 320, startY + 210, { steps: 10 });
  await page.mouse.up();

  const graph = page.getByTestId("overlay-graph3d").first();
  await expect(graph).toBeVisible();
  return graph;
}
