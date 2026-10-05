// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { measureElementTopInCanvas } from "./comment-geometry";

function place(element: Element, top: number, height: number): void {
  element.getBoundingClientRect = () => new DOMRect(0, top, 400, height);
  element.getClientRects = () => [new DOMRect(0, top, 400, height)] as unknown as DOMRectList;
}

/** display: none で畳んだ要素 (と、その中の要素): 外接矩形は 0、描画矩形は 1 つも無い。 */
function fold(element: Element): void {
  element.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  element.getClientRects = () => [] as unknown as DOMRectList;
}

function surface() {
  const canvas = document.createElement("div");
  canvas.innerHTML = `
    <div class="ProseMirror">
      <p data-sigma-doc-id="a">前の段落</p>
      <p data-sigma-doc-id="x">畳む段落<span class="comment-mark" data-comment-thread-id="t1">注</span></p>
      <div data-flow-extension-node-id="card">カード</div>
      <p data-sigma-doc-id="b">後の段落</p>
    </div>`;
  document.body.append(canvas);
  const find = (selector: string) => canvas.querySelector<HTMLElement>(selector)!;
  place(canvas, 40, 1000);
  place(find(".ProseMirror"), 40, 1000);
  place(find('[data-sigma-doc-id="a"]'), 140, 20);
  place(find('[data-sigma-doc-id="x"]'), 160, 20);
  place(find(".comment-mark"), 160, 20);
  place(find('[data-flow-extension-node-id="card"]'), 180, 60);
  place(find('[data-sigma-doc-id="b"]'), 240, 20);
  return { canvas, find };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("measureElementTopInCanvas", () => {
  it("measures a drawn element from the canvas top (unzoomed)", () => {
    const { canvas, find } = surface();
    expect(measureElementTopInCanvas(canvas, find('[data-sigma-doc-id="x"]'), 200)).toBe(60);
  });

  it("places what sits in a folded block where the block was: at the next drawn element, not at the top of page 1", () => {
    // 「適用後だけ」で畳んだ段落 x とその中のコメント。0 の矩形を読むと 1 ページ目の先頭へ飛ぶ。
    const { canvas, find } = surface();
    fold(find('[data-sigma-doc-id="x"]'));
    fold(find(".comment-mark"));
    place(find('[data-flow-extension-node-id="card"]'), 160, 60);
    place(find('[data-sigma-doc-id="b"]'), 220, 20);

    expect(measureElementTopInCanvas(canvas, find('[data-sigma-doc-id="x"]'), 100)).toBe(120);
    expect(measureElementTopInCanvas(canvas, find(".comment-mark"), 100)).toBe(120);
  });

  it("falls back to the bottom of the drawn element before a folded block at the end", () => {
    const { canvas, find } = surface();
    find('[data-flow-extension-node-id="card"]').remove();
    find('[data-sigma-doc-id="b"]').remove();
    fold(find('[data-sigma-doc-id="x"]'));

    expect(measureElementTopInCanvas(canvas, find('[data-sigma-doc-id="x"]'), 100)).toBe(120);
  });
});
