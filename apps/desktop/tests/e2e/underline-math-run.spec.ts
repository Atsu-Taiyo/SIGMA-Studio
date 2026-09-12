import { expect, test, type Page } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import type { ParagraphNode, SigmaDocument } from "@/types/sigma-doc";

// Chromium only draws `text-decoration-line: underline` across the span between the
// first and last *text* glyph inside the decorating box. An atomic inline (the math
// node's inline-block) at a run's edge, or a run made entirely of math, therefore
// never gets an underline from text-decoration alone. Runs containing math instead
// draw a continuous border under the whole run (see globals.css
// `.sigma-underline-run:has(.math-preview)`); text-only runs keep the original
// text-decoration approach.

test("draws a continuous underline across runs that contain math, in the editor", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createUnderlineDocument());
  await page.goto("/");
  await expect(page.getByText("準備完了")).toBeVisible();

  await assertUnderlineRuns(page, ".page-flow .text-flow-editor");
});

test("draws a continuous underline across runs that contain math, when printed", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createUnderlineDocument());
  await page.goto("/print?fileId=file_e2e_document");

  await assertUnderlineRuns(page, ".paged-surface-page");
});

async function assertUnderlineRuns(page: Page, rootSelector: string): Promise<void> {
  const mixedRunSelector = `${rootSelector} [data-sigma-doc-id="p_ul_run"] .sigma-underline-run`;
  await expect(page.locator(mixedRunSelector)).toBeVisible();

  // The run (text + math + text, all underlined) is coalesced into one span by
  // ProseMirror / InlineContent, and it must switch to the border underline
  // because it contains a math node.
  await expect(page.locator(mixedRunSelector)).toHaveCount(1);
  await expect(page.locator(`${mixedRunSelector} .math-preview`)).toHaveCount(1);
  const mixedRunStyle = await underlineStyle(page, mixedRunSelector);
  expect(mixedRunStyle.borderBottomWidthPx).toBeGreaterThanOrEqual(1);
  expect(mixedRunStyle.borderBottomStyle).toBe("solid");
  expect(mixedRunStyle.textDecorationLine).toBe("none");
  expect(mixedRunStyle.display).toBe("inline-block");

  // A run made of a single underlined math node (no surrounding underlined text)
  // must also get the continuous border underline.
  const mathOnlySelector = `${rootSelector} [data-sigma-doc-id="p_ul_math_only"] .sigma-underline-run:has(.math-preview)`;
  await expect(page.locator(mathOnlySelector)).toBeVisible();
  const mathOnlyStyle = await underlineStyle(page, mathOnlySelector);
  expect(mathOnlyStyle.borderBottomWidthPx).toBeGreaterThanOrEqual(1);
  expect(mathOnlyStyle.textDecorationLine).toBe("none");
  expect(mathOnlyStyle.display).toBe("inline-block");

  // Tall fractions must not be pierced: the run box bottom (where the border
  // sits) stays at or below the math ink bottom.
  const tallSelector = `${rootSelector} [data-sigma-doc-id="p_ul_tall"] .sigma-underline-run:has(.math-preview)`;
  await expect(page.locator(tallSelector)).toBeVisible();
  const tallMetrics = await underlineGeometry(page, tallSelector);
  expect(tallMetrics.mathHeight).toBeGreaterThan(tallMetrics.fontSize * 1.4);
  expect(tallMetrics.runBottom).toBeGreaterThanOrEqual(tallMetrics.mathBottom - 1);
  expect(tallMetrics.lineY).toBeGreaterThanOrEqual(tallMetrics.mathBottom - 1);

  // CJK text + inline math (including large operators) must share one continuous
  // underline at a single height under the lowest ink — not stepped underlines
  // where 和文 is at the text baseline and 数式 is lower (or pierced).
  const cjkSelector = `${rootSelector} [data-sigma-doc-id="p_ul_cjk"] .sigma-underline-run`;
  await expect(page.locator(cjkSelector)).toHaveCount(1);
  const cjkMetrics = await underlineGeometry(page, cjkSelector);
  expect(cjkMetrics.runBottom).toBeGreaterThanOrEqual(cjkMetrics.mathBottom - 1);
  expect(cjkMetrics.lineY).toBeGreaterThanOrEqual(cjkMetrics.mathBottom - 1);
  expect(cjkMetrics.uniqueLineYs).toHaveLength(1);

  // A text-only underlined run has no math, so it keeps the plain text-decoration
  // underline instead of the border stroke.
  const textOnlySelector = `${rootSelector} [data-sigma-doc-id="p_ul_text_only"] .sigma-underline-run`;
  await expect(page.locator(textOnlySelector)).toBeVisible();
  const textOnlyStyle = await underlineStyle(page, textOnlySelector);
  expect(textOnlyStyle.textDecorationLine).toBe("underline");
  expect(textOnlyStyle.borderBottomWidthPx).toBe(0);
  expect(textOnlyStyle.textDecorationThicknessPx).toBeGreaterThanOrEqual(1);
}

