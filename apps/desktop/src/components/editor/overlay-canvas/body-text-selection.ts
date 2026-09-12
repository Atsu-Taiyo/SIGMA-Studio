/**
 * いま本文にある**範囲**選択。キャレット (collapsed) とオーバーレイ側の range は対象外。
 *
 * 混在選択 (本文の範囲 + 図形) は「本文側が生きていること」が前提で、Cmd+C はその両方を
 * 1 つの payload にまとめる。図形へキーボードを渡すときに範囲を捨てるかどうかの判定
 * (`focusOverlaySurface`) と、その範囲を描き直す帯 (`HeldBodySelectionOverlay`) が、
 * どちらもここを唯一の出典にする。
 */
export function getBodyTextRangeSelection(ownerDocument: Document): Range | null {
  const selection = ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const container = selection.getRangeAt(0).commonAncestorContainer;
  const element = container instanceof Element ? container : container.parentElement;
  const isBodyText = Boolean(
    element?.closest(".text-flow-editor") && !element.closest(".overlay-canvas-bleed-surface"),
  );
  return isBodyText ? selection.getRangeAt(0).cloneRange() : null;
}
