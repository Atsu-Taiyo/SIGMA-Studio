// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import type { OverlayShape } from "@/components/editor/overlay-canvas/types";

import { reanchorAfterDeletion } from "@/components/editor/overlay-canvas/anchor";
import { anchorMeasurementKey } from "@/components/editor/overlay-canvas/snapshot-anchors";

import { isSameBlockGeometry } from "./incremental-layout";
import { sameMeasuredBlockMap } from "./layout-equality";
import {
  calculateReserveSpaceGaps,
  measureFlowBlocks,
  type LineMeasureCache,
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

  it("keeps a block folded after it was measured at its last measured place (whole and incremental passes)", () => {
    // 畳むのは表示だけ。付け替えの候補・前回の計測・固定した図形の位置が切り替えで変わらないよう、
    // 最後に描かれていた矩形のまま残す (0 の矩形は読まない)。
    const { flow, find } = flowWithFoldable();
    const previous = measureFlowBlocks(flow, 1, 96);
    fold(find("x"));
    fold(find("x_item"));
    place(find("b"), 120, 20);

    const incremental = measureFlowBlocks(flow, 1, 96, undefined, { scope: { kind: "dirtyUnit", unitId: "a" }, previous });
    const whole = measureFlowBlocks(flow, 1, 96, undefined, { previous });

    for (const measurement of [incremental, whole]) {
      // 描かれていない印を付けて残す (付け替えでは候補、点から選ぶ新しい固定先には出さない)。
      expect(measurement.rects.get("x")).toEqual({ ...previous.rects.get("x"), undrawn: true });
      expect(measurement.rects.get("x_item")).toEqual({ ...previous.rects.get("x_item"), undrawn: true });
      expect(measurement.anchorable.map((block) => block.id)).toContain("x");
      expect(measurement.tops.get("b")).toBe(120);
    }
  });

  it("keeps the last rect from the line cache when no previous measurement is passed (the deletion re-anchor pass)", () => {
    const { flow, find } = flowWithFoldable();
    const cache: LineMeasureCache = new Map();
    const before = measureFlowBlocks(flow, 1, 96, cache);
    fold(find("x"));
    fold(find("x_item"));

    const folded = measureFlowBlocks(flow, 1, 96, cache);

    expect(folded.rects.get("x")?.top).toBe(before.rects.get("x")?.top);
    expect(folded.anchorable.map((block) => block.id)).toContain("x");
  });

  it("keeps a folded block after a zoom change (the kept geometry does not depend on the zoom)", () => {
    const { flow, find } = flowWithFoldable();
    const cache: LineMeasureCache = new Map();
    const before = measureFlowBlocks(flow, 1, 96, cache);
    fold(find("x"));
    fold(find("x_item"));
    // ズームを変えると前回の計測は持ち越されない (呼び出し側が previous を捨てる)。
    flow.getBoundingClientRect = () => new DOMRect(0, 0, 800, 2000);

    const zoomed = measureFlowBlocks(flow, 2, 96, cache);

    expect(zoomed.rects.get("x")).toMatchObject({ top: before.rects.get("x")?.top, height: before.rects.get("x")?.height, undrawn: true });
  });

  it("re-anchors a figure of a deleted block to the same block whether or not its neighbour is folded", () => {
    const { flow, find } = flowWithFoldable();
    const cache: LineMeasureCache = new Map();
    const preDeletion = measureFlowBlocks(flow, 1, 96, cache);
    // a を消した後: 描かれているブロックの位置は同じにして、候補の違いだけを見る。
    find("a").remove();
    const shapes = [{ id: "s", x: 10, y: 0, anchor: { type: "block" as const, blockId: "a", dx: 10, dy: 40 } }];
    const reanchor = () => reanchorAfterDeletion(
      shapes,
      new Set(["a"]),
      preDeletion.extents,
      measureFlowBlocks(flow, 1, 96, cache).anchorable,
    ).shapes[0]?.anchor;

    const shown = reanchor();
    fold(find("x"));
    fold(find("x_item"));
    const folded = reanchor();

    expect(shown?.type === "block" ? ["x", "x_item"] : []).toContain(shown?.type === "block" ? shown.blockId : null);
    expect(folded).toEqual(shown);
  });

  it("lets the first element with an id win even when it is not drawn (a later fragment copy is not taken as its place)", () => {
    const { flow, find } = flowWithFoldable();
    const copy = document.createElement("div");
    copy.className = "fragment-copy";
    copy.innerHTML = '<ul data-sigma-doc-id="x"><li data-sigma-doc-id="x_item">複製</li></ul>';
    flow.firstElementChild!.append(copy);
    place(copy.querySelector('[data-sigma-doc-id="x"]')!, 700, 30);
    place(copy.querySelector('[data-sigma-doc-id="x_item"]')!, 700, 30);
    const previous = measureFlowBlocks(flow, 1, 96);
    expect(previous.rects.get("x")?.top).toBe(120);
    fold(find("x"));
    fold(find("x_item"));

    expect(measureFlowBlocks(flow, 1, 96).rects.has("x")).toBe(false);
    expect(measureFlowBlocks(flow, 1, 96, undefined, { previous }).rects.get("x")?.top).toBe(120);
  });

  it("tells a fold and an unfold apart even when nothing moves (block map identity, geometry check and overlay key)", () => {
    // 畳んだブロックが最後にあれば、畳んでも戻しても他のブロックは 1px も動かない。それでも印が変われば
    // 下流 (紙面の blockRects / blockAnchorable・overlay の固定先の計測) は新しい計測を受け取る。
    const { flow, find } = flowWithFoldable();
    find("b").remove();
    const cache: LineMeasureCache = new Map();
    const drawn = measureFlowBlocks(flow, 1, 96, cache);
    fold(find("x"));
    fold(find("x_item"));

    for (const scope of [undefined, { kind: "dirtyUnit" as const, unitId: "a" }]) {
      const folded = measureFlowBlocks(flow, 1, 96, cache, { previous: drawn, ...(scope ? { scope } : {}) });
      expect(folded.rects.get("x")?.undrawn).toBe(true);
      expect(folded.anchorable.find((block) => block.id === "x")?.undrawn).toBe(true);
      expect(isSameBlockGeometry(folded.rects.get("x")!, drawn.rects.get("x"))).toBe(false);
      expect(sameMeasuredBlockMap(drawn.rects, folded.rects)).toBe(false);
      expect(anchorMeasurementKey(folded.anchorable)).not.toBe(anchorMeasurementKey(drawn.anchorable));

      place(find("x"), 120, 30);
      place(find("x_item"), 120, 30);
      const unfolded = measureFlowBlocks(flow, 1, 96, cache, { previous: folded, ...(scope ? { scope } : {}) });
      expect(unfolded.rects.get("x")?.undrawn).toBeUndefined();
      expect(unfolded.anchorable.find((block) => block.id === "x")?.undrawn).toBeUndefined();
      expect(sameMeasuredBlockMap(folded.rects, unfolded.rects)).toBe(false);
      expect(anchorMeasurementKey(unfolded.anchorable)).toBe(anchorMeasurementKey(drawn.anchorable));
      fold(find("x"));
      fold(find("x_item"));
    }
  });
});
