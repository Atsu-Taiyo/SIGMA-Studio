import { expect, test, type Locator, type Page } from "@playwright/test";

import type { SigmaDocument } from "@/types/sigma-doc";

import { grabShapeFromBody } from "./body-overlay-entry";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { waitForPagedSurfaceSettled } from "./paged-surface";
import { selectUiOptionInPage } from "./ui-select";

/**
 * Where a table's `double` boundaries are drawn, on each of the surfaces that draw them.
 *
 * A `double` boundary cannot be a cell border (a collapsed border would only paint one of the two
 * lines), so it is drawn as its own absolutely positioned element on top of the table, positioned
 * from the resolved row offsets. Three things then have to agree, and used not to:
 *
 * - the drawn line and the cell edge it stands in for, on the same surface;
 * - the editing surface and the idle static view, which swap in and out under the author;
 * - the editor and the PDF, which is the gate this repository holds itself to.
 *
 * They disagreed because the resolved row heights could add up to less than the shape's height. The
 * browser stretches `<tr>` heights to fill `<table style="height: h">`, so the cells moved while the
 * overlay stayed where the model put it. The editor hid its half of that by reading its own rendered
 * rows back out of the DOM every time they resized and drawing from the measurement — the static
 * view and the PDF have no DOM to read, so there the line simply sat in the wrong place.
 *
 * `resolveTrackSizes` now fills the box exactly, which leaves the browser nothing to distribute and
 * makes the model's offsets the thing every surface draws.
 */

/** 0.5 CSS px ≈ 0.13 mm — below one device pixel, so invisible on paper. */
const TOLERANCE_PX = 0.5;

const AUTO_TABLE_ID = "shape_line_parity_auto";
const FIXED_TABLE_ID = "shape_line_parity_fixed";
const SPAN_TABLE_ID = "shape_line_parity_span";
const THICK_TABLE_ID = "shape_line_parity_thick";

function shapeSelector(id: string): string {
  return `.overlay-shape-tableShape[data-overlay-shape-id="${id}"]`;
}

const AUTO_SELECTOR = shapeSelector(AUTO_TABLE_ID);
const FIXED_SELECTOR = shapeSelector(FIXED_TABLE_ID);
const SPAN_SELECTOR = shapeSelector(SPAN_TABLE_ID);
const THICK_SELECTOR = shapeSelector(THICK_TABLE_ID);

/**
 * The tables under test, with the outer border width each one's grid origin is offset by.
 *
 * The 4px entry is the reason the list exists: at 1px the collapsed-border offset is 0.5px, which is
 * exactly the parity tolerance, so a residual that scaled with the border would sit right under it.
 */
const CASES = [
  { label: "auto rows", selector: AUTO_SELECTOR, outerBorderWidth: 1 },
  { label: "fixed rows", selector: FIXED_SELECTOR, outerBorderWidth: 1 },
  { label: "merged cells", selector: SPAN_SELECTOR, outerBorderWidth: 1 },
  { label: "thick outer border", selector: THICK_SELECTOR, outerBorderWidth: 4 },
] as const;

interface TableTrack {
  mode: "auto" | "fixed" | "fr";
  value?: number;
  min?: number;
  max?: number;
}

interface TableCellSpec {
  id: string;
  rowId: string;
  columnId: string;
  rowSpan?: number;
  colSpan?: number;
  text?: string;
}

/**
 * A table whose inner horizontal boundaries are `double`, so every one of them is drawn by the
 * overlay layer rather than by the cell edges.
 */
