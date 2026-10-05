// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import type { OverlayShape } from "@/components/editor/overlay-canvas/types";

import {
  calculateReserveSpaceGaps,
  measureFlowBlocks,
} from "./layout-measure";

describe("calculateReserveSpaceGaps", () => {
  it("keeps body flow independent from legacy reserveSpace overlay anchors", () => {
    const shape = {
      id: "legacy_callout",
      type: "callout",
      x: 20,
      y: 80,
      rotation: 0,
      anchor: { type: "block", blockId: "body_1", dx: 20, dy: 80, reserveSpace: true },
      props: {
        w: 320,
        h: 68,
        radius: 18,
        tail: {
          baseStart: { x: 48, y: 68 },
          baseEnd: { x: 88, y: 68 },
          tip: { x: 64, y: 96 },
        },
        blocks: [{ type: "paragraph", id: "layout_measure_test_32", children: [] }],
        color: "#111111",
        size: "m",
        dash: "solid",
        strokeWidth: "m",
      },
    } satisfies OverlayShape;

    expect(calculateReserveSpaceGaps([shape])).toEqual({});
  });
});

describe("measureFlowBlocks with blocks that are not drawn", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function place(element: Element, top: number, height: number): void {
    element.getBoundingClientRect = () => new DOMRect(0, top, 400, height);
    element.getClientRects = () => [new DOMRect(0, top, 400, height)] as unknown as DOMRectList;
  }

  /** display: none で畳んだ要素 (と、その中の要素): 外接矩形は 0、描画矩形は 1 つも無い。 */
  function fold(element: Element): void {
    element.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    element.getClientRects = () => [] as unknown as DOMRectList;
  }

  /** 段落 a → (畳める) リスト x と項目 → 段落 b。 */
  function flowWithFoldable() {
    const flow = document.createElement("div");
    flow.innerHTML = `
      <div data-flow-unit-id="a">
        <div class="ProseMirror">
          <p data-sigma-doc-id="a">前の段落</p>
          <ul data-sigma-doc-id="x"><li data-sigma-doc-id="x_item">畳む項目</li></ul>
          <p data-sigma-doc-id="b">後の段落</p>
        </div>
      </div>`;
    document.body.append(flow);
    const find = (id: string) => flow.querySelector(`[data-sigma-doc-id="${id}"]`)!;
    flow.getBoundingClientRect = () => new DOMRect(0, 0, 400, 1000);
    place(find("a"), 100, 20);
    place(find("x"), 120, 30);
    place(find("x_item"), 120, 30);
    place(find("b"), 150, 20);
    return { flow, find };
  }

  it("leaves out a folded body block and the blocks inside it instead of reading their zero rects", () => {
    const { flow, find } = flowWithFoldable();
    fold(find("x"));
    fold(find("x_item"));
    place(find("b"), 120, 20);

    const measurement = measureFlowBlocks(flow, 1, 96);

    expect(measurement.ordered.map((block) => block.id)).toEqual(["a", "b"]);
    expect(measurement.rects.has("x")).toBe(false);
    expect(measurement.rects.has("x_item")).toBe(false);
    expect(measurement.tops.get("b")).toBe(120);
  });

  it("drops a block folded after it was measured, also when only its unit is measured again", () => {
    const { flow, find } = flowWithFoldable();
    const previous = measureFlowBlocks(flow, 1, 96);
    expect(previous.rects.has("x")).toBe(true);
    fold(find("x"));
    fold(find("x_item"));
    place(find("b"), 120, 20);

    const incremental = measureFlowBlocks(flow, 1, 96, undefined, { scope: { kind: "dirtyUnit", unitId: "a" }, previous });

    expect(incremental.ordered.map((block) => block.id)).toEqual(["a", "b"]);
    expect(incremental.rects.has("x")).toBe(false);
    expect(incremental.tops.get("b")).toBe(120);
  });
});
