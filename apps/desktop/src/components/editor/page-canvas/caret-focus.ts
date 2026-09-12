export type ClientPoint = {
  x: number;
  y: number;
};

export type OverlayPreviewPointerHandoff = {
  pointerId: number;
  pointerType: string;
  start: ClientPoint;
  latest: ClientPoint;
  cleanup: () => void;
};

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

export function focusUnderlyingEditorAtPoint(point: ClientPoint) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const target = window.document.elementFromPoint(point.x, point.y);
      if (!(target instanceof Element)) {
        return;
      }

      const editable = getEditableElement(target);
      if (!editable) {
        return;
      }

      dispatchPointerEvent(target, "pointerdown", point);
      dispatchMouseEvent(target, "mousedown", point);
      focusEditableElement(editable, point);
      dispatchPointerEvent(target, "pointerup", point);
      dispatchMouseEvent(target, "mouseup", point);
      dispatchMouseEvent(target, "click", point);
    });
  });
}

/**
 * その位置の下にある編集可能要素。`elementFromPoint` と違って重なりの全段を見るので、
 * 図形モード (オーバーレイが `pointer-events: auto` で本文の上に乗っている状態) からでも
 * 「そこに本文があるか」を確かめられる。オーバーレイ自身のテキスト図形は本文ではないので除く。
 */
export function findEditableElementUnderPoint(point: ClientPoint): HTMLElement | HTMLInputElement | HTMLTextAreaElement | null {
  const stack = window.document.elementsFromPoint(point.x, point.y);
  for (const element of stack) {
    const editable = getEditableElement(element);
    if (editable && !editable.closest(".overlay-canvas-bleed-surface")) {
      return editable;
    }
  }

  return null;
}

/**
 * 図形モードのマーキーが図形を1つも掴まなかったとき、そのドラッグを本文の範囲選択として
 * 引き継ぐ。本文モードへ戻る再描画を挟むので、`focusUnderlyingEditorAtPoint` と同じく
 * 2フレーム待ってから測る。
 */
export function selectUnderlyingEditorRange(start: ClientPoint, end: ClientPoint) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const editable = findEditableElementUnderPoint(start);
      if (!editable || editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
        return;
      }

      const startRange = getCaretRangeAtPoint(start, editable);
      if (!startRange) {
        return;
      }

      // 終点が別のエディタ (別の問題エリアなど) に落ちた場合は範囲を張れない。
      // 掴めた分だけ — 始点のキャレット — を本文へ渡す。
      const endRange = getCaretRangeAtPoint(end, editable) ?? startRange;
      editable.focus({ preventScroll: true });
      const selection = window.getSelection();
      if (!selection) {
        return;
      }

      selection.removeAllRanges();
      selection.setBaseAndExtent(
        startRange.startContainer,
        startRange.startOffset,
        endRange.startContainer,
        endRange.startOffset,
      );
    });
  });
}

export function getEditableElement(target: Element): HTMLElement | HTMLInputElement | HTMLTextAreaElement | null {
  const editable = target.closest("[contenteditable='true'], input, textarea");

  if (
    editable instanceof HTMLInputElement ||
    editable instanceof HTMLTextAreaElement ||
    editable instanceof HTMLElement && editable.isContentEditable
  ) {
    return editable;
  }

  return null;
}

function focusEditableElement(editable: HTMLElement | HTMLInputElement | HTMLTextAreaElement, point: ClientPoint) {
  editable.focus({ preventScroll: true });

  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    const position = getTextControlCaretOffsetAtPoint(editable, point);
    editable.setSelectionRange(position, position);
    return;
  }

  placeContentEditableCaretAtPoint(editable, point);
}

export function getTextControlCaretOffsetAtPoint(
  editable: HTMLInputElement | HTMLTextAreaElement,
  point: ClientPoint,
): number {
  const doc = editable.ownerDocument;
  const rect = editable.getBoundingClientRect();
  const computed = window.getComputedStyle(editable);
  const mirror = doc.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  Object.assign(mirror.style, {
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    boxSizing: computed.boxSizing,
    left: `${rect.left - editable.scrollLeft}px`,
    top: `${rect.top - editable.scrollTop}px`,
    width: `${rect.width}px`,
    minHeight: `${rect.height}px`,
    margin: "0",
    borderTop: computed.borderTop,
    borderRight: computed.borderRight,
    borderBottom: computed.borderBottom,
    borderLeft: computed.borderLeft,
    padding: computed.padding,
    font: computed.font,
    fontKerning: computed.fontKerning,
    fontSizeAdjust: computed.fontSizeAdjust,
    letterSpacing: computed.letterSpacing,
    lineHeight: computed.lineHeight,
    textAlign: computed.textAlign,
    textIndent: computed.textIndent,
    textTransform: computed.textTransform,
    tabSize: computed.tabSize,
    whiteSpace: editable instanceof HTMLTextAreaElement ? "pre-wrap" : "pre",
    overflowWrap: editable instanceof HTMLTextAreaElement ? "break-word" : "normal",
  });

  const markers: HTMLSpanElement[] = [];
  for (let offset = 0; offset <= editable.value.length; offset += 1) {
    const marker = doc.createElement("span");
    marker.textContent = "\u200b";
    marker.dataset.caretOffset = String(offset);
    mirror.append(marker);
    markers.push(marker);
    if (offset < editable.value.length) {
      mirror.append(doc.createTextNode(editable.value[offset] ?? ""));
    }
  }

  doc.body.append(mirror);
  let closestOffset = editable.value.length;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const marker of markers) {
    const markerRect = marker.getBoundingClientRect();
    const dx = point.x - markerRect.left;
    const dy = point.y - (markerRect.top + markerRect.height / 2);
    const distance = dx * dx + dy * dy * 4;
    if (distance < closestDistance) {
      closestDistance = distance;
      closestOffset = Number(marker.dataset.caretOffset);
    }
  }
  mirror.remove();
  return closestOffset;
}

export function placeContentEditableCaretAtPoint(editable: HTMLElement, point: ClientPoint) {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = getCaretRangeAtPoint(point, editable);
  if (!range) {
    return;
  }

  selection.removeAllRanges();
  selection.addRange(range);
}

export function getCaretRangeAtPoint(point: ClientPoint, editable: HTMLElement): Range | null {
  const doc = window.document as CaretDocument;

  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(point.x, point.y);
    if (position && editable.contains(position.offsetNode)) {
      const range = doc.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
      return range;
    }
  }

  const range = doc.caretRangeFromPoint?.(point.x, point.y) ?? null;
  return range && editable.contains(range.startContainer) ? range : null;
}

export function dispatchPointerEvent(target: Element, type: "pointerdown" | "pointerup", point: ClientPoint) {
  if (typeof window.PointerEvent !== "function") {
    return;
  }

  target.dispatchEvent(new window.PointerEvent(type, {
    bubbles: true,
    button: 0,
    buttons: type === "pointerdown" ? 1 : 0,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
    composed: true,
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse",
  }));
}

export function dispatchMouseEvent(target: Element, type: "mousedown" | "mouseup" | "click", point: ClientPoint) {
  target.dispatchEvent(new window.MouseEvent(type, {
    bubbles: true,
    button: 0,
    buttons: type === "mousedown" ? 1 : 0,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
    composed: true,
  }));
}
