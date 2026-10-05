import { describe, expect, it } from "vitest";

import type { BlockExtent, MeasuredBlock } from "../overlay-canvas/anchor";
import type { OverlayShape } from "../overlay-canvas/types";
import { reanchorOverlayShapesAfterDeletion } from "./deletion-reanchor";

function rectangle(id: string, blockId: string, dy: number, parentId?: string): OverlayShape {
  return {
    id,
    type: "geo",
    x: 60,
    y: 100 + dy,
    rotation: 0,
    anchor: { type: "block", blockId, dy },
    ...(parentId ? { parentId } : {}),
    props: { w: 40, h: 30, geo: "rectangle", fill: "solid", color: "#111111", dash: "solid", size: "m" },
  } as unknown as OverlayShape;
}

const preMeasure = new Map<string, BlockExtent>([
  ["h", { top: 50, height: 20 }],
  ["a", { top: 100, height: 20 }],
  ["b", { top: 200, height: 20 }],
]);
const anchorable: MeasuredBlock[] = [{ id: "h", top: 50 }, { id: "b", top: 180 }];

describe("reanchorOverlayShapesAfterDeletion", () => {
  it("re-anchors every figure of the deleted block, including ones hidden for the result only, as one change", () => {
    // 消した固定先からの選び直しは変更口が導出として通す。隠した図形 (とグループ) だけ残すと、消えた
    // ブロックへの固定と削除前の y のまま残り、表示を戻すと本文からずれる (この再検出は 1 回きり)。
    const shapes = [
      rectangle("plain", "a", 50),
      rectangle("run_locked", "a", 50),
      rectangle("result_hidden", "a", 50),
      { ...rectangle("hidden_group", "a", 50), type: "group", props: { w: 40, h: 30 } } as unknown as OverlayShape,
      rectangle("hidden_member", "a", 50, "hidden_group"),
    ];

    const next = reanchorOverlayShapesAfterDeletion(shapes, new Set(["a"]), preMeasure, anchorable);

    const byId = new Map(next!.map((shape) => [shape.id, shape]));
    for (const id of ["plain", "run_locked", "result_hidden", "hidden_group", "hidden_member"]) {
      expect(byId.get(id)).toMatchObject({ y: 130, anchor: { type: "block", blockId: "h", dy: 80 } });
    }
  });

  it("changes nothing (null) when no figure hung off the deleted block", () => {
    const shapes = [rectangle("elsewhere", "b", 10)];
    expect(reanchorOverlayShapesAfterDeletion(shapes, new Set(["a"]), preMeasure, anchorable)).toBeNull();
  });
});
