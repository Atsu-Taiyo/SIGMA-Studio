// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { expect, it } from "vitest";
import { StyledTextExtension } from "./text-format-extensions";
import { inlineNodesToTiptapNodes, tiptapDocToInlineNodes } from "@/lib/tiptap-adapter";

it("renders, edits and reparses baseline shifts without changing the text size", () => {
  const editor = new Editor({ extensions: [StarterKit, StyledTextExtension], content: {
    type: "doc", content: [{ type: "paragraph", content: inlineNodesToTiptapNodes([
      { type: "text", text: "見出し", fontSize: 12, baselineShiftPx: 1.4457 },
    ]) }],
  }});
  let reloaded: Editor | undefined;
  try {
    expect(editor.view.dom.querySelector("span")?.style.verticalAlign).toBe("1.4457px");
    editor.commands.insertContentAt(2, "追");
    const nodes = tiptapDocToInlineNodes(editor.getJSON());
    expect(nodes).toEqual([{ type: "text", text: "見追出し", fontSize: 12, baselineShiftPx: 1.4457 }]);
    reloaded = new Editor({ extensions: [StarterKit, StyledTextExtension], content: editor.getHTML() });
    expect(tiptapDocToInlineNodes(reloaded.getJSON())).toEqual(nodes);
  } finally { reloaded?.destroy(); editor.destroy(); }
});