function doubleLineTable(
  prefix: string,
  rowTracks: TableTrack[],
  columnTracks: TableTrack[],
  cells: TableCellSpec[],
  outerBorderWidth = 1,
) {
  const rows = rowTracks.map((height, index) => ({
    id: `${prefix}_row_${index + 1}`,
    height,
    role: "body" as const,
  }));
  const columns = columnTracks.map((width, index) => ({
    id: `${prefix}_col_${index + 1}`,
    width,
  }));

  return {
    version: 1,
    kind: "plain",
    columns,
    rows,
    cells: cells.map((cell) => ({
      id: cell.id,
      rowId: cell.rowId,
      columnId: cell.columnId,
      ...(cell.rowSpan ? { rowSpan: cell.rowSpan } : {}),
      ...(cell.colSpan ? { colSpan: cell.colSpan } : {}),
      content: [{
        type: "paragraph",
        id: `${cell.id}_p`,
        align: "center",
        children: cell.text ? [{ type: "text", text: cell.text }] : [],
      }],
    })),
    grid: {
      borderColor: "#111827",
      borderWidth: 1,
      borderStyle: "solid",
      showOuterBorder: true,
      showInnerBorders: true,
      lineOverrides: [
        ...rows.slice(1).map((row) => ({
          axis: "horizontal",
          beforeRowId: row.id,
          style: { borderColor: "#111827", borderStyle: "double", borderWidth: 3 },
        })),
        // The outer border decides where the grid of cells starts, because a collapsed border sits
        // astride the table's edge. A fixture that only ever used 1px would let a residual of half
        // an outer border hide under a 0.5px tolerance.
        ...(outerBorderWidth === 1 ? [] : (["top", "bottom"] as const).map((edge) => ({
          axis: "horizontal",
          edge,
          style: { borderColor: "#111827", borderStyle: "solid", borderWidth: outerBorderWidth },
        }))),
      ],
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
  };
}

function parityDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_table_line_parity",
    metadata: { title: "表の罫線パリティ" },
    content: [
      {
        id: "line_parity_paragraph",
        type: "paragraph",
        children: [{ type: "text", text: "表の罫線位置の確認" }],
      },
    ],
    outputProfiles: {
      student: { showSolutions: false },
      teacher: { showSolutions: true },
      answerBook: { onlySolutions: true, showSolutions: true },
    },
    updatedAt: "2026-08-05T00:00:00.000+09:00",
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 15, right: 15, bottom: 15, left: 15 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
      overlay: {
        updatedAt: "2026-08-05T00:00:00.000+09:00",
        overlaySnapshot: {
          version: 1,
          assets: {},
          shapes: [
            {
              // Auto rows: 3 × 30px in a 168px shape. The declared rows add up to 90, so the
              // browser used to stretch them by 78px while the overlay stayed at 30 / 60.
              id: AUTO_TABLE_ID,
              type: "tableShape",
              x: 60,
              y: 120,
              rotation: 0,
              props: {
                w: 240,
                h: 168,
                table: doubleLineTable(
                  "auto",
                  [{ mode: "auto", min: 30 }, { mode: "auto", min: 30 }, { mode: "auto", min: 30 }],
                  [{ mode: "fr", value: 1, min: 60 }, { mode: "fr", value: 1, min: 60 }],
                  [
                    { id: "auto_c11", rowId: "auto_row_1", columnId: "auto_col_1", text: "あ" },
                    { id: "auto_c12", rowId: "auto_row_1", columnId: "auto_col_2", text: "い" },
                    { id: "auto_c21", rowId: "auto_row_2", columnId: "auto_col_1", text: "う" },
                    { id: "auto_c22", rowId: "auto_row_2", columnId: "auto_col_2", text: "え" },
                    { id: "auto_c31", rowId: "auto_row_3", columnId: "auto_col_1", text: "お" },
                    { id: "auto_c32", rowId: "auto_row_3", columnId: "auto_col_2", text: "か" },
                  ],
                ),
              },
            },
            {
              // Explicit row heights, which is what dragging a row boundary writes. Unequal on
              // purpose: an expansion that ignored the ratio would still add up to 132.
              id: FIXED_TABLE_ID,
              type: "tableShape",
              x: 330,
              y: 120,
              rotation: 0,
              props: {
                w: 200,
                h: 132,
                table: doubleLineTable(
                  "fixed",
                  [{ mode: "fixed", value: 20 }, { mode: "fixed", value: 40 }],
                  [{ mode: "fixed", value: 100 }, { mode: "fixed", value: 100 }],
                  [
                    { id: "fixed_c11", rowId: "fixed_row_1", columnId: "fixed_col_1", text: "上" },
                    { id: "fixed_c12", rowId: "fixed_row_1", columnId: "fixed_col_2", text: "右上" },
                    { id: "fixed_c21", rowId: "fixed_row_2", columnId: "fixed_col_1", text: "下" },
                    { id: "fixed_c22", rowId: "fixed_row_2", columnId: "fixed_col_2", text: "右下" },
                  ],
                ),
              },
            },
            {
              // A merged cell spanning two rows, and a cell whose text is far taller than the row
              // it sits in. Cell content is out of flow (`position: absolute; inset: 0`), which is
              // the reason the row heights can be decided without measuring anything — a row that
              // grew with its content would put this whole approach back to square one.
              id: SPAN_TABLE_ID,
              type: "tableShape",
              x: 60,
              y: 340,
              rotation: 0,
              props: {
                w: 240,
                h: 150,
                table: doubleLineTable(
                  "span",
                  [{ mode: "auto", min: 24 }, { mode: "auto", min: 24 }, { mode: "auto", min: 48 }],
                  [{ mode: "fr", value: 1, min: 60 }, { mode: "fr", value: 1, min: 60 }],
                  [
                    { id: "span_c11", rowId: "span_row_1", columnId: "span_col_1", rowSpan: 2, text: "結合" },
                    { id: "span_c12", rowId: "span_row_1", columnId: "span_col_2", text: "あふれる長い文章がここに入って行の高さを超える" },
                    { id: "span_c22", rowId: "span_row_2", columnId: "span_col_2", text: "え" },
                    { id: "span_c31", rowId: "span_row_3", columnId: "span_col_1", colSpan: 2, text: "横結合" },
                  ],
                ),
              },
            },
            {
              // A 4px outer border. The whole grid of cells starts 2px lower than the box the
              // overlay draws into, so this is where a residual that scales with the border width
              // becomes bigger than the parity tolerance instead of hiding under it.
              id: THICK_TABLE_ID,
              type: "tableShape",
              x: 330,
              y: 340,
              rotation: 0,
              props: {
                w: 200,
                h: 140,
                table: doubleLineTable(
                  "thick",
                  [{ mode: "auto", min: 26 }, { mode: "auto", min: 26 }, { mode: "auto", min: 26 }],
                  [{ mode: "fr", value: 1, min: 60 }, { mode: "fr", value: 1, min: 60 }],
                  [
                    { id: "thick_c11", rowId: "thick_row_1", columnId: "thick_col_1", text: "太" },
                    { id: "thick_c12", rowId: "thick_row_1", columnId: "thick_col_2", text: "枠" },
                    { id: "thick_c21", rowId: "thick_row_2", columnId: "thick_col_1", text: "の" },
                    { id: "thick_c22", rowId: "thick_row_2", columnId: "thick_col_2", text: "表" },
                    { id: "thick_c31", rowId: "thick_row_3", columnId: "thick_col_1", text: "下" },
                    { id: "thick_c32", rowId: "thick_row_3", columnId: "thick_col_2", text: "段" },
                  ],
                  4,
                ),
              },
            },
          ],
        },
      },
    },
  } as unknown as SigmaDocument;
}

