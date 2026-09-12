import { expect, test, type Page } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import type { InlineNode, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

test("gives a box a title with math from the ⋯ menu, then hands the caret back to the box", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("box_trigger", ""),
    paragraph("after_box", "後続本文"),
  ]));

  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
  const trigger = page.locator('[data-sigma-doc-id="box_trigger"]').first();
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.keyboard.type("/fancybox");
  await expect(page.locator(".slash-command-popover")).toContainText("fancybox");
  await page.keyboard.press("Enter");

  const box = page.locator(".sigma-doc-box-block").first();
  await expect(box).toBeVisible();

  await box.hover();
  await box.getByRole("button", { name: "box操作" }).click();
  const actions = page.getByRole("dialog", { name: "box操作" });
  await actions.getByRole("button", { name: "タイトルを編集…" }).click();

  const dialog = page.getByRole("dialog", { name: "ボックス設定" });
  await expect(dialog).toBeVisible();
  // 開いた瞬間からタイトルへ打てる (ダイアログを開いてから入力欄を探させない)。
  await expect.poll(() => activeElementClassName(page)).toContain("ProseMirror-focused");
  await page.keyboard.type("重要公式");
  await expect(page.locator(".sigma-doc-box-title").first()).toContainText("重要公式");

  // 数式は本文と同じインライン数式ノードとして入る。
  await dialog.getByRole("button", { name: "タイトルに数式を挿入" }).click();
  await expect(dialog.locator("math-field")).toHaveCount(1);
  await page.keyboard.type("x^2+1");
  await page.keyboard.press("Enter");
  await page.keyboard.type("を確認");

  await expect.poll(() => savedBoxTitle(page)).toEqual([
    { type: "text", text: "重要公式" },
    expect.objectContaining({ type: "mathInline", tex: "x^2+1" }),
    { type: "text", text: "を確認" },
  ]);
  await expect(page.locator('.sigma-doc-box-title [data-sigma-doc-math-inline]')).toHaveCount(1);

  // 閉じたあとのフォーカスは箱へ戻る。ModalFrame の既定の復帰先 (body 先頭 = 画面上端の
  // 教材タイトル) のままだと、次の 1 打鍵が教材名の書き換えになる。
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.keyboard.type("！");
  await expect.poll(() => savedBoxTitle(page)).toEqual([
    { type: "text", text: "重要公式" },
    expect.objectContaining({ type: "mathInline", tex: "x^2+1" }),
    { type: "text", text: "を確認！" },
  ]);
  await expect.poll(() => savedDocumentTitle(page)).toBe("箱タイトル E2E");
});

test("titles a box that is split across pages from a single dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    boxBlock("box_long", Array.from({ length: 90 }, (_, index) => (
      paragraph(`box_long_p${index}`, `ページ跨ぎ確認 ${index + 1}`)
    ))),
  ]));

  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
  // 箱が複数ページへ分かれ、元の面と複製面が同時に描かれている状態を作る。
  await expect.poll(() => page.locator(".editor-box-fragment-viewport").count()).toBeGreaterThan(0);
  const surfaces = await page.locator(".sigma-doc-box-block").count();
  expect(surfaces).toBeGreaterThan(1);

  const body = page.locator('[data-sigma-doc-id="box_long_p3"]').first();
  await body.click();
  await body.click({ button: "right" });
  const menu = page.locator(".page-context-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "タイトルを編集…" }).click();

  // 設定を持てるのは元の面だけ。面の数だけ開くと、下の層が開いた時点の古いタイトルを
  // 抱えたまま残り、閉じたときに空欄のダイアログが顔を出す。
  await expect(page.getByRole("dialog", { name: "ボックス設定" })).toHaveCount(1);
  await page.keyboard.type("分割箱の題");

  await expect.poll(() => savedBoxTitle(page)).toEqual([{ type: "text", text: "分割箱の題" }]);
  // 複製面にも同じタイトルが出る。
  const titles = await page.locator(".sigma-doc-box-title").allTextContents();
  expect(titles.slice(0, surfaces)).toEqual(Array.from({ length: surfaces }, () => "分割箱の題"));

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "ボックス設定" })).toHaveCount(0);
});

function activeElementClassName(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.className ?? "");
}

async function savedBoxTitle(page: Page): Promise<InlineNode[] | null> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return null;
    }
    const blocks = (JSON.parse(raw) as { content?: Array<Record<string, unknown>> }).content ?? [];
    const box = blocks.find((block) => block.type === "boxBlock") as { title?: unknown } | undefined;
    return (box?.title ?? null) as InlineNode[] | null;
  });
}

async function savedDocumentTitle(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    return raw ? (JSON.parse(raw) as { metadata?: { title?: string } }).metadata?.title ?? null : null;
  });
}

function paragraph(id: string, text: string): SigmaBlock {
  return {
    type: "paragraph",
    id,
    children: text ? [{ type: "text", text }] : [],
  } as SigmaBlock;
}

function boxBlock(id: string, blocks: SigmaBlock[]): SigmaBlock {
  return { type: "boxBlock", id, styleId: "fancybox", blocks } as unknown as SigmaBlock;
}

function createDocument(content: SigmaBlock[]): SigmaDocument {
  return {
    version: "2.0",
    docId: "box_title_dialog_e2e_doc",
    metadata: { title: "箱タイトル E2E" },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  } as unknown as SigmaDocument;
}
