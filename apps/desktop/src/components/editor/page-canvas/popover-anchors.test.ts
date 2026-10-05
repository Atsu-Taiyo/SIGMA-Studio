// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import type { OverlayShape } from "@/components/editor/overlay-canvas/types";
import type { OverlaySelectionSummary } from "@/components/editor/page-overlay-types";

import {
  getOverlaySelectionActionPopoverPosition,
  getOverlaySelectionControlsCanvasRect,
} from "./popover-anchors";

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
  it.each([50, 100, 200])("covers the popover and the rotate handle above the shapes at zoom %i%%", (zoom) => {
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
  });
});
