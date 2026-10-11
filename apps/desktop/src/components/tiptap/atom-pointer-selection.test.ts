import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";

import { registerAtomPointerSelectionStarter, startAtomPointerSelection } from "./atom-pointer-selection";

function request() {
  return { event: new Event("mousedown") as MouseEvent, from: 3, to: 4, onClick: vi.fn() };
}

describe("atom pointer selection", () => {
  it("hands the press to the starter registered for that editor only", () => {
    const editor = {} as Editor;
    const other = {} as Editor;
    const starter = vi.fn(() => true);
    const dispose = registerAtomPointerSelectionStarter(editor, starter);

    const pressed = request();
    expect(startAtomPointerSelection(editor, pressed)).toBe(true);
    expect(starter).toHaveBeenCalledWith(pressed);
    // 登録の無い編集面 (表のセル・図形の文字) では、ノードビューが自分で伸ばす。
    expect(startAtomPointerSelection(other, request())).toBe(false);

    dispose();
    expect(startAtomPointerSelection(editor, request())).toBe(false);
  });

  it("does not let a stale disposer remove a newer registration", () => {
    const editor = {} as Editor;
    const disposeFirst = registerAtomPointerSelectionStarter(editor, () => true);
    const second = vi.fn(() => true);
    registerAtomPointerSelectionStarter(editor, second);

    disposeFirst();

    expect(startAtomPointerSelection(editor, request())).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
