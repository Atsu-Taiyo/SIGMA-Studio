// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import type { OverlayShape } from "@/components/editor/overlay-canvas/types";
import type { OverlaySelectionSummary } from "@/components/editor/page-overlay-types";

import {
  getCommentOffsetText,
  getOverlaySelectionActionPopoverPosition,
  getOverlaySelectionControlsCanvasRect,
  getOverlaySelectionPointer,
  getSelectionFollowUpAnchor,
  getSelectionTrailingAnchor,
  placeSelectionTrailingActions,
  type SelectionTrailingAnchor,
} from "./popover-anchors";

it("reads math-only selections from TeX even when the formula has no native selected text", () => {
  const paragraph = document.createElement("p");
  paragraph.innerHTML = '<span class="inline-math-node" data-tex="x^2" contenteditable="false"></span>';
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  expect(range.toString()).toBe("");
  expect(getCommentOffsetText(range)).toBe("$x^2$");
});

const rectangle = {
  id: "shape-1",
  type: "geo",
  x: 300,
  y: 400,
  props: { w: 100, h: 50, geo: "rectangle" },
} as unknown as OverlayShape;

function selectionOf(partial: Partial<OverlaySelectionSummary>): OverlaySelectionSummary {
  return { selectedCount: 0, selectedShapeIds: [], selectedShapes: [], ...partial } as OverlaySelectionSummary;
}

const shapeSelection = selectionOf({ selectedCount: 1, selectedShapeIds: ["shape-1"], selectedShapes: [rectangle] });

/** 左上が画面の (left, top) にある紙面の要素。 */
function canvasAt(left: number, top: number): HTMLElement {
  const canvas = document.createElement("div");
  canvas.getBoundingClientRect = () => new DOMRect(left, top, 2000, 4000);
  return canvas;
}

describe("getOverlaySelectionControlsCanvasRect", () => {
  it.each([50, 100, 200])("without a pointer (keyboard selection), covers the popover and the rotate handle above the shapes at zoom %i%%", (zoom) => {
    const rect = getOverlaySelectionControlsCanvasRect(shapeSelection, zoom);
    const scale = zoom / 100;

    // ポップオーバー (高さ 38) と回転ハンドルの間隔 (42) は画面の px なので、紙面ではズームで割る。
    expect(rect).not.toBeNull();
    expect(rect!.y + rect!.h).toBe(400);
    expect(rect!.h).toBeCloseTo((38 + 42) / scale);
    expect(rect!.x + rect!.w / 2).toBe(350);
    expect(rect!.w).toBeCloseTo(210 / scale);
  });

  it("stays a band above a multi-shape selection and leaves the selected area itself free", () => {
    const lower = { ...rectangle, id: "shape-2", y: 850 } as OverlayShape;
    const rect = getOverlaySelectionControlsCanvasRect(
      selectionOf({ selectedCount: 2, selectedShapeIds: ["shape-1", "shape-2"], selectedShapes: [rectangle, lower] }),
      100,
    );

    // 選んだ範囲 (y 400〜900) の中は障害物にしない (グループ・全選択でもバーを押し出さない)。
    expect(rect).toMatchObject({ y: 400 - 80, h: 80 });
  });

  it("spans the popover's measured width once it is drawn (its content decides the width)", () => {
    const rect = getOverlaySelectionControlsCanvasRect(shapeSelection, 200, 478);

    expect(rect!.w).toBeCloseTo(478 / 2);
    expect(rect!.x + rect!.w / 2).toBe(350);
  });

  it("starts where the popover itself is placed on the screen", () => {
    const zoom = 150;
    const canvas = canvasAt(100, 50);
    const rect = getOverlaySelectionControlsCanvasRect(shapeSelection, zoom)!;
    const position = getOverlaySelectionActionPopoverPosition(canvas, shapeSelection, zoom)!;

    expect(50 + rect.y * zoom / 100).toBeCloseTo(position.top);
    expect(100 + (rect.x + rect.w / 2) * zoom / 100).toBeCloseTo(position.centerX!);
  });

  it("leaves only the popover's gap above a region selection, which has no rotate handle", () => {
    const rect = getOverlaySelectionControlsCanvasRect(
      selectionOf({ region: { x: 10, y: 300, w: 80, h: 40 } }),
      100,
    );

    expect(rect).toMatchObject({ y: 300 - 38 - 8, h: 38 + 8 });
  });

  it("is absent without a selection", () => {
    expect(getOverlaySelectionControlsCanvasRect(selectionOf({}), 100)).toBeNull();
    expect(getOverlaySelectionControlsCanvasRect(selectionOf({}), 100, 210, { x: 10, y: 10 })).toBeNull();
  });

  it.each([50, 100, 200])("follows the card at the bottom-right of the pointer at zoom %i%%", (zoom) => {
    const scale = zoom / 100;
    const rect = getOverlaySelectionControlsCanvasRect(shapeSelection, zoom, 300, { x: 330, y: 420 });

    // 図形の上の帯ではなく、マウスの右下 (+12, +16 画面 px) から始まるカード。
    expect(rect!.x).toBeCloseTo(330 + 12 / scale);
    expect(rect!.y).toBeCloseTo(420 + 16 / scale);
    expect(rect!.w).toBeCloseTo(300 / scale);
    expect(rect!.h).toBeCloseTo(38 / scale);
  });
});