interface TableLineGeometry {
  /** Centre line of every `double` boundary the surface drew, relative to the table's top edge. */
  doubleLines: number[];
  /** Every horizontal cell edge, from the rendered rows, relative to the same origin. */
  rowEdges: number[];
  /** Centre of every row boundary grip. Empty on a surface that has no chrome. */
  handles: number[];
  tableHeight: number;
}

/**
 * Reads the drawn boundaries out of whichever renderer is currently mounted.
 *
 * The `double` lines are found by their computed `border-top-style` rather than by a class name: the
 * static view is deliberately class-free (its markup also ships as a standalone SVG), so a
 * class-based query would only ever see the editing surface and quietly compare it with itself.
 *
 * Everything is measured against the `<table>`'s own top edge and divided by the canvas zoom, so the
 * numbers are the model's px on every surface.
 */
async function tableLineGeometry(page: Page, selector: string): Promise<TableLineGeometry> {
  return page.evaluate((shapeQuery) => {
    const shape = document.querySelector<HTMLElement>(shapeQuery);
    const table = shape?.querySelector<HTMLTableElement>("table");
    if (!shape || !table) {
      throw new Error(`no table inside ${shapeQuery}`);
    }
    const canvas = shape.closest<HTMLElement>(".page-canvas");
    const zoomRaw = canvas ? Number(getComputedStyle(canvas).getPropertyValue("--editor-zoom")) : 1;
    const zoom = Number.isFinite(zoomRaw) && zoomRaw > 0 ? zoomRaw : 1;
    const origin = table.getBoundingClientRect().top;
    const round = (value: number) => Math.round((value / zoom) * 1000) / 1000;

    const doubleLines = Array.from(shape.querySelectorAll<HTMLElement>("div"))
      .filter((element) => {
        const style = getComputedStyle(element);
        return style.borderTopStyle === "double"
          && Number.parseFloat(style.borderTopWidth) > 0;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return round(rect.top + rect.height / 2 - origin);
      })
      .sort((a, b) => a - b);

    const rowEdges = [
      round(table.rows[0].getBoundingClientRect().top - origin),
      ...Array.from(table.rows).map((row) => round(row.getBoundingClientRect().bottom - origin)),
    ];

    // `translateY(-50%)` on a 10px hit area, so the rect's centre is the offset it was given.
    const handles = Array.from(
      shape.querySelectorAll<HTMLElement>('[data-testid="overlay-table-row-boundary"]'),
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      return round(rect.top + rect.height / 2 - origin);
    }).sort((a, b) => a - b);

    return {
      doubleLines,
      rowEdges,
      handles,
      tableHeight: round(table.getBoundingClientRect().height),
    };
  }, selector);
}

