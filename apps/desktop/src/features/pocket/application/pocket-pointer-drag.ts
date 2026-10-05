import { beginPocketDrag } from "./pocket-drag";
import { setPocketDragState } from "./pocket-drag-state";

/** ポインタをこれだけ動かしたらドラッグとみなす。クリックの手ぶれでは始めない。 */
const DRAG_THRESHOLD_PX = 5;
/** ドラッグ中だけ <html> に付ける印。全体のカーソルを「掴んでいる」にするのに使う。 */
export const POCKET_DRAGGING_ATTRIBUTE = "data-pocket-dragging";

export type PocketDragOutcome = "dropped" | "cancelled";

export interface PocketPointerDragCallbacks {
  /** しきい値を超えて、ドラッグが始まったとき。 */
  onStart: () => void;
  /** ドロップが受け入れられたか (dropped)、取り消された・受けない場所だった (cancelled)。 */
  onEnd: (outcome: PocketDragOutcome) => void;
}

let cancelActiveDrag: (() => void) | null = null;
let suppressClick = false;

/**
 * ドラッグで終わった押下のあとに来る click かどうか。ドラッグの終わりをチップの上で離すと、
 * ブラウザはそのまま click を送る。挿入が二重に走らないよう、チップ側が一度だけ読み捨てる。
 */
export function consumePocketDragClick(): boolean {
  const wasDrag = suppressClick;
  suppressClick = false;
  return wasDrag;
}

function createDataTransfer(): DataTransfer | null {
  try {
    return new DataTransfer();
  } catch {
    return null;
  }
}

function createDragEvent(
  type: "dragover" | "dragleave" | "drop",
  dataTransfer: DataTransfer,
  clientX: number,
  clientY: number,
  relatedTarget: Element | null = null,
): DragEvent | null {
  try {
    return new DragEvent(type, { bubbles: true, cancelable: true, clientX, clientY, dataTransfer, relatedTarget });
  } catch {
    return null;
  }
}

/**
 * チップの押下から始まる、ポインタでのドラッグ。
 *
 * ブラウザ標準のドラッグ (`draggable`) は使わない: ポケットは「押しても本文のキャレットと選択を
 * 動かさない」ために mousedown の既定動作を止めており、止めるとブラウザはドラッグを始めない。
 * かといって既定動作を許すと焦点が本文から外れ、クリックでの挿入が壊れる。そこで押下はそのままに、
 * ポインタの動きから自前でドラッグを組み立てる。
 *
 * 指している場所へは、標準のドラッグと同じ `dragover` / `drop` を合成して送る。紙面は
 * それを受けて座標を変換し、ドロップを処理する (外から運ばれたファイルと同じ受け口)。
 * 受けた場所は `dragover` を preventDefault するので、それでゴーストの受け入れ表示を決める。
 */
export function startPocketPointerDrag(
  id: string,
  start: { clientX: number; clientY: number },
  callbacks: PocketPointerDragCallbacks,
): void {
  cancelActiveDrag?.();
  const dataTransfer = createDataTransfer();
  if (!dataTransfer) {
    return;
  }
  beginPocketDrag(dataTransfer, id);

  let active = false;
  let lastTarget: Element | null = null;

  const targetAt = (x: number, y: number): Element | null => document.elementFromPoint(x, y);

  const leave = (next: Element | null) => {
    if (lastTarget && lastTarget !== next) {
      const event = createDragEvent("dragleave", dataTransfer, 0, 0, next);
      if (event) {
        lastTarget.dispatchEvent(event);
      }
    }
  };

  const finish = (outcome: PocketDragOutcome | null) => {
    window.removeEventListener("pointermove", handleMove, true);
    window.removeEventListener("pointerup", handleUp, true);
    window.removeEventListener("pointercancel", handleCancel, true);
    window.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("blur", handleCancel);
    cancelActiveDrag = null;
    if (!active) {
      return;
    }
    document.documentElement.removeAttribute(POCKET_DRAGGING_ATTRIBUTE);
    setPocketDragState(null);
    if (outcome) {
      callbacks.onEnd(outcome);
    }
  };

  const abort = () => {
    leave(null);
    lastTarget = null;
    finish("cancelled");
  };

  function handleMove(event: PointerEvent): void {
    if (!active) {
      if (Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < DRAG_THRESHOLD_PX) {
        return;
      }
      active = true;
      document.documentElement.setAttribute(POCKET_DRAGGING_ATTRIBUTE, "");
      callbacks.onStart();
    }
    const target = targetAt(event.clientX, event.clientY);
    leave(target);
    let accepted = false;
    if (target) {
      const over = createDragEvent("dragover", dataTransfer!, event.clientX, event.clientY);
      if (over) {
        target.dispatchEvent(over);
        accepted = over.defaultPrevented;
      }
    }
    lastTarget = target;
    setPocketDragState({ id, x: event.clientX, y: event.clientY, accepted });
  }

  function handleUp(event: PointerEvent): void {
    if (!active) {
      finish(null);
      return;
    }
    // ドラッグの終わりをチップの上で離すと click が続く。それは挿入として扱わない。
    suppressClick = true;
    window.setTimeout(() => {
      suppressClick = false;
    }, 0);
    const target = targetAt(event.clientX, event.clientY);
    let accepted = false;
    if (target) {
      const drop = createDragEvent("drop", dataTransfer!, event.clientX, event.clientY);
      if (drop) {
        target.dispatchEvent(drop);
        accepted = drop.defaultPrevented;
      }
    }
    lastTarget = null;
    finish(accepted ? "dropped" : "cancelled");
  }

  function handleCancel(): void {
    if (!active) {
      finish(null);
      return;
    }
    abort();
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && active) {
      event.preventDefault();
      event.stopPropagation();
      abort();
    }
  }

  window.addEventListener("pointermove", handleMove, true);
  window.addEventListener("pointerup", handleUp, true);
  window.addEventListener("pointercancel", handleCancel, true);
  window.addEventListener("keydown", handleKeyDown, true);
  window.addEventListener("blur", handleCancel);
  cancelActiveDrag = handleCancel;
}
