import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

function createChunkedDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_text_run_span_input";
  document.metadata = { ...document.metadata, title: "本文跨ぎ選択の連続入力 E2E" };
  // チャンク規則 (text-run-chunking.ts: target 40 / max 80 / min 10) で確実に 2 エディタに
  // なる段落数。80 段落 → sliceEvery(40) = [40, 40]、どちらも min 以上なので併合されない。
  // (41 段落だと [40, 1] の後ろが mergeSmallChunks で吸収され 1 エディタになる。)
  document.content = Array.from({ length: 80 }, (_, index) => ({
    type: "paragraph" as const,
    id: `text_run_input_${index}`,
    children: [{ type: "text" as const, text: `段落 ${index + 1}` }],
  }));
  return document;
}

async function openEditor(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, createChunkedDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 });
  await expect(page.locator(".text-flow-editor")).toHaveCount(2);
}

/**
 * ポインタドラッグでチャンク境界 (段落 40 | 41) を跨ぐ選択を張る。「段落 40」の先頭から
 * `endParagraphId` の末尾まで。⌘A と違い、PM が mousedown 中の dispatch を DOM 選択へ
 * 同期しない経路を踏む。
 */
async function dragCrossEditorSelection(page: Page, endParagraphId: string): Promise<void> {
  const start = page.locator('[data-sigma-doc-id="text_run_input_39"]');
  const end = page.locator(`[data-sigma-doc-id="${endParagraphId}"]`);
  await page.locator('[data-sigma-doc-id="text_run_input_40"]').scrollIntoViewIfNeeded();
  const startBox = await start.boundingBox();
  const endBox = await end.boundingBox();
  if (!startBox || !endBox) {
    throw new Error("チャンク境界前後の段落が画面に無い");
  }
  await page.mouse.move(startBox.x + 1, startBox.y + startBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    endBox.x + endBox.width - 1,
    endBox.y + endBox.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(page.locator(".text-flow-editor[data-text-run-span]")).toHaveCount(2);
  // 跨ぎ選択の描画は CSS Custom Highlight (`::highlight(text-run-span)`) に登録される。
  await expect.poll(() => page.evaluate(() => CSS.highlights.has("text-run-span"))).toBe(true);
}

test("a drag selection contained in a single chunk stays visible and is replaced by typing", async ({ page }) => {
  await openEditor(page);
  // 「段落 3」〜「段落 6」(すべて先頭チャンク内) をドラッグ選択。span は張られず、焦点
  // エディタのネイティブ DOM 選択が帯を描く — PM は mousedown 中の dispatch を DOM 選択へ
  // 同期しないため、applySpan の単一ユニット分岐が自前で張らないと選択が完全に不可視のまま
  // 状態選択にだけ残り、次の打鍵が見えない範囲を置換してしまう (リグレッション対象)。
  const start = page.locator('[data-sigma-doc-id="text_run_input_2"]');
  const end = page.locator('[data-sigma-doc-id="text_run_input_5"]');
  const startBox = await start.boundingBox();
  const endBox = await end.boundingBox();
  if (!startBox || !endBox) {
    throw new Error("ドラッグ対象の段落が画面に無い");
  }
  await page.mouse.move(startBox.x + 1, startBox.y + startBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(endBox.x + endBox.width - 1, endBox.y + endBox.height / 2, { steps: 8 });

  // mouseup 前 (ドラッグ中) から DOM 選択が張られて見えている。
  await expect.poll(() => page.evaluate(() => {
    const selection = window.getSelection();
    return selection && !selection.isCollapsed ? selection.toString() : "";
  })).toContain("段落 4");

  await page.mouse.up();
  await expect(page.locator(".text-flow-editor[data-text-run-span]")).toHaveCount(0);
  const selectedText = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selectedText).toContain("段落 3");
  expect(selectedText).toContain("段落 6");

  // 見えている選択がそのまま置換される。
  await page.keyboard.type("x");
  await expect.poll(async () => (
    (await page.locator(".text-flow-editor").allTextContents()).join("")
  )).toContain("段落 2x段落 7");
});

test("a double-click drag in a chunked document extends the selection word by word", async ({ page }) => {
  await openEditor(page);
  // 「段落 3」の単語「段落」をダブルクリックしてから「段落 5」の 1 文字目 (単語「段落」の
  // 途中) までドラッグ。head も mousedown と同じ単語粒度で伸びるので、選択は単語境界
  // (「段落」の直後) まで — 1 文字単位に落ちると単一チャンク文書のネイティブ挙動と割れる。
  const start = page.locator('[data-sigma-doc-id="text_run_input_2"]');
  const target = page.locator('[data-sigma-doc-id="text_run_input_4"]');
  const charCenter = async (paragraph: typeof start, index: number) => (
    paragraph.evaluate((element, charIndex) => {
      const textNode = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
      if (!textNode) {
        throw new Error("テキストノードが無い");
      }
      const range = document.createRange();
      range.setStart(textNode, charIndex);
      range.setEnd(textNode, charIndex + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, index)
  );
  const startPoint = await charCenter(start, 0);
  const targetPoint = await charCenter(target, 0);

  await page.mouse.move(startPoint.x, startPoint.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 6 });
  await page.mouse.up();

  await expect(page.locator(".text-flow-editor[data-text-run-span]")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const selection = window.getSelection();
    return selection && !selection.isCollapsed ? selection.toString() : "";
  })).toContain("段落 4");

  // 「段落 5」は単語「段落」までが選択され、残り「 5」が置換後に生き残る。
  await page.keyboard.type("x");
  await expect.poll(async () => (
    await page.locator('[data-sigma-doc-id="text_run_input_2"]').textContent()
  )).toBe("x 5");
  await expect(page.locator('[data-sigma-doc-id="text_run_input_3"]')).toHaveCount(0);
});

