import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 本文編集面の表示言語。**ja / en の両方**を回すのが要点で、英語化したつもりが
 * 日本語のまま残っている面と、英語化のついでに日本語を壊した面の両方を捕まえる。
 */

function emptyDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_editor_canvas_locale";
  document.comments = [];
  // 空の段落 1 つ = プレースホルダが必ず出る状態。見出しと問題も 1 つずつ置いて、
  // アウトラインに**中身のある行**が並ぶようにする (空だと空状態の文言しか見えない)。
  document.content = [
    { type: "paragraph", id: "p_empty", children: [] },
    { type: "heading", id: "h_1", level: 2, children: [] },
    { type: "problem", id: "prob_1", tags: [], lead: [], prompt: [], solution: [], hints: [] },
    {
      type: "layoutSection",
      id: "sec_1",
      layout: { columnCount: 2 },
      children: [{ type: "paragraph", id: "p_col", children: [] }],
    },
  ] as unknown as SigmaDocument["content"];
  return document;
}

async function openEditor(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installDesktopRuntimeMock(page, emptyDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".text-flow-editor").first()).toBeVisible();
}

/** 空段落に出るプレースホルダ。CSS の `content: attr(data-placeholder)` で描かれる。 */
function placeholderOf(page: Page): Promise<string | null> {
  return page.locator(".text-flow-editor [data-placeholder]").first().getAttribute("data-placeholder");
}

/** `/` を打って挿入候補を開く。 */
async function openSlashMenu(page: Page): Promise<void> {
  const paragraph = page.locator("[data-sigma-doc-id='p_empty']").first();
  await paragraph.click();
  await expect.poll(() => page.evaluate(
    () => document.activeElement?.closest(".text-flow-editor") !== null,
  )).toBe(true);
  await page.keyboard.type("/");
  await expect(page.locator(".slash-command-popover")).toBeVisible();
}

test.describe("body editing in English", () => {
  test.use({ locale: "en-US" });

  test("writes the body placeholder, the slash menu and the outline in English", async ({ page }) => {
    await openEditor(page);

    expect(await placeholderOf(page)).toBe("Write here");
    await expect(page.locator("[data-sigma-doc-id='p_empty'] .text-formatting-mark")).toHaveCount(0);

    await openSlashMenu(page);
    const popover = page.locator(".slash-command-popover");
    await expect(popover.locator(".slash-command-title")).toHaveText("Insert");
    // 箱コマンドの説明も辞書から出る。
    await expect(popover).toContainText("Frames the text in a full-width box");
    // 候補の並びは素材が先に来ることもあるので、種別ラベルは集合で見る。
    await expect(popover.locator(".slash-command-kind")).toContainText(["Box"]);
    await page.keyboard.press("Escape");

    // アウトラインは `collectOutline` が付ける名前がそのまま出る面。
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("menuitem", { name: "Show outline" }).click();
    const outline = page.getByRole("dialog", { name: "Outline", exact: true });
    await expect(outline).toBeVisible();
    await expect(outline.getByRole("heading", { name: "Outline" })).toBeVisible();
    // 行の名前は `collectOutline` が付ける。見出しが空なら種別名がそのまま出るので、
    // ここが日本語のままだと「ダイアログの枠だけ英語」を見逃す。
    await expect(outline.locator(".outline-dialog-list")).toContainText("Heading");
    await expect(outline.locator(".outline-dialog-list")).toContainText("Problem 1");
  });

  test("writes the placeholder of a column section and a problem area in English", async ({ page }) => {
    // 段組セクションと問題エリアは `TextFlowEditor` に placeholder を**明示的に**渡すので、
    // トップレベル段落が英語になっただけでは英語にならない (実際にそうなっていた)。
    await openEditor(page);
    const placeholders = await page.locator(".text-flow-editor [data-placeholder]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-placeholder")));
    expect(placeholders.length).toBeGreaterThan(1);
    expect(placeholders.filter((value) => value && /[\u3040-\u30ff\u4e00-\u9fff]/u.test(value))).toEqual([]);
  });

  test("writes the comment panel in English", async ({ page }) => {
    await openEditor(page);
    // コメントパネルは本文の空状態でも開ける (空メッセージが出る)。
    const panel = page.locator(".comment-thread-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("No comments yet");
  });
});

test.describe("body editing stays in Japanese", () => {
  test("keeps the placeholder, the slash menu and the comment panel in Japanese", async ({ page }) => {
    await openEditor(page);

    expect(await placeholderOf(page)).toBe("本文を入力");
    await expect(page.locator("[data-sigma-doc-id='p_empty'] .text-formatting-mark")).toHaveCount(0);

    await openSlashMenu(page);
    const popover = page.locator(".slash-command-popover");
    await expect(popover.locator(".slash-command-title")).toHaveText("挿入");
    await expect(popover).toContainText("本文を段幅いっぱいの枠で囲む");
    await page.keyboard.press("Escape");

    await expect(page.locator(".comment-thread-panel")).toContainText("コメントはありません");

    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("menuitem", { name: "アウトラインを表示" }).click();
    const outline = page.getByRole("dialog", { name: "アウトライン", exact: true });
    await expect(outline.locator(".outline-dialog-list")).toContainText("見出し");
    await expect(outline.locator(".outline-dialog-list")).toContainText("問題 1");
  });
});
