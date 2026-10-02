import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { grabShapeFromBody } from "./body-overlay-entry";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 枠で囲んだ数式を含む文章を、本文と図中テキストの間でコピー・切り取り・貼り付けする。
 *
 * クリップボードの HTML は、スキーマ自身の直列化を同じスキーマの解析が読み戻す往復で成り立つ。
 * 解析側で数式の span が「装飾の無い文字」に食われると、貼り付け先が別の編集面のとき (本文 → 図中
 * テキスト、切り取り → 貼り付け) だけ数式が KaTeX の文字列へ崩れる。本文 → 本文は SigmaDoc の
 * payload で運ぶので壊れず、どの経路でも同じ結果になることをここで固定する。
 */
const MATH_TEX = "0<|x|<1";
const EXPECTED_TEXT = "は明らか. $0<|x|<1$ なら $|x|=\\frac{1}{1+h}$となる";

function createDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_boxed_math_clipboard";
  document.metadata = { ...document.metadata, title: "枠付き数式のコピー E2E" };
  document.content = [
    {
      type: "paragraph",
      id: "p_src",
      children: [
        { type: "text", text: "は明らか. " },
        { type: "mathInline", id: "m_one", tex: MATH_TEX, display: "inline", marks: ["boxed"], semanticRole: "expression" },
        { type: "text", text: " なら " },
        { type: "mathInline", id: "m_two", tex: "|x|=\\frac{1}{1+h}", display: "inline", marks: ["boxed"], semanticRole: "expression" },
        { type: "text", text: "となる", marks: ["boxed"] },
      ],
    },
    { type: "paragraph", id: "p_dst", children: [{ type: "text", text: "貼り付け先" }] },
  ] as SigmaDocument["content"];
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        assets: {},
        shapes: [{
          id: "shape_text",
          type: "text",
          x: 120,
          y: 360,
          rotation: 0,
          props: {
            w: 320,
            h: 40,
            color: "#111827",
            size: "m",
            blocks: [{ type: "paragraph", id: "o_p1", children: [{ type: "text", text: "図" }] }],
          },
        }],
      },
    },
  } as SigmaDocument["pageLayout"];
  return document;
}

interface SavedInline {
  type: string;
  text?: string;
  tex?: string;
  marks?: string[];
}

/** 保存された文書から、本文ブロックと図中テキストのブロックを集める。 */
async function savedBlocks(page: Page): Promise<Record<string, SavedInline[]>> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("sigma-studio:e2e-document");
    const blocks: Record<string, SavedInline[]> = {};
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const record = value as { id?: unknown; type?: unknown; children?: unknown };
      if (record.type === "paragraph" && typeof record.id === "string" && Array.isArray(record.children)) {
        blocks[record.id] = record.children as SavedInline[];
      }
      Object.values(value).forEach(visit);
    };
    visit(raw ? JSON.parse(raw) : null);
    return blocks;
  });
}

async function savedBodyParagraphs(page: Page): Promise<SavedInline[][]> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) as { content?: Array<{ type?: string; children?: SavedInline[] }> } : {};
    return (document.content ?? [])
      .filter((block) => block.type === "paragraph")
      .map((block) => block.children ?? []);
  });
}

function plainTextOf(children: SavedInline[] | undefined): string {
  return (children ?? []).map((child) => child.type === "mathInline" ? `$${child.tex}$` : child.text ?? "").join("");
}

function boxedMath(children: SavedInline[] | undefined): string[] {
  return (children ?? [])
    .filter((child) => child.type === "mathInline" && child.marks?.includes("boxed"))
    .map((child) => child.tex ?? "");
}

async function openEditor(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 });
  await expect(page.locator('[data-sigma-doc-id="p_src"]').first()).toBeVisible();
}

/** 1 行を端から端までドラッグして選ぶ。枠付きの数式も選択に含まれる。 */
async function selectSourceLine(page: Page): Promise<void> {
  const box = await page.locator('[data-sigma-doc-id="p_src"]').first().boundingBox();
  if (!box) throw new Error("source paragraph is not visible");
  const y = box.y + box.height / 2;
  await page.mouse.click(box.x + 6, y);
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("となる");
}

