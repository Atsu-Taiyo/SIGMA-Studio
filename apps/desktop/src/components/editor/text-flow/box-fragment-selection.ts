import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { CaretAddress } from "@/features/text-editing";

import {
  getCaretSurface,
  getCaretSurfacesForBox,
  subscribeCaretSurfaceUnregister,
  type CaretSurfaceHandle,
} from "./caret-router";
import { posAtClientPoint } from "./pos-at-client-point";

/** 断片跨ぎ選択が面に求めるもの。面そのものは `caret-router` が持つ。 */
type BoxFragmentSelectionHandle = CaretSurfaceHandle;

interface ActiveBoxFragmentSelection {
  anchor: CaretAddress;
  boxId: string;
  head: CaretAddress;
}

const listeners = new Set<() => void>();
let activeSelection: ActiveBoxFragmentSelection | null = null;

subscribeCaretSurfaceUnregister((handle) => {
  if (activeSelection && handle.boxIds.includes(activeSelection.boxId)) {
    clearBoxFragmentSelection();
  }
});

export function subscribeBoxFragmentSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearBoxFragmentSelection(): void {
  if (!activeSelection) {
    return;
  }
  const boxId = activeSelection.boxId;
  activeSelection = null;
  for (const handle of boxHandles(boxId)) {
    handle.editor.view.dom.removeAttribute("data-box-fragment-span");
  }
  listeners.forEach((listener) => listener());
}

export function clearBoxFragmentSelectionOnOutsideFocus(editor: Editor): void {
  if (activeSelection && !getCaretSurface(editor)?.boxIds.includes(activeSelection.boxId)) {
    clearBoxFragmentSelection();
  }
}

export function startBoxFragmentPointerSelection(
  event: ReactMouseEvent<HTMLElement>,
  editor: Editor,
): boolean {
  if (event.button !== 0 || event.defaultPrevented || event.target instanceof Element === false) {
    return false;
  }
  const boxId = getFragmentedBoxId(event.target);
  const participants = boxId ? boxHandles(boxId) : [];
  const startHandle = getCaretSurface(editor);
  if (!boxId || !startHandle || participants.length <= 1) {
    return false;
  }
  const startPosition = positionAtPoint(startHandle, event.clientX, event.clientY);
  const anchor = startPosition === null ? null : startHandle.addressAt(startPosition);
  if (!anchor) {
    return false;
  }

  event.preventDefault();
  editor.view.focus();
  applySelection(boxId, anchor, anchor, startHandle);
  const origin = { x: event.clientX, y: event.clientY };
  const ownerWindow = editor.view.dom.ownerDocument.defaultView ?? window;

  const update = (clientX: number, clientY: number) => {
    const target = handleAtPoint(participants, boxId, clientX, clientY) ?? startHandle;
    const position = positionAtPoint(target, clientX, clientY);
    const head = position === null ? null : target.addressAt(position);
    if (head) {
      applySelection(boxId, anchor, head, startHandle);
    }
  };
  const onMouseMove = (moveEvent: MouseEvent) => {
    if (Math.abs(moveEvent.clientX - origin.x) > 2 || Math.abs(moveEvent.clientY - origin.y) > 2) {
      moveEvent.preventDefault();
      update(moveEvent.clientX, moveEvent.clientY);
    }
  };
  const onMouseUp = (upEvent: MouseEvent) => {
    update(upEvent.clientX, upEvent.clientY);
    ownerWindow.removeEventListener("mousemove", onMouseMove);
  };
  ownerWindow.addEventListener("mousemove", onMouseMove);
  ownerWindow.addEventListener("mouseup", onMouseUp, { once: true });
  return true;
}

export function getBoxFragmentSelectionRanges(): Range[] {
  if (!activeSelection) {
    return [];
  }
  const ranges: Range[] = [];
  for (const handle of boxHandles(activeSelection.boxId)) {
    const anchor = handle.posFor(activeSelection.anchor);
    const head = handle.posFor(activeSelection.head);
    if (anchor === null || head === null || anchor === head) {
      continue;
    }
    try {
      const from = handle.editor.view.domAtPos(Math.min(anchor, head));
      const to = handle.editor.view.domAtPos(Math.max(anchor, head));
      const range = handle.editor.view.dom.ownerDocument.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      ranges.push(range);
    } catch {
      // A replica may be lazily unmounted while scrolling; the remaining visible
      // replicas still paint the logical selection.
    }
  }
  return ranges;
}

