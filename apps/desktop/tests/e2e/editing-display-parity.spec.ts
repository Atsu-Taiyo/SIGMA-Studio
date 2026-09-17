import { expect, test, type Locator, type Page } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";
import { grabShapeFromBody } from "./body-overlay-entry";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * The editor is the WYSIWYG surface, so anything it draws differently while focused than when idle
 * reads as the document changing under the author. Overlay text and table cells swap a Tiptap
 * editor for a static renderer on every focus change, which is the widest such seam in the app;
 * the geometry tests below walk every glyph rect, every boxed frame and the shape's own box across
 * that swap. Three specific divergences that were fixed have their own cases:
 *
 * 1. A blank line inside overlay text. ProseMirror pads every empty textblock with
 *    `<br class="ProseMirror-trailingBreak">`, so the blank line was a full line tall while the
 *    text shape was focused and 0px tall the moment it blurred — the lines below jumped up by one
 *    line every time the author clicked away (行間が変わって見える).
 * 2. A coloured formula. `.inline-math-node.editing` pinned `color: var(--text-primary)`, which
 *    overrode the styledText mark wrapping the node view, so opening a red formula for editing
 *    repainted it black until it was committed.
 * 3. Boxed runs. The Tiptap mark and the static renderer emitted different class names and nested
 *    the inline wrappers in a different order, and the editor drew one rectangle per run where the
 *    static twin drew a border per segment.
 */

const TEXT_ID = "shape_parity_text";
const TEXT_SELECTOR = `.overlay-shape-text[data-overlay-shape-id="${TEXT_ID}"]`;
const OVERLAY_MACRO_TEXT_ID = "shape_parity_overlay_macro";
const OVERLAY_MACRO_TEXT_SELECTOR = `.overlay-shape-text[data-overlay-shape-id="${OVERLAY_MACRO_TEXT_ID}"]`;
const OVERLAY_PREAMBLE_MACRO_MATH_ID = "math_parity_overlay_preamble_macro";
const BOXED_TEXT_ID = "shape_parity_boxed";
const BOXED_TEXT_SELECTOR = `.overlay-shape-text[data-overlay-shape-id="${BOXED_TEXT_ID}"]`;
const TABLE_ID = "shape_parity_table";
const TABLE_SELECTOR = `.overlay-shape-tableShape[data-overlay-shape-id="${TABLE_ID}"]`;
const TREND_TABLE_ID = "shape_parity_trend";
const TREND_TABLE_SELECTOR = `.overlay-shape-tableShape[data-overlay-shape-id="${TREND_TABLE_ID}"]`;
const MATH_ID = "math_parity_colored";
const MATH_COLOR = "#dc2626";
/** 入れ子分数。旧実装は静的側だけ `\dfrac` へ書き換えていたので、開くと内側だけ縮んで見えた。 */
const NESTED_FRACTION_MATH_ID = "math_parity_nested_fraction";
/** MathLive が描けないので静的側は KaTeX へ落ちる式。KaTeX の既定は textstyle。 */
const KATEX_FALLBACK_MATH_ID = "math_parity_katex_fallback";
/** 上と同じ式の `\dfrac` 版。静的側が displaystyle なら `\frac` 版と同じ高さになる。 */
const KATEX_FALLBACK_DISPLAY_MATH_ID = "math_parity_katex_fallback_display";
/** 前文マクロを使う式。マクロが静的側に渡らないと KaTeX (textstyle) に固定される。 */
const PREAMBLE_MACRO_MATH_ID = "math_parity_preamble_macro";
/** 共通テスト選択肢。独自 class の寸法も PDF と同じ静的組版箱だけが決める。 */
const KYOUTSUU_CHOICE_MATH_ID = "math_parity_kyoutsuu_choice";
const PARITY_TEX_PREAMBLE = String.raw`\newcommand{\RR}{\mathbb{R}}`;
const INLINE_MATH_INPUT_MODE_STORAGE_KEY = "sigma-studio:inline-math-input-mode";
/** The acceptance tolerance for the focused/idle comparison. */
const PARITY_TOLERANCE_PX = 0.5;
/**
 * 数式ノードの箱を編集中と比べるときの許容。math-field はキャレット層と選択層を持ち、
 * 静的プレビューにはその分の余白が無いので厳密には一致しない。組版が変われば
 * (displaystyle ⇔ textstyle) 分数 1 段でも数 px 単位で動くので、この幅で十分捕まる。
 */
const TYPESET_TOLERANCE_PX = 1.5;

