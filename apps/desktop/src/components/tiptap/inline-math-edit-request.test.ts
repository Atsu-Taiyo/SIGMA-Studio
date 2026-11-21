// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerEditorInputRouting } from "./editor-input-target";
import { registerInlineMathInput, requestInlineMathEdit } from "./inline-math-edit-request";

const cleanups: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  window.dispatchEvent(new PointerEvent("pointerdown"));
  cleanups.splice(0).forEach(dispose => dispose());
  vi.useRealTimers();
});
function input(id = "m1") {
  const dom = document.createElement("div");
  document.body.append(dom);
  const editor = { isDestroyed: false, view: { dom, composing: false } } as unknown as Editor;
  const edit = vi.fn();
  let position = 1;
  const unregister = registerInlineMathInput(editor, { id: () => id, position: () => position, edit });
  cleanups.push(unregister, () => dom.remove());
  return { editor, edit, unregister, move: (value: number) => { position = value; } };
}

it("opens only the requested editor when formula IDs are duplicated", async () => {
  const source = input();
  const replica = input();
  const otherDocument = input();
  requestInlineMathEdit(source.editor, "m1", "start");
  await vi.advanceTimersByTimeAsync(400);
  expect(source.edit).toHaveBeenCalledExactlyOnceWith({ cursorPosition: "start", pendingLatexCommandTrigger: undefined });
  expect(replica.edit).not.toHaveBeenCalled();
  expect(otherDocument.edit).not.toHaveBeenCalled();
});

it("asks the caret router for the visible surface using the formula's latest position", async () => {
  const source = input();
  const replica = input();
  const resolve = vi.fn(position => ({ editor: replica.editor, position }));
  cleanups.push(registerEditorInputRouting(source.editor, { resolve, focus: () => true }));
  requestInlineMathEdit(source.editor, "m1");
  source.move(9); // A peer inserted text before the formula before the frame ran.
  await vi.advanceTimersByTimeAsync(400);
  expect(resolve).toHaveBeenCalledExactlyOnceWith(9);
  expect(source.edit).not.toHaveBeenCalled();
  expect(replica.edit).toHaveBeenCalledOnce();
});

it.each(["pointer", "focus", "destroy"])("cancels stale opening after a %s change", async reason => {
  const source = input();
  const other = input();
  requestInlineMathEdit(source.editor, "m1");
  if (reason === "pointer") window.dispatchEvent(new PointerEvent("pointerdown"));
  if (reason === "focus") other.editor.view.dom.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  if (reason === "destroy") source.unregister();
  await vi.advanceTimersByTimeAsync(400);
  expect(source.edit).not.toHaveBeenCalled();
  expect(other.edit).not.toHaveBeenCalled();
});

it("an older request cannot open later or cancel a newer request", async () => {
  const first = input("old");
  const second = input("new");
  requestInlineMathEdit(first.editor, "old");
  requestInlineMathEdit(second.editor, "new");
  await vi.advanceTimersByTimeAsync(400);
  expect(first.edit).not.toHaveBeenCalled();
  expect(second.edit).toHaveBeenCalledOnce();
});

it("does not steal IME focus or fall back to an unowned copy", async () => {
  const source = input();
  const replica = input();
  cleanups.push(registerEditorInputRouting(source.editor, { resolve: () => null, focus: () => false }));
  requestInlineMathEdit(source.editor, "m1");
  await vi.advanceTimersByTimeAsync(400);
  expect(source.edit).not.toHaveBeenCalled();
  expect(replica.edit).not.toHaveBeenCalled();
});
