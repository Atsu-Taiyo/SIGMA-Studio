/**
 * 数式 1 つ分の DOM の**名前の唯一の出典** (クラス名と属性)。
 *
 * 同じ数式を描く面が 4 つある — 編集面の ProseMirror NodeView、静的レンダラ (PDF・印刷・viewer)、
 * React の `InlineMathPreview`、HTML 文字列の連結 — ので、クラス名・属性・入れ子をここに 1 つだけ
 * 置く。どれかが独自に組み立てると「編集中と印刷で見た目が違う」に直結する
 * (`inline-dom-parity.test.ts` / `inline-math-node-view.test.ts` がここを固定する)。
 *
 * 構造:
 *
 * ```html
 * <span class="inline-math-node …" data-sigma-doc-math-inline data-id data-tex title>
 *   <span class="math-preview math-preview-inline" data-empty="false">…MathLive の markup…</span>
 * </span>
 * ```
 *
 * このファイルは**葉**にしておく: 無害化 (`math-markup.ts`) は SVG 書き出しの文字列
 * シリアライザや node 環境でも動く必要があり、そこから辿れる依存に MathLive/KaTeX を
 * 混ぜたくない。DOM を実際に組む側 (`innerHTML` を持つ側) は `inline-math-dom.ts`。
 */
export const INLINE_MATH_FRAME_CLASS_NAME = "inline-math-node";
/**
 * 編集面のノードビューだけが持つ印。静的レンダラの数式には付かない。
 *
 * 囲みランの採寸が「1 つの mark span が何個の文書ターゲットを代表しているか」を数えるのに使う
 * (`boxed-text-run-height.ts`)。React ノードビューだった頃に Tiptap が被せていた
 * `.react-renderer` が果たしていた役目。
 */
export const INLINE_MATH_NODE_VIEW_ATTRIBUTE = "data-inline-math-node-view";
export const INLINE_MATH_BODY_CLASS_NAME = "math-preview";

export interface InlineMathFrameStateOptions {
  className?: string;
  displayMode?: boolean;
  editing?: boolean;
  selected?: boolean;
  textSelected?: boolean;
}

export interface InlineMathFrameDataOptions {
  id?: string;
  tex: string;
  title?: string;
}

/** 外枠のクラス。状態 (選択・テキスト選択・編集中) はここに出る。 */
export function inlineMathNodeClassName({
  className,
  displayMode = false,
  editing = false,
  selected = false,
  textSelected = false,
}: InlineMathFrameStateOptions = {}): string {
  return [
    INLINE_MATH_FRAME_CLASS_NAME,
    displayMode ? "display-math-node" : "",
    selected ? "selected" : "",
    textSelected ? "text-selected" : "",
    editing ? "editing" : "",
    className,
  ].filter(Boolean).join(" ");
}

/** 外枠の属性。`data-tex` は貼り付けの読み戻し (`parseHTML`) が読む。 */
export function inlineMathNodeDataAttributes({ id, tex, title = tex }: InlineMathFrameDataOptions): Record<string, string> {
  return {
    "data-sigma-doc-math-inline": "",
    ...(id ? { "data-id": id } : {}),
    "data-tex": tex,
    title,
  };
}

/** 中身 (MathLive の markup を載せる箱) のクラス。 */
export function inlineMathBodyClassName(displayMode = false, className?: string): string {
  return [
    INLINE_MATH_BODY_CLASS_NAME,
    displayMode ? "math-preview-display" : "math-preview-inline",
    className,
  ].filter(Boolean).join(" ");
}
