import {
  BLOCK_SPACE_AFTER_CSS_VARIABLE,
  blockSpaceAfterFromStyleValue,
  blockSpaceAfterStyleAttr,
  LIST_ITEM_SPACE_AFTER_CSS_VARIABLE,
  listItemSpaceAfterStyleAttr,
} from "@/features/document";

/**
 * ブロック下余白 (`spaceAfterPx`) を ProseMirror の doc へ載せる属性の定義。本文 (`SigmaDocTextAttrs`) と
 * 図中テキスト (`OverlayTextBlockAttrs`) が **同じ定義** を使う — 面ごとに書くと、片方だけ
 * 往復から落ちる (保存すると消える) 食い違いが起きる。
 *
 * どれも `keepOnSplit: false`: 「このブロックの下の余白」なので、Enter で割ったときは前半が持つ。
 */

/** 段落・見出し・リストの下余白。DOM へ出す — 編集面・静的描画・印刷/PDF が同じ custom property を読む。 */
export const BLOCK_SPACE_AFTER_ATTRIBUTE = {
  default: null,
  keepOnSplit: false,
  parseHTML: (element: HTMLElement) => blockSpaceAfterFromStyleValue(
    element.style.getPropertyValue(BLOCK_SPACE_AFTER_CSS_VARIABLE),
  ),
  renderHTML: (attributes: Record<string, unknown>) => blockSpaceAfterStyleAttr(attributes.spaceAfterPx),
};

/**
 * リスト項目 (`li`) の下余白の **描画側**。値の持ち主は先頭段落の {@link LIST_ITEM_LEADING_SPACE_AFTER_ATTRIBUTE}
 * (項目の id を持ち、分割・再構成を生き残る) で、`li` には専用の変数だけを書く。
 */
export const LIST_ITEM_SPACE_AFTER_ATTRIBUTE = {
  default: null,
  keepOnSplit: false,
  parseHTML: (element: HTMLElement) => blockSpaceAfterFromStyleValue(
    element.style.getPropertyValue(LIST_ITEM_SPACE_AFTER_CSS_VARIABLE),
  ),
  renderHTML: (attributes: Record<string, unknown>) => listItemSpaceAfterStyleAttr(attributes.spaceAfterPx),
};

/**
 * リスト項目の下余白の **保存側**。描かない — 先頭段落に通常のブロック余白として描くと、
 * 同じ余白が二重になる。HTML からは、先頭の段落に限って親の `li` が書いた専用変数を読み戻す
 * (payload を持たない貼り付け: 切り取り・別の編集面からのコピー。継続行は項目の値を持たない)。
 */
export const LIST_ITEM_LEADING_SPACE_AFTER_ATTRIBUTE = {
  default: null,
  keepOnSplit: false,
  parseHTML: (element: HTMLElement) => {
    const item = element.parentElement;
    return item?.tagName === "LI" && item.firstElementChild === element
      ? blockSpaceAfterFromStyleValue(item.style.getPropertyValue(LIST_ITEM_SPACE_AFTER_CSS_VARIABLE))
      : null;
  },
  renderHTML: () => ({}),
};