function parityDocument(): SigmaDocument {
  const problem = sampleDocument.content.find((block) => block.type === "problem");
  if (!problem || problem.type !== "problem") {
    throw new Error("Editing/display parity fixture requires the sample problem");
  }

  return {
    ...sampleDocument,
    metadata: { ...sampleDocument.metadata, texPreamble: PARITY_TEX_PREAMBLE },
    content: [
      {
        id: "parity_paragraph",
        type: "paragraph",
        children: [
          { type: "text", text: "赤い" },
          { type: "mathInline", id: MATH_ID, tex: "x^2+1", display: "inline", color: MATH_COLOR },
        ],
      },
      {
        id: "parity_typeset_paragraph",
        type: "paragraph",
        children: [
          {
            type: "mathInline",
            id: NESTED_FRACTION_MATH_ID,
            tex: String.raw`\frac{x}{\frac{a}{b}}`,
            display: "inline",
          },
          { type: "text", text: " " },
          {
            type: "mathInline",
            id: KATEX_FALLBACK_MATH_ID,
            tex: String.raw`1,\dots,\frac{a}{b}`,
            display: "inline",
          },
          { type: "text", text: " " },
          {
            type: "mathInline",
            id: KATEX_FALLBACK_DISPLAY_MATH_ID,
            tex: String.raw`1,\dots,\dfrac{a}{b}`,
            display: "inline",
          },
          { type: "text", text: " " },
          {
            type: "mathInline",
            id: PREAMBLE_MACRO_MATH_ID,
            tex: String.raw`\frac{a}{b}\RR`,
            display: "inline",
          },
        ],
      },
      { ...problem, lead: [], hints: [], solution: [] },
    ],
    pageLayout: {
      ...sampleDocument.pageLayout,
      overlay: {
        ...sampleDocument.pageLayout?.overlay,
        overlaySnapshot: {
          version: 1,
          assets: {},
          shapes: [
            {
              id: TEXT_ID,
              type: "text",
              x: 60,
              y: 420,
              rotation: 0,
              props: {
                w: 200,
                h: 70,
                color: "#111111",
                size: "m",
                blocks: [
                  { type: "paragraph", id: "parity_text_p1", children: [{ type: "text", text: "うえ" }] },
                  { type: "paragraph", id: "parity_text_p2", children: [] },
                  { type: "paragraph", id: "parity_text_p3", children: [{ type: "text", text: "した" }] },
                ],
              },
            },
            {
              id: BOXED_TEXT_ID,
              type: "text",
              x: 320,
              y: 420,
              rotation: 0,
              props: {
                w: 300,
                h: 90,
                color: "#111111",
                size: "m",
                blocks: [
                  {
                    // A boxed run of text + a tall formula + text: the case where per-segment
                    // borders and one drawn rectangle disagree, and where the run's height is
                    // decided by the formula rather than by the glyphs beside it.
                    type: "paragraph",
                    id: "parity_boxed_p1",
                    children: [
                      { type: "text", text: "枠", marks: ["boxed"], boxedPaddingY: 2 },
                      {
                        type: "mathInline",
                        id: "math_parity_boxed",
                        tex: "\\frac{1}{2}",
                        display: "inline",
                        marks: ["boxed"],
                        boxedPaddingY: 2,
                      },
                      { type: "text", text: "です", marks: ["boxed"], boxedPaddingY: 2 },
                    ],
                  },
                  {
                    // Every other inline wrapper, combined with a box: the mark nesting order has
                    // to be the same on both sides or the box scales with a different font size.
                    type: "paragraph",
                    id: "parity_boxed_p2",
                    children: [
                      {
                        type: "text",
                        text: "太字斜体下線",
                        marks: ["bold", "italic", "underline", "boxed"],
                        boxedVariant: "thick",
                        boxedPaddingY: 1,
                        fontSize: 13,
                        color: "#1d4ed8",
                      },
                      { type: "text", text: "そと" },
                    ],
                  },
                ],
              },
            },
            {
              id: OVERLAY_MACRO_TEXT_ID,
              type: "text",
              x: 650,
              y: 420,
              rotation: 0,
              props: {
                w: 110,
                h: 32,
                color: "#111111",
                size: "m",
                blocks: [{
                  type: "paragraph",
                  id: "parity_macro_p1",
                  children: [
                    { type: "text", text: "macro " },
                    {
                      type: "mathInline",
                      id: OVERLAY_PREAMBLE_MACRO_MATH_ID,
                      tex: String.raw`\RR`,
                      display: "inline",
                    },
                  ],
                }],
              },
            },
            {
              id: TABLE_ID,
              type: "tableShape",
              x: 60,
              y: 560,
              rotation: 0,
              props: {
                w: 240,
                h: 68,
                table: {
                  version: 1,
                  kind: "plain",
                  columns: [
                    { id: "parity_col_1", width: { mode: "fr", value: 1, min: 60 } },
                    { id: "parity_col_2", width: { mode: "fr", value: 1, min: 60 } },
                  ],
                  rows: [{ id: "parity_row_1", height: { mode: "auto", min: 34 }, role: "body" }],
                  cells: [
                    {
                      id: "parity_cell_1",
                      rowId: "parity_row_1",
                      columnId: "parity_col_1",
                      content: [{
                        type: "paragraph",
                        id: "parity_cell_1_p",
                        align: "center",
                        children: [{ type: "text", text: "枠セル", marks: ["boxed"], boxedPaddingY: 2 }],
                      }],
                    },
                    {
                      id: "parity_cell_2",
                      rowId: "parity_row_1",
                      columnId: "parity_col_2",
                      content: [{
                        type: "paragraph",
                        id: "parity_cell_2_p",
                        align: "center",
                        children: [{ type: "text", text: "隣" }],
                      }],
                    },
                  ],
                  grid: {
                    borderColor: "#111827",
                    borderWidth: 1,
                    borderStyle: "solid",
                    showOuterBorder: true,
                    showInnerBorders: true,
                  },
                  defaultCellStyle: {
                    align: "center",
                    verticalAlign: "middle",
                    paddingX: 8,
                    paddingY: 5,
                    color: "#111827",
                    fontSize: 15,
                    fontWeight: "normal",
                  },
                },
              },
            },
            {
              // Trend cells: one per direction, plus a merged one whose arrow widens with its
              // `colSpan`. They are drawn by `OverlayTableTrendCell` on every surface.
              id: TREND_TABLE_ID,
              type: "tableShape",
              x: 340,
              y: 560,
              rotation: 0,
              props: {
                w: 300,
                h: 68,
                table: {
                  version: 1,
                  kind: "variation",
                  columns: [
                    { id: "trend_col_1", width: { mode: "fr", value: 1, min: 60 } },
                    { id: "trend_col_2", width: { mode: "fr", value: 1, min: 60 } },
                    // Narrower than the arrow's own 44px, like the interval columns of an imported
                    { id: "trend_col_3", width: { mode: "fixed", value: 30 } },
                  ],
                  rows: [
                    { id: "trend_row_1", height: { mode: "auto", min: 34 }, role: "body" },
                    { id: "trend_row_2", height: { mode: "auto", min: 34 }, role: "body" },
                  ],
                  cells: [
                    {
                      id: "trend_cell_up",
                      rowId: "trend_row_1",
                      columnId: "trend_col_1",
                      content: [{
                        type: "trend",
                        id: "trend_up",
                        direction: "up",
                        label: [{ type: "text", text: "増" }],
                      }],
                    },
                    {
                      id: "trend_cell_down",
                      rowId: "trend_row_1",
                      columnId: "trend_col_2",
                      content: [{ type: "trend", id: "trend_down", direction: "down" }],
                    },
                    {
                      id: "trend_cell_narrow",
                      rowId: "trend_row_1",
                      columnId: "trend_col_3",
                      content: [{ type: "trend", id: "trend_narrow", direction: "up" }],
                    },
                    {
                      id: "trend_cell_flat",
                      rowId: "trend_row_2",
                      columnId: "trend_col_1",
                      colSpan: 2,
                      content: [{ type: "trend", id: "trend_flat", direction: "flat" }],
                    },
                  ],
                  grid: {
                    borderColor: "#111827",
                    borderWidth: 1,
                    borderStyle: "solid",
                    showOuterBorder: true,
                    showInnerBorders: true,
                  },
                  defaultCellStyle: {
                    align: "center",
                    verticalAlign: "middle",
                    paddingX: 8,
                    paddingY: 5,
                    color: "#111827",
                    fontSize: 15,
                    fontWeight: "normal",
                  },
                },
              },
            },
          ],
        },
      },
    },
  } as SigmaDocument;
}

