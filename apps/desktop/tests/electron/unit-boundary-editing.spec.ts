import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { ParagraphNode, SigmaBlock, SigmaDocument } from "@/features/document";

/**
 * 本文の編集単位 (チャンク・問題の区分) の境目で起きていた 2 つの不具合を実機で固定する。
 *
 * 1. 単位の先頭の段落の行頭で Enter を押すと、新しい空行がフォーカス中のエディタの外 (前の単位や
 *    単独の単位) へ回り、空行が二重に描かれ、そこへ打った文字も二重に見え、余分な空行が保存された。
 *    文書の先頭ではキャレットごと消えた。
 * 2. 数式の上から押し始めたドラッグは、数式のある単位の中でしか伸びなかった。
 */

const APP_ROOT = path.resolve(__dirname, "../..");

async function launch(content: SigmaBlock[]): Promise<{ app: ElectronApplication; page: Page; fileId: string; profile: string }> {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-unit-boundary-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  const page = await app.firstWindow();
  await (await app.browserWindow(page)).evaluate(window => window.setContentSize(1200, 900));
  await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
  const source: SigmaDocument = {
    version: "2.0", docId: "unit_boundary_editing",
    metadata: { title: "単位の境目", styleUnits: { fontSize: "pt" } },
    content,
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
  const fileId = await page.evaluate(async document => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    await window.desktopAPI!.settings!.setUiLocale!("ja");
    const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
    await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
    return file.fileId;
  }, source);
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.evaluate(() => document.fonts.ready);
  return { app, page, fileId, profile };
}

function paragraph(id: string, text: string): ParagraphNode {
  return { type: "paragraph", id, children: [{ type: "text", text }] };
}

async function caretAtStart(page: Page, id: string): Promise<void> {
  const block = page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first();
  await block.scrollIntoViewIfNeeded();
  // 段落の中央は、紙面の上に浮かぶ選択のバー (AI に依頼・コメント) と重なることがある。
  await block.click({ position: { x: 4, y: 6 } });
  // macOS の合成 Meta+ArrowLeft は当てにならないので、DOM の選択を直接置く。
  await block.evaluate(el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    getSelection()!.collapse(walker.nextNode(), 0);
  });
  // DOM の選択は selectionchange で遅れて ProseMirror へ届く。届く前に打鍵すると、クリックした
  // 位置 (段落の途中) で効いてしまう。
  await expect.poll(() => block.evaluate(el => {
    const editor = (el.closest(".ProseMirror") as (Element & {
      editor?: { state: { selection: { empty: boolean; $from: { parentOffset: number; parent: { attrs: Record<string, unknown> } } } } };
    }) | null)?.editor;
    const selection = editor?.state.selection;
    return Boolean(selection?.empty && selection.$from.parentOffset === 0
      && selection.$from.parent.attrs.sigmaDocId === el.getAttribute("data-sigma-doc-id"));
  })).toBe(true);
}

async function savedTexts(page: Page, fileId: string): Promise<string[]> {
  await page.keyboard.press("ControlOrMeta+s");
  const saved = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
  return (saved?.content ?? []).map(block => block.type === "paragraph"
    ? block.children.map(run => run.type === "text" ? run.text : "").join("")
    : `<${block.type}>`);
}

/** 紙面に描かれている本文ブロックの文字 (同じブロックが二つの編集面に描かれると二重に数える)。 */
async function drawnTexts(page: Page): Promise<string[]> {
  return page.locator(".page-flow .ProseMirror > p").evaluateAll(nodes => nodes.map(node => node.textContent ?? ""));
}

