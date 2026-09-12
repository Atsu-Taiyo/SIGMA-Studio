// @vitest-environment happy-dom
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditGuardExtension, type TextFlowEditGuard } from "./edit-guard-extension";

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

function setup(text = "前の本文【AI対象】後の本文", from = 4, to = 10) {
  const guard: TextFlowEditGuard = {
    blockId: "p1", guardId: "run1", isPrimaryActionTarget: false, blockedMessage: "blocked", highlight: true,
    presentation: { highlightedBlockClassName: "locked", partialBlockClassName: "partial", readOnlyBlockClassName: "readonly", characterClassName: "char", atomClassName: "atom" },
    highlightScopes: [{ kind: "text", blockId: "p1", from, to }],
    contentReservations: [{ baselineText: text, ranges: [{ from, to }], inlineMathIds: [] }],
  };
  const guards = new Map([["p1", guard]]);
  const blocked = vi.fn();
  const editor = new Editor({
    extensions: [StarterKit, Extension.create({
      name: "testIds",
      addGlobalAttributes: () => [{ types: ["paragraph"], attributes: { sigmaDocId: { default: null } } }],
    }), EditGuardExtension.configure({ getGuards: () => guards, onBlockedAttempt: blocked })],
    content: { type: "doc", content: [{ type: "paragraph", attrs: { sigmaDocId: "p1" }, content: [{ type: "text", text }] }] },
  });
  editors.push(editor);
  return { editor, blocked, guards, guard };
}

describe("fragment edit guards", () => {
  it("counts soft line breaks when resolving a text reservation", () => {
    const { editor, blocked } = setup("前\n対象後", 2, 4);
    editor.commands.setContent({ type: "doc", content: [{
      type: "paragraph", attrs: { sigmaDocId: "p1" }, content: [
        { type: "text", text: "前" }, { type: "hardBreak" }, { type: "text", text: "対象後" },
      ],
    }] }, { emitUpdate: false });
    editor.commands.insertContentAt(1, "先");
    expect([...editor.view.dom.querySelectorAll(".char")].map((node) => node.textContent).join("")).toBe("対象");
    editor.view.dispatch(editor.state.tr.insertText("変", 4, 5));
    expect(blocked).toHaveBeenCalledOnce();
  });
  it("clips the animated-character overflow span to the protected fragment", () => {
    const { editor } = setup("x".repeat(700) + "対象" + "後", 700, 702);
    expect([...editor.view.dom.querySelectorAll(".char")].map((node) => node.textContent).join("")).toBe("対象");
  });
  it("accepts repeated edits around the range and keeps only that range read-only", () => {
    const { editor, blocked } = setup();
    editor.commands.insertContentAt(1, "先頭");
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, "末尾");
    editor.commands.insertContentAt(1, "追記");
    expect(editor.getText()).toBe("追記先頭前の本文【AI対象】後の本文末尾");
    expect(blocked).not.toHaveBeenCalled();
    expect(editor.view.dom.querySelector("p")?.getAttribute("contenteditable")).not.toBe("false");
    expect([...editor.view.dom.querySelectorAll('[data-edit-guard-id="run1"][data-edit-guard-range]')]
      .map((node) => node.textContent).join("")).toBe("【AI対象】");
  });

  it("refuses insert/delete/format changes inside the range, including IME transactions", () => {
    const { editor, blocked } = setup();
    const original = editor.getJSON();
    editor.view.dispatch(editor.state.tr.insertText("の", 7).setMeta("composition", 1));
    editor.view.dispatch(editor.state.tr.delete(6, 8));
    editor.view.dispatch(editor.state.tr.addMark(6, 8, editor.schema.marks.bold.create()));
    expect(editor.getJSON()).toEqual(original);
    expect(blocked).toHaveBeenCalledTimes(3);
  });

  it("uses actual step positions for repeated characters", () => {
    const { editor, blocked } = setup("aaaaaa", 1, 4);
    editor.view.dispatch(editor.state.tr.insertText("a", 3));
    expect(editor.getText()).toBe("aaaaaa");
    expect(blocked).toHaveBeenCalledOnce();
  });

  it("allows formatting outside the range and releases it when the run ends", () => {
    const { editor, blocked, guards } = setup();
    editor.view.dispatch(editor.state.tr.addMark(1, 3, editor.schema.marks.bold.create()));
    expect(blocked).not.toHaveBeenCalled();
    guards.clear();
    editor.commands.insertContentAt(7, "編集");
    expect(editor.getText()).toContain("編集");
  });

  it("keeps canonical view adoption available and enforces whole-document writes", () => {
    const { editor, guard } = setup();
    editor.commands.setContent(editor.getJSON(), { emitUpdate: false });
    guard.contentReservations = undefined;
    editor.commands.insertContentAt(1, "禁止");
    expect(editor.getText()).not.toContain("禁止");
  });
});
