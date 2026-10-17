/**
 * MathLive は入力を受ける隠し要素 `.ML__keyboard-sink` (position: fixed) を、画面座標を前提に
 * `left` / `top` で動かす。紙面はズーム用の transform を持つ `.page-stack` (ホワイトボードは
 * `.whiteboard-canvas`) の中にあり、fixed の基準がそちらへ移るので、書かれた値は
 * 「紙面の原点 + 値 × 倍率」に化ける。Chromium は打った文字・変換中の文字を見せようとこの要素まで
 * 編集面をスクロールし、IME の候補窓もこの要素の位置に出るので、化けた分だけ画面と候補窓がずれる。
 *
 * - IME 変換の開始時: キャレットの画面座標へ置く。下へスクロールしているほど (改ページの後など)
 *   画面の上の外に出て、編集面が上へ飛んでいた。→ 基準の原点と倍率を測って置き直す。
 * - 範囲を選んでいる間 (分数などを入れた直後の空欄・全選択): 画面外 `left: -1000px` へ隠す。
 *   紙面の左の外になり、そこで文字を打つ・変換すると編集面が左端まで横へ飛んでいた。→ 数式の左上に置く。
 * - 範囲を選んだまま変換を始めたとき: キャレットが無いので MathLive は置き直さず、候補窓が隠した位置
 *   (紙面の左の外) に出ていた。→ 変換中の文字が描かれたら、その始まりへ置く。
 *
 * どれも描画より前 (MathLive が書いた直後か、変換中の文字を描いた同じフレーム) に直す。
 */
const MATHLIVE_SINK_SELECTOR = ".ML__keyboard-sink";
/** MathLive 0.111 の keyboardDelegate.setValue が、選んだ範囲の TeX を入れるときに隠す位置。 */
const MATHLIVE_HIDDEN_SINK_LEFT = "-1000px";
/** MathLive が描くキャレット (数式・文字・TeX 入力のどれか1つ)。 */
const MATHLIVE_CARET_SELECTOR = ".ML__caret, .ML__text-caret, .ML__latex-caret";

const anchoredRoots = new WeakSet<ShadowRoot>();
/** こちらで最後に書いた位置。同じ値なら MathLive は動かしていない。 */
const anchoredPositions = new WeakMap<HTMLElement, { left: string; top: string }>();

export function installMathLiveCompositionAnchor(root: ShadowRoot) {
  if (anchoredRoots.has(root)) return;
  anchoredRoots.add(root);

  const anchor = (sink: HTMLElement, x: number, y: number) => {
    placeFixedElementAtViewportPoint(sink, x, y);
    anchoredPositions.set(sink, { left: sink.style.left, top: sink.style.top });
    // ここで書いた left / top で、もう一度呼ばれないようにする。
    observer.takeRecords();
  };

  const observer = new MutationObserver((records) => {
    const sinks = new Set<HTMLElement>();
    for (const record of records) {
      if (isKeyboardSink(record.target)) sinks.add(record.target);
    }
    sinks.forEach((sink) => {
      const anchored = anchoredPositions.get(sink);
      const { left, top } = sink.style;
      if (anchored && left === anchored.left && top === anchored.top) return;
      if (left === MATHLIVE_HIDDEN_SINK_LEFT) {
        // 隠す代わりに数式の左上に置く。clip-path で見えないのは MathLive の CSS のまま。
        const field = (root.host as HTMLElement).getBoundingClientRect();
        anchor(sink, field.left, field.top);
      } else {
        anchor(sink, parseFloat(left), parseFloat(top));
      }
    });
  });
  observer.observe(root, { attributes: true, attributeFilter: ["style"], subtree: true });

  let composingWithoutCaret: HTMLElement | null = null;
  // capture: sink 上の MathLive の処理より先に、今の描画にキャレットがあるかを見る。MathLive も同じ描画で
  // キャレットを探し、無ければ (範囲を選んでいたら) sink を動かさない。
  root.addEventListener("compositionstart", (event) => {
    const sink = event.target;
    if (!isKeyboardSink(sink)) return;
    composingWithoutCaret = root.querySelector(MATHLIVE_CARET_SELECTOR) ? null : sink;
  }, { capture: true });
  root.addEventListener("compositionupdate", (event) => {
    const sink = event.target;
    if (!isKeyboardSink(sink) || sink !== composingWithoutCaret) return;
    composingWithoutCaret = null;
    // MathLive が変換中の文字の描画を積んだ後なので、この rAF は同じフレームのその後に走る。
    requestAnimationFrame(() => {
      const start = compositionStart(root);
      if (start) anchor(sink, start.x, start.y);
    });
  });
}

/** 変換中の文字の始まり。MathLive が変換開始時に使う「キャレットの左上」と同じ高さにする。 */
function compositionStart(root: ShadowRoot): { x: number; y: number } | null {
  const composition = root.querySelector(".ML__composition")?.getBoundingClientRect();
  const caret = root.querySelector(MATHLIVE_CARET_SELECTOR)?.getBoundingClientRect();
  const x = composition?.left ?? caret?.right;
  const y = caret?.top ?? composition?.top;
  return x === undefined || y === undefined ? null : { x, y };
}

function isKeyboardSink(target: unknown): target is HTMLElement {
  return target instanceof HTMLElement && target.matches(MATHLIVE_SINK_SELECTOR);
}

/** position: fixed の要素を、fixed の基準が transform を持つ祖先でも画面座標 (x, y) に置く。 */
export function placeFixedElementAtViewportPoint(element: HTMLElement, x: number, y: number) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  // 基準 (transform を持つ祖先、無ければ画面) の原点と倍率は、0 と 100px に置いて測る。
  element.style.left = "0px";
  element.style.top = "0px";
  const origin = element.getBoundingClientRect();
  element.style.left = "100px";
  element.style.top = "100px";
  const step = element.getBoundingClientRect();
  const scaleX = (step.left - origin.left) / 100 || 1;
  const scaleY = (step.top - origin.top) / 100 || 1;
  element.style.left = `${(x - origin.left) / scaleX}px`;
  element.style.top = `${(y - origin.top) / scaleY}px`;
}