function parityDocumentWithKyoutsuuChoice(): SigmaDocument {
  const document = parityDocument();
  return {
    ...document,
    content: [
      ...document.content,
      {
        id: "choice_reference_line",
        type: "paragraph",
        children: [
          { type: "mathInline", id: "choice_reference_zero", tex: String.raw`\kyoutsuuchoice{0}\quad`, display: "inline" },
          { type: "text", text: "プロ選手と花子さんの「ボールが最も高くなるときの地上の位置」の方が、", fontFamily: "serif" },
        ],
      },
      {
        id: "parity_kyoutsuu_choice_paragraph",
        type: "paragraph",
        children: [
          { type: "text", text: "次の" },
          {
            type: "mathInline",
            id: KYOUTSUU_CHOICE_MATH_ID,
            tex: String.raw`\kyoutsuuchoice{0}\text{aaa}\quad\kyoutsuuchoice{1}\text{aaa}\quad\kyoutsuuchoice{2}\text{aaa}\quad\kyoutsuuchoice{3}\text{aaa}`,
            display: "inline",
          },
          { type: "text", text: "に当てはまるもの" },
        ],
      },
    ],
  };
}

/** Top edge and height of every rendered line inside the overlay text shape. */
async function overlayTextLineBoxes(page: Page): Promise<Array<{ height: number; top: number }>> {
  return page.evaluate((selector) => {
    const shape = document.querySelector<HTMLElement>(selector);
    const content = shape?.querySelector<HTMLElement>(".overlay-text-shape-content");
    if (!content) {
      throw new Error("overlay text content not found");
    }
    const contentTop = content.getBoundingClientRect().top;
    return Array.from(content.querySelectorAll<HTMLElement>("p")).map((paragraph) => {
      const rect = paragraph.getBoundingClientRect();
      return {
        height: Math.round(rect.height * 100) / 100,
        top: Math.round((rect.top - contentTop) * 100) / 100,
      };
    });
  }, TEXT_SELECTOR);
}

