// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFlowProbeCache, probeFlow } from "./flow-probe";

/**
 * 実描画の座標は happy-dom に無いので、要素と文字の矩形を表で与える (表示位置 = 自然位置 + 変位)。
 */
interface Box { top: number; bottom: number; left?: number; width?: number }

const textRects = new Map<Node, Box[]>();

function toDomRect({ top, bottom, left = 0, width = 400 }: Box): DOMRect {
  return new DOMRect(left, top, width, bottom - top);
}

function place(element: Element, box: Box): void {
  element.getBoundingClientRect = () => toDomRect(box);
  element.getClientRects = () => [toDomRect(box)] as unknown as DOMRectList;
}

function placeText(element: Element, ...boxes: Box[]): void {
  const node = Array.from(element.childNodes).find((child) => child.nodeType === Node.TEXT_NODE);
  if (!node) throw new Error("text node missing");
  textRects.set(node, boxes);
}

function html(markup: string): HTMLElement {
  const flow = document.createElement("div");
  flow.className = "page-flow";
  flow.innerHTML = markup;
  document.body.append(flow);
  place(flow, { top: 0, bottom: 2000 });
  return flow;
}

function find(flow: HTMLElement, selector: string): HTMLElement {
  const element = flow.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

const OPTIONS = { zoomFactor: 1, breakIds: new Set<string>() };

beforeEach(() => {
  textRects.clear();
  vi.spyOn(document, "createRange").mockImplementation(() => {
    let target: Node | null = null;
    return {
      selectNodeContents: (node: Node) => { target = node; },
      selectNode: (node: Node) => { target = node; },
      getClientRects: () => (target ? textRects.get(target) ?? [] : []).map(toDomRect),
      getBoundingClientRect: () => {
        const first = target ? textRects.get(target)?.[0] : undefined;
        return first ? toDomRect(first) : new DOMRect();
      },
    } as unknown as Range;
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/**
 * 段落 p1 (0〜20) → 拡張ノード (30〜130: 2 行の本文と操作のボタン) → 段落 p2 (140〜160)。
 * `dy` は拡張ノードに与えた変位 (表示位置はその分だけ下)。
 */
function cardFlow({ dy = 0, revision = "r1" }: { dy?: number; revision?: string } = {}) {
  const flow = html(`
    <div data-flow-unit-id="unit">
      <div class="ProseMirror"><p data-sigma-doc-id="p1">本文</p></div>
      <div data-flow-extension-node-id="extension:card" data-flow-measure-revision="${revision}"${dy ? ` data-flow-dy="${dy}"` : ""}>
        <section><p class="row-1">提案の1行目</p><p class="row-2">提案の2行目</p><button type="button">適用</button></section>
      </div>
      <div class="ProseMirror"><p data-sigma-doc-id="p2">後続</p></div>
    </div>
  `);
  place(find(flow, "[data-flow-unit-id]"), { top: 0, bottom: 160 + dy });
  place(find(flow, '[data-sigma-doc-id="p1"]'), { top: 0, bottom: 20 });
  placeText(find(flow, '[data-sigma-doc-id="p1"]'), { top: 0, bottom: 20 });
  const card = find(flow, "[data-flow-extension-node-id]");
  place(card, { top: 30 + dy, bottom: 130 + dy });
  placeText(find(flow, ".row-1"), { top: 40 + dy, bottom: 60 + dy });
  placeText(find(flow, ".row-2"), { top: 70 + dy, bottom: 90 + dy });
  placeText(find(flow, "button"), { top: 100 + dy, bottom: 115 + dy });
  place(find(flow, '[data-sigma-doc-id="p2"]'), { top: 140 + dy, bottom: 160 + dy });
  placeText(find(flow, '[data-sigma-doc-id="p2"]'), { top: 140 + dy, bottom: 160 + dy });
  return { flow, card };
}

describe("probeFlow extension nodes", () => {
  it("returns an extension node as its own node between the blocks, in document order", () => {
    const { flow } = cardFlow();
    const [unit] = probeFlow(flow, OPTIONS).units;
    expect(unit.nodes.map((node) => [node.id, node.kind ?? "block"])).toEqual([
      ["p1", "block"],
      ["extension:card", "extension"],
      ["p2", "block"],
    ]);
    const card = unit.nodes[1];
    expect(card.rect).toMatchObject({ top: 30, bottom: 130 });
    // 操作のボタンも紙面に描かれる中身なので行に数える。
    expect(card.ink.map((ink) => [ink.top, ink.bottom])).toEqual([[40, 60], [70, 90], [100, 115]]);
    expect(card.breakBefore).toBe(false);
  });

  it("subtracts the displacement the node itself was given (no double counting)", () => {
    const { flow } = cardFlow({ dy: 40 });
    const card = probeFlow(flow, OPTIONS).units[0].nodes[1];
    expect(card.rect).toMatchObject({ top: 30, bottom: 130 });
    expect(card.ink.map((ink) => [ink.top, ink.bottom])).toEqual([[40, 60], [70, 90], [100, 115]]);
  });

  it("re-measures a node of the same height when its measure revision changes", () => {
    const { flow, card } = cardFlow();
    const cache = createFlowProbeCache();
    probeFlow(flow, { ...OPTIONS, cache });
    // 中身だけが変わり、高さは同じ (2 行目が下がった)。
    placeText(find(flow, ".row-2"), { top: 74, bottom: 94 });
    const unchanged = probeFlow(flow, { ...OPTIONS, cache }).units[0].nodes[1];
    expect(unchanged.ink.map((ink) => ink.top)).toEqual([40, 70, 100]);
    card.setAttribute("data-flow-measure-revision", "r2");
    const changed = probeFlow(flow, { ...OPTIONS, cache }).units[0].nodes[1];
    expect(changed.ink.map((ink) => ink.top)).toEqual([40, 74, 100]);
  });

  it("drops rows hidden by a scrolling or clipping box inside the node", () => {
    const flow = html(`
      <div data-flow-unit-id="unit">
        <div data-flow-extension-node-id="extension:card">
          <div class="scroller" style="overflow-y: auto"><p class="visible">見える行</p><p class="cut">途中で切れる行</p><p class="hidden">隠れた行</p></div>
          <button type="button">適用</button>
        </div>
      </div>
    `);
    place(find(flow, "[data-flow-unit-id]"), { top: 0, bottom: 200 });
    place(find(flow, "[data-flow-extension-node-id]"), { top: 0, bottom: 200 });
    place(find(flow, ".scroller"), { top: 0, bottom: 90 });
    placeText(find(flow, ".visible"), { top: 10, bottom: 30 });
    placeText(find(flow, ".cut"), { top: 80, bottom: 100 });
    placeText(find(flow, ".hidden"), { top: 150, bottom: 170 });
    placeText(find(flow, "button"), { top: 170, bottom: 190 });
    const card = probeFlow(flow, OPTIONS).units[0].nodes[0];
    expect(card.ink.map((ink) => [ink.top, ink.bottom])).toEqual([[10, 30], [80, 90], [170, 190]]);
  });

  it("makes no row for a body block that is not drawn (folded away with display: none)", () => {
    // 適用後だけを見せる提案の変更前: 本文から畳まれ、描画矩形を持たない。0 の矩形から変位を引くと
    // 負の位置の行になり、ページ割りが前のページへ行を置く。畳んだブロックが持つ手動改ページ
    // (breakIds の p1) も行と一緒に消える: 畳んだ間のページ割りは、適用後のブロックが持つ改ページを
    // まだ表さない (カードへ引き継ぐのは follow-up)。
    const { flow } = cardFlow();
    const folded = find(flow, '[data-sigma-doc-id="p1"]');
    folded.setAttribute("data-flow-dy", "40");
    folded.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    folded.getClientRects = () => [] as unknown as DOMRectList;
    textRects.clear();
    placeText(find(flow, ".row-1"), { top: 40, bottom: 60 });
    placeText(find(flow, ".row-2"), { top: 70, bottom: 90 });
    placeText(find(flow, "button"), { top: 100, bottom: 115 });
    placeText(find(flow, '[data-sigma-doc-id="p2"]'), { top: 140, bottom: 160 });

    const [unit] = probeFlow(flow, { ...OPTIONS, breakIds: new Set(["p1"]) }).units;

    expect(unit.nodes.map((node) => node.id)).toEqual(["extension:card", "p2"]);
    expect(Math.min(...unit.nodes.map((node) => node.rect.top))).toBeGreaterThanOrEqual(0);
  });

  it("still measures an empty-looking body block that is drawn (a zero-height rect)", () => {
    const { flow } = cardFlow();
    const empty = find(flow, '[data-sigma-doc-id="p1"]');
    place(empty, { top: 0, bottom: 0 });
    expect(probeFlow(flow, OPTIONS).units[0].nodes.map((node) => node.id)).toEqual(["p1", "extension:card", "p2"]);
  });

  it("skips an empty (collapsed) extension node", () => {
    const { flow, card } = cardFlow();
    card.innerHTML = "";
    place(card, { top: 30, bottom: 30 });
    expect(probeFlow(flow, OPTIONS).units[0].nodes.map((node) => node.id)).toEqual(["p1", "p2"]);
  });

  it("does not probe editor-like blocks inside an extension node as body blocks", () => {
    const { flow, card } = cardFlow();
    const inner = document.createElement("div");
    inner.className = "ProseMirror";
    inner.innerHTML = '<p data-sigma-doc-id="preview">表示用のコピー</p>';
    card.querySelector("section")!.append(inner);
    place(inner.firstElementChild!, { top: 116, bottom: 128 });
    placeText(inner.firstElementChild!, { top: 116, bottom: 128 });
    const [unit] = probeFlow(flow, OPTIONS).units;
    expect(unit.nodes.map((node) => node.id)).toEqual(["p1", "extension:card", "p2"]);
  });

  it("does not take a problem number drawn inside an extension node as the unit's attachment", () => {
    const { flow, card } = cardFlow();
    const marker = document.createElement("span");
    marker.className = "problem-number-marker";
    marker.textContent = "1";
    card.querySelector("section")!.prepend(marker);
    place(marker, { top: 32, bottom: 38 });
    expect(probeFlow(flow, OPTIONS).units[0].attachments).toEqual([]);
  });

  it("lets the first node with an id win even when it is not drawn (a later duplicate is not measured)", () => {
    const { flow, card } = cardFlow();
    const duplicate = card.cloneNode(true) as HTMLElement;
    find(flow, '[data-sigma-doc-id="p2"]').closest(".ProseMirror")!.after(duplicate);
    place(duplicate, { top: 170, bottom: 190 });
    card.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    card.getClientRects = () => [] as unknown as DOMRectList;

    expect(probeFlow(flow, OPTIONS).units[0].nodes.map((node) => node.id)).toEqual(["p1", "p2"]);
  });

  it("measures an extension node id only once even if a feature draws it twice", () => {
    const { flow, card } = cardFlow();
    const duplicate = card.cloneNode(true) as HTMLElement;
    find(flow, '[data-sigma-doc-id="p2"]').closest(".ProseMirror")!.after(duplicate);
    place(duplicate, { top: 170, bottom: 190 });
    const ids = probeFlow(flow, OPTIONS).units[0].nodes.map((node) => node.id);
    expect(ids).toEqual(["p1", "extension:card", "p2"]);
  });

  it("starts a problem area's reserved space after an extension node placed below the area body", () => {
    const flow = html(`
      <section data-flow-unit-id="area" style="min-height: 300px">
        <div class="problem-area-paper-content"><div class="ProseMirror"><p data-sigma-doc-id="prompt">問題文</p></div></div>
        <div data-flow-extension-node-id="extension:after-problem"><p class="row">提案</p></div>
      </section>
    `);
    place(find(flow, "[data-flow-unit-id]"), { top: 0, bottom: 300 });
    place(find(flow, ".problem-area-paper-content"), { top: 0, bottom: 50 });
    place(find(flow, '[data-sigma-doc-id="prompt"]'), { top: 0, bottom: 50 });
    placeText(find(flow, '[data-sigma-doc-id="prompt"]'), { top: 10, bottom: 40 });
    place(find(flow, "[data-flow-extension-node-id]"), { top: 60, bottom: 120 });
    placeText(find(flow, ".row"), { top: 70, bottom: 110 });
    const [unit] = probeFlow(flow, OPTIONS).units;
    expect(unit.nodes.map((node) => node.id)).toEqual(["prompt", "extension:after-problem"]);
    expect(unit.reservation).toEqual({ top: 120, bottom: 300 });
  });
});