describe("getOverlaySelectionActionPopoverPosition with a pointer", () => {
  it("puts the card at the bottom-right of the pointer instead of above the shape", () => {
    const zoom = 200;
    const canvas = canvasAt(100, 50);
    // 図形の中 (紙面の 330, 420) を押した。図形の上端は紙面の 400。
    const position = getOverlaySelectionActionPopoverPosition(canvas, shapeSelection, zoom, undefined, { x: 330, y: 420 })!;

    expect(position.pointer).toEqual({ x: 100 + 330 * 2, y: 50 + 420 * 2 });
    expect(position).toMatchObject({ left: 100 + 330 * 2 + 12, top: 50 + 420 * 2 + 16 });
    expect(position.anchor).toBeUndefined();
  });

  it("keeps the pointer on the same point of the page when the whiteboard pans", () => {
    const canvas = canvasAt(0, 0);
    const pointer = getOverlaySelectionPointer(canvas, { x: 500, y: 300 }, 100, { x: 40, y: 20 });
    expect(pointer).toEqual({ x: 460, y: 280 });

    const panned = getOverlaySelectionActionPopoverPosition(canvas, shapeSelection, 100, { x: 140, y: -30 }, pointer)!;
    expect(panned.pointer).toEqual({ x: 600, y: 250 });
  });

  it("round-trips a screen point through zoom", () => {
    const canvas = canvasAt(100, 50);
    const pointer = getOverlaySelectionPointer(canvas, { x: 700, y: 650 }, 150);
    const position = getOverlaySelectionActionPopoverPosition(canvas, shapeSelection, 150, undefined, pointer)!;

    expect(position.pointer!.x).toBeCloseTo(700);
    expect(position.pointer!.y).toBeCloseTo(650);
  });
});

describe("placeSelectionTrailingActions", () => {
  const anchor: SelectionTrailingAnchor = { right: 400, bottom: 300, top: 260, limitRight: 1080, limitBottom: 1100 };
  const chip = { width: 200, height: 40 };

  it("puts the chip's top-left corner at the bottom-right corner of the selection", () => {
    expect(placeSelectionTrailingActions(anchor, chip)).toEqual({ left: 400, top: 306, placement: "below" });
  });

  it("aligns the chip to the page's right edge instead of running off the page", () => {
    expect(placeSelectionTrailingActions({ ...anchor, right: 1000 }, chip)).toMatchObject({ left: 880, placement: "below" });
  });

  it("moves above the selection only when the chip does not fit below", () => {
    expect(placeSelectionTrailingActions({ ...anchor, limitBottom: 340 }, chip)).toEqual({ left: 400, top: 214, placement: "above" });
    expect(placeSelectionTrailingActions({ ...anchor, limitBottom: 346 }, chip).placement).toBe("below");
  });
});

