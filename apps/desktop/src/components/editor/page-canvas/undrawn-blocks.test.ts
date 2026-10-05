// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { measureBlockTops, type MeasuredBlock } from "../overlay-canvas/anchor";
import { reanchorShapesAgainstCanvas } from "../overlay-canvas/snapshot-anchors";
import type { OverlayShape } from "../overlay-canvas/types";
import { probeFlow } from "./flow-probe";
import { measureFlowBlocks } from "./layout-measure";

/**
 * 描かれていないブロック (機能が display: none で紙面から畳んだもの) の扱いは `undrawn-blocks.ts` の 1 か所で
 * 決める。本文を測る 3 本 — ページ割りの `probeFlow`・page canvas の `measureFlowBlocks`・overlay の
 * `measureBlockTops` — と保存時の付け替えは、同じ DOM に同じ答えを出す。
 *
 * 紙面の原点と倍率は 3 本とも同じに置く (flow 要素 = overlay の座標面、ズーム 1)。座標系の一致そのものは
 * `anchor-measure-parity.test.ts` が見ている。
 */

function place(element: Element, top: number, height: number): void {
  element.getBoundingClientRect = () => new DOMRect(24, top, 352, height);
  element.getClientRects = () => [new DOMRect(24, top, 352, height)] as unknown as DOMRectList;
}

/** display: none で畳んだ要素 (と、その中の要素): 外接矩形は 0、描画矩形は 1 つも無い。 */
function fold(element: Element): void {
  element.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  element.getClientRects = () => [] as unknown as DOMRectList;
}

/** 段落 a → (畳める) リスト x と項目 → 段落 b。 */
function surface() {
  const flow = document.createElement("div");
  flow.className = "page-flow";
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
  flow.getClientRects = () => [new DOMRect(0, 0, 400, 1000)] as unknown as DOMRectList;
  place(find("a"), 100, 20);
  place(find("x"), 120, 30);
  place(find("x_item"), 120, 30);
  place(find("b"), 150, 20);
  const foldX = () => {
    fold(find("x"));
    fold(find("x_item"));
    place(find("b"), 120, 20);
  };
  return { flow: flow as HTMLDivElement, foldX };
}

const COORD_HEIGHT = 1000;
const COORD_WIDTH = 400;

function geometryOf(block: MeasuredBlock | undefined) {
  return block && { top: block.top, left: block.left, width: block.width, height: block.height, undrawn: block.undrawn };
}

function anchoredRectangle(id: string, blockId: string, y: number, dy: number): OverlayShape {
  return {
    id,
    type: "geo",
    x: 84,
    y,
    rotation: 0,
    anchor: { type: "block", blockId, dx: 60, dy },
    props: { w: 120, h: 60, geo: "rectangle", fill: "solid", color: "#111111", dash: "solid", size: "m" },
  } as unknown as OverlayShape;
}

beforeEach(() => {
  // 行ボックス (Range) は 3 本とも同じヘルパで測るので、ここでは比べない。
  vi.spyOn(document, "createRange").mockImplementation(() => ({
    selectNodeContents: () => undefined,
    selectNode: () => undefined,
    setStart: () => undefined,
    setEnd: () => undefined,
    getClientRects: () => [],
    getBoundingClientRect: () => new DOMRect(),
    detach: () => undefined,
  }) as unknown as Range);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("a folded block measured by every body measurement", () => {
  it("is never read as a zero rect, and both anchor measurements keep the same last drawn geometry", () => {
    const { flow, foldX } = surface();
    const pageBefore = measureFlowBlocks(flow, 1, 96);
    const overlayBefore = measureBlockTops(flow, flow, COORD_HEIGHT, COORD_WIDTH);
    foldX();

    const pageCanvas = measureFlowBlocks(flow, 1, 96, undefined, { previous: pageBefore });
    const overlay = measureBlockTops(flow, flow, COORD_HEIGHT, COORD_WIDTH, overlayBefore.rects);
    const probe = probeFlow(flow, { zoomFactor: 1, breakIds: new Set() });

    // ページ割り: 畳んだブロックは行を作らない (畳んだ間は無いものとして割る)。
    expect(probe.units.flatMap((unit) => unit.nodes.map((node) => node.id))).toEqual(["a", "b"]);
    for (const id of ["x", "x_item"]) {
      // 固定先の計測: 0 の矩形は読まず、最後に描かれていた幾何に印を付けて残す。2 本で同じ答え。
      expect(overlay.rects.get(id)).toEqual({ ...overlayBefore.rects.get(id), undrawn: true });
      expect(geometryOf(pageCanvas.rects.get(id))).toEqual(geometryOf(overlay.rects.get(id)));
    }
    expect(overlay.tops.get("x")).toBe(120);
    expect(geometryOf(pageCanvas.rects.get("b"))).toEqual(geometryOf(overlay.rects.get("b")));
    expect(overlay.ordered.map((block) => block.id).sort()).toEqual(pageCanvas.anchorable.map((block) => block.id).sort());
  });

  it("is left out of both anchor measurements when it was never drawn, and the overlay still names it", () => {
    const { flow, foldX } = surface();
    foldX();

    const pageCanvas = measureFlowBlocks(flow, 1, 96);
    const overlay = measureBlockTops(flow, flow, COORD_HEIGHT, COORD_WIDTH);

    for (const id of ["x", "x_item"]) {
      expect(pageCanvas.rects.has(id)).toBe(false);
      expect(overlay.rects.has(id)).toBe(false);
    }
    // 計測から外しても「在るが描かれていない」は分かる: 保存時の付け替えが固定先を選び直さないため。
    expect([...overlay.undrawnIds]).toEqual(["x", "x_item"]);
    expect(overlay.ordered.map((block) => block.id)).toEqual(["a", "b"]);
  });
});

describe("saving the overlay while a block is folded", () => {
  it("keeps the stored anchor of a figure on the folded block, with or without its last drawn geometry", () => {
    const { flow, foldX } = surface();
    const lastDrawn = measureBlockTops(flow, flow, COORD_HEIGHT, COORD_WIDTH).rects;
    const onFolded = anchoredRectangle("on_folded", "x", 130, 10);
    const onDrawn = anchoredRectangle("on_drawn", "a", 110, 10);
    foldX();

    for (const known of [lastDrawn, undefined]) {
      const saved = reanchorShapesAgainstCanvas([onFolded, onDrawn], flow, COORD_HEIGHT, COORD_WIDTH, flow, known);
      // 無関係な図形を動かして保存しても、畳んだブロックに固定された図形の保存内容は変わらない。
      expect(saved.find((shape) => shape.id === "on_folded")).toEqual(onFolded);
      expect(saved.find((shape) => shape.id === "on_drawn")?.anchor).toMatchObject(onDrawn.anchor!);
    }
  });
});