for (const side of ["left", "right"] as const) {
  test(`dragging into the ${side} margin keeps selection on the pointer's line`, async ({ page }) => {
    await openEditor(page);
    const paragraph = page.locator('[data-sigma-doc-id="text_run_input_2"]');
    const box = await paragraph.boundingBox();
    if (!box) throw new Error("本文が画面に無い");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 20, y);
    await page.mouse.down();
    await page.mouse.move(side === "left" ? box.x - 12 : box.x + box.width + 12, y, { steps: 8 });
    await expect(page.locator(".text-flow-editor[data-text-run-span]")).toHaveCount(0);
    await page.mouse.up();
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected.length).toBeGreaterThan(0);
    expect(selected).not.toContain("段落 4");
    expect(selected).not.toContain("段落 2");
    await page.keyboard.type("x");
    await expect(paragraph).toContainText("x");
    await expect(page.locator('[data-sigma-doc-id="text_run_input_3"]')).toHaveText("段落 4");
    await expect(page.locator('[data-sigma-doc-id="text_run_input_79"]')).toHaveText("段落 80");
  });
}

for (const [startIndex, endIndex] of [[2, 5], [39, 40]]) {
  test(`dragging back to the starting caret clears the range before typing (${startIndex} to ${endIndex})`, async ({ page }) => {
    await openEditor(page);
    const paragraph = page.locator(`[data-sigma-doc-id="text_run_input_${startIndex}"]`);
    const endParagraph = page.locator(`[data-sigma-doc-id="text_run_input_${endIndex}"]`);
    await endParagraph.scrollIntoViewIfNeeded();
    const start = await paragraph.evaluate((element) => {
      const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange();
      range.setStart(text, 2);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y + rect.height / 2 };
    });
    const end = await endParagraph.boundingBox();
    if (!end) throw new Error("本文が画面に無い");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x + 40, end.y + end.height / 2, { steps: 8 });
    await expect.poll(() => page.evaluate(() => (
      !window.getSelection()?.isCollapsed || CSS.highlights.has("text-run-span")
    ))).toBe(true);
    await page.mouse.move(start.x, start.y, { steps: 8 });
    await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
    await expect(page.locator(".text-flow-editor[data-text-run-span]")).toHaveCount(0);
    await page.mouse.up();
    await page.keyboard.type("x");
    await expect(paragraph).toHaveText(`段落x ${startIndex + 1}`);
    await expect(endParagraph).toHaveText(`段落 ${endIndex + 1}`);
  });
}

