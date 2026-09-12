// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { inlineNodesToTiptapDoc, tiptapDocToInlineNodes } from "@/lib/tiptap-adapter";
import { createRichTextEngineExtensions } from "./rich-text-engine";

const editors: Editor[] = [];
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); });

describe("text block typography projection", () => {
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
