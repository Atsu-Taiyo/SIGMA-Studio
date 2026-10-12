/**
 * CSS Custom Highlight API (`CSS.highlights`) の登録口。
 *
 * 跨ぎ選択と図形操作中の保持選択は、Chromium がフォーカスの無い contenteditable の
 * ::selection を描かないため PM の外から描く。以前は fixed レイヤー + mix-blend-mode:
 * multiply の矩形帯だったが、(a) 有彩色文字が暗転する (赤 #dc2626 が rgb(166,32,38) になる)、
 * (b) 隣接行の帯が 2〜3px 重なり 32% アルファの二重合成で縞が出る、(c) 帯が overlay 図形の
 * 上に乗る、の 3 つが構造的に消えなかった。Highlight はブラウザがネイティブ ::selection と
 * 同じ層 (グリフの背後) に描くため、どれも起きない。色は下の `::highlight(...)` 規則が持つ。
 *
 * `::highlight` は globals.css に書けない。Next.js 16 の Turbopack が使う LightningCSS が
 * 未対応で、パース失敗のあと規則を落とす (vercel/next.js#85398)。ここでは `<style>` として
 * 注入する。`style-src 'unsafe-inline'` はデスクトップ CSP で既に必要。
 *
 * 数式アトムの選択色は PM の状態選択に付く `.inline-math-node.text-selected` 装飾 (数式全体の
 * 背景) が持つ。Range は数式の中の KaTeX の文字も含むので、Highlight はそれも塗ってしまい、背景の
 * 上に記号ごとの四角が濃く重なる。数式の中では Highlight を塗らない (ネイティブ ::selection の
 * 対の規則は math-and-comments.css)。
 */

/** チャンクを跨ぐ本文選択 (`TextRunSelectionOverlay`)。 */
export const TEXT_RUN_SPAN_HIGHLIGHT_NAME = "text-run-span";
/** 図形操作中に保持した本文選択 (`HeldBodySelectionOverlay`)。 */
export const HELD_BODY_SELECTION_HIGHLIGHT_NAME = "held-body-selection";

const CUSTOM_HIGHLIGHT_STYLE_ID = "sigma-custom-highlight-styles";

const CUSTOM_HIGHLIGHT_CSS = `::highlight(${TEXT_RUN_SPAN_HIGHLIGHT_NAME}),
::highlight(${HELD_BODY_SELECTION_HIGHLIGHT_NAME}) {
  background-color: var(--editor-selection-background);
}
.inline-math-node ::highlight(${TEXT_RUN_SPAN_HIGHLIGHT_NAME}),
.inline-math-node ::highlight(${HELD_BODY_SELECTION_HIGHLIGHT_NAME}) {
  background-color: transparent;
}`;

function ensureCustomHighlightStyles(): void {
  if (typeof document === "undefined") {
    return;
  }
  if (document.getElementById(CUSTOM_HIGHLIGHT_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = CUSTOM_HIGHLIGHT_STYLE_ID;
  style.textContent = CUSTOM_HIGHLIGHT_CSS;
  document.head.appendChild(style);
}

/** 範囲群を登録する (空なら削除)。API の無い環境 (テスト DOM) では何もしない。 */
export function setCustomHighlight(name: string, ranges: readonly Range[]): void {
  ensureCustomHighlightStyles();
  if (typeof Highlight === "undefined" || typeof CSS === "undefined" || !CSS.highlights) {
    return;
  }
  if (ranges.length === 0) {
    CSS.highlights.delete(name);
    return;
  }
  CSS.highlights.set(name, new Highlight(...ranges));
}