interface ShapeGeometry {
  /** One entry per drawn thing, labelled so a mismatch says which one moved. */
  items: Array<{ height: number; label: string; left: number; top: number; width: number }>;
}

/**
 * Every rect the shape draws, relative to its own box: the glyph runs, each boxed frame, each drawn
 * run rectangle, and every line box.
 *
 * Text is measured through a `Range` over the text nodes rather than through their parent elements,
 * so the comparison is over where the glyphs actually landed and not over the wrappers around them
 * (the two surfaces are allowed to differ in one wrapper — `.rich-inline-content` — and must not
 * differ in anything the reader can see).
 */
async function shapeGeometry(page: Page, selector: string, contentSelector: string): Promise<ShapeGeometry> {
  return page.evaluate(({ selector: shapeSelector, contentSelector: innerSelector }) => {
    const shape = document.querySelector<HTMLElement>(shapeSelector);
    const roots = Array.from(shape?.querySelectorAll<HTMLElement>(innerSelector) ?? []);
    if (!shape || roots.length === 0) {
      throw new Error(`no ${innerSelector} inside ${shapeSelector}`);
    }
    const origin = shape.getBoundingClientRect();
    const round = (value: number) => Math.round(value * 100) / 100;
    const items: Array<{ height: number; label: string; left: number; top: number; width: number }> = [];
    const push = (label: string, rect: DOMRect) => {
      items.push({
        height: round(rect.height),
        label,
        left: round(rect.left - origin.left),
        top: round(rect.top - origin.top),
        width: round(rect.width),
      });
    };

    roots.forEach((root, rootIndex) => {
      let textIndex = 0;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        if (text.trim().length === 0) {
          continue;
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        Array.from(range.getClientRects()).forEach((rect, rectIndex) => {
          push(`text#${rootIndex}.${textIndex}.${rectIndex}:${text}`, rect);
        });
        range.detach();
        textIndex += 1;
      }

      // The element that paints a boxed run's border is its height target: the `.boxed-text` span
      // itself in static output, and a ProseMirror decoration span inside it in the editor (which
      // zeroes the wrapper's own border through `.boxed-text:has(…)`). Measuring `.boxed-text` would
      // compare a painted frame against an invisible wrapper.
      root.querySelectorAll<HTMLElement>('[data-boxed-run-height-target="true"]').forEach((element, index) => {
        Array.from(element.getClientRects()).forEach((rect, rectIndex) => {
          push(`box#${rootIndex}.${index}.${rectIndex}`, rect);
        });
      });
      root.querySelectorAll<HTMLElement>(".boxed-run-frame").forEach((element, index) => {
        push(`frame#${rootIndex}.${index}`, element.getBoundingClientRect());
      });
      root.querySelectorAll<HTMLElement>("p,h1,h2,h3").forEach((element, index) => {
        push(`line#${rootIndex}.${index}`, element.getBoundingClientRect());
      });
    });

    return { items };
  }, { contentSelector, selector });
}

/**
 * Reads the geometry until it stops changing.
 *
 * Several consecutive readings have to agree, not two: the boxed-run measurement runs over a chain
 * of animation frames and then dispatches decorations that trigger another pass, so a single quiet
 * frame proves nothing. Reading the first frame after focus used to pass while a drawn rectangle
 * was still one pass away from appearing.
 */
async function settledShapeGeometry(page: Page, selector: string, contentSelector: string): Promise<ShapeGeometry> {
  let previous = await shapeGeometry(page, selector, contentSelector);
  let quiet = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await page.waitForTimeout(150);
    const current = await shapeGeometry(page, selector, contentSelector);
    quiet = geometryDelta(previous, current) === 0 ? quiet + 1 : 0;
    previous = current;
    if (quiet >= 4) {
      return current;
    }
  }
  throw new Error(`${selector} geometry never settled`);
}

/**
 * The largest movement between two readings, or `Infinity` when they do not even describe the same
 * set of drawn things (a wrapper appearing or a frame vanishing has to fail, not be averaged away).
 */
function geometryDelta(a: ShapeGeometry, b: ShapeGeometry): number {
  const labels = a.items.map((item) => item.label).join("|");
  if (labels !== b.items.map((item) => item.label).join("|")) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, ...a.items.map((item, index) => {
    const other = b.items[index];
    return Math.max(
      Math.abs(item.left - other.left),
      Math.abs(item.top - other.top),
      Math.abs(item.width - other.width),
      Math.abs(item.height - other.height),
    );
  }));
}

/** The saved `props.h` of an overlay shape, as the runtime mock last persisted it. */
async function savedShapeHeight(page: Page, shapeId: string): Promise<number | undefined> {
  return page.evaluate((id) => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return undefined;
    }
    const shapes = (JSON.parse(raw) as {
      pageLayout?: { overlay?: { overlaySnapshot?: { shapes?: Array<{ id: string; props?: { h?: number } }> } } };
    }).pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    return shapes.find((shape) => shape.id === id)?.props?.h;
  }, shapeId);
}

