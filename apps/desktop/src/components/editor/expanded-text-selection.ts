import type { Editor } from "@tiptap/core";
import type { MouseEvent as ReactMouseEvent } from "react";

import { posAtClientPoint } from "@/components/editor/text-flow/pos-at-client-point";

const CONTENT_EDITABLE_SELECTOR = "[contenteditable='true']";
const DIRECT_CONTROL_SELECTOR = "input, textarea, select, button, math-field";
const DRAG_SELECTION_THRESHOLD_PX = 2;

interface ClientPoint {
  x: number;
  y: number;
}

export function startExpandedTextSelection(event: ReactMouseEvent<HTMLElement>, editor: Editor | null): boolean {
  if (!editor || editor.isDestroyed || event.button !== 0 || event.detail > 1 || event.defaultPrevented) {
    return false;
  }

  if (!(event.target instanceof Element) || event.target.closest(DIRECT_CONTROL_SELECTOR)) {
    return false;
  }

  const startPoint = { x: event.clientX, y: event.clientY };
  const side = getEditorSideAtClientPoint(editor, startPoint);
  if (side === null && event.target.closest(CONTENT_EDITABLE_SELECTOR)) {
    return false;
  }

  let anchor = side === null ? getPosAtClientPoint(editor, event.clientX, event.clientY) : null;
  if (anchor === null) {
    const rect = editor.view.dom.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || side === null) {
      return false;
    }
  }

  event.preventDefault();
  const ownerWindow = editor.view.dom.ownerDocument.defaultView ?? window;
  if (anchor !== null) {
    editor.commands.focus();
    editor.commands.setTextSelection(anchor);
  } else {
    ownerWindow.getSelection()?.removeAllRanges();
  }

  const updateSelection = (clientX: number, clientY: number) => {
    if (anchor === null) {
      const edgePosition = getSideEdgePosition(editor, side, clientY);
      if (edgePosition === null) {
        return;
      }

      if (isPointInsideRect({ x: clientX, y: clientY }, editor.view.dom.getBoundingClientRect())) {
        anchor = edgePosition;
        editor.commands.focus();
      } else {
        editor.commands.setTextSelection(edgePosition);
        return;
      }
    }

    const head = getPosAtClientPoint(editor, clientX, clientY);
    if (head === null) {
      return;
    }

    editor.commands.setTextSelection({ from: anchor, to: head });
  };

  let dragging = false;
  const handleMouseMove = (moveEvent: MouseEvent) => {
    dragging ||=
      Math.abs(moveEvent.clientX - startPoint.x) > DRAG_SELECTION_THRESHOLD_PX ||
      Math.abs(moveEvent.clientY - startPoint.y) > DRAG_SELECTION_THRESHOLD_PX;

    if (!dragging) {
      return;
    }

    moveEvent.preventDefault();
    updateSelection(moveEvent.clientX, moveEvent.clientY);
  };

  const handleMouseUp = (upEvent: MouseEvent) => {
    if (
      dragging ||
      Math.abs(upEvent.clientX - startPoint.x) > DRAG_SELECTION_THRESHOLD_PX ||
      Math.abs(upEvent.clientY - startPoint.y) > DRAG_SELECTION_THRESHOLD_PX
    ) {
      updateSelection(upEvent.clientX, upEvent.clientY);
    }
    ownerWindow.removeEventListener("mousemove", handleMouseMove);
  };

  ownerWindow.addEventListener("mousemove", handleMouseMove);
  ownerWindow.addEventListener("mouseup", handleMouseUp, { once: true });
  return true;
}

export function getEditorSideAtClientPoint(editor: Editor, point: ClientPoint): "left" | "right" | null {
  const rect = editor.view.dom.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || point.y < rect.top || point.y > rect.bottom) {
    return null;
  }

  if (point.x < rect.left) {
    return "left";
  }

  if (point.x > rect.right) {
    return "right";
  }

  return null;
}

function getSideEdgePosition(editor: Editor, side: "left" | "right" | null, clientY: number): number | null {
  if (side === null) {
    return null;
  }

  const rect = editor.view.dom.getBoundingClientRect();
  const edgeX = side === "left" ? rect.left + 1 : rect.right - 1;
  return getPosAtClientPoint(editor, edgeX, clientY);
}

function getPosAtClientPoint(editor: Editor, clientX: number, clientY: number): number | null {
  return posAtClientPoint(editor.view, clientX, clientY);
}

function isPointInsideRect(point: ClientPoint, rect: DOMRect): boolean {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}
