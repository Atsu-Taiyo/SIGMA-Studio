import { INLINE_MATH_FONT_MENU_ATTRIBUTE, wrapMathWithFont } from "@/lib/math-font-style";

import { getDeepActiveElement } from "./inline-math-type-ahead";

/**
 * ツールバーのフォントを、数式の入力欄で選んだ範囲だけに付ける (数式の外側の本文には付けない)。
 * 範囲を選んでいない・数式を開いていないときは本文の書式として扱う。
 */
export const APPLY_INLINE_MATH_FONT_EVENT = "sigma-studio:apply-inline-math-font";

export interface ApplyInlineMathFontDetail {
  /** 本文の書式と同じフォントの値 (CSS のフォント名の並び)。 */
  fontFamily: string;
}

/**
 * フォントメニューを開いたときに焦点のあった要素を覚える。メニューの検索欄をクリックすると焦点が
 * 数式の入力欄から離れるので、開いた時点の入力欄 (と、そこで選んでいた範囲) へ届けるために使う。
 * マウスで開くとき、メニューのボタンは焦点を奪わないので、ここでは入力欄の中の要素が返る。
 */
export function captureInlineMathFontTarget(ownerDocument: Document = document): Element | null {
  return getDeepActiveElement(ownerDocument);
}

/**
 * 数式の入力欄へフォントを渡す。いま焦点のある要素、無ければメニューを開いたときの要素
 * (`captureInlineMathFontTarget`、閉じた入力欄はもう文書に無いので使わない) へ順に送る。
 * 入力欄が選んだ範囲に付けたら true。
 */
export function applyFontToInlineMathSelection(
  fontFamily: string,
  rememberedTarget: Element | null = null,
  ownerDocument: Document = document,
): boolean {
  const active = getDeepActiveElement(ownerDocument);
  if (active && dispatchInlineMathFont(active, fontFamily)) {
    return true;
  }
  return Boolean(
    rememberedTarget
      && rememberedTarget !== active
      && rememberedTarget.isConnected
      && dispatchInlineMathFont(rememberedTarget, fontFamily),
  );
}

/** フォントメニューを閉じたときに文書へ送る知らせ (`watchInlineMathFontMenuFocus` が待つ)。 */
export const INLINE_MATH_FONT_MENU_CLOSED_EVENT = "sigma-studio:inline-math-font-menu-closed";

export function notifyInlineMathFontMenuClosed(ownerDocument: Document = document): void {
  ownerDocument.dispatchEvent(new Event(INLINE_MATH_FONT_MENU_CLOSED_EVENT));
}

/** フォントメニューの中 (`INLINE_MATH_FONT_MENU_ATTRIBUTE`) の要素か。 */
export function isInlineMathFontMenuElement(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(`[${INLINE_MATH_FONT_MENU_ATTRIBUTE}]`));
}

/**
 * 数式の入力欄からフォントメニューへ焦点が移ったあとを見張る。焦点が入力欄へ戻ったら (フォントを
 * 付けると入力欄が焦点を取り戻す) 見張りをやめ、メニューと入力欄の外へ出たら、またはメニューが
 * 閉じたときに入力欄に焦点が無ければ `onLeave` (入力欄を確定して閉じる) を呼ぶ。返り値で見張りを外す。
 */
export function watchInlineMathFontMenuFocus(field: Element, onLeave: () => void): () => void {
  const ownerDocument = field.ownerDocument;
  const isInsideField = (target: EventTarget | null) => target instanceof Node && (target === field || field.contains(target));
  const stop = () => {
    ownerDocument.removeEventListener("focusin", handleFocusIn, true);
    ownerDocument.removeEventListener(INLINE_MATH_FONT_MENU_CLOSED_EVENT, handleMenuClosed);
  };
  const leave = () => {
    stop();
    onLeave();
  };
  function handleFocusIn(event: FocusEvent) {
    if (isInsideField(event.target)) {
      stop();
    } else if (!isInlineMathFontMenuElement(event.target)) {
      leave();
    }
  }
  function handleMenuClosed() {
    if (!field.isConnected) {
      stop();
    } else if (isInsideField(ownerDocument.activeElement)) {
      stop();
    } else {
      leave();
    }
  }
  ownerDocument.addEventListener("focusin", handleFocusIn, true);
  ownerDocument.addEventListener(INLINE_MATH_FONT_MENU_CLOSED_EVENT, handleMenuClosed);
  return stop;
}

function dispatchInlineMathFont(target: Element, fontFamily: string): boolean {
  const event = new CustomEvent<ApplyInlineMathFontDetail>(APPLY_INLINE_MATH_FONT_EVENT, {
    bubbles: true,
    cancelable: true,
    composed: true,
    detail: { fontFamily },
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** MathLive の入力欄のうち、ここで使う分だけ。 */
export interface MathFieldFontTarget {
  selection?: unknown;
  selectionIsCollapsed?: boolean;
  getValue?: (...args: never[]) => string;
  insert: (...args: never[]) => unknown;
}

/** 入力欄で選んだ範囲をそのフォントで包む。範囲が空なら何もしない (false)。 */
export function applyFontToMathFieldSelection(field: MathFieldFontTarget, fontFamily: string): boolean {
  if (field.selectionIsCollapsed !== false || typeof field.getValue !== "function") {
    return false;
  }
  const getRange = field.getValue as unknown as (start: number, end: number, format: "latex") => string;
  const range = tightenMathFieldRange(readSelectionRange(field.selection), (start, end) => getRange.call(field, start, end, "latex"));
  if (!range) {
    return false;
  }
  // 置き換えは詰めた範囲で行う。Shift+← で分母の中身を選ぶと、範囲は分子の終わりから始まって
  // いて (見た目と TeX は分母の中身だけ)、そのまま置き換えると分子の側へ入ってしまう。
  field.selection = { ranges: [[range.start, range.end]], direction: "forward" };
  const insert = field.insert as unknown as (latex: string, options: {
    format: "latex";
    insertionMode: "replaceSelection";
    selectionMode: "item";
    focus: boolean;
  }) => unknown;
  insert.call(field, wrapMathWithFont(range.latex, fontFamily), {
    format: "latex",
    insertionMode: "replaceSelection",
    // 付けた範囲を選んだままにする (続けて別のフォントを選び直せる)。
    selectionMode: "item",
    focus: true,
  });
  return true;
}

function readSelectionRange(selection: unknown): [number, number] | null {
  const ranges = (selection as { ranges?: unknown } | null | undefined)?.ranges;
  const first = Array.isArray(ranges) ? ranges[0] : null;
  if (!Array.isArray(first) || typeof first[0] !== "number" || typeof first[1] !== "number") {
    return null;
  }
  return [Math.min(first[0], first[1]), Math.max(first[0], first[1])];
}

/**
 * 同じ TeX を表す最も狭い範囲。MathLive の範囲は構造の境目 (分子の終わり・分母の始まり) を
 * またいでいても同じ中身を返すので、両端から 1 つずつ詰めて、中身が変わる手前で止める。
 */
export function tightenMathFieldRange(
  range: [number, number] | null,
  latexOf: (start: number, end: number) => string,
): { start: number; end: number; latex: string } | null {
  if (!range) {
    return null;
  }
  let [start, end] = range;
  const latex = latexOf(start, end);
  if (!latex) {
    return null;
  }
  while (start + 1 < end && latexOf(start + 1, end) === latex) {
    start += 1;
  }
  while (end - 1 > start && latexOf(start, end - 1) === latex) {
    end -= 1;
  }
  return { start, end, latex };
}
