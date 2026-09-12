import { expect, test, type Page } from "@playwright/test";

import { normalizePageLayout } from "@/lib/page-layout";
import type { SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 本文を全部消しても入力を続けられること。
 *
 * 本文ブロックが 0 件の文書は本文エディタが 1 つも生まれず、クリックしても打鍵しても
 * 何も起きない行き止まりになる (`buildRenderUnits` がユニット 0 件を返す)。削除の経路
 * ごとに「最後の 1 ブロックを消した直後」と「空のまま保存された教材を開いた直後」を見る。
 */

function paragraph(id: string, text: string): SigmaBlock {
  return { type: "paragraph", id, children: text ? [{ type: "text", text }] : [] } as SigmaBlock;
}

function createDocument(content: SigmaBlock[]): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_empty_body_recovery",
    metadata: { title: "empty body recovery" },
    pageLayout: normalizePageLayout({ preset: "A4", orientation: "portrait" }),
    content,
    outputProfiles: {
      student: { showSolutions: false, showHints: false, includeAnswers: false },
      teacher: { showSolutions: true, showHints: true, includeAnswers: true, includeComments: true },
      answerBook: { showSolutions: true, showHints: false, includeAnswers: true, onlySolutions: true },
    },
  } as SigmaDocument;
}

async function openDocument(page: Page, content: SigmaBlock[]) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, createDocument(content));
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
}

/** クリックし直さずに打てること = 削除の続きにそのまま書ける、を見る。 */
async function expectBodyAcceptsTyping(page: Page) {
  await expect(page.locator(".text-flow-editor p")).toHaveCount(1);
  await page.keyboard.type("あいう");
  await expect(page.locator(".page-flow")).toContainText("あいう");
}

async function deleteBlockFromHandleMenu(page: Page, text: string) {
  const target = page.locator(".text-flow-editor p").filter({ hasText: text }).first();
  const box = (await target.boundingBox())!;
  // ハンドルは「そのブロックにポインタが乗っている間」だけ出る。前のメニューを閉じた直後は
  // ポインタが動いていないので、一度離してから左端へ寄せる。
  await page.mouse.move(box.x + 300, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(box.x + 10, box.y + box.height / 2, { steps: 3 });
  const handle = page.locator(".page-block-handle");
  await expect(handle).toBeVisible();
  await handle.click();
  await page.getByText("この段落を削除").click();
}

test("段落を1つずつ全部消しても、そのまま入力できる", async ({ page }) => {
  await openDocument(page, [paragraph("p1", "一行目"), paragraph("p2", "二行目"), paragraph("p3", "三行目")]);

  for (const text of ["一行目", "二行目", "三行目"]) {
    await deleteBlockFromHandleMenu(page, text);
  }

  await expect(page.locator(".text-flow-editor p")).toHaveCount(1);
  await expectBodyAcceptsTyping(page);
});

test("最後の段落をブロック選択して Delete しても、そのまま入力できる", async ({ page }) => {
  await openDocument(page, [paragraph("p1", "一行目")]);

  const target = page.locator(".text-flow-editor p").filter({ hasText: "一行目" }).first();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await expect(page.locator(".page-block-handle")).toBeVisible();
  await page.locator(".page-block-handle").click();
  await page.keyboard.press("Delete");

  await expectBodyAcceptsTyping(page);
});

test("本文を全選択して消しても、そのまま入力できる", async ({ page }) => {
  await openDocument(page, [paragraph("p1", "一行目"), paragraph("p2", "二行目"), paragraph("p3", "三行目")]);

  await page.locator(".text-flow-editor p").filter({ hasText: "一行目" }).first().click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");

  // 全選択削除は段落を id ごと作り直すので、本文がエディタへ流れ直すまで待ってから打つ。
  // この最中に割り込んだ打鍵が飲まれるのは本件とは別の既存挙動 (main でも同じ)。
  await expect(page.locator(".text-flow-editor p")).toHaveCount(1);
  await page.waitForTimeout(1500);
  await expectBodyAcceptsTyping(page);
});

test("全消し → 書く → もう一度全消し、を繰り返しても入力できる", async ({ page }) => {
  await openDocument(page, [paragraph("p1", "一行目"), paragraph("p2", "二行目")]);

  for (const texts of [["一行目", "二行目"], ["あいう"]]) {
    for (const text of texts) {
      await deleteBlockFromHandleMenu(page, text);
    }
    await expectBodyAcceptsTyping(page);
  }
});

test("全消しのあと放置しても段落が増えたり減ったりしない", async ({ page }) => {
  await openDocument(page, [paragraph("p1", "一行目"), paragraph("p2", "二行目")]);

  for (const text of ["一行目", "二行目"]) {
    await deleteBlockFromHandleMenu(page, text);
  }

  // 補った空段落が「増える → 消える」を繰り返すと、そのまま自走ループになる。
  await expect(page.locator(".text-flow-editor p")).toHaveCount(1);
  await page.waitForTimeout(4000);
  await expect(page.locator(".text-flow-editor p")).toHaveCount(1);
});

test("本文が空のまま保存された教材を開いても入力できる", async ({ page }) => {
  await openDocument(page, []);

  await page.locator(".text-flow-editor p").first().click();
  await expectBodyAcceptsTyping(page);
});
