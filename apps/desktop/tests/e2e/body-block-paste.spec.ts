import { expect, test, type Page } from "@playwright/test";

import type { SigmaDocument } from "@/features/document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 入れ物ブロック (コード・引用) の中への貼り付け。
 *
 * ここで見るのは「貼ったものが入れ物の中に収まるか」の 1 点。コードブロックの中身は
 * inline だけなので、貼るものを段落のまま渡すと ProseMirror が入れ物を閉じて外へ出す
 * (＝コードの箱から溢れる) 。
 */

interface SavedInline {
  type: string;
  text?: string;
  tex?: string;
}

interface SavedBlock {
  id: string;
  type: string;
  language?: string;
  title?: SavedInline[];
  children?: SavedInline[];
  blocks?: SavedBlock[];
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
});

test("コードブロックへ複数行を貼っても 1 つの箱の中に収まる", async ({ page }) => {
  await openEditor(page);

  await clickAtEndOfBlock(page, "code_target");
  await dispatchPlainTextPaste(page, ["const a = 1;", "const b = 2;", "console.log(a + b);"].join("\n"));

  await expect.poll(async () => summarize(await savedBlocks(page))).toEqual([
    { type: "paragraph", text: "貼り付けの前の段落です。" },
    { type: "codeBlock", text: "// ここへ貼るconst a = 1;\nconst b = 2;\nconsole.log(a + b);" },
    { type: "quote", text: "引用の中の段落です。" },
    { type: "boxBlock", text: "箱のタイトル" },
    { type: "paragraph", text: "貼り付けの後の段落です。" },
  ]);
});

test("コードブロックへ Markdown 記法を貼っても見出しやリストにならない", async ({ page }) => {
  await openEditor(page);

  await clickAtEndOfBlock(page, "code_target");
  await dispatchPlainTextPaste(page, ["## 見出し", "- 箇条書き"].join("\n"));

  await expect.poll(async () => summarize(await savedBlocks(page))).toEqual([
    { type: "paragraph", text: "貼り付けの前の段落です。" },
    { type: "codeBlock", text: "// ここへ貼る## 見出し\n- 箇条書き" },
    { type: "quote", text: "引用の中の段落です。" },
    { type: "boxBlock", text: "箱のタイトル" },
    { type: "paragraph", text: "貼り付けの後の段落です。" },
  ]);
});

test("本文からコピーした段落もコードブロックの中へ貼れる", async ({ page }) => {
  await openEditor(page);

  await selectWholeBlock(page, "p_before");
  await page.keyboard.press("ControlOrMeta+C");

  await clickAtEndOfBlock(page, "code_target");
  await page.keyboard.press("ControlOrMeta+V");

  await expect.poll(async () => summarize(await savedBlocks(page))).toEqual([
    { type: "paragraph", text: "貼り付けの前の段落です。" },
    { type: "codeBlock", text: "// ここへ貼る貼り付けの前の段落です。" },
    { type: "quote", text: "引用の中の段落です。" },
    { type: "boxBlock", text: "箱のタイトル" },
    { type: "paragraph", text: "貼り付けの後の段落です。" },
  ]);
});

test("箱のタイトルへ複数行を貼ってもタイトルの中に収まる", async ({ page }) => {
  await openEditor(page);

  const title = page.locator(".sigma-doc-box-title").first();
  await title.click();
  await page.keyboard.press("ControlOrMeta+ArrowRight");
  await dispatchPlainTextPaste(page, ["足す 1 行目", "足す 2 行目"].join("\n"));

  await expect.poll(async () => {
    const box = (await savedBlocks(page)).find((block) => block.type === "boxBlock");
    return {
      title: inlineText(box?.title),
      bodyTypes: (box?.blocks ?? []).map((child) => child.type),
    };
  }).toEqual({
    title: "箱のタイトル足す 1 行目\n足す 2 行目",
    bodyTypes: ["paragraph"],
  });
});

test("コードブロックを跨いでコピーすると、貼り付け先でもコードブロックのまま", async ({ page }) => {
  await openEditor(page);

  await dragSelectRange(page, "p_before", "code_target");
  await page.keyboard.press("ControlOrMeta+C");

  await clickAtEndOfBlock(page, "p_after");
  await page.keyboard.press("ControlOrMeta+V");

  await expect.poll(async () => summarize(await savedBlocks(page))).toEqual([
    { type: "paragraph", text: "貼り付けの前の段落です。" },
    { type: "codeBlock", text: "// ここへ貼る" },
    { type: "quote", text: "引用の中の段落です。" },
    { type: "boxBlock", text: "箱のタイトル" },
    // ブロックを跨ぐコピーは構造を保存し、貼り付け先の段落の後へ各ブロックを挿入する。
    { type: "paragraph", text: "貼り付けの後の段落です。" },
    { type: "paragraph", text: "貼り付けの前の段落です。" },
    { type: "codeBlock", text: "// ここへ貼る" },
  ]);
});

