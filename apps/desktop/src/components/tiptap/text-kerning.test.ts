// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { expect, it } from "vitest";
import { StyledTextExtension } from "./text-format-extensions";
import { inlineNodesToTiptapNodes, tiptapDocToInlineNodes } from "@/lib/tiptap-adapter";
import { InlineNodeSchema } from "@/lib/sigma-doc-schema";
import { buildInlineRichTextDom } from "@/features/rendering/adapters/rich-text-dom";
import { normalizePageLayout } from "@/features/document/application/page-layout";

it("retains explicit kerning through typing, HTML paste and canonical serialization", () => {
  const nodes = [{ type: "text" as const, text: '\",\"', fontKerning: "none" as const }];
  const editor = new Editor({ extensions: [StarterKit, StyledTextExtension], content: {
    type: "doc", content: [{ type: "paragraph", content: inlineNodesToTiptapNodes(nodes) }],
  }});
  let pasted: Editor | undefined;
  try {
    expect(editor.view.dom.querySelector("span")?.style.fontKerning).toBe("none");
    editor.commands.insertContentAt(2, "x");
    const saved = tiptapDocToInlineNodes(editor.getJSON());
    expect(saved).toEqual([{ ...nodes[0], text: '\"x,\"' }]);
    pasted = new Editor({ extensions: [StarterKit, StyledTextExtension], content: editor.getHTML() });
    expect(tiptapDocToInlineNodes(pasted.getJSON())).toEqual(saved);
    expect(saved.map(n => InlineNodeSchema.parse(JSON.parse(JSON.stringify(n))))).toEqual(saved);
  } finally { pasted?.destroy(); editor.destroy(); }
});

it("keeps kerning choices distinct and rejects unsupported values", () => {
  const nodes = ["auto", "normal", "none"].map(fontKerning => InlineNodeSchema.parse({ type: "text", text: "x", fontKerning }));
  const editor = new Editor({ extensions: [StarterKit, StyledTextExtension], content: {
    type: "doc", content: [{ type: "paragraph", content: inlineNodesToTiptapNodes(nodes) }],
  }});
  try { expect(tiptapDocToInlineNodes(editor.getJSON())).toEqual(nodes); }
  finally { editor.destroy(); }
  expect(InlineNodeSchema.safeParse({ type: "text", text: "x", fontKerning: "invalid" }).success).toBe(false);
  expect(InlineNodeSchema.parse({ type: "text", text: "x" })).toEqual({ type: "text", text: "x" });
});

it("uses the same kerning setting in static output and running regions", () => {
  const nodes = [{ type: "text" as const, text: '\",\"', fontKerning: "none" as const }];
  expect(JSON.stringify(buildInlineRichTextDom(nodes, { keyPrefix: "kerning" }))).toContain('"font-kerning":"none"');
  for (const region of ["header", "footer"] as const) {
    const layout = normalizePageLayout({ [region]: { enabled: true, blocks: [{ type: "paragraph", id: "p", children: nodes }] } });
    expect(layout[region]?.blocks?.[0]).toMatchObject({ children: nodes });
  }
});
