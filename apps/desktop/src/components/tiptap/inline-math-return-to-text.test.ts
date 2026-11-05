// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_MATH_RENDER_ENVIRONMENT } from "@/lib/math-environment";
import { InlineMathNodeView } from "./inline-math-extension";
import { createRichTextEngineExtensions } from "./rich-text-engine";

let editor: Editor;
let nodeView: InlineMathNodeView;
afterEach(() => {
  nodeView?.destroy();
  editor?.destroy();
  document.body.replaceChildren();
});

function setup() {
  const element = document.createElement("div");
  const otherInput = document.createElement("textarea");
  document.body.append(element, otherInput);
  editor = new Editor({ element, extensions: createRichTextEngineExtensions(), content: {
    type: "doc", content: [
      { type: "paragraph", attrs: { sigmaDocId: "p0" }, content: [
        { type: "text", text: "前" }, { type: "mathInline", attrs: { id: "m1", tex: "x" } }, { type: "text", text: "後" },
      ] },
      { type: "paragraph", attrs: { sigmaDocId: "p1" }, content: [{ type: "text", text: "別の段落" }] },
    ],
  } });
  nodeView = new InlineMathNodeView({ decorations: [], editor, node: editor.state.doc.nodeAt(2)!, getPos: () => 2 }, {
    mathEnvironment: DEFAULT_MATH_RENDER_ENVIRONMENT,
  });
  otherInput.focus();
  return otherInput;
}

function commit(side: "after" | "before") {
  const view = nodeView as unknown as {
    commitMathAndReturnToTextAfter: (tex: string) => void;
    commitMathAndReturnToTextBefore: (tex: string) => void;
  };
  if (side === "after") view.commitMathAndReturnToTextAfter("x");
  else view.commitMathAndReturnToTextBefore("x");
}

it.each(["after", "before"] as const)("returns focus %s the formula before the next native input", side => {
  setup();
  commit(side);
  expect(editor.view.hasFocus()).toBe(true);
  expect(editor.state.selection.from).toBe(side === "after" ? 3 : 2);
  expect(editor.state.selection.empty).toBe(true);
  editor.commands.insertContent("c");
  expect(editor.state.doc.firstChild!.child(side === "after" ? 2 : 0).text).toBe(side === "after" ? "c後" : "前c");
});

it.each(["after", "before"] as const)("does not replay an old %s caret after later input or a deliberate focus change", async side => {
  const otherInput = setup();
  commit(side);
  editor.commands.insertContent("c");
  const nextParagraph = editor.state.doc.firstChild!.nodeSize + 1;
  editor.commands.setTextSelection(nextParagraph);
  otherInput.focus();
  await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  expect(editor.state.selection.from).toBe(nextParagraph);
  expect(document.activeElement).toBe(otherInput);
});
