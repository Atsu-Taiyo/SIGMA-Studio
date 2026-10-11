// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useChromeHeldBodySelection } from "./use-chrome-held-body-selection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  const held = useChromeHeldBodySelection();
  return <output data-held={held?.id ?? ""} />;
}

describe("useChromeHeldBodySelection", () => {
  let root: Root;
  let host: HTMLDivElement;
  let editor: HTMLDivElement;
  let toolbarInput: HTMLInputElement;
  let otherInput: HTMLInputElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="body-editor" class="text-flow-editor" contenteditable="true" tabindex="0"><p>本文</p></div>
      <input class="toolbar-font-size-input" />
      <input class="other" />
      <div id="host"></div>`;
    editor = document.querySelector(".text-flow-editor")!;
    toolbarInput = document.querySelector(".toolbar-font-size-input")!;
    otherInput = document.querySelector(".other")!;
    host = document.querySelector("#host")!;
    root = createRoot(host);
    act(() => root.render(<Probe />));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  function held(): string | undefined {
    return host.querySelector("output")?.dataset.held;
  }

  function moveFocus(target: Element, from: Element | null) {
    act(() => {
      target.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: from }));
    });
  }

  it("holds the body editor while focus moves from it into chrome inputs, and releases on return", () => {
    expect(held()).toBe("");

    moveFocus(toolbarInput, editor.querySelector("p"));
    expect(held()).toBe(editor.id);

    // 入力欄から入力欄へ移る間は持ち続ける (relatedTarget は本文ではない)。
    moveFocus(otherInput, toolbarInput);
    expect(held()).toBe(editor.id);

    moveFocus(editor, otherInput);
    expect(held()).toBe("");
  });

  it("does not hold anything when focus did not come from a body editor", () => {
    moveFocus(toolbarInput, otherInput);
    expect(held()).toBe("");
  });
});