/**
 * A fresh page renders overlay shapes through the read-only preview layer until the page's overlay
 * editing session activates, and the first pointerdown swaps in the interactive editor
 * synchronously. Two separate clicks re-resolve the locator against whatever is currently mounted
 * while Chromium still reads them as a double-click (see overlay-callout-rich-text.spec.ts).
 */
async function dblclickIntoTextShape(page: Page, shape: Locator): Promise<void> {
  const box = await shape.boundingBox();
  expect(box).not.toBeNull();
  const point = {
    x: box!.x + Math.min(16, box!.width * 0.3),
    y: box!.y + Math.min(7, box!.height * 0.15),
  };
  // 本文モードでは未選択の図形が透過するので、明示操作で掴んでからもう一度押して編集に入る。
  await grabShapeFromBody(page, point);
  await page.mouse.click(point.x, point.y);
}

test("keeps overlay text line boxes identical between the focused editor and the idle view", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, parityDocument());
  await page.goto("/");

  const shape = page.locator(TEXT_SELECTOR);
  await expect(shape).toBeVisible();
  await expect.poll(() => overlayTextLineBoxes(page).then((boxes) => boxes.length)).toBe(3);

  const displayBoxes = await overlayTextLineBoxes(page);
  // The blank middle line must occupy a real line box, not collapse to zero height.
  expect(displayBoxes[1]?.height).toBeGreaterThan(0);
  expect(displayBoxes[2]?.top).toBeGreaterThan(displayBoxes[1]!.top);

  await dblclickIntoTextShape(page, shape);
  await expect(page.locator(`${TEXT_SELECTOR} .ProseMirror[contenteditable="true"]`)).toBeVisible();
  await expect.poll(() => overlayTextLineBoxes(page)).toEqual(displayBoxes);
});

test("keeps a coloured formula's colour while its editor is open", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, parityDocument());
  await page.goto("/");

  const math = page.locator(`.text-flow-editor .inline-math-node[data-id="${MATH_ID}"]`);
  await expect(math).toBeVisible();

  const mathColor = () => math.evaluate((element) => window.getComputedStyle(element).color);
  await expect.poll(mathColor).toBe("rgb(220, 38, 38)");

  await math.click();
  await expect(math).toHaveClass(/editing/);
  await expect(page.locator(`.inline-math-node[data-id="${MATH_ID}"] math-field`)).toBeVisible();

  await expect.poll(mathColor).toBe("rgb(220, 38, 38)");
  await expect.poll(() => page
    .locator(`.inline-math-node[data-id="${MATH_ID}"] math-field`)
    .evaluate((element) => window.getComputedStyle(element).color)).toBe("rgb(220, 38, 38)");
});

test("keeps the document TeX environment while editing overlay text", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, parityDocument());
  await page.goto("/");

  const shape = page.locator(OVERLAY_MACRO_TEXT_SELECTOR);
  const mathSelector = `.inline-math-node[data-id="${OVERLAY_PREAMBLE_MACRO_MATH_ID}"]`;
  const math = shape.locator(mathSelector);
  await expect(math).toBeVisible();
  await expect(math.locator("[data-math-unrendered]")).toHaveCount(0);
  const idle = await settledBoundingBox(math);

  await dblclickIntoTextShape(page, shape);
  await expect(page.locator(`${OVERLAY_MACRO_TEXT_SELECTOR} .ProseMirror[contenteditable="true"]`)).toBeVisible();
  await expect(math.locator("[data-math-unrendered]")).toHaveCount(0);
  const focused = await settledBoundingBox(math);
  expect(Math.abs(focused.height - idle.height)).toBeLessThanOrEqual(TYPESET_TOLERANCE_PX);
  expect(Math.abs(focused.width - idle.width)).toBeLessThanOrEqual(TYPESET_TOLERANCE_PX);

  await math.click();
  await expect(math).toHaveClass(/editing/);
  await expect(math.locator("math-field")).toBeVisible();
  const editing = await settledBoundingBox(math);
  expect(Math.abs(editing.height - idle.height)).toBeLessThanOrEqual(TYPESET_TOLERANCE_PX);
});