/** Reads the geometry until several consecutive readings agree. */
async function settledTableLineGeometry(page: Page, selector: string): Promise<TableLineGeometry> {
  let previous = await tableLineGeometry(page, selector);
  let quiet = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await page.waitForTimeout(120);
    const current = await tableLineGeometry(page, selector);
    quiet = geometryDelta(previous, current) === 0 ? quiet + 1 : 0;
    previous = current;
    if (quiet >= 4) {
      return current;
    }
  }
  throw new Error(`${selector} の罫線位置が収束しませんでした`);
}

function geometryDelta(a: TableLineGeometry, b: TableLineGeometry): number {
  const shape = (value: TableLineGeometry) => [
    value.doubleLines.length,
    value.rowEdges.length,
    value.handles.length,
  ].join("/");
  if (shape(a) !== shape(b)) {
    return Number.POSITIVE_INFINITY;
  }
  const pairs: Array<[number, number]> = [
    ...a.doubleLines.map((value, index) => [value, b.doubleLines[index]] as [number, number]),
    ...a.rowEdges.map((value, index) => [value, b.rowEdges[index]] as [number, number]),
    ...a.handles.map((value, index) => [value, b.handles[index]] as [number, number]),
    [a.tableHeight, b.tableHeight],
  ];
  return Math.max(0, ...pairs.map(([left, right]) => Math.abs(left - right)));
}

/**
 * Each drawn `double` line pairs with the cell boundary it stands in for, one for one and in order,
 * and every pair is off by the same amount.
 *
 * Deliberately not "off by zero". `border-collapse: collapse` puts the outer border astride the
 * table's edge, so the grid of cells begins half an outer border below the box the overlay is
 * positioned inside. Every boundary carries that same shift, and every surface renders the same
 * markup, so it is a constant of the collapsed-border model rather than drift — the shift is
 * asserted against the outer border width so that a change in it has to be a deliberate one.
 *
 * The property that failed before is the *uniformity*: the error used to grow down the table,
 * because the browser had stretched the rows while the overlay stayed at the unstretched offsets
 * (26px by the last boundary of the three-row fixture below). A "nearest boundary within tolerance"
 * check would not have caught that at the first boundary, and would let several lines collapse onto
 * one boundary, so the pairing is by index instead.
 */
function expectLinesOnCellEdges(
  geometry: TableLineGeometry,
  label: string,
  outerBorderWidthPx: number,
): void {
  // `rowEdges` is [top of the first row, ...bottom of each row], so the inner boundaries — the ones
  // a `double` override applies to — are everything but the two ends, in order.
  const innerEdges = geometry.rowEdges.slice(1, -1);
  expect(geometry.doubleLines.length, `${label}: 罫線の本数が内側境界の数と違う`)
    .toBe(innerEdges.length);

  const shifts = geometry.doubleLines.map((line, index) => innerEdges[index] - line);
  const spread = Math.max(...shifts) - Math.min(...shifts);
  expect(spread, `${label}: 罫線とセル境界のずれが一定でない (${JSON.stringify(shifts)})`)
    .toBeLessThanOrEqual(0.05);
  expect(shifts[0], `${label}: ずれ ${shifts[0]} が外枠 ${outerBorderWidthPx}px の半分と違う`)
    .toBeCloseTo(outerBorderWidthPx / 2, 1);
}