test("引用の中へ貼ったものは引用の中に残る", async ({ page }) => {
  await openEditor(page);

  await clickAtEndOfBlock(page, "quote_paragraph");
  await dispatchPlainTextPaste(page, ["最初の行", "", "次の段落"].join("\n"));

  await expect.poll(async () => summarize(await savedBlocks(page))).toEqual([
    { type: "paragraph", text: "貼り付けの前の段落です。" },
    { type: "codeBlock", text: "// ここへ貼る" },
    { type: "quote", text: "引用の中の段落です。最初の行\n次の段落" },
    { type: "boxBlock", text: "箱のタイトル" },
    { type: "paragraph", text: "貼り付けの後の段落です。" },
  ]);
});

async function openEditor(page: Page): Promise<void> {
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 });
  await expect(page.locator('[data-sigma-doc-id="code_target"]').first()).toBeVisible();
}

async function clickAtEndOfBlock(page: Page, blockId: string): Promise<void> {
  const block = page.locator(`[data-sigma-doc-id="${blockId}"]`).first();
  await block.scrollIntoViewIfNeeded();
  const box = await block.boundingBox();
  if (!box) {
    throw new Error(`block ${blockId} is not visible`);
  }
  await page.mouse.click(box.x + box.width - 6, box.y + box.height - 8);
  await page.keyboard.press("End");
}

async function selectWholeBlock(page: Page, blockId: string): Promise<void> {
  const block = page.locator(`[data-sigma-doc-id="${blockId}"]`).first();
  await block.scrollIntoViewIfNeeded();
  const box = await block.boundingBox();
  if (!box) {
    throw new Error(`block ${blockId} is not visible`);
  }
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function dragSelectRange(page: Page, fromBlockId: string, toBlockId: string): Promise<void> {
  const from = await page.locator(`[data-sigma-doc-id="${fromBlockId}"]`).first().boundingBox();
  const to = await page.locator(`[data-sigma-doc-id="${toBlockId}"]`).first().boundingBox();
  if (!from || !to) {
    throw new Error("range endpoints are not visible");
  }
  await page.mouse.move(from.x + 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 6, to.y + to.height - 8, { steps: 12 });
  await page.mouse.up();
}

async function dispatchPlainTextPaste(page: Page, text: string): Promise<void> {
  await page.evaluate((pastedText) => {
    const target = document.activeElement?.closest(".text-flow-editor");
    if (!target) {
      throw new Error("Text flow editor is not focused");
    }
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pastedText);
    target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  }, text);
}

async function savedBlocks(page: Page): Promise<SavedBlock[]> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return [] as SavedBlock[];
    }
    return (JSON.parse(raw) as { content: SavedBlock[] }).content ?? [];
  });
}

function summarize(blocks: SavedBlock[]): Array<Record<string, unknown>> {
  return blocks.map((block) => {
    if (block.type === "quote") {
      return { type: "quote", text: (block.blocks ?? []).map((child) => inlineText(child.children)).join("\n") };
    }
    if (block.type === "boxBlock") {
      return { type: "boxBlock", text: inlineText(block.title) };
    }
    return { type: block.type, text: inlineText(block.children) };
  });
}

function inlineText(nodes: SavedInline[] = []): string {
  return nodes
    .map((child) => (child.type === "text" ? child.text ?? "" : `$${child.tex ?? ""}$`))
    .join("");
}

function createDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_body_block_paste",
    metadata: { title: "本文ブロックへの貼り付け" },
    content: [
      { type: "paragraph", id: "p_before", children: [{ type: "text", text: "貼り付けの前の段落です。" }] },
      { type: "codeBlock", id: "code_target", language: "javascript", children: [{ type: "text", text: "// ここへ貼る" }] },
      {
        type: "quote",
        id: "quote_target",
        blocks: [
          { type: "paragraph", id: "quote_paragraph", children: [{ type: "text", text: "引用の中の段落です。" }] },
        ],
      },
      {
        type: "boxBlock",
        id: "box_target",
        styleId: "fancybox",
        title: [{ type: "text", text: "箱のタイトル" }],
        blocks: [
          { type: "paragraph", id: "box_body", children: [{ type: "text", text: "箱の中の本文です。" }] },
        ],
      },
      { type: "paragraph", id: "p_after", children: [{ type: "text", text: "貼り付けの後の段落です。" }] },
    ],
    outputProfiles: {
      student: { showSolutions: false, showHints: false, includeAnswers: false },
      teacher: { showSolutions: true, showHints: true, includeAnswers: true, includeComments: true },
      answerBook: { showSolutions: true, showHints: false, includeAnswers: true, onlySolutions: true },
    },
  } as SigmaDocument;
}
