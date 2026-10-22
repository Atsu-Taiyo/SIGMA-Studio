import { expect, test, type Page } from "@playwright/test";

import type { InlineNode, ParagraphNode, SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 太字・斜体を含む囲み文字の枠が、途中で2つに割れない (#囲みの枠が分かれる)。
 *
 * ProseMirror は「囲み」マークが等しい隣り合う文を、中の太字・斜体が違っても 1 つの
 * `.boxed-text` span にまとめる。以前の計測は span と文書の囲み対象を順番に 1 対 1 で
 * 突き合わせていたので、文が 1 つ増えるたびに後ろの対象が 1 つずつずれ、ランの後半が
 * 装飾されず、素の `.boxed-text` の罫線が「少し低く・短い」2 つ目の枠として残った。
 * 先生の「（参考）　I_n = ∫ tanⁿx　型だけは「部分積分」ではなく「式変形」で作る！」は
 * 「（参考）」だけが太字のこの形だった。
 */

const TEX = String.raw`I_n = \int_0^{\frac{\pi}{4}} \tan^n x`;
const TAIL = "型だけは「部分積分」ではなく「式変形」で作る！";

const boxed = (text: string, extra: Record<string, unknown> = {}): InlineNode => ({ type: "text", text, marks: ["boxed"], ...extra }) as InlineNode;
const formula = (id: string): InlineNode => ({ type: "mathInline", id, tex: TEX, display: "inline", marks: ["boxed"] }) as InlineNode;
const paragraph = (id: string, children: InlineNode[]): ParagraphNode => ({ type: "paragraph", id, lineHeight: "1.8", children }) as ParagraphNode;

function createDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "boxed_run_mixed_marks_doc",
    metadata: { title: "太字を含む囲み文字" },
    content: [
      // 先生の文書: 「（参考）」だけが太字。
      paragraph("p_label_bold", [boxed("（参考）", { marks: ["boxed", "bold"] }), boxed("　"), formula("m_label_bold"), boxed("　" + TAIL)]),
      // 後半の語だけが太字・斜体 (「」の中)。
      paragraph("p_tail_marks", [
        boxed("（参考）　"), formula("m_tail_marks"), boxed("　型だけは「"),
        boxed("部分積分", { marks: ["boxed", "bold"] }), boxed("」ではなく「"),
        boxed("式変形", { marks: ["boxed", "italic"] }), boxed("」で作る！"),
      ]),
      // 同じ書式で別々に囲んだ隣り合うラン: 文書の上では 1 つの文になり、1 つの枠。
      paragraph("p_same_style", [boxed("（参考）"), boxed("　"), formula("m_same_style"), boxed("　"), boxed(TAIL)]),
      // 囲んでいない 1 文字 (全角の空白) が間にあるときは、枠は 2 つのまま (空白は枠の外)。
      paragraph("p_unboxed_gap", [boxed("（参考）　"), formula("m_unboxed_gap"), { type: "text", text: "　" } as InlineNode, boxed(TAIL)]),
    ],
    outputProfiles: {
      student: {},
      teacher: { showSolutions: true, showHints: true },
      answerBook: { includeAnswers: true, onlySolutions: true },
    },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 18, right: 18, bottom: 18, left: 18 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
    },
  };
}

interface RunCensus {
  frames: Array<{ left: number; right: number; top: number; bottom: number }>;
  /** 計測対象 (`data-boxed-run-height-target`) を 1 つも持たない `.boxed-text` の数。素の罫線が残る。 */
  undecoratedMarks: number;
  segments: Array<{ left: number; right: number; top: number; bottom: number }>;
}