test("keeps every glyph and boxed frame in a text shape put when it takes focus", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, parityDocument());
  await page.goto("/");

  const shape = page.locator(BOXED_TEXT_SELECTOR);
  await expect(shape).toBeVisible();
  await expect(shape.locator(".boxed-text")).toHaveCount(4);
  const savedHeight = await savedShapeHeight(page, BOXED_TEXT_ID);
  const idle = await settledShapeGeometry(page, BOXED_TEXT_SELECTOR, ".overlay-text-shape-content");
  expect(idle.items.length).toBeGreaterThan(8);

  await dblclickIntoTextShape(page, shape);
  await expect(page.locator(`${BOXED_TEXT_SELECTOR} .ProseMirror[contenteditable="true"]`)).toBeVisible();
  // The same four boxed spans, from the Tiptap mark this time instead of the static renderer.
  await expect(shape.locator(".boxed-text")).toHaveCount(4);

  const focused = await settledShapeGeometry(page, BOXED_TEXT_SELECTOR, ".overlay-text-shape-content");
  expect(geometryDelta(idle, focused)).toBeLessThanOrEqual(PARITY_TOLERANCE_PX);
  // A drawn rectangle for the whole run is only allowed where the static twin draws one too, and
  // this shape's twin paints per-segment borders.
  await expect(shape.locator(".boxed-run-frame")).toHaveCount(0);
  // `handleTextAutoSize` writes `props.h` back whenever the measured height differs, which would
  // mark the document dirty just for having clicked into a shape.
  expect(await savedShapeHeight(page, BOXED_TEXT_ID)).toBe(savedHeight);
});

test("keeps a table cell's content put through all three of its renderers", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, parityDocument());
  await page.goto("/");

  // A table cell is drawn by three different things: the read-only static table view before the
  // page's overlay session activates, the static paragraph view once the shape is interactive but
  // the cell is not being edited, and Tiptap while it is. `table` is the only root all three share.
  const shape = page.locator(TABLE_SELECTOR);
  await expect(shape).toBeVisible();
  await expect(shape.locator(".boxed-text")).toHaveCount(1);
  const idle = await settledShapeGeometry(page, TABLE_SELECTOR, "table");

  const boxedCell = shape.locator("td").first();
  await grabShapeFromBody(page, boxedCell);
  await boxedCell.click();
  await expect(page.locator(`${TABLE_SELECTOR} .ProseMirror[contenteditable="true"]`).first()).toBeVisible();
  expect(geometryDelta(idle, await settledShapeGeometry(page, TABLE_SELECTOR, "table")))
    .toBeLessThanOrEqual(PARITY_TOLERANCE_PX);
  await expect(shape.locator(".boxed-run-frame")).toHaveCount(0);

  // Moving the caret to the neighbour hands the boxed cell back to the static paragraph view, the
  // third renderer, while the shape stays interactive.
  const plainCell = shape.locator("td").nth(1);
  await grabShapeFromBody(page, plainCell);
  await plainCell.click();
  await expect(shape.locator('[data-boxed-run-height-target="true"]')).toHaveCount(1);
  expect(geometryDelta(idle, await settledShapeGeometry(page, TABLE_SELECTOR, "table")))
    .toBeLessThanOrEqual(PARITY_TOLERANCE_PX);
});

test("keeps a trend cell's arrow the same size once the table becomes interactive", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, parityDocument());
  await page.goto("/");

  const shape = page.locator(TREND_TABLE_SELECTOR);
  await expect(shape).toBeVisible();
  // One drawing of the arrow, on every surface: the idle canvas mounts the static table view, the
  // interactive layer mounts the cell editor, and both reach the same component. The editing surface
  // used to draw a KaTeX arrow of its own instead.
  await expect(shape.locator("polygon")).toHaveCount(4);
  await expect(shape.locator(".katex")).toHaveCount(0);

  // Every rect the arrows occupy, the drawn line inside each of them, and how far each one overflows
  // its cell: the box comes from the container and the drawing is scaled into it, so all three have
  // to be compared.
  const arrowGeometry = async () => shape.locator(".overlay-table-trend svg").evaluateAll(
    (elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      const line = element.querySelector("line")!.getBoundingClientRect();
      const cell = element.closest("td")!.getBoundingClientRect();
      return [
        `${Math.round(box.width)}x${Math.round(box.height)}`,
        `${Math.round(line.width)}x${Math.round(line.height)}`,
        `overflow:${Math.round(Math.max(0, cell.left - box.left, box.right - cell.right))}`,
      ].join(" ");
    }),
  );
  const idle = await arrowGeometry();
  // Four arrows, none degenerate, the merged one wider than a single-column one, and none of them
  // reaching past its cell — `.overlay-table-cell-content-layer` clips, so an arrow that cannot
  // shrink into the 30px column would lose its head in the editor and in the PDF.
  expect(idle).toHaveLength(4);
  expect(idle.filter((entry) => /^\d+x\d+ [1-9]/.test(entry))).toHaveLength(4);
  expect(idle[3]).not.toBe(idle[0]);
  expect(idle.map((entry) => entry.split(" ")[2])).toEqual(["overflow:0", "overflow:0", "overflow:0", "overflow:0"]);

  const cell = shape.locator("td").first();
  await grabShapeFromBody(page, cell);
  await cell.click();
  // The editor-only class: `<table>` alone is also what the read-only static view renders, so waiting
  // on that would let the rest of this test compare the idle surface with itself.
  await expect(page.locator(`${TREND_TABLE_SELECTOR} .overlay-table-shape-table`)).toBeVisible();

  await expect(shape.locator("polygon")).toHaveCount(4);
  await expect(shape.locator(".katex")).toHaveCount(0);
  // The arrow used to be sized by `svg { width: 100%; height: 100% }`, a rule the interactive layer
  // does not carry: the same cell drew 116x29 idle and 44x24 here.
  expect(await arrowGeometry()).toEqual(idle);
});