function expectSameGeometry(left: TableLineGeometry, right: TableLineGeometry, label: string): void {
  expect(left.doubleLines.length, `${label}: 罫線の本数`).toBe(right.doubleLines.length);
  expect(left.rowEdges.length, `${label}: 行数`).toBe(right.rowEdges.length);
  const delta = geometryDelta(
    { ...left, handles: [] },
    { ...right, handles: [] },
  );
  expect(delta, `${label}: ${delta}px ずれ\n${JSON.stringify({ left, right }, null, 2)}`)
    .toBeLessThanOrEqual(TOLERANCE_PX);
}

async function openEditor(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, parityDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  // AI タスク Dock は `.editor-canvas` の左上に sticky で貼り付く浮遊アフォーダンスで、この
  // フィクスチャの表とちょうど重なる。罫線の幾何しか見ないテストなので、押下を奪われないように
  // 当たり判定ごと外す (表の描画には一切関係しない)。
  await page.addStyleTag({ content: ".ai-task-dock-root { display: none !important; }" });
  await expect(page.locator(shapeSelector(AUTO_TABLE_ID))).toBeVisible();
}

/**
 * Swaps the read-only preview for the interactive editor.
 *
 * `.overlay-table-shape-table` is the editor-only class; plain `table` is also what the static view
 * renders, so waiting on that would let a failed activation compare the idle surface with itself.
 */
async function activateTableEditor(page: Page, selector: string): Promise<Locator> {
  const shape = page.locator(selector);
  const cell = shape.locator("td").first();
  // 本文モードでは未選択の図形が透過するので、まず明示操作で掴んでから編集に入る。
  await grabShapeFromBody(page, cell);
  await cell.click();
  await expect(page.locator(`${selector} .overlay-table-shape-table`)).toBeVisible();
  return shape;
}

test("draws a table's double boundaries on its cell edges, idle and while editing", async ({ page }) => {
  await openEditor(page);

  // Every idle reading is taken before anything is activated. The interactive layer is per page, not
  // per shape (`PageCanvasEditor`), so activating one table hands *all* of them to
  // `OverlayTableShapeEditor` — reading the second table's "idle" after that would compare the
  // editing surface with itself and pass no matter what either surface drew.
  await expect(page.locator(".overlay-table-shape-table")).toHaveCount(0);
  const idleByLabel = new Map<string, TableLineGeometry>();
  for (const { label, selector, outerBorderWidth } of CASES) {
    const idle = await settledTableLineGeometry(page, selector);
    expect(idle.doubleLines.length, `${label}: double 罫線が描かれていない`).toBeGreaterThan(0);
    expectLinesOnCellEdges(idle, `${label} / 静的描画`, outerBorderWidth);
    idleByLabel.set(label, idle);
  }

  for (const { label, selector, outerBorderWidth } of CASES) {
    await activateTableEditor(page, selector);
    const editing = await settledTableLineGeometry(page, selector);
    const idle = idleByLabel.get(label)!;
    expectLinesOnCellEdges(editing, `${label} / 編集面`, outerBorderWidth);
    expectSameGeometry(editing, idle, `${label} / 編集面 vs 静的描画`);

    // The grips the author drags are on the same boundaries as the drawn lines, plus the two outer
    // edges. They used to come from the measured DOM while the lines came from the model.
    expect(editing.handles.length, `${label}: 行境界グリップ`).toBe(idle.rowEdges.length);
    // Paired by index against the inner boundaries, for the same reason the lines are: a "nearest
    // grip" check passes when several of them land on one boundary.
    const innerHandles = editing.handles.slice(1, -1);
    editing.doubleLines.forEach((line, index) => {
      expect(Math.abs(innerHandles[index] - line), `${label}: グリップ ${innerHandles[index]} が罫線 ${line} からずれている`)
        .toBeLessThanOrEqual(TOLERANCE_PX);
    });
    await page.keyboard.press("Escape");
  }
});

