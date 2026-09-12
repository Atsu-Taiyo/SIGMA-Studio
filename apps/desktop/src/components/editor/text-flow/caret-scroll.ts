import type { EditorView } from "@tiptap/pm/view";

/** キャレットを可視域へ入れるときに空ける余白 (client px)。 */
const CARET_SCROLL_MARGIN_PX = 24;

export interface CaretBand {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

/**
 * まだ紙面上の位置が確定していない場所にキャレットが居る間、スクロールを保留した面。
 *
 * 段組みのブロック配置と未計測ユニットの座標は**次の計測が決める**。確定前に測った座標は
 * 「潰れた編集面 root の原点 = 1 ページ目の上端」を指すので、そこへ追従すると挿入のたびに
 * 紙面が文書先頭へ吹っ飛ぶ。保留し、配置が確定した commit で `flushDeferredCaretScroll` が
 * 見せ直す。
 */
const deferredCaretScrollViews = new WeakSet<EditorView>();

/**
 * 保留していたスクロールを、配置が確定した後の座標でやり直す。
 * 呼ぶのは配置を反映した側 (`TextFlowEditor` の同期 decoration refresh)。
 */
export function flushDeferredCaretScroll(view: EditorView): void {
  if (!deferredCaretScrollViews.has(view)) {
    return;
  }
  deferredCaretScrollViews.delete(view);
  if (view.isDestroyed || !view.hasFocus()) {
    return;
  }
  scrollCaretIntoView(view);
}

/**
 * キャレットの座標がまだ意味を持たない = 次の計測待ちか。
 *
 * - 面ごと `visibility: hidden` (段組みの未計測ユニットなど): 配置前の仮置き。
 * - ブロック単位配置を使う面で、キャレットのトップレベルブロックにまだ配置
 *   (`text-flow-column-block`) が付いていない: 挿入直後のブロック。
 *
 * 断片の複製 (viewport 基準) と、ブロック単位配置を使わない面は
 * 静的位置がそのまま正しいので対象にしない。
 */
function caretAwaitsColumnPlacement(view: EditorView): boolean {
  const viewDom = view.dom as HTMLElement;
  if (viewDom.closest(".editor-box-fragment-viewport")) {
    return false;
  }
  if (getComputedStyle(viewDom).visibility === "hidden") {
    return true;
  }
  const block = caretTopLevelBlockElement(view);
  return shouldDeferCaretScrollForPlacement({
    caretHasPlacement: block?.classList.contains("text-flow-column-block") ?? false,
    caretIsTopLevelBlock: block?.parentElement === viewDom,
    hasPlacedBlocks: viewDom.querySelector(":scope > .text-flow-column-block") !== null,
    isPlacementSurface: viewDom.closest(".text-flow-shell.column-flow-positioned") !== null,
  });
}

/**
 * 配置装飾の更新を待つべきか。ページ段組みと layoutSection の独立カラムは、
 * どちらも `column-flow-positioned` 面と同じ装飾を使う。
 */
export function shouldDeferCaretScrollForPlacement(input: {
  caretHasPlacement: boolean;
  caretIsTopLevelBlock: boolean;
  hasPlacedBlocks: boolean;
  isPlacementSurface: boolean;
}): boolean {
  return input.isPlacementSurface
    && input.caretIsTopLevelBlock
    && !input.caretHasPlacement
    && input.hasPlacedBlocks;
}

function caretTopLevelBlockElement(view: EditorView): HTMLElement | null {
  const { $head } = view.state.selection;
  if ($head.depth === 0) {
    return null;
  }
  const dom = view.nodeDOM($head.before(1));
  return dom instanceof HTMLElement ? dom : null;
}

/**
 * キャレットを可視域へ入れるためにスクロールを動かす量 (client px の差分)。
 *
 * **client px の差分しか使わない**のがこの設計の要点で、ズーム係数を持ち込まない。
 * キャレットが可視域より背が高いときは上端に合わせる (下端に合わせると行の頭が切れる)。
 */
export function resolveScrollDelta(
  caret: { bottom: number; top: number },
  viewport: { bottom: number; top: number },
  margin: number,
): number {
  const above = caret.top - margin - viewport.top;
  if (above < 0) {
    return above;
  }
  const below = caret.bottom + margin - viewport.bottom;
  return below > 0 ? below : 0;
}

/**
 * `coordsAtPos` が空キャレットに返す原点の 0 矩形は、紙面上の座標ではない。
 * その場合だけ所属ブロックの矩形へ倒し、見えているブロックを動かさない。
 */
export function resolveCaretRectForScroll(
  caret: { bottom: number; top: number },
  block: { bottom: number; top: number } | null,
): { bottom: number; top: number } {
  const caretIsMeasurable = Number.isFinite(caret.top)
    && Number.isFinite(caret.bottom)
    && (caret.top !== 0 || caret.bottom !== 0);
  return caretIsMeasurable || !block ? caret : block;
}

/**
 * この面が実際にキャレットを見せられる帯 (client 座標)。
 *
 * - 断片の複製 → viewport の矩形 (中身は `translateY` されているので `view.dom` は使えない)
 * - それ以外 → **実際に描かれているブロック矩形の和**。編集面自身の矩形は当てにならない:
 *   段組みの本文はブロックが絶対配置されて矩形が潰れ、逆に末尾に分割ブロックがあると
 *   clip された見えない領域まで伸びている。
 */
export function getCaretSurfaceBand(
  viewDom: HTMLElement,
  containerBlockId: string | null,
): CaretBand {
  const viewport = viewDom.closest<HTMLElement>(".editor-box-fragment-viewport");
  const editorRect = viewDom.getBoundingClientRect();
  if (viewport) {
    const rect = viewport.getBoundingClientRect();
    return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
  }

  const clipped = containerBlockId ? findClippedSource(viewDom, containerBlockId) : null;
  if (clipped) {
    const rect = clipped.getBoundingClientRect();
    return {
      bottom: visibleBottomOf(clipped, rect),
      left: editorRect.left,
      right: editorRect.right,
      top: rect.top,
    };
  }

  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const block of viewDom.querySelectorAll<HTMLElement>("[data-sigma-doc-id]")) {
    const rect = block.getBoundingClientRect();
    if (rect.height <= 0) {
      continue;
    }
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, visibleBottomOf(block, rect));
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom - top < 2) {
    return {
      bottom: editorRect.bottom,
      left: editorRect.left,
      right: editorRect.right,
      top: editorRect.top,
    };
  }
  return { bottom, left: editorRect.left, right: editorRect.right, top };
}

