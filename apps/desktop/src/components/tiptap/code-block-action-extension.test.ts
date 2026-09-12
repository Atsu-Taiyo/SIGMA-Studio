// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import { textFlowToTiptap } from "@/components/editor/text-flow/tiptap-document-adapter";
import { CodeBlockActionExtension } from "@/components/tiptap/code-block-action-extension";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";

const editors: Editor[] = [];

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }
});

describe("CodeBlockActionExtension", () => {
  it("adds an accessible settings button without adding anything to the document", () => {
    const onOpen = vi.fn();
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [
        ...createRichTextEngineExtensions({
          blockExtensions: [SigmaDocTextAttrs],
          bodyBlocks: true,
        }),
        CodeBlockActionExtension.configure({
          onOpen,
          getLabel: () => "コードブロックの設定",
        }),
      ],
      content: textFlowToTiptap([{
        type: "codeBlock",
        id: "code_settings",
        children: [{ type: "text", text: "const answer = 42;" }],
      }]),
    });
    editors.push(editor);
    const documentBeforeClick = editor.getJSON();
    const button = editor.view.dom.querySelector<HTMLButtonElement>(
      "[data-code-block-action-button='true']",
    );

    expect(button?.getAttribute("aria-label")).toBe("コードブロックの設定");
    expect(button?.getAttribute("aria-haspopup")).toBe("dialog");
    button?.click();
    expect(onOpen).toHaveBeenCalledWith("code_settings", button);
    expect(editor.getJSON()).toEqual(documentBeforeClick);
  });
});
