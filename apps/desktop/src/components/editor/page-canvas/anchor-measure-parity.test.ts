import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { measureBlockTops } from "../overlay-canvas/anchor";
import { measureFlowBlocks } from "./layout-measure";

/**
 * 本文の計測は 2 本ある。
 *
 * - `measureFlowBlocks` (page canvas): `flow` 要素を原点に、`zoomFactor` で割る。
 * - `measureBlockTops` (overlay): オーバーレイのキャンバス要素を原点に、
 *   `coordHeight / rect.height` で割る。
 *
 * この 2 つが同じ答えを出すのは **原点と倍率が一致する時だけ**。実際の紙面では
 * `.page-flow` (`position:absolute; top:0; left:0`) と `.overlay-canvas-editor`
 * (bleed 面の負の inset をちょうど打ち消す `top/left`) が同じ配置先の左上に載るので一致する。
 *
 * ここはその前提を固定するためのテスト。崩れると図形が本文から静かにずれるので、
 * 「一致する条件」と「ずれた時に何が起きるか」の両方を書いてある。
 */
const windowRef = new Window();

const ZOOM = 1.25;
const PAGE_WIDTH = 600;
const TOTAL_HEIGHT = 2000;
const MARGIN_TOP = 96;
const ORIGIN_TOP = 137;
const ORIGIN_LEFT = 42;

beforeEach(() => {
  (globalThis as { document?: unknown }).document = windowRef.document;
  (globalThis as { window?: unknown }).window = windowRef;
  (globalThis as { Node?: unknown }).Node = windowRef.Node;
  (globalThis as { CSS?: unknown }).CSS = { escape: (value: string) => value };
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { CSS?: unknown }).CSS;
});