/** ブロックが実際に描かれている下端 (分割ブロックは clip された可視帯まで)。 */
export function visibleBottomOf(block: HTMLElement, rect: DOMRect): number {
  if (!block.classList.contains("text-flow-box-fragment-source")) {
    return rect.bottom;
  }
  const visibleHeight = Number.parseFloat(
    getComputedStyle(block).getPropertyValue("--text-flow-box-fragment-visible-height"),
  );
  if (!Number.isFinite(visibleHeight)) {
    return rect.bottom;
  }
  return Math.min(
    rect.bottom,
    rect.top + Math.max(0, visibleHeight) * getCaretZoomScale(block, rect),
  );
}

/** 実寸との比で取る表示倍率 (`clip-path` は `offsetHeight` を変えないので純粋な倍率になる)。 */
export function getCaretZoomScale(element: HTMLElement, rect: DOMRect): number {
  const scale = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/**
 * ProseMirror の既定のスクロール追従を置き換える。**`true` を返すと PM は
 * `scrollRectIntoView` を呼ばない。**
 *
 * PM の既定は `overflow` を見ずに全ての祖先へ `scrollTop += moveY` を試みるため、断片の
 * viewport を動かして「見えない場所へスクロールした状態」を作ってしまう。ここでは
 * **`.editor-canvas` だけ**を動かし、断片の viewport には一切触らない
 * (`translateY` で上へ押し出された内容は `scrollTop` では戻せない)。
 */
export function scrollCaretIntoView(
  view: EditorView,
  onOutsideBand?: () => void,
): boolean {
  // **どの経路でも `true` を返す。** `false` を返すと ProseMirror の既定 (`overflow` を見ずに
  // 全ての祖先へ `scrollTop += moveY`) が走り、まさに塞ぎたかった経路が復活する。
  if (caretAwaitsColumnPlacement(view)) {
    deferredCaretScrollViews.add(view);
    return true;
  }
  let caret: { bottom: number; top: number };
  try {
    const coords = view.coordsAtPos(view.state.selection.head);
    const blockRect = caretTopLevelBlockElement(view)?.getBoundingClientRect() ?? null;
    caret = resolveCaretRectForScroll(
      { bottom: coords.bottom, top: coords.top },
      blockRect ? { bottom: blockRect.bottom, top: blockRect.top } : null,
    );
  } catch {
    return true;
  }

  // この面が見せていない位置なら紙面を動かさない (動かすと「何も描かれていない紙面」へ飛ぶ)。
  // 代わりに、見せている面へ配り直すよう呼び出し側へ知らせる。
  const band = getCaretSurfaceBand(view.dom as HTMLElement, caretContainerBlockId(view));
  const middle = (caret.top + caret.bottom) / 2;
  if (middle < band.top - 0.5 || middle >= band.bottom + 0.5) {
    onOutsideBand?.();
    return true;
  }

  scrollRectIntoScroller(view.dom as HTMLElement, caret);
  return true;
}

/**
 * 矩形をスクローラーの可視域へ入れる。**断片の viewport は決してスクローラーにしない** —
 * `translateY` で上へ押し出された内容は `scrollTop` では戻せないため。
 */
function scrollRectIntoScroller(
  from: HTMLElement,
  rect: { bottom: number; top: number },
): void {
  const scroller = findCaretScroller(from);
  if (!scroller) {
    return;
  }
  const view = scroller.getBoundingClientRect();
  const viewport = { bottom: view.bottom, top: view.top };
  // 余白は「実際にはみ出しているとき」だけ効かせる。常に効かせると、可視域の縁から 24px
  // 以内にキャレットがあるだけで紙面が動き、フォーカスの受け渡しのたびに小さく跳ねる。
  if (resolveScrollDelta(rect, viewport, 0) === 0) {
    return;
  }
  const delta = resolveScrollDelta(rect, viewport, CARET_SCROLL_MARGIN_PX);
  if (delta !== 0) {
    scroller.scrollTop += delta;
  }
}

/**
 * この面を載せているスクローラー。紙面 (`.editor-canvas`) が基本だが、素材編集ダイアログの
 * ように別のスクローラーの中で開く面もあるので、見つからなければ祖先を辿る。
 */
function findCaretScroller(from: HTMLElement): HTMLElement | null {
  const canvas = from.closest<HTMLElement>(".editor-canvas");
  if (canvas) {
    return canvas;
  }
  let element: HTMLElement | null = from.parentElement;
  while (element) {
    if (!element.classList.contains("editor-box-fragment-viewport")) {
      const overflowY = getComputedStyle(element).overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll")
        && element.scrollHeight > element.clientHeight + 1
      ) {
        return element;
      }
    }
    element = element.parentElement;
  }
  return null;
}