function applySelection(
  boxId: string,
  anchorPoint: CaretAddress,
  headPoint: CaretAddress,
  focused: BoxFragmentSelectionHandle,
): void {
  if (anchorPoint.blockId === headPoint.blockId && anchorPoint.offset === headPoint.offset) {
    const position = focused.posFor(anchorPoint);
    if (position !== null) {
      try {
        const selection = TextSelection.near(focused.editor.state.doc.resolve(position), 1);
        focused.editor.view.dispatch(focused.editor.state.tr.setSelection(selection));
        if (!focused.editor.view.hasFocus()) {
          focused.editor.view.focus();
        }
      } catch {
        // A pagination commit may replace this replica between down and up.
      }
    }
    clearBoxFragmentSelection();
    return;
  }
  activeSelection = { anchor: anchorPoint, boxId, head: headPoint };
  for (const handle of boxHandles(boxId)) {
    const anchor = handle.posFor(anchorPoint);
    const head = handle.posFor(headPoint);
    if (anchor === null || head === null) {
      continue;
    }
    try {
      const selection = TextSelection.between(
        handle.editor.state.doc.resolve(anchor),
        handle.editor.state.doc.resolve(head),
      );
      if (!selection.eq(handle.editor.state.selection)) {
        handle.editor.view.dispatch(handle.editor.state.tr.setSelection(selection));
      }
      handle.editor.view.dom.toggleAttribute("data-box-fragment-span", !selection.empty);
    } catch {
      // Ignore a stale replica during a pagination re-render.
    }
  }
  if (!focused.editor.view.hasFocus()) {
    focused.editor.view.focus();
  }
  listeners.forEach((listener) => listener());
}

function boxHandles(boxId: string): BoxFragmentSelectionHandle[] {
  return getCaretSurfacesForBox(boxId);
}

function getFragmentedBoxId(target: Element): string | null {
  return target.closest<HTMLElement>("[data-box-fragment-source-id]")?.dataset.boxFragmentSourceId
    ?? target.closest<HTMLElement>(".editor-box-fragment-viewport[data-box-source-id]")?.dataset.boxSourceId
    ?? null;
}

function handleAtPoint(
  participants: readonly BoxFragmentSelectionHandle[],
  boxId: string,
  x: number,
  y: number,
): BoxFragmentSelectionHandle | null {
  let nearest: { distance: number; handle: BoxFragmentSelectionHandle } | null = null;
  for (const handle of participants) {
    const rect = visibleBoxRect(handle, boxId);
    if (!rect) {
      continue;
    }
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return handle;
    }
    const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    if (!nearest || distance < nearest.distance) {
      nearest = { distance, handle };
    }
  }
  return nearest?.handle ?? null;
}

function visibleBoxRect(
  handle: BoxFragmentSelectionHandle,
  boxId: string,
): { bottom: number; left: number; right: number; top: number } | null {
  const viewport = handle.editor.view.dom.closest<HTMLElement>(
    `.editor-box-fragment-viewport[data-box-source-id="${CSS.escape(boxId)}"]`,
  );
  if (viewport) {
    return viewport.getBoundingClientRect();
  }
  const source = handle.editor.view.dom.querySelector<HTMLElement>(
    `[data-box-fragment-source-id="${CSS.escape(boxId)}"]`,
  );
  if (!source) {
    return null;
  }
  const rect = source.getBoundingClientRect();
  const visibleHeight = Number.parseFloat(
    getComputedStyle(source).getPropertyValue("--text-flow-box-fragment-visible-height"),
  );
  if (!Number.isFinite(visibleHeight)) {
    return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
  }
  // 可視高さはズーム前の canvas px、矩形は client px。実寸との比で倍率を取る
  // (`clip-path` は `offsetHeight` を変えないので、比は純粋な表示倍率になる)。
  const scale = source.offsetHeight > 0 ? rect.height / source.offsetHeight : 1;
  const zoomScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    top: rect.top,
    right: rect.right,
    bottom: Math.min(rect.bottom, rect.top + Math.max(0, visibleHeight) * zoomScale),
    left: rect.left,
  };
}

function positionAtPoint(handle: BoxFragmentSelectionHandle, x: number, y: number): number | null {
  return posAtClientPoint(handle.editor.view, x, y);
}
