// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isPocketDrag, readPocketDragItemId } from "./pocket-drag";
import { getPocketDragState } from "./pocket-drag-state";
import {
  consumePocketDragClick,
  POCKET_DRAGGING_ATTRIBUTE,
  startPocketPointerDrag,
  type PocketDragOutcome,
} from "./pocket-pointer-drag";

/** happy-dom の DragEvent は init の `dataTransfer` を引き継がないので、持たせるだけの代わりを使う。 */
class FakeDragEvent extends Event {
  readonly dataTransfer: DataTransfer | null;
  readonly clientX: number;
  readonly clientY: number;
  readonly relatedTarget: EventTarget | null;
  constructor(type: string, init: { dataTransfer?: DataTransfer; clientX?: number; clientY?: number; relatedTarget?: EventTarget | null } & EventInit = {}) {
    super(type, init);
    this.dataTransfer = init.dataTransfer ?? null;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.relatedTarget = init.relatedTarget ?? null;
  }
}

interface Seen {
  type: string;
  target: Element;
  id: string | null;
  isPocket: boolean;
  related: EventTarget | null;
  x: number;
  y: number;
}

function pointer(type: "pointermove" | "pointerup" | "pointercancel", x: number, y: number): void {
  window.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true }));
}

describe("pocket pointer drag", () => {
  let zones: Array<{ element: HTMLElement; accepts: boolean }>;
  let seen: Seen[];
  let at: HTMLElement | null;
  let outcomes: Array<PocketDragOutcome | "start">;

  function addZone(accepts: boolean): HTMLElement {
    const element = document.body.appendChild(document.createElement("div"));
    for (const type of ["dragover", "drop", "dragleave"]) {
      element.addEventListener(type, (event) => {
        const drag = event as unknown as FakeDragEvent;
        seen.push({
          type,
          target: element,
          id: drag.dataTransfer ? readPocketDragItemId(drag.dataTransfer) : null,
          isPocket: isPocketDrag(drag.dataTransfer),
          related: drag.relatedTarget,
          x: drag.clientX,
          y: drag.clientY,
        });
        if (accepts && type !== "dragleave") event.preventDefault();
      });
    }
    zones.push({ element, accepts });
    return element;
  }

  function begin(): void {
    startPocketPointerDrag("pocket_1", { clientX: 100, clientY: 100 }, {
      onStart: () => outcomes.push("start"),
      onEnd: (outcome) => outcomes.push(outcome),
    });
  }

  beforeEach(() => {
    vi.stubGlobal("DragEvent", FakeDragEvent);
    zones = [];
    seen = [];
    outcomes = [];
    at = null;
    document.body.innerHTML = "";
    document.elementFromPoint = vi.fn(() => at);
  });

  afterEach(() => {
    // 途中で終わったドラッグが次のテストへ残らないように、取り消す。
    pointer("pointercancel", 0, 0);
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("is a plain click, with no drag events, until the pointer has moved a few pixels", () => {
    const zone = addZone(true);
    at = zone;
    begin();

    pointer("pointermove", 102, 101);
    pointer("pointerup", 102, 101);

    expect(seen).toEqual([]);
    expect(outcomes).toEqual([]);
    expect(document.documentElement.hasAttribute(POCKET_DRAGGING_ATTRIBUTE)).toBe(false);
    expect(consumePocketDragClick()).toBe(false);
  });

  it("starts once past the threshold and tells the page what is being dragged", () => {
    const zone = addZone(true);
    at = zone;
    begin();

    pointer("pointermove", 140, 130);

    expect(outcomes).toEqual(["start"]);
    expect(document.documentElement.hasAttribute(POCKET_DRAGGING_ATTRIBUTE)).toBe(true);
    // 標準のドラッグと同じ dragover を、指している場所へ送る。運ぶのは項目の ID だけ。
    expect(seen).toEqual([{ type: "dragover", target: zone, id: "pocket_1", isPocket: true, related: null, x: 140, y: 130 }]);
    expect(getPocketDragState()).toEqual({ id: "pocket_1", x: 140, y: 130, accepted: true });

    pointer("pointermove", 150, 135);
    expect(outcomes).toEqual(["start"]);
  });

  it("marks a place that does not take the drop, so the ghost can say so", () => {
    at = addZone(false);
    begin();

    pointer("pointermove", 200, 200);

    expect(getPocketDragState()?.accepted).toBe(false);
  });

  it("drops where the pointer is released, and says whether the page took it", () => {
    const takes = addZone(true);
    at = takes;
    begin();
    pointer("pointermove", 300, 220);

    pointer("pointerup", 310, 230);

    expect(seen.filter((entry) => entry.type === "drop")).toEqual([
      { type: "drop", target: takes, id: "pocket_1", isPocket: true, related: null, x: 310, y: 230 },
    ]);
    expect(outcomes).toEqual(["start", "dropped"]);
    expect(document.documentElement.hasAttribute(POCKET_DRAGGING_ATTRIBUTE)).toBe(false);
    expect(getPocketDragState()).toBeNull();

    outcomes = [];
    seen = [];
    const refuses = addZone(false);
    at = refuses;
    begin();
    pointer("pointermove", 300, 220);
    pointer("pointerup", 300, 220);

    expect(outcomes).toEqual(["start", "cancelled"]);
  });

  it("swallows the click that follows a drag released over the chip, once", () => {
    at = addZone(true);
    begin();
    pointer("pointermove", 300, 220);
    pointer("pointerup", 300, 220);

    expect(consumePocketDragClick()).toBe(true);
    expect(consumePocketDragClick()).toBe(false);
  });

  it("tells the place it leaves, so the editor can hide its own drop cursor", () => {
    const first = addZone(true);
    const second = addZone(true);
    at = first;
    begin();
    pointer("pointermove", 300, 220);

    at = second;
    pointer("pointermove", 400, 220);

    expect(seen.map((entry) => `${entry.type}:${entry.target === first ? "first" : "second"}`)).toEqual([
      "dragover:first",
      "dragleave:first",
      "dragover:second",
    ]);
    expect(seen[1]?.related).toBe(second);
  });

  it("cancels on Escape without dropping anything, and lets go of the place it was over", () => {
    const zone = addZone(true);
    at = zone;
    begin();
    pointer("pointermove", 300, 220);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    pointer("pointerup", 300, 220);

    expect(seen.map((entry) => entry.type)).toEqual(["dragover", "dragleave"]);
    expect(outcomes).toEqual(["start", "cancelled"]);
    expect(consumePocketDragClick()).toBe(false);
    expect(document.documentElement.hasAttribute(POCKET_DRAGGING_ATTRIBUTE)).toBe(false);
  });

  it("cancels when the pointer is cancelled, e.g. by a system gesture", () => {
    at = addZone(true);
    begin();
    pointer("pointermove", 300, 220);

    pointer("pointercancel", 300, 220);

    expect(outcomes).toEqual(["start", "cancelled"]);
    expect(seen.some((entry) => entry.type === "drop")).toBe(false);
  });

  it("lets a new drag replace one that was left running", () => {
    at = addZone(true);
    begin();
    pointer("pointermove", 300, 220);

    begin();

    expect(outcomes).toEqual(["start", "cancelled"]);
  });

  it("does nothing when there is no element under the pointer", () => {
    at = null;
    begin();

    pointer("pointermove", 300, 220);
    pointer("pointerup", 300, 220);

    expect(seen).toEqual([]);
    expect(outcomes).toEqual(["start", "cancelled"]);
  });
});