/** キャレットが分割されたブロックの中にいるなら、その id。 */
function caretContainerBlockId(view: EditorView): string | null {
  const host = caretHostElement(view);
  const clipped = host?.closest<HTMLElement>(".text-flow-box-fragment-source") ?? null;
  return clipped?.dataset.sigmaDocId ?? null;
}

/**
 * キャレットが載っている DOM 要素。`domAtPos` はブロック境界で内容ルートまで上がって
 * クリップされた祖先を見失うので、解決済み位置から内側の深さで辿る。
 */
function caretHostElement(view: EditorView): HTMLElement | null {
  const { $head } = view.state.selection;
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    const dom = view.nodeDOM($head.before(depth));
    if (dom instanceof HTMLElement) {
      return dom;
    }
  }
  return view.dom instanceof HTMLElement ? view.dom : null;
}

function findClippedSource(viewDom: HTMLElement, blockId: string): HTMLElement | null {
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(blockId)
    : blockId.replace(/["\\]/g, "\\$&");
  const element = viewDom.querySelector<HTMLElement>(`[data-sigma-doc-id="${escaped}"]`);
  if (!element) {
    return null;
  }
  return element.classList.contains("text-flow-box-fragment-source")
    ? element
    : element.closest<HTMLElement>(".text-flow-box-fragment-source");
}

/**
 * 要素を `.editor-canvas` の可視域へ入れる。`scrollIntoView` を使わないのは、祖先の
 * スクロール可能な箱 (断片の viewport) まで動かしてしまうため。
 */
export function scrollElementIntoCanvasView(element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  scrollRectIntoScroller(element, { bottom: rect.bottom, top: rect.top });
}
