// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { createRunningFieldDecorations, RunningFieldExtension } from "./running-field-extension";

const values = { title: "小テスト", page: 2, total: 5 };
let editor: Editor | null = null;

function createEditor(text: string): Editor {
  editor = new Editor({
    extensions: [Document, Paragraph, Text, RunningFieldExtension.configure({ getValues: () => values })],
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
  });
  return editor;
}

function press(target: Editor, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent("keydown", { key, ...init });
  return target.view.someProp("handleKeyDown", (handler) => handler(target.view, event)) ?? false;
}

function caret(target: Editor, pos: number): void {
  target.view.dispatch(target.state.tr.setSelection(TextSelection.create(target.state.doc, pos)));
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("RunningFieldExtension", () => {
  it("shows each field as its value and keeps the written text in the document", () => {
    const target = createEditor("p.{page}/{total}");
    expect(target.state.doc.textContent).toBe("p.{page}/{total}");
    expect(Array.from(target.view.dom.querySelectorAll(".running-field-value"), (node) => node.textContent)).toEqual(["2", "5"]);
    expect(target.view.dom.querySelectorAll(".running-field-source")).toHaveLength(2);
  });

  it("does nothing on a surface that has no values (the body)", () => {
    const target = createEditor("{page}");
    expect(createRunningFieldDecorations(target.state.doc, null).find()).toHaveLength(0);
  });

  it("deletes a field as one unit with Backspace after it and Delete before it", () => {
    const target = createEditor("a{page}b");
    caret(target, 8);
    expect(press(target, "Backspace")).toBe(true);
    expect(target.state.doc.textContent).toBe("ab");

    target.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a{title}b" }] }] });
    caret(target, 2);
    expect(press(target, "Delete")).toBe(true);
    expect(target.state.doc.textContent).toBe("ab");
  });

  it("moves across a field with one arrow press and extends the selection with Shift", () => {
    const target = createEditor("a{page}b");
    caret(target, 2);
    expect(press(target, "ArrowRight")).toBe(true);
    expect(target.state.selection.head).toBe(8);
    expect(press(target, "ArrowLeft")).toBe(true);
    expect(target.state.selection.head).toBe(2);
    caret(target, 8);
    expect(press(target, "ArrowLeft", { shiftKey: true })).toBe(true);
    expect(target.state.selection).toMatchObject({ anchor: 8, head: 2 });
    // 差し込みをまたがない移動はブラウザに任せる。
    caret(target, 1);
    expect(press(target, "ArrowRight")).toBe(false);
  });

  it("never leaves the caret inside a field", () => {
    const target = createEditor("a{page}b");
    caret(target, 8);
    caret(target, 5);
    expect(target.state.selection.head).toBe(2);
    caret(target, 2);
    caret(target, 4);
    expect(target.state.selection.head).toBe(8);
  });
});