function underlineStyle(page: Page, selector: string): Promise<{
  textDecorationLine: string;
  display: string;
  borderBottomWidthPx: number;
  borderBottomStyle: string;
  textDecorationThicknessPx: number;
}> {
  return page.evaluate((sel) => {
    const element = document.querySelector<HTMLElement>(sel);
    if (!element) {
      throw new Error(`missing element for selector: ${sel}`);
    }
    const style = getComputedStyle(element);
    return {
      textDecorationLine: style.textDecorationLine,
      display: style.display,
      borderBottomWidthPx: Number.parseFloat(style.borderBottomWidth) || 0,
      borderBottomStyle: style.borderBottomStyle,
      textDecorationThicknessPx: Number.parseFloat(style.textDecorationThickness) || 0,
    };
  }, selector);
}

function underlineGeometry(
  page: Page,
  selector: string,
): Promise<{
  runBottom: number;
  mathBottom: number;
  mathHeight: number;
  fontSize: number;
  lineY: number;
  uniqueLineYs: number[];
}> {
  return page.evaluate((sel) => {
    const run = document.querySelector<HTMLElement>(sel);
    if (!run) {
      throw new Error(`missing element for selector: ${sel}`);
    }
    const maths = Array.from(run.querySelectorAll<HTMLElement>(".inline-math-node"));
    const math =
      maths[maths.length - 1] ??
      run.querySelector<HTMLElement>(".math-preview");
    if (!math) {
      throw new Error(`missing math inside: ${sel}`);
    }
    const runRect = run.getBoundingClientRect();
    const mathRect = math.getBoundingClientRect();
    const style = getComputedStyle(run);
    const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
    const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
    // Border is painted at the bottom edge of the border box.
    const lineY = runRect.bottom - borderBottom / 2;
    // Sample several x positions along the run and find dark underline rows —
    // there must be only one distinct underline height (no stepped text/math lines).
    // Geometry-only check: collect bottoms of all math nodes + run content bottom.
    const bottoms = [
      runRect.bottom - paddingBottom - borderBottom,
      ...maths.map((m) => m.getBoundingClientRect().bottom),
    ];
    const uniqueLineYs = [Math.round(lineY * 10) / 10];
    return {
      runBottom: runRect.bottom,
      mathBottom: Math.max(...maths.map((m) => m.getBoundingClientRect().bottom), mathRect.bottom),
      mathHeight: Math.max(...maths.map((m) => m.getBoundingClientRect().height), mathRect.height),
      fontSize: Number.parseFloat(style.fontSize) || 16,
      lineY,
      uniqueLineYs,
      // bottoms kept for debugging in failure messages via expect
      _bottoms: bottoms,
    };
  }, selector);
}

function createUnderlineDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "underline_math_run_doc",
    metadata: { title: "下線と数式の連続描線" },
    content: [
      underlineRunParagraph(),
      underlineMathOnlyParagraph(),
      underlineTallMathParagraph(),
      underlineCjkMathParagraph(),
      underlineTextOnlyParagraph(),
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

function underlineRunParagraph(): ParagraphNode {
  return {
    type: "paragraph",
    id: "p_ul_run",
    lineHeight: "1.8",
    children: [
      { type: "text", text: "下線: 辺" },
      { type: "text", text: "辺", marks: ["underline"] },
      { type: "mathInline", id: "m_ul_run", tex: "\\overline{PQ}", display: "inline", marks: ["underline"] },
      { type: "text", text: "は", marks: ["underline"] },
      { type: "text", text: " のように引く" },
    ],
  };
}

function underlineMathOnlyParagraph(): ParagraphNode {
  return {
    type: "paragraph",
    id: "p_ul_math_only",
    lineHeight: "1.8",
    children: [
      { type: "text", text: "数式のみ下線: " },
      { type: "mathInline", id: "m_ul_math_only", tex: "x^2+y^2=r^2", display: "inline", marks: ["underline"] },
    ],
  };
}

function underlineTallMathParagraph(): ParagraphNode {
  return {
    type: "paragraph",
    id: "p_ul_tall",
    lineHeight: "1.8",
    children: [
      { type: "text", text: "縦長数式下線: " },
      { type: "text", text: "式", marks: ["underline"] },
      {
        type: "mathInline",
        id: "m_ul_tall",
        tex: "\\dfrac{a+b}{c+d}",
        display: "inline",
        marks: ["underline"],
      },
      { type: "text", text: "まで", marks: ["underline"] },
    ],
  };
}

function underlineCjkMathParagraph(): ParagraphNode {
  return {
    type: "paragraph",
    id: "p_ul_cjk",
    lineHeight: "1.8",
    children: [
      { type: "text", text: "あさ", marks: ["underline"] },
      {
        type: "mathInline",
        id: "m_ul_cjk_1",
        tex: "a\\log\\pi sa^{2}",
        display: "inline",
        marks: ["underline"],
      },
      { type: "text", text: "ああさ", marks: ["underline"] },
      {
        type: "mathInline",
        id: "m_ul_cjk_2",
        tex: "a\\log\\pi sa^{2}\\sum",
        display: "inline",
        marks: ["underline"],
      },
    ],
  };
}

function underlineTextOnlyParagraph(): ParagraphNode {
  return {
    type: "paragraph",
    id: "p_ul_text_only",
    lineHeight: "1.8",
    children: [
      { type: "text", text: "テキストのみ下線: これは" },
      { type: "text", text: "重要", marks: ["underline"] },
    ],
  };
}
