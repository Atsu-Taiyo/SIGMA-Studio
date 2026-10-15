/**
 * MathLive は IME 変換の開始時、入力を受ける隠し要素 `.ML__keyboard-sink` (position: fixed) を
 * 次のフレームでキャレットの画面座標へ置く。紙面はズーム用の transform を持つ `.page-stack`
 * (ホワイトボードは `.whiteboard-canvas`) の中にあり、fixed の基準がそちらへ移るので、隠し要素は
 * 「紙面の原点 + 画面座標 × 倍率」にずれる。下へスクロールしているほど (改ページの後など) 画面の
 * 上の外に出て、Chromium が変換中の文字を見せようと編集面を上へスクロールしていた (候補窓もずれる)。
 * MathLive が置いたのと同じフレームのうちに、基準の原点と倍率を測って置き直す。
 */
const anchoredRoots = new WeakSet<ShadowRoot>();

export function installMathLiveCompositionAnchor(root: ShadowRoot) {
  if (anchoredRoots.has(root)) return;
  anchoredRoots.add(root);
  root.addEventListener("compositionstart", (event) => {
    const sink = event.target;
    if (!(sink instanceof HTMLElement) || !sink.classList.contains("ML__keyboard-sink")) return;
    const before = `${sink.style.left} ${sink.style.top}`;
    // MathLive の compositionstart は sink 自身の capture で先に走り、rAF も先に積む。
    // ここの rAF はその直後・同じフレームで走るので、ずれた位置のまま変換文字が入ることはない。
    requestAnimationFrame(() => {
      const { left, top } = sink.style;
      // キャレットが無くて MathLive が動かさなかったときは、前回直した値をそのまま使う。
      if (`${left} ${top}` === before) return;
      placeFixedElementAtViewportPoint(sink, parseFloat(left), parseFloat(top));
    });
  });
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