describe("getSelectionFollowUpAnchor", () => {
  const anchor: SelectionTrailingAnchor = { right: 400, bottom: 300, top: 260, limitRight: 1080, limitBottom: 1100 };

  it("opens the AI and comment inputs just below the selection, not below the band above it", () => {
    // 入力欄は錨の 46px 下 (帯の高さ 38 + 間隔 8) に開くので、錨の下端 = 選択の下端 + 間隔 6。
    expect(getSelectionFollowUpAnchor(anchor)).toEqual({ left: 400, top: 268 });
    expect(getSelectionFollowUpAnchor({ ...anchor, right: 1000 }).left).toBe(870);
  });
});

describe("getSelectionTrailingAnchor", () => {
  function sheetCanvas(): HTMLElement {
    const canvas = document.createElement("div");
    const backdrop = document.createElement("div");
    backdrop.className = "page-backdrop";
    const sheet = document.createElement("div");
    sheet.className = "a4-page-sheet";
    sheet.getBoundingClientRect = () => new DOMRect(300, 100, 800, 1100);
    backdrop.append(sheet);
    canvas.append(backdrop);
    document.body.append(canvas);
    return canvas;
  }

  it("takes the right end of the last line, not of the whole multi-line selection", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
    const canvas = sheetCanvas();
    const anchor = getSelectionTrailingAnchor([
      new DOMRect(500, 200, 520, 22),
      new DOMRect(360, 230, 660, 22),
      new DOMRect(360, 260, 140, 22),
    ], canvas);

    expect(anchor).toMatchObject({ right: 500, bottom: 282, top: 200 });
    // 用紙の右端 (1100) から少し内側までに収める。
    expect(anchor!.limitRight).toBe(1092);
    canvas.remove();
  });

  it("treats taller pieces on the same line (inline math) as that line", () => {
    const canvas = sheetCanvas();
    const anchor = getSelectionTrailingAnchor([
      new DOMRect(360, 260, 100, 22),
      new DOMRect(460, 252, 80, 36),
    ], canvas);

    expect(anchor).toMatchObject({ right: 540, bottom: 288 });
    canvas.remove();
  });

  it("follows where the selection ends when it runs from the bottom of one column into the next", () => {
    const canvas = sheetCanvas();
    // 1 段目 (360〜690) の下 2 行から、2 段目 (720〜1050) の上 2 行まで。
    const lines = [
      new DOMRect(500, 1000, 190, 22),
      new DOMRect(360, 1030, 330, 22),
      new DOMRect(720, 200, 330, 22),
      new DOMRect(720, 230, 120, 22),
    ];
    const anchor = getSelectionTrailingAnchor(lines, canvas, new DOMRect(840, 230, 0, 22));

    expect(anchor).toMatchObject({ right: 840, bottom: 252 });
    canvas.remove();
  });

  it("keeps a line in the other column at the same height out of the last line", () => {
    const canvas = sheetCanvas();
    const anchor = getSelectionTrailingAnchor([
      new DOMRect(360, 230, 330, 40),
      new DOMRect(720, 230, 60, 22),
      new DOMRect(780, 226, 50, 30),
    ], canvas, new DOMRect(830, 230, 0, 22));

    // 2 段目の行 (文字と、続く背の高い数式) だけを使い、同じ高さの 1 段目の行 (下端 270) は数えない。
    expect(anchor).toMatchObject({ right: 830, bottom: 256 });
    canvas.remove();
  });

  it("ends at the selection end even when a fully selected paragraph box spans the column", () => {
    const canvas = sheetCanvas();
    const anchor = getSelectionTrailingAnchor([
      new DOMRect(360, 200, 660, 52),
      new DOMRect(360, 230, 200, 22),
    ], canvas, new DOMRect(560, 230, 0, 22));

    expect(anchor).toMatchObject({ right: 560, bottom: 252 });
    canvas.remove();
  });

  it("falls back to the lowest line when the end position is off the selected pieces", () => {
    const canvas = sheetCanvas();
    // 折り返しの位置で終わると、終わりのカーソルは次の行の先頭に測られる。
    const anchor = getSelectionTrailingAnchor([
      new DOMRect(360, 200, 660, 22),
      new DOMRect(360, 230, 660, 22),
    ], canvas, new DOMRect(360, 260, 0, 22));

    expect(anchor).toMatchObject({ right: 1020, bottom: 252 });
    canvas.remove();
  });
});
