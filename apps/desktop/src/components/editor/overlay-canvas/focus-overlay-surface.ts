import { getBodyTextRangeSelection } from "./body-text-selection";

/** Move keyboard ownership from body text editing to the overlay canvas. */
export function focusOverlaySurface(surface: HTMLElement | null): void {
  if (!surface) {
    return;
  }

  const ownerDocument = surface.ownerDocument;
  const activeElement = ownerDocument.activeElement;
  if (
    activeElement instanceof HTMLElement &&
    activeElement.classList.contains("ProseMirror") &&
    !activeElement.closest(".overlay-canvas-bleed-surface")
  ) {
    activeElement.blur();
  }

  // 本文の**範囲**選択だけは残す — 図形と一緒に選ばれている「混在選択」の片側だから。
  // キーボードの持ち主を移すのは上の blur とフォーカス移動が済ませているので、範囲を
  // 残しても Delete の行き先は変わらない。捨てると、本文をドラッグ選択してから図形を
  // 選んだ瞬間に本文側が消えて Cmd+C が図形だけになる。キャレット (collapsed) は残しても
  // 「まだ本文を編集中」に見えるだけなので、オーバーレイに付いた古い range と一緒に捨てる。
  if (!getBodyTextRangeSelection(ownerDocument)) {
    ownerDocument.getSelection()?.removeAllRanges();
  }

  if (ownerDocument.activeElement !== surface) {
    surface.focus({ preventScroll: true });
  }
}
