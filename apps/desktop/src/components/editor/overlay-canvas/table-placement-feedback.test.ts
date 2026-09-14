// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getTablePlacementBounds } from "@/features/drawing";
import { beginTablePlacementFeedback, bindTablePlacementFeedback, cancelTablePlacementFeedback,
  finishTablePlacementFeedback } from "./table-placement-feedback";

let frames: FrameRequestCallback[];
let canvas: HTMLDivElement;
const paint = () => { const pending = frames; frames = []; pending.forEach((callback) => callback(0)); };
const gesture = () => {
  canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 20, clientY: 30 }));
  canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 320, clientY: 210 }));
};
beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  canvas = document.createElement("div"); canvas.className = "page-canvas"; document.body.append(canvas);
});
afterEach(() => { cancelTablePlacementFeedback(); canvas.remove(); vi.unstubAllGlobals(); });

it("shows feedback synchronously and keeps an early gesture until the editor can commit it exactly once", () => {
  const activate = vi.fn(); const commit = vi.fn();
  beginTablePlacementFeedback(1, "ドラッグで行・列を増やす", vi.fn(), activate);
  expect(document.querySelector("[data-table-placement-preview]")).not.toBeNull();
  expect(activate).not.toHaveBeenCalled();
  gesture();
  expect(document.querySelector("[data-table-placement-pending]")).not.toBeNull();
  const binding = { bounds: (start: {x:number;y:number}, end: {x:number;y:number}) => getTablePlacementBounds(start, end, {w:64,h:36}),
    commit, cancel: vi.fn(), freeze: vi.fn() };
  bindTablePlacementFeedback(1, binding);
  bindTablePlacementFeedback(1, binding);
  paint(); expect(commit).not.toHaveBeenCalled();
  paint();
  expect(activate).toHaveBeenCalledTimes(1);
  expect(commit).toHaveBeenCalledExactlyOnceWith({ x: 20, y: 30 }, expect.objectContaining({ x: 320, y: 210 }));
  expect(document.querySelector("[data-table-placement-pending]")).not.toBeNull();
  finishTablePlacementFeedback();
  expect(document.querySelector("[data-table-placement-feedback]")).toBeNull();
});

it("cancels queued activation and insertion without leaving a phantom table", () => {
  const activate = vi.fn(); const commit = vi.fn(); const cancelRequest = vi.fn();
  beginTablePlacementFeedback(1, "hint", cancelRequest, activate);
  gesture();
  bindTablePlacementFeedback(1, { bounds: (start, end) => getTablePlacementBounds(start, end, {w:64,h:36}),
    commit, cancel: vi.fn(), freeze: vi.fn() });
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  paint(); paint();
  expect(activate).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  expect(cancelRequest).toHaveBeenCalledTimes(1);
  expect(document.querySelector("[data-table-placement-feedback]")).toBeNull();
});