test("keeps the second typed character after replacing a cross-editor selection", async ({ page }) => {
  await openEditor(page);
  await page.locator('[data-sigma-doc-id="text_run_input_0"]').click();
  await page.keyboard.press("ControlOrMeta+A");

  await expect(page.locator(".text-flow-editor[data-text-run-span]")).toHaveCount(2);
  await page.keyboard.type("xy");

  await expect.poll(async () => (
    (await page.locator(".text-flow-editor").allTextContents()).join("")
  )).toBe("xy");
});

test("IME composition over a cross-editor selection inserts the composed text", async ({ page }) => {
  await openEditor(page);
  await page.locator('[data-sigma-doc-id="text_run_input_0"]').click();
  await page.keyboard.press("ControlOrMeta+A");
  await expect(page.locator(".text-flow-editor[data-text-run-span]")).toHaveCount(2);

  // CDP の IME 合成イベントで日本語入力を再現する。compositionstart で跨ぎ選択が解除され、
  // 焦点エディタ以外の担当分が消え、合成テキストは焦点エディタのネイティブ選択を置換する
  // (合成セッションは切れない = 確定文字が落ちない)。
  const client = await page.context().newCDPSession(page);
  await client.send("Input.imeSetComposition", { text: "あ", selectionStart: 1, selectionEnd: 1 });
  // 合成開始で span は即解除される (置換は合成テキスト側が担う)。
  await expect(page.locator(".text-flow-editor[data-text-run-span]")).toHaveCount(0);
  await client.send("Input.imeSetComposition", { text: "あい", selectionStart: 2, selectionEnd: 2 });
  await client.send("Input.insertText", { text: "あい" });

  await expect.poll(async () => (
    (await page.locator(".text-flow-editor").allTextContents()).join("")
  )).toBe("あい");

  // 合成後の通常打鍵も落ちない (握りつぶしフラグの残留が無い)。
  await page.keyboard.type("う");
  await expect.poll(async () => (
    (await page.locator(".text-flow-editor").allTextContents()).join("")
  )).toBe("あいう");
});

test("IME composition over a drag-made cross-editor selection replaces the whole span", async ({ page }) => {
  await openEditor(page);
  // ドラッグ起点: ⌘A と違い、焦点エディタの DOM 選択が mousedown 位置に collapsed の
  // まま残る経路 (PM はドラッグ中の dispatch を DOM 選択へ同期しない)。mouseup で
  // 担当範囲へ同期し直していないと、確定テキストがアンカー位置に入り選択分が残る。
  // 終点は「段落 41」(隣チャンクの先頭ブロック) のテキスト末尾 — 先頭ブロックごと消すと
  // チャンク境界のアンカーが死んで合成中にチャンクが併合される (既知の別問題) ため。
  await dragCrossEditorSelection(page, "text_run_input_40");

  const client = await page.context().newCDPSession(page);
  await client.send("Input.imeSetComposition", { text: "あ", selectionStart: 1, selectionEnd: 1 });
  await expect(page.locator(".text-flow-editor[data-text-run-span]")).toHaveCount(0);
  await client.send("Input.imeSetComposition", { text: "あい", selectionStart: 2, selectionEnd: 2 });
  await client.send("Input.insertText", { text: "あい" });

  // 選択範囲全体 (段落 40〜41 のテキスト) が消え、合成テキストだけが入る。
  await expect.poll(async () => (
    await page.locator('[data-sigma-doc-id="text_run_input_39"]').textContent()
  )).toBe("あい");
  // 端点段落は compositionend 後に打鍵と同じく境界結合される (finishTextRunSpanComposition)。
  // 合成中は空段落が残るが、確定後は打鍵の置換と同じ最終文書 (空段落なし) になる。
  await expect(page.locator('[data-sigma-doc-id="text_run_input_40"]')).toHaveCount(0);
  await expect(page.locator('[data-sigma-doc-id="text_run_input_41"]')).toHaveText("段落 42");

  // 合成セッションは切れていない (続けての打鍵も同じ段落へ入る)。
  await page.keyboard.type("う");
  await expect.poll(async () => (
    await page.locator('[data-sigma-doc-id="text_run_input_39"]').textContent()
  )).toBe("あいう");
});

