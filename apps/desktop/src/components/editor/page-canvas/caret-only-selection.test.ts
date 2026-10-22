// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { AllSelection, EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerCaretSurface, type CaretSurfaceHandle } from "../text-flow/caret-router";
import { isCaretOnlyInBlock } from "./caret-only-selection";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", attrs: { sigmaDocId: { default: "" } } },
    figure: { group: "block", atom: true, selectable: true, attrs: { sigmaDocId: { default: "" } } },
    text: {},
  },
});

function buildState() {
  return EditorState.create({
    doc: schema.node("doc", null, [
      schema.node("paragraph", { sigmaDocId: "p1" }, [schema.text("hello world")]),
      schema.node("figure", { sigmaDocId: "fig1" }),
      schema.node("paragraph", { sigmaDocId: "p2" }, [schema.text("second")]),
    ]),
  });
}

/** 先頭の段落の中の位置 (p1 は 1..12)。 */
const inP1 = (state: EditorState, from: number, to = from) => state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
const figurePos = (state: EditorState) => state.doc.child(0).nodeSize;

let canvas: HTMLElement;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  canvas = document.createElement("div");
  document.body.append(canvas);
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.innerHTML = "";
});

function mount(state: EditorState, options: { focused?: boolean; inside?: HTMLElement } = {}) {
  const dom = document.createElement("div");
  (options.inside ?? canvas).append(dom);
  const editor = {
    isDestroyed: false,
    isFocused: Boolean(options.focused),
    state,
    view: { dom, hasFocus: () => Boolean(options.focused) },
  };
  cleanups.push(registerCaretSurface({ editor: editor as unknown as Editor, addressAt: () => null } as unknown as CaretSurfaceHandle));
  return editor;
}

describe("isCaretOnlyInBlock", () => {
  it("is true only for a collapsed cursor inside the selected block", () => {
    mount(inP1(buildState(), 3));
    expect(isCaretOnlyInBlock(canvas, "p1")).toBe(true);
    // 別のブロックを選んでいるなら、カーソルがあってもカーソルだけの選択ではない。
    expect(isCaretOnlyInBlock(canvas, "p2")).toBe(false);
    expect(isCaretOnlyInBlock(canvas, null)).toBe(false);
    expect(isCaretOnlyInBlock(null, "p1")).toBe(false);
  });

  it("is false for a text range, a node selection and a select-all", () => {
    const range = mount(inP1(buildState(), 2, 6));
    expect(isCaretOnlyInBlock(canvas, "p1")).toBe(false);

    const base = buildState();
    range.state = base.apply(base.tr.setSelection(NodeSelection.create(base.doc, figurePos(base))));
    expect(isCaretOnlyInBlock(canvas, "fig1")).toBe(false);
    // ノードを選んでいるとき、その中身にカーソルがあるわけではない。
    expect(isCaretOnlyInBlock(canvas, "p1")).toBe(false);

    range.state = base.apply(base.tr.setSelection(new AllSelection(base.doc)));
    expect(isCaretOnlyInBlock(canvas, "p1")).toBe(false);
  });

  it("ignores editors outside the page canvas", () => {
    const outside = document.createElement("div");
    document.body.append(outside);
    mount(inP1(buildState(), 3), { inside: outside });
    expect(isCaretOnlyInBlock(canvas, "p1")).toBe(false);
  });

  it("lets the focused surface decide over a stale selection kept by another surface", () => {
    // 別の面が、同じブロックの中に置いたままのカーソルを覚えている。
    mount(inP1(buildState(), 3));
    expect(isCaretOnlyInBlock(canvas, "p1")).toBe(true);
    // いま操作している面は、同じブロックの範囲を選んでいる。
    mount(inP1(buildState(), 2, 6), { focused: true });
    expect(isCaretOnlyInBlock(canvas, "p1")).toBe(false);
  });
});