/**
 * 数式ノードの箱が落ち着くまで待って読む。囲み枠の高さ合わせや math-field のマウントは
 * 複数フレームにまたがるので、1 フレームだけ静かでも読み時ではない。
 */
async function settledBoundingBox(locator: Locator): Promise<{ height: number; width: number }> {
  let previous = { height: -1, width: -1 };
  let quiet = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await locator.page().waitForTimeout(100);
    const box = await locator.boundingBox();
    if (!box) {
      throw new Error("inline math node has no box");
    }
    const current = { height: box.height, width: box.width };
    quiet = current.height === previous.height && current.width === previous.width ? quiet + 1 : 0;
    previous = current;
    if (quiet >= 3) {
      return current;
    }
  }
  throw new Error("inline math node box never settled");
}

/**
 * 数式は「開く前 / math-field 表示中 / 閉じた後」で同じ組版で描かれなければならない。
 * 高さは mathstyle をそのまま映す (displaystyle の分数は textstyle の 1.5 倍以上)。
 * 経路 B (静的側だけ TeX を `\dfrac` へ書き換える) と経路 D (静的側にマクロが渡らず
 * KaTeX の textstyle へ倒れる) は、どちらが戻ってもここで箱の高さが変わる。
 */
for (const { id, label } of [
  { id: NESTED_FRACTION_MATH_ID, label: "入れ子分数" },
  { id: PREAMBLE_MACRO_MATH_ID, label: "前文マクロを使う式" },
]) {
  test(`keeps ${label} typeset the same before, during and after editing`, async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.addInitScript(() => window.localStorage.clear());
    await installDesktopRuntimeMock(page, parityDocument());
    await page.goto("/");

    const math = page.locator(`.text-flow-editor .inline-math-node[data-id="${id}"]`);
    await expect(math).toBeVisible();
    // 描けなかった式は生 TeX 表示になる。組版以前の問題なので先に弾く。
    await expect(math.locator("[data-math-unrendered]")).toHaveCount(0);

    const idleBefore = await settledBoundingBox(math);

    await math.click();
    await expect(math).toHaveClass(/editing/);
    await expect(page.locator(`.inline-math-node[data-id="${id}"] math-field`)).toBeVisible();
    const editing = await settledBoundingBox(math);

    await page.keyboard.press("Escape");
    await expect(math).not.toHaveClass(/editing/);
    const idleAfter = await settledBoundingBox(math);

    expect(Math.abs(editing.height - idleBefore.height)).toBeLessThanOrEqual(TYPESET_TOLERANCE_PX);
    expect(Math.abs(idleAfter.height - idleBefore.height)).toBeLessThanOrEqual(PARITY_TOLERANCE_PX);
  });
}

/**
 * MathLive が描けない式 (`\dots`) は静的側だけ KaTeX に落ちる。**KaTeX の既定は textstyle** なので、
 * 組版スタイルを前置していないと、この経路の式だけが小さいまま残る (経路 A)。
 * `\frac` 版と `\dfrac` 版の高さを比べれば、字形の違う 2 つのレンダラを跨がずにそれを検出できる
 * (displaystyle なら両者は同じ組版、textstyle なら `\frac` だけが縮む)。
 */
test("renders the KaTeX fallback path in the document typeset style", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, parityDocument());
  await page.goto("/");

  const plain = page.locator(`.text-flow-editor .inline-math-node[data-id="${KATEX_FALLBACK_MATH_ID}"]`);
  const display = page.locator(`.text-flow-editor .inline-math-node[data-id="${KATEX_FALLBACK_DISPLAY_MATH_ID}"]`);
  await expect(plain).toBeVisible();
  await expect(display).toBeVisible();
  // この式が KaTeX へ落ちていること自体が前提。MathLive で描けるようになったら別の式に替える。
  await expect(plain.locator(".katex")).toHaveCount(1);

  const plainBox = await settledBoundingBox(plain);
  const displayBox = await settledBoundingBox(display);

  expect(Math.abs(plainBox.height - displayBox.height)).toBeLessThanOrEqual(PARITY_TOLERANCE_PX);
});