async function census(page: Page, selector: string): Promise<RunCensus> {
  return page.evaluate((sel) => {
    const root = document.querySelector<HTMLElement>(sel);
    if (!root) return { frames: [], undecoratedMarks: -1, segments: [] };
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    const marks = Array.from(root.querySelectorAll<HTMLElement>(".boxed-text"));
    return {
      frames: Array.from(root.querySelectorAll(".boxed-run-frame")).map(box),
      undecoratedMarks: marks.filter((mark) => !mark.matches('[data-boxed-run-height-target="true"]')
        && !mark.querySelector('[data-boxed-run-height-target="true"]')).length,
      segments: Array.from(root.querySelectorAll('[data-boxed-run-height-target="true"]')).map(box),
    };
  }, selector);
}

/** 1 本の枠が、すべての計測対象 (文・数式) を包んでいる。 */
function expectOneFrameAroundTheRun(result: RunCensus) {
  expect(result.undecoratedMarks).toBe(0);
  expect(result.frames).toHaveLength(1);
  const [frame] = result.frames;
  const left = Math.min(...result.segments.map((s) => s.left)), right = Math.max(...result.segments.map((s) => s.right));
  const top = Math.min(...result.segments.map((s) => s.top)), bottom = Math.max(...result.segments.map((s) => s.bottom));
  expect(Math.abs(frame.left - left)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(frame.right - right)).toBeLessThanOrEqual(1.5);
  // 空白だけの区間は枠の上下端を決めない (文字・数式の行から求める) ので、枠は区間の外接より狭くてよいが、はみ出さない。
  expect(frame.top).toBeGreaterThanOrEqual(top - 1.5);
  expect(frame.bottom).toBeLessThanOrEqual(bottom + 1.5);
  expect(frame.bottom - frame.top).toBeGreaterThan(30);
}

for (const [label, url, scope] of [
  ["editing view", "/", ".page-flow .text-flow-editor"],
  ["printed output", "/print?fileId=file_e2e_document", ".paged-surface-page"],
] as const) {
  test(`draws one frame around a boxed run that mixes bold or italic text with a formula (${label})`, async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await installDesktopRuntimeMock(page, createDocument());
    await page.goto(url);
    await expect(page.locator(`${scope} [data-sigma-doc-id="p_label_bold"]`)).toBeVisible();

    for (const id of ["p_label_bold", "p_tail_marks", "p_same_style"]) {
      const selector = `${scope} [data-sigma-doc-id="${id}"]`;
      await expect.poll(async () => {
        const result = await census(page, selector);
        return [result.frames.length, result.undecoratedMarks];
      }, { message: id }).toEqual([1, 0]);
      expectOneFrameAroundTheRun(await census(page, selector));
    }

    // 囲んでいない空白を挟んだ 2 つのランは、別々の枠のまま。
    const gap = await census(page, `${scope} [data-sigma-doc-id="p_unboxed_gap"]`);
    expect(gap.frames).toHaveLength(2);
    expect(gap.frames[1].left - gap.frames[0].right).toBeGreaterThan(8);
  });
}

test("keeps one frame when a word inside a boxed run is made bold afterwards", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  const scope = '.page-flow .text-flow-editor [data-sigma-doc-id="p_same_style"]';
  await expect(page.locator(scope)).toBeVisible();
  await expect.poll(async () => (await census(page, scope)).frames.length).toBe(1);

  // 行頭の「（参考）」を選んで太字にする。
  await page.locator(scope).click();
  await page.evaluate((sel) => {
    const walker = document.createTreeWalker(document.querySelector(sel)!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = (node.textContent ?? "").indexOf("（参考）");
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start); range.setEnd(node, start + 4);
      const selection = window.getSelection()!;
      selection.removeAllRanges(); selection.addRange(range);
      return;
    }
    throw new Error("label not found");
  }, scope);
  await page.getByRole("button", { name: "太字", exact: true }).first().click();
  await expect(page.locator(`${scope} strong`)).toHaveCount(1);

  await expect.poll(async () => {
    const result = await census(page, scope);
    return [result.frames.length, result.undecoratedMarks];
  }).toEqual([1, 0]);
  expectOneFrameAroundTheRun(await census(page, scope));
});