async function caretAtEndOfDestination(page: Page): Promise<void> {
  const destination = page.locator('[data-sigma-doc-id="p_dst"]').first();
  // 図中テキストの編集で紙面がスクロールしていることがあるので、押す前に見える位置へ戻す。
  await destination.scrollIntoViewIfNeeded();
  const box = await destination.boundingBox();
  if (!box) throw new Error("destination paragraph is not visible");
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
  await page.keyboard.press("End");
}

/** 本文からオーバーレイ編集を始め、図中テキストの末尾へキャレットを置く。 */
async function caretAtEndOfShapeText(page: Page): Promise<void> {
  const box = await page.locator('[data-overlay-shape-id="shape_text"]').first().boundingBox();
  if (!box) throw new Error("text shape is not visible");
  const point = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.5 };
  await grabShapeFromBody(page, point);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(".overlay-text-shape-content.ProseMirror-focused")).toBeVisible();
  await page.keyboard.press("End");
}

test("keeps a boxed formula when body text is copied and pasted into body text", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+C");
  await caretAtEndOfDestination(page);
  await page.keyboard.press("ControlOrMeta+V");

  await expect.poll(async () => plainTextOf((await savedBlocks(page)).p_dst)).toBe(`貼り付け先${EXPECTED_TEXT}`);
  expect(boxedMath((await savedBlocks(page)).p_dst)).toEqual([MATH_TEX, "|x|=\\frac{1}{1+h}"]);
});

test("keeps a boxed formula when body text is cut and pasted back", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+X");
  await caretAtEndOfDestination(page);
  await page.keyboard.press("ControlOrMeta+V");

  await expect.poll(async () => plainTextOf((await savedBlocks(page)).p_dst)).toBe(`貼り付け先${EXPECTED_TEXT}`);
  expect(boxedMath((await savedBlocks(page)).p_dst)).toEqual([MATH_TEX, "|x|=\\frac{1}{1+h}"]);
});

test("pastes boxed body text into a text shape as formulas, not as rendered glyphs", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+C");
  await caretAtEndOfShapeText(page);
  await page.keyboard.press("ControlOrMeta+V");

  await expect.poll(async () => plainTextOf((await savedBlocks(page)).o_p1)).toBe(`図${EXPECTED_TEXT}`);
  expect(boxedMath((await savedBlocks(page)).o_p1)).toEqual([MATH_TEX, "|x|=\\frac{1}{1+h}"]);
});

test("copies text shape content with its formulas back into the body", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+C");
  await caretAtEndOfShapeText(page);
  await page.keyboard.press("ControlOrMeta+V");
  await expect.poll(async () => boxedMath((await savedBlocks(page)).o_p1)).toHaveLength(2);

  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+C");
  // 図形に当たらない素のクリックでオーバーレイ編集を降りて、本文にキャレットを置く。
  await caretAtEndOfDestination(page);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
  await page.keyboard.press("ControlOrMeta+V");

  // Select All produces a closed paragraph slice, so pasting it creates a new body paragraph.
  // Read the saved body content: the shape also contains identical text and must not satisfy this check.
  await expect.poll(async () => (await savedBodyParagraphs(page)).map(plainTextOf))
    .toContain(`図${EXPECTED_TEXT}`);
  const pasted = (await savedBodyParagraphs(page)).find((children) => plainTextOf(children) === `図${EXPECTED_TEXT}`);
  expect(boxedMath(pasted)).toEqual([MATH_TEX, "|x|=\\frac{1}{1+h}"]);
});

test("paints the selection color on a formula inside a box like on the text around it", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);

  const backgrounds = await page.locator('[data-sigma-doc-id="p_src"] .inline-math-node').evaluateAll((nodes) => (
    nodes.map((node) => getComputedStyle(node).backgroundColor)
  ));
  expect(backgrounds).toHaveLength(2);
  for (const background of backgrounds) {
    expect(background).not.toBe("rgba(0, 0, 0, 0)");
  }
});