test.describe("Common Test choice visual verification", () => {
test.use({ deviceScaleFactor: 3 });
test("keeps canonical static math geometry while MathLive is editing", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, parityDocumentWithKyoutsuuChoice());
  await page.goto("/");

  for (const id of [
    KYOUTSUU_CHOICE_MATH_ID,
    NESTED_FRACTION_MATH_ID,
    PREAMBLE_MACRO_MATH_ID,
  ]) {
    const math = page.locator(`.text-flow-editor .inline-math-node[data-id="${id}"]`);
    const preview = math.locator(":scope > .math-preview");
    await expect(math).toBeVisible();
    await expect(preview).toBeVisible();
    const idle = await settledBoundingBox(math);
    const idleMarkup = await preview.innerHTML();

    if (id === KYOUTSUU_CHOICE_MATH_ID) {
      // Compare visible lowercase ink with the oval, not merely the formula's
      // unchanged layout box: that missed the original vertical misalignment.
      const centerGap = await preview.evaluate(el => {
        const oval = el.querySelector<HTMLElement>(".sigma-kyoutsuu-choice")!;
        const label = oval.nextElementSibling as HTMLElement;
        if (label.textContent !== "aaa") throw new Error("Missing adjacent text fixture");
        const style = getComputedStyle(label);
        const context = document.createElement("canvas").getContext("2d")!;
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const ink = context.measureText("aaa");
        const baseline = document.createElement("span");
        baseline.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
        label.after(baseline);
        const textCenter = baseline.getBoundingClientRect().top
          + (ink.actualBoundingBoxDescent - ink.actualBoundingBoxAscent) / 2;
        baseline.remove();
        const rect = oval.getBoundingClientRect();
        return Math.abs(rect.top + rect.height / 2 - textCenter);
      });
      expect(centerGap, "choice oval and adjacent aaa ink centers").toBeLessThanOrEqual(1.5);
      await page.screenshot({ path: testInfo.outputPath("choice-static.png") });
      await math.locator("xpath=..").screenshot({ path: testInfo.outputPath("choice-detail.png"), scale: "css" });
      const paragraph = math.locator("xpath=..");
      await paragraph.screenshot({ path: testInfo.outputPath("choice-enlarged.png"), scale: "device" });
      await page.locator('.text-flow-editor [data-sigma-doc-id="choice_reference_line"]').screenshot({
        path: testInfo.outputPath("choice-reference-line.png"), scale: "device",
      });
    }

    await math.click();
    await expect(math).toHaveClass(/editing/);
    await expect(math.locator("math-field")).toBeVisible();
    // 非表示にしても取り外さない。同じ静的 markup がレイアウトを所有し続ける。
    await expect(preview).toHaveCSS("visibility", "hidden");
    const editing = await settledBoundingBox(math);

    if (id === KYOUTSUU_CHOICE_MATH_ID) {
      await page.screenshot({ path: testInfo.outputPath("choice-editing.png") });
    }

    expect(Math.abs(editing.height - idle.height), `${id} height`).toBeLessThanOrEqual(PARITY_TOLERANCE_PX);
    expect(Math.abs(editing.width - idle.width), `${id} width`).toBeLessThanOrEqual(PARITY_TOLERANCE_PX);

    let committedDraft = false;
    if (id === NESTED_FRACTION_MATH_ID) {
      await math.locator("math-field").evaluate((field) => {
        (field as HTMLElement & { value: string }).value = String.raw`\frac{1}{2}+x`;
        field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      });
      await expect.poll(() => preview.innerHTML()).not.toBe(idleMarkup);
      const draftLayout = await settledBoundingBox(math);
      await page.keyboard.press("Enter");
      await expect(math).not.toHaveClass(/editing/);
      const committedLayout = await settledBoundingBox(math);
      expect(Math.abs(draftLayout.height - committedLayout.height), "draft height parity")
        .toBeLessThanOrEqual(PARITY_TOLERANCE_PX);
      expect(Math.abs(draftLayout.width - committedLayout.width), "draft width parity")
        .toBeLessThanOrEqual(PARITY_TOLERANCE_PX);
      committedDraft = true;
    }

    if (!committedDraft) {
      await page.keyboard.press("Escape");
      await expect(math).not.toHaveClass(/editing/);
    }
    await expect(preview).toBeVisible();
  }
});

});

/**
 * TeX 入力ダイアログのライブプレビューは本文の静的描画と同じ出口・同じ環境で描かれる。
 * ここが割れると「ダイアログが見えているときだけ組版が違う」= 経路 C の再発。
 */
test("keeps the TeX dialog preview identical to the body rendering", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(({ key, value }) => {
    window.localStorage.clear();
    window.localStorage.setItem(key, value);
  }, { key: INLINE_MATH_INPUT_MODE_STORAGE_KEY, value: "tex" });
  await installDesktopRuntimeMock(page, parityDocument(), {
    preserveStorageKeys: [INLINE_MATH_INPUT_MODE_STORAGE_KEY],
  });
  await page.goto("/");

  for (const id of [NESTED_FRACTION_MATH_ID, KATEX_FALLBACK_MATH_ID, PREAMBLE_MACRO_MATH_ID]) {
    const math = page.locator(`.text-flow-editor .inline-math-node[data-id="${id}"]`);
    await expect(math).toBeVisible();
    const bodyMarkup = await math.locator(".math-preview").innerHTML();

    await math.click();
    const preview = page.locator(".inline-math-tex-live-preview .math-preview");
    await expect(preview).toBeVisible();
    expect(await preview.innerHTML(), id).toBe(bodyMarkup);

    await page.keyboard.press("Escape");
    await expect(math).not.toHaveClass(/editing/);
  }
});
