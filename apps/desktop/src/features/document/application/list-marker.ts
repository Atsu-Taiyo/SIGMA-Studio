import {
  normalizeListIndentEm,
  normalizeOrderedListMarkerStyle,
  type OrderedListMarkerStyle,
} from "../model/blocks";

/**
 * リストの字下げ (`ListNode.indentEm`) を描く custom property。編集面 (ProseMirror)・静的描画・
 * 印刷/PDF が同じインライン変数を書き、`document-surface.css` の `padding-inline-start` が読む。
 */
export const LIST_INDENT_CSS_VARIABLE = "--sigma-doc-list-indent";

export function listIndentStyleVars(value: unknown): Record<string, string> {
  const em = normalizeListIndentEm(value);
  return em === undefined ? {} : { [LIST_INDENT_CSS_VARIABLE]: `${em}em` };
}

/** Tiptap の `renderHTML` 側。`mergeAttributes` は同じ `style` キーを "; " で繋ぐ。 */
export function listIndentStyleAttr(value: unknown): Record<string, string> {
  const em = normalizeListIndentEm(value);
  return em === undefined ? {} : { style: `${LIST_INDENT_CSS_VARIABLE}: ${em}em` };
}

/** Tiptap の `parseHTML` 側。HTML 貼り付けで運ばれてきたインライン style から読み戻す。 */
export function listIndentFromStyleValue(value: string | null | undefined): number | null {
  return normalizeListIndentEm(Number.parseFloat(value ?? "")) ?? null;
}

/**
 * `ol[data-list-marker]` の値。`document-surface.css` がこの属性で `@counter-style` を選ぶ。
 * 既定の decimal は属性を書かない (UA 既定のまま)。
 */
export function orderedListMarkerDataAttr(value: unknown): Exclude<OrderedListMarkerStyle, "decimal"> | undefined {
  const markerStyle = normalizeOrderedListMarkerStyle(value);
  return markerStyle && markerStyle !== "decimal" ? markerStyle : undefined;
}

/** 書式なしテキスト・Markdown へ書き出すときのマーカー。CSS の `@counter-style` と同じ見た目。 */
export function orderedListMarkerText(markerStyle: OrderedListMarkerStyle | undefined, value: number): string {
  switch (markerStyle) {
    case "paren":
      return `(${value})`;
    case "parenLowerAlpha":
      return `(${alphabeticMarker(value)})`;
    case "parenUpperAlpha":
      return `(${alphabeticMarker(value).toUpperCase()})`;
    case "parenLowerRoman":
      return `(${romanMarker(value)})`;
    case "parenUpperRoman":
      return `(${romanMarker(value).toUpperCase()})`;
    default:
      return `${value}.`;
  }
}

function alphabeticMarker(value: number): string {
  let rest = Math.max(1, Math.floor(value));
  let text = "";
  while (rest > 0) {
    rest -= 1;
    text = String.fromCharCode(97 + (rest % 26)) + text;
    rest = Math.floor(rest / 26);
  }
  return text;
}

const ROMAN_STEPS: ReadonlyArray<[number, string]> = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

function romanMarker(value: number): string {
  let rest = Math.floor(value);
  if (rest < 1 || rest > 3999) {
    return String(value);
  }
  let text = "";
  for (const [step, digits] of ROMAN_STEPS) {
    while (rest >= step) {
      text += digits;
      rest -= step;
    }
  }
  return text;
}
