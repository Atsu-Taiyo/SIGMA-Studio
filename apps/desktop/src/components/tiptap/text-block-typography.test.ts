// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { inlineNodesToTiptapDoc, tiptapDocToInlineNodes } from "@/lib/tiptap-adapter";
import { textFlowToTiptap } from "@/components/editor/text-flow/tiptap-document-adapter";
import { createRichTextEngineExtensions } from "./rich-text-engine";
import { SigmaDocTextAttrs } from "./sigma-doc-text-attributes";
import { SigmaDocTextIdentity } from "./sigma-doc-text-identity";

const editors: Editor[] = [];
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); });

describe("text block typography projection", () => {
  it.each([10, 18])("draws the empty paragraph at the %ipt typing size immediately after Enter", (fontSize) => {
    const editor = new Editor({
      extensions: createRichTextEngineExtensions({ blockExtensions: [SigmaDocTextAttrs, SigmaDocTextIdentity] }),
      content: textFlowToTiptap([{ type: "paragraph", id: "body", children: [{ type: "text", text: "本文", fontSize }] }]),
    });
    editors.push(editor);
    editor.commands.setTextSelection(3);
    editor.commands.keyboardShortcut("Enter");
    const empty = editor.view.dom.querySelector("p:last-child") as HTMLElement;
    expect(empty.textContent).toBe("");
    expect(empty.style.getPropertyValue("--sigma-doc-text-line-font-size")).toBe(`${fontSize}pt`);
    const before = editor.getJSON();
    editor.commands.setFontSize(7.5);
    expect((editor.view.dom.querySelector("p:last-child") as HTMLElement).style.getPropertyValue("--sigma-doc-text-line-font-size")).toBe("7.5pt");
    expect(editor.getJSON()).not.toEqual(before);
    editor.commands.unsetFontSize();
    expect((editor.view.dom.querySelector("p:last-child") as HTMLElement).style.getPropertyValue("--sigma-doc-text-line-font-size")).toBe("");
  });

  it("does not apply the caret's pending size to existing text or a range selection", () => {
    const editor = new Editor({
      extensions: createRichTextEngineExtensions(),
      content: "<p>本文</p><p></p>",
    });
    editors.push(editor);
    editor.commands.setTextSelection(5);
    editor.commands.setFontSize(10);
    const empty = editor.view.dom.querySelector("p:last-child") as HTMLElement;
    expect(empty.style.getPropertyValue("--sigma-doc-text-line-font-size")).toBe("10pt");
    editor.commands.setTextSelection({ from: 1, to: 5 });
    expect(empty.style.getPropertyValue("--sigma-doc-text-line-font-size")).toBe("10pt");
    editor.commands.setTextSelection(2);
    editor.commands.setFontSize(18);
    expect(editor.view.dom.querySelector("p:first-child")?.getAttribute("style") ?? "").not.toContain("18pt");
  });

  it("updates and removes derived geometry as a selected run's size changes, without persisting it", () => {
    const editor = new Editor({
      extensions: createRichTextEngineExtensions(),
      content: inlineNodesToTiptapDoc([{ type: "text", text: "注記" }]),
    });
    editors.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 3 });
    editor.commands.setFontSize(1);
    expect(editor.view.dom.querySelector("p")?.style.getPropertyValue("--sigma-doc-text-line-font-size")).toBe("1pt");
    expect(tiptapDocToInlineNodes(editor.getJSON())).toEqual([{ type: "text", text: "注記", fontSize: 1 }]);
    expect(JSON.stringify(editor.getJSON())).not.toContain("sigma-doc-text-line-font-size");

    editor.commands.setFontSize(7.5);
    expect(editor.view.dom.querySelector("p")?.style.getPropertyValue("--sigma-doc-text-line-font-size")).toBe("7.5pt");
    editor.commands.unsetFontSize();
    expect(editor.view.dom.querySelector("p")?.style.getPropertyValue("--sigma-doc-text-line-font-size")).toBe("");
    expect(tiptapDocToInlineNodes(editor.getJSON())).toEqual([{ type: "text", text: "注記" }]);
  });

  it("preserves the inherited size around a smaller run through further typing", () => {
    const editor = new Editor({
      extensions: createRichTextEngineExtensions(),
      content: inlineNodesToTiptapDoc([
        { type: "text", text: "前 " },
        { type: "text", text: "注記", fontSize: 1 },
        { type: "text", text: " 後", marks: ["bold"] },
      ]),
    });
    editors.push(editor);
    expect(Array.from(editor.view.dom.querySelectorAll("[data-sigma-doc-inherited-font]"), (node) => node.textContent))
      .toEqual(["前 ", " 後"]);
    editor.commands.setTextSelection(4);
    editor.commands.insertContent("追記");
    expect(tiptapDocToInlineNodes(editor.getJSON())).toEqual([
      { type: "text", text: "前 " },
      { type: "text", text: "注追記記", fontSize: 1 },
      { type: "text", text: " 後", marks: ["bold"] },
    ]);
  });
});