test("Enter at the start of a later unit's first paragraph adds one blank line inside that unit", async () => {
  const content = Array.from({ length: 90 }, (_, index) => paragraph(`b${index}`, `段落${index}`));
  const { app, page, fileId, profile } = await launch(content);
  try {
    await expect(page.locator('[data-flow-unit-id="b40"]')).toHaveCount(1);
    await caretAtStart(page, "b40");
    await page.keyboard.press("Enter");
    await expect.poll(async () => {
      const texts = await drawnTexts(page);
      return texts.slice(texts.indexOf("段落39"), texts.indexOf("段落40") + 1);
    }).toEqual(["段落39", "", "段落40"]);
    // この回帰は空行の所属と保存を検証する。矢印キーの非同期な行移動に依存せず、
    // 同じ編集単位に追加された空行へカーソルを置く（元の不具合ならここで落ちる）。
    const unitAfterEnter = page.locator(".page-flow [data-flow-unit-id]:has(.ProseMirror-focused)");
    await expect(unitAfterEnter.locator('[data-sigma-doc-id="b40"]')).toHaveCount(1);
    const blank = unitAfterEnter.locator("p[data-sigma-doc-id]").first();
    await expect(blank).toHaveText("");
    const blankId = await blank.getAttribute("data-sigma-doc-id");
    expect(blankId).toBeTruthy();
    await caretAtStart(page, blankId!);
    await page.keyboard.type("テスト");

    await expect.poll(() => drawnTexts(page).then(texts => texts.filter(text => text === "テスト").length)).toBe(1);
    const drawn = await drawnTexts(page);
    expect(drawn.slice(drawn.indexOf("段落39"), drawn.indexOf("段落40") + 1)).toEqual(["段落39", "テスト", "段落40"]);
    // 打った文字はフォーカス中のエディタに入り、そのエディタが空行と元の先頭段落を一緒に持つ。
    const focusedUnit = page.locator(".page-flow [data-flow-unit-id]:has(.ProseMirror-focused)");
    await expect(focusedUnit).toContainText("テスト");
    await expect(focusedUnit.locator('[data-sigma-doc-id="b40"]')).toHaveCount(1);

    await expect.poll(async () => {
      const texts = await savedTexts(page, fileId);
      return texts.slice(texts.indexOf("段落39"), texts.indexOf("段落40") + 1);
    }).toEqual(["段落39", "テスト", "段落40"]);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const reloaded = await drawnTexts(page);
    expect(reloaded.filter(text => text === "テスト")).toHaveLength(1);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("Enter at the start of the document keeps the caret in the moved paragraph", async () => {
  const { app, page, fileId, profile } = await launch([paragraph("p0", "最初の段落"), paragraph("p1", "次の段落")]);
  try {
    await caretAtStart(page, "p0");
    await page.keyboard.press("Enter");
    // 以前は空行が単独の単位になり、元の単位のエディタが中身を差し替えられて焦点ごと落ちた。
    await expect(page.locator(".page-flow .ProseMirror-focused")).toHaveCount(1);
    await page.keyboard.type("あ");

    await expect.poll(() => savedTexts(page, fileId)).toEqual(["", "あ最初の段落", "次の段落"]);
    expect(await drawnTexts(page)).toEqual(["", "あ最初の段落", "次の段落"]);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("a formula in a paragraph with a sized run is coloured when selected", async () => {
  // 同じ段落に文字サイズを指定した文字があると、本文の書体の装飾が残りの文字と数式を
  // `<span data-sigma-doc-inherited-font>` で包む。選択の印 (`text-selected`) がその span に
  // 載り、数式だけを選んでも色が付かなかった。
  const { app, page, profile } = await launch([
    { type: "paragraph", id: "p0", children: [
      { type: "text", text: "大きい文字", fontSize: 16 },
      { type: "text", text: " と分数 " },
      { type: "mathInline", id: "m0", tex: "\\frac{1}{2}", display: "inline" },
      { type: "text", text: " の段落" },
    ] },
  ]);
  try {
    const formula = page.locator('.page-flow [data-sigma-doc-id="p0"] .inline-math-node');
    await expect(formula.locator("xpath=..")).toHaveAttribute("data-sigma-doc-inherited-font", "");
    const box = (await formula.boundingBox())!;
    await page.mouse.move(box.x - 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 4, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect(formula.locator("xpath=..")).toHaveClass(/text-selected/);
    await expect.poll(() => formula.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    // 数式の中の記号にはネイティブの選択色を重ねない。重ねると背景の上に記号ごとの四角が濃く出て、
    // 数式だけ 2 色に見えた。
    expect(await formula.evaluate(el => {
      const glyph = [...el.querySelectorAll("*")].find(node => node.children.length === 0 && node.textContent?.trim());
      return glyph ? getComputedStyle(glyph, "::selection").backgroundColor : null;
    })).toBe("rgba(0, 0, 0, 0)");
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("a drag that starts on a formula extends into the next unit", async () => {
  const { app, page, profile } = await launch([
    { type: "paragraph", id: "p0", children: [
      { type: "text", text: "末尾が数式 " },
      { type: "mathInline", id: "m0", tex: "\\sqrt{2}", display: "inline" },
    ] },
    {
      type: "problem", id: "q1", tags: [], lead: [], hints: [], solution: [],
      prompt: [paragraph("q1_p", "問題文の段落です。ここまで選択を伸ばします。")],
    },
  ]);
  try {
    const formula = page.locator('.page-flow [data-sigma-doc-id="p0"] .inline-math-node');
    const start = (await formula.boundingBox())!;
    const prompt = page.locator('.page-flow [data-sigma-doc-id="q1_p"]').first();
    const end = (await prompt.boundingBox())!;
    await page.mouse.move(start.x + start.width * 0.3, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.x + 60, end.y + end.height / 2, { steps: 12 });
    await page.mouse.up();

    // 数式のある単位と問題文の単位の両方が選択に入る (以前は数式の単位の中で止まった)。
    // 間の導入文 (空の区分) も編集面なので、それも含めて選択が続く。
    for (const blockId of ["p0", "q1_p"]) {
      await expect(page.locator(`.page-flow .text-flow-editor[data-text-run-span]:has([data-sigma-doc-id="${blockId}"])`)).toHaveCount(1);
    }
    await expect(formula).toHaveClass(/text-selected/);
    await expect(formula).not.toHaveClass(/editing/);

    // 動かさずに押したときは、これまでどおり数式を編集で開く。
    await prompt.click();
    await formula.click();
    await expect(page.locator(".page-flow math-field")).toHaveCount(1);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