test("one undo restores the document after IME replaces a drag-made cross-editor selection", async ({ page }) => {
  await openEditor(page);
  await dragCrossEditorSelection(page, "text_run_input_40");

  const client = await page.context().newCDPSession(page);
  await client.send("Input.imeSetComposition", { text: "あ", selectionStart: 1, selectionEnd: 1 });
  await client.send("Input.insertText", { text: "あ" });
  await expect.poll(async () => (
    await page.locator('[data-sigma-doc-id="text_run_input_39"]').textContent()
  )).toBe("あ");
  await expect(page.locator('[data-sigma-doc-id="text_run_input_40"]')).toHaveCount(0);

  // 他ユニットの削除・合成挿入・境界結合が 1 つの undo グループに載る。Cmd+Z 1 回で
  // 「合成消滅 + 旧テキスト復活 + 他チャンク削除のまま」の中間状態を経ずに完全復元する。
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (
    await page.locator('[data-sigma-doc-id="text_run_input_39"]').textContent()
  )).toBe("段落 40");
  await expect(page.locator('[data-sigma-doc-id="text_run_input_40"]')).toHaveText("段落 41");
  await expect(page.locator('[data-sigma-doc-id="text_run_input_41"]')).toHaveText("段落 42");
  await expect.poll(async () => (
    (await page.locator(".text-flow-editor").allTextContents()).join("")
  )).not.toContain("あ");
});

test("clicking the page margin clears a cross-editor span and re-enables editing", async ({ page }) => {
  await openEditor(page);
  await page.locator('[data-sigma-doc-id="text_run_input_0"]').click();
  await page.keyboard.press("ControlOrMeta+A");
  await expect(page.locator(".text-flow-editor[data-text-run-span]")).toHaveCount(2);

  // ページ余白 (本文カラムの左外) をクリック。単一エディタの「余白クリックで選択解除」と
  // 同じく span が消える — 以前は帯が出たまま Escape も文字入力も効かなくなっていた。
  const paragraph = page.locator('[data-sigma-doc-id="text_run_input_2"]');
  const paragraphBox = await paragraph.boundingBox();
  const canvasBox = await page.locator(".page-canvas").boundingBox();
  if (!paragraphBox || !canvasBox) {
    throw new Error("余白クリックの基準要素が画面に無い");
  }
  await page.mouse.click(
    (canvasBox.x + paragraphBox.x) / 2,
    paragraphBox.y + paragraphBox.height / 2,
  );
  await expect(page.locator(".text-flow-editor[data-text-run-span]")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => CSS.highlights.has("text-run-span"))).toBe(false);

  // 解除後は本文クリック + 入力が普通に効く (操作不能の再発防止)。
  await paragraph.click();
  await page.keyboard.type("x");
  await expect.poll(async () => (
    await paragraph.textContent()
  )).toContain("x");
  // 選択は解除済みなので、他の段落は置換されず残っている。
  await expect(page.locator('[data-sigma-doc-id="text_run_input_0"]')).toHaveText("段落 1");
});

test("ribbon bold and ⌘I format the whole drag-made cross-editor selection", async ({ page }) => {
  await openEditor(page);
  // 跨ぎドラッグは mousedown/mouseup のターゲットが別エディタになり、click が共通祖先で
  // 発火する。そこで選択解除されるとリボンの書式ボタンが disabled になる (F3)。
  await dragCrossEditorSelection(page, "text_run_input_41");

  const boldButton = page.getByRole("button", { name: "太字", exact: true }).first();
  await expect(boldButton).toBeEnabled();
  await boldButton.click();

  // 範囲全体 (両エディタの担当分) に太字が付き、トグル状態も点灯する。
  await expect(page.locator('[data-sigma-doc-id="text_run_input_39"] strong')).toHaveText("段落 40");
  await expect(page.locator('[data-sigma-doc-id="text_run_input_41"] strong')).toHaveText("段落 42");
  await expect(page.locator('[data-sigma-doc-id="text_run_input_0"] strong')).toHaveCount(0);
  await expect(boldButton).toHaveAttribute("aria-pressed", "true");

  // キーボード経路 (⌘I) も span 全体へ効く。
  await page.keyboard.press("ControlOrMeta+i");
  await expect(page.locator('[data-sigma-doc-id="text_run_input_39"] em')).toHaveText("段落 40");
  await expect(page.locator('[data-sigma-doc-id="text_run_input_41"] em')).toHaveText("段落 42");
  await expect(page.locator('[data-sigma-doc-id="text_run_input_0"] em')).toHaveCount(0);
});