test("keeps the drawn boundaries identical between the editor and the PDF", async ({ page }) => {
  await openEditor(page);
  await expect(page.locator(".overlay-table-shape-table")).toHaveCount(0);
  const idleByLabel = new Map<string, TableLineGeometry>();
  for (const { label, selector } of CASES) {
    idleByLabel.set(label, await settledTableLineGeometry(page, selector));
  }

  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".paged-surface[data-paged-surface-state='ready']")).toHaveCount(1);
  await waitForPagedSurfaceSettled(page);

  for (const { label, selector, outerBorderWidth } of CASES) {
    const paged = await settledTableLineGeometry(page, `.paged-surface-page ${selector}`);
    expectLinesOnCellEdges(paged, `${label} / PDF面`, outerBorderWidth);
    expectSameGeometry(paged, idleByLabel.get(label)!, `${label} / PDF面 vs エディタ`);
  }
});

test("keeps the boundaries where they are through a zoom change", async ({ page }) => {
  await openEditor(page);
  const atOneHundred = await settledTableLineGeometry(page, AUTO_SELECTOR);

  // 以前は select に "1.1" を流し込んでいた。選択肢に無い値なので value は "" になり、
  // 実際に適用されていたのは下限の 10% だった。同じ倍率を、いまの選択コントロールから明示的に選ぶ。
  await selectUiOptionInPage(page, "ズーム", "10");
  await activateTableEditor(page, AUTO_SELECTOR);

  // Divided by `--editor-zoom`, so a zoomed surface has to report the same model px. The editor's
  // old measurement divided the rects by a scale it derived from `offsetWidth`, which is the piece
  // of the removed code that had to keep working at every zoom level.
  expectSameGeometry(
    await settledTableLineGeometry(page, AUTO_SELECTOR),
    atOneHundred,
    "auto rows / zoom 1.1 vs 100%",
  );
});

/**
 * The fixed point, demonstrated the way `boxed-text-run-height.spec.ts` demonstrates its own: thirty
 * consecutive frames with no movement at all.
 *
 * Zero, not "within tolerance". The removed `ResizeObserver` loop re-measured the rendered rows and
 * re-drew from the measurement, which is a loop that can only be shown to have stopped by watching
 * the frames it used to move on.
 */
test("draws the boundaries from a fixed point, with no frame-to-frame movement", async ({ page }) => {
  await openEditor(page);
  await activateTableEditor(page, AUTO_SELECTOR);
  await settledTableLineGeometry(page, AUTO_SELECTOR);

  const proof = await page.evaluate(async (shapeQuery) => {
    const shape = document.querySelector<HTMLElement>(shapeQuery)!;
    const read = () => {
      const table = shape.querySelector<HTMLTableElement>("table")!;
      const origin = table.getBoundingClientRect().top;
      const lines = Array.from(shape.querySelectorAll<HTMLElement>("div"))
        .filter((element) => getComputedStyle(element).borderTopStyle === "double")
        .map((element) => element.getBoundingClientRect().top - origin);
      const handles = Array.from(
        shape.querySelectorAll<HTMLElement>('[data-testid="overlay-table-row-boundary"]'),
      ).map((element) => element.getBoundingClientRect().top - origin);
      const rows = Array.from(table.rows)
        .map((row) => row.getBoundingClientRect().bottom - origin);
      const ascending = (a: number, b: number) => a - b;
      return [...lines.sort(ascending), ...handles.sort(ascending), ...rows];
    };

    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const first = read();
    let maxFrameDelta = 0;
    for (let index = 0; index < 30; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const frame = read();
      if (frame.length !== first.length) {
        return { maxFrameDelta: Number.POSITIVE_INFINITY, sampleCount: first.length };
      }
      frame.forEach((value, position) => {
        maxFrameDelta = Math.max(maxFrameDelta, Math.abs(value - first[position]));
      });
    }
    return { maxFrameDelta, sampleCount: first.length };
  }, AUTO_SELECTOR);

  expect(proof.sampleCount).toBeGreaterThan(0);
  expect(proof.maxFrameDelta).toBe(0);
});
