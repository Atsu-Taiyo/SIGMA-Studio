import type { EditorView } from "@tiptap/pm/view";

/**
 * 編集面の描かれた範囲を、最上位ブロックごとの矩形の並びで返す。
 *
 * 最上位ブロックはページ・段へ相対配置でずらして描かれる。編集面の root の矩形は自然配置の
 * 位置のままなので、2 ページ目以降の本文はその外に描かれる。ポインタがどの編集面の上か・
 * どちらの余白かは、root ではなくこの並びで判定する。
 */
export function getEditorVisualRects(view: EditorView): DOMRect[] {
  const rects: DOMRect[] = [];
  for (const child of Array.from(view.dom.children)) {
    const rect = child.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) rects.push(rect);
  }
  if (rects.length === 0) rects.push(view.dom.getBoundingClientRect());
  return rects;
}

/** 描かれた範囲のうち、縦位置 `y` を含む矩形。無ければ null。 */
export function getEditorVisualRectAtY(view: EditorView, y: number): DOMRect | null {
  return getEditorVisualRects(view).find((rect) => y >= rect.top && y <= rect.bottom) ?? null;
}

/** 点が描かれた範囲のどれかの中にあるか。 */
export function isPointInEditorVisualRects(view: EditorView, x: number, y: number): boolean {
  return getEditorVisualRects(view).some((rect) => (
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  ));
}
