// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { installMathLiveCompositionSelection, type CompositionSelectionMathField } from "./mathlive-composition-selection";

const PLACEHOLDER = String.raw`\placeholder{}`;

/**
 * MathLive の入力欄の代わり。値は「選んだ範囲の TeX」だけを持ち、sink 上の capture で MathLive の
 * 変換開始処理 (選んだ範囲を消す) を真似て、そのとき範囲が残っていたかを記録する。
 */
function mountMathField(selected: { range: [number, number]; latex: string } | null) {
  const host = document.createElement("div") as CompositionSelectionMathField;
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const sink = document.createElement("span");
  sink.className = "ML__keyboard-sink";
  root.append(sink);
  let selection = selected;
  Object.defineProperties(host, {
    selection: { get: () => ({ ranges: [selection?.range ?? [3, 3]] }) },
    selectionIsCollapsed: { get: () => selection === null },
  });
  host.getValue = (start, end) => (selection && start === selection.range[0] && end === selection.range[1] ? selection.latex : "");
  const insert = vi.fn((text: string) => {
    if (text === "" && selection === null) return false;
    selection = text === PLACEHOLDER ? { range: [1, 2], latex: PLACEHOLDER } : null;
    return true;
  });
  host.insert = insert;
  const mathLiveSawRange: boolean[] = [];
  sink.addEventListener("compositionstart", () => mathLiveSawRange.push(selection !== null), { capture: true });
  return { host, root, sink, insert, mathLiveSawRange };
}

const composition = (type: string, data = "") => {
  const event = new CompositionEvent(type, { bubbles: true, composed: true, data });
  // happy-dom は CompositionEventInit の data を持たないので、確定した文字を直接載せる。
  if (event.data !== data) Object.defineProperty(event, "data", { value: data });
  return event;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("installMathLiveCompositionSelection", () => {
  it("empties a selected blank the way typing does, before MathLive deletes the selection with its parent", () => {
    const { host, root, sink, insert, mathLiveSawRange } = mountMathField({ range: [1, 2], latex: PLACEHOLDER });
    installMathLiveCompositionSelection(host, root);
    installMathLiveCompositionSelection(host, root);

    sink.dispatchEvent(composition("compositionstart"));

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith("", { insertionMode: "replaceSelection" });
    // MathLive の deleteRange には消すものが残っていない (分数ごと消さない)。
    expect(mathLiveSawRange).toEqual([false]);

    sink.dispatchEvent(composition("compositionend", "漢"));
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("puts the blank back, selected, when the composition is cancelled", () => {
    const { host, root, sink, insert } = mountMathField({ range: [1, 2], latex: PLACEHOLDER });
    installMathLiveCompositionSelection(host, root);

    sink.dispatchEvent(composition("compositionstart"));
    sink.dispatchEvent(composition("compositionend"));

    expect(insert).toHaveBeenLastCalledWith(PLACEHOLDER, { format: "latex", selectionMode: "placeholder" });
    expect(host.selectionIsCollapsed).toBe(false);
  });

  it("replaces any other selection the same way, without bringing a blank back", () => {
    const { host, root, sink, insert, mathLiveSawRange } = mountMathField({ range: [1, 3], latex: "ab" });
    installMathLiveCompositionSelection(host, root);

    sink.dispatchEvent(composition("compositionstart"));
    sink.dispatchEvent(composition("compositionend"));

    expect(insert.mock.calls).toEqual([["", { insertionMode: "replaceSelection" }]]);
    expect(mathLiveSawRange).toEqual([false]);
  });

  it("leaves a composition at a caret to MathLive", () => {
    const { host, root, sink, insert } = mountMathField(null);
    installMathLiveCompositionSelection(host, root);

    sink.dispatchEvent(composition("compositionstart"));
    sink.dispatchEvent(composition("compositionend"));

    expect(insert).not.toHaveBeenCalled();
  });
});