function stubRect(element: HTMLElement, rect: { top: number; left: number; width: number; height: number }): void {
  (element as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => ({
    top: rect.top,
    left: rect.left,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  }) as DOMRect;
  // 行ボックスは両方とも `measureElementLineBoxes` (= `Range.getClientRects`) で測る同じ
  // ヘルパなので、ここでは比較対象にしない。この stub 自体は効いていない点に注意。
  (element as unknown as { getClientRects: () => unknown }).getClientRects = () => [];
}

/** 本文 1 ページぶんの DOM。`canvasTop` をずらすと原点不一致を再現できる。 */
function createSurface(canvasTop: number = ORIGIN_TOP) {
  const doc = windowRef.document;
  const root = doc.createElement("div") as unknown as HTMLElement;

  const canvas = doc.createElement("div") as unknown as HTMLElement;
  canvas.className = "overlay-canvas-editor";
  stubRect(canvas, {
    top: canvasTop,
    left: ORIGIN_LEFT,
    width: PAGE_WIDTH * ZOOM,
    height: TOTAL_HEIGHT * ZOOM,
  });

  const flow = doc.createElement("div") as unknown as HTMLElement;
  flow.className = "page-flow";
  stubRect(flow, {
    top: ORIGIN_TOP,
    left: ORIGIN_LEFT,
    width: PAGE_WIDTH * ZOOM,
    height: TOTAL_HEIGHT * ZOOM,
  });

  const unit = doc.createElement("div") as unknown as HTMLElement;
  unit.setAttribute("data-flow-unit-id", "unit-1");
  stubRect(unit, { top: ORIGIN_TOP, left: ORIGIN_LEFT, width: PAGE_WIDTH * ZOOM, height: 400 * ZOOM });

  const prose = doc.createElement("div") as unknown as HTMLElement;
  prose.className = "ProseMirror";
  stubRect(prose, { top: ORIGIN_TOP, left: ORIGIN_LEFT, width: PAGE_WIDTH * ZOOM, height: 400 * ZOOM });

  for (let index = 0; index < 5; index += 1) {
    const block = doc.createElement("p") as unknown as HTMLElement;
    block.setAttribute("data-sigma-doc-id", `block-${index}`);
    stubRect(block, {
      // 実寸 (ズーム済み) の座標を置く。両方の計算が同じ unzoomed 値に戻すはず。
      top: ORIGIN_TOP + (MARGIN_TOP + index * 30) * ZOOM,
      left: ORIGIN_LEFT + 24 * ZOOM,
      width: 480 * ZOOM,
      height: 24 * ZOOM,
    });
    if (index === 0) {
      // `.ProseMirror` の直下ではない = ページ送りの単位ではないが、アンカーは乗れる。
      // (リスト項目や枠の中のブロックがこの形。)
      const nested = doc.createElement("span") as unknown as HTMLElement;
      nested.setAttribute("data-sigma-doc-id", "block-0-nested");
      stubRect(nested, {
        top: ORIGIN_TOP + (MARGIN_TOP + 4) * ZOOM,
        left: ORIGIN_LEFT + 36 * ZOOM,
        width: 200 * ZOOM,
        height: 16 * ZOOM,
      });
      block.appendChild(nested as never);
    }
    prose.appendChild(block as never);
  }

  unit.appendChild(prose as never);
  flow.appendChild(unit as never);
  root.appendChild(canvas as never);
  root.appendChild(flow as never);
  return { canvas, flow };
}

describe("本文計測の座標系", () => {
  it("原点と倍率が揃っていれば overlay と page canvas の計測は一致する", () => {
    const { canvas, flow } = createSurface();

    const overlay = measureBlockTops(canvas, flow, TOTAL_HEIGHT, PAGE_WIDTH);
    const pageCanvas = measureFlowBlocks(flow, ZOOM, MARGIN_TOP);

    expect(overlay.rects.size).toBe(6);
    expect(pageCanvas.rects.size).toBe(overlay.rects.size);

    for (const [id, overlayBlock] of overlay.rects) {
      const canvasBlock = pageCanvas.rects.get(id);
      expect(canvasBlock, `${id} は両方で測れている`).toBeDefined();
      expect(canvasBlock!.top).toBeCloseTo(overlayBlock.top, 6);
      expect(canvasBlock!.left).toBeCloseTo(overlayBlock.left ?? 0, 6);
      expect(canvasBlock!.width).toBeCloseTo(overlayBlock.width ?? 0, 6);
      expect(canvasBlock!.height).toBeCloseTo(overlayBlock.height ?? 0, 6);
    }
  });

  it("overlay が使う並びは `ordered` ではなく `anchorable`", () => {
    const { canvas, flow } = createSurface();

    const overlay = measureBlockTops(canvas, flow, TOTAL_HEIGHT, PAGE_WIDTH);
    const pageCanvas = measureFlowBlocks(flow, ZOOM, MARGIN_TOP);

    const overlayIds = overlay.ordered.map((block) => block.id);
    // `anchorable` は入れ子を含む = overlay が自前で測っていた集合と一致する。
    expect(overlayIds).toEqual(pageCanvas.anchorable.map((block) => block.id));
    // `ordered` はページ送りの単位だけなので入れ子が落ちる。ここを取り違えると、
    // リスト項目や枠の中のブロックに付いた図形が無言で追従しなくなる。
    expect(pageCanvas.ordered.map((block) => block.id)).not.toContain("block-0-nested");
    expect(overlayIds).not.toEqual(pageCanvas.ordered.map((block) => block.id));
  });

  it("marginTop は打ち消し合う (top は flow 要素からの距離)", () => {
    const { flow } = createSurface();
    const withMargin = measureFlowBlocks(flow, ZOOM, MARGIN_TOP);
    const withoutMargin = measureFlowBlocks(flow, ZOOM, 0);
    for (const [id, block] of withMargin.rects) {
      expect(withoutMargin.rects.get(id)!.top).toBeCloseTo(block.top, 6);
    }
  });

  it("原点がずれると overlay 側だけその差分ぶん動く", () => {
    const shift = 50;
    const { canvas, flow } = createSurface(ORIGIN_TOP - shift);

    const overlay = measureBlockTops(canvas, flow, TOTAL_HEIGHT, PAGE_WIDTH);
    const pageCanvas = measureFlowBlocks(flow, ZOOM, MARGIN_TOP);

    for (const [id, overlayBlock] of overlay.rects) {
      // 差は「ズーム前に直した原点の差」ちょうど。ここが 0 でない構成では計測を
      // 一本化できない (図形が本文に対してこの分ずれる)。
      expect(overlayBlock.top - pageCanvas.rects.get(id)!.top).toBeCloseTo(shift / ZOOM, 6);
    }
  });
});
