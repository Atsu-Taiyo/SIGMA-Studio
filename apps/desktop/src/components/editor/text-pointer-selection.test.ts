// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import type { MouseEvent as ReactMouseEvent } from "react";
import { startExpandedTextSelection } from "./expanded-text-selection";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finishTextPointerSelection, isTextPointerSelectionClick, registerTextPointerSelectionCommit } from "./text-pointer-selection";

vi.mock("./text-flow/pos-at-client-point", () => ({
  posAtClientPoint: (...args: unknown[]) => Number(args[1]),
}));

const root = document.createElement("div");
const editor = { view: { dom: root } } as unknown as Editor;
const mouse = (type: string, x = 200) => new MouseEvent(type, { bubbles: true, detail: 1, clientX: x, clientY: 100 });
function ignored(event: MouseEvent): boolean {
  let result = false;
  root.addEventListener("click", e => { result = isTextPointerSelectionClick(e); }, { once: true });
  root.dispatchEvent(event);
  return result;
}
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); });

describe("body text drag completion", () => {
  it("re-publishes selection and ignores only the following click at all ancestors", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const dispose = registerTextPointerSelectionCommit(editor, commit);
    finishTextPointerSelection(editor, mouse("mouseup"));
    expect(commit).toHaveBeenCalledOnce();
    const click = mouse("click");
    expect(ignored(click)).toBe(true);
    expect(isTextPointerSelectionClick(click)).toBe(true);
    expect(ignored(mouse("click"))).toBe(false);
    dispose();
  });
  it("expires without a click and does not swallow a later margin click", () => {
    vi.useFakeTimers();
    finishTextPointerSelection(editor, mouse("mouseup"));
    vi.runAllTimers();
    expect(ignored(mouse("click"))).toBe(false);
  });
  it("clears at the next mousedown even before its timer runs", () => {
    vi.useFakeTimers();
    finishTextPointerSelection(editor, mouse("mouseup"));
    document.dispatchEvent(mouse("mousedown"));
    expect(ignored(mouse("click"))).toBe(false);
  });
  it("leaves normal clicks, keyboard activation, and unrelated locations alone", () => {
    vi.useFakeTimers();
    expect(ignored(mouse("click"))).toBe(false);
    finishTextPointerSelection(editor, mouse("mouseup"));
    expect(ignored(mouse("click", 300))).toBe(false);
    finishTextPointerSelection(editor, mouse("mouseup"));
    expect(ignored(new MouseEvent("click", { detail: 0 }))).toBe(false);
  });
});

it.each([false, true])("only commits and guards an expanded selection after actual movement: %s", (drag) => {
  vi.useFakeTimers();
  const commands = { focus: vi.fn(), setTextSelection: vi.fn() };
  const textEditor = { view: { dom: root }, commands, isDestroyed: false } as unknown as Editor;
  const commit = vi.fn();
  const dispose = registerTextPointerSelectionCommit(textEditor, commit);
  root.addEventListener("mousedown", event => {
    expect(startExpandedTextSelection(event as unknown as ReactMouseEvent<HTMLElement>, textEditor)).toBe(true);
  }, { once: true });
  root.dispatchEvent(mouse("mousedown"));
  if (drag) window.dispatchEvent(mouse("mousemove", 210));
  window.dispatchEvent(mouse("mouseup", drag ? 210 : 200));
  expect(commit).toHaveBeenCalledTimes(drag ? 1 : 0);
  expect(ignored(mouse("click", drag ? 210 : 200))).toBe(drag);
  dispose();
});
