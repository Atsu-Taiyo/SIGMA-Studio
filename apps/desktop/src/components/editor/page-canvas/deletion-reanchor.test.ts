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
  it("re-anchors every figure of the deleted block except the ones a feature preserves (and their group's members)", () => {
    const shapes = [
      rectangle("plain", "a", 50),
      // AI の実行中・合成できない提案でロックされた図形・バーで隠した図形は、従来どおり付け替える。
      rectangle("run_locked", "a", 50),
      rectangle("bar_hidden", "a", 50),
      // 適用後だけで隠した図形 (とそのグループの中の図形) は保存のまま残す。
      rectangle("result_hidden", "a", 50),
      { ...rectangle("hidden_group", "a", 50), type: "group", props: { w: 40, h: 30 } } as unknown as OverlayShape,
      rectangle("hidden_member", "a", 50, "hidden_group"),
    ];

    const next = reanchorOverlayShapesAfterDeletion(shapes, new Set(["a"]), preMeasure, anchorable, new Set(["result_hidden", "hidden_group"]));

    const byId = new Map(next!.map((shape) => [shape.id, shape]));
    for (const id of ["plain", "run_locked", "bar_hidden"]) {
      expect(byId.get(id)).toMatchObject({ y: 130, anchor: { type: "block", blockId: "h", dy: 80 } });
    }
    for (const id of ["result_hidden", "hidden_group", "hidden_member"]) {
      expect(byId.get(id)).toBe(shapes.find((shape) => shape.id === id));
    }
  });

  it("changes nothing (null) when only preserved figures hung off the deleted block", () => {
    const shapes = [rectangle("result_hidden", "a", 50), rectangle("elsewhere", "b", 10)];
    expect(reanchorOverlayShapesAfterDeletion(shapes, new Set(["a"]), preMeasure, anchorable, new Set(["result_hidden"]))).toBeNull();
  });
});
