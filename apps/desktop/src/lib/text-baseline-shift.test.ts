import { expect, it } from "vitest";
import { InlineNodeSchema } from "./sigma-doc-schema";

it("retains signed fractional baseline shift independently of font size", () => {
  for (const baselineShiftPx of [-1.37, 0, 1.4457]) {
    const node = { type: "text", text: "見出し", fontSize: 12, baselineShiftPx };
    expect(InlineNodeSchema.parse(JSON.parse(JSON.stringify(node)))).toEqual(node);
  }
  for (const baselineShiftPx of [NaN, Infinity, -Infinity]) {
    expect(InlineNodeSchema.safeParse({ type: "text", text: "x", baselineShiftPx }).success).toBe(false);
  }
  expect(InlineNodeSchema.parse({ type: "text", text: "existing" })).toEqual({ type: "text", text: "existing" });
});

import { inlineNodesToTiptapNodes, tiptapNodesToInlineNodes } from "./tiptap-adapter";
import { inlineTextStyleDeclarations } from "@/features/rendering/adapters/boxed-inline-dom";
import type { InlineNode } from "@/features/document";

it("keeps differently shifted runs distinct across editor serialization", () => {
  const nodes: InlineNode[] = [
    { type: "text", text: "前", baselineShiftPx: 1.4457 },
    { type: "text", text: "後", baselineShiftPx: -1.37 },
    { type: "text", text: "標準", baselineShiftPx: 0 },
  ];
  expect(tiptapNodesToInlineNodes(inlineNodesToTiptapNodes(nodes))).toEqual(nodes);
  expect(inlineTextStyleDeclarations({ baselineShiftPx: -1.37 })).toEqual({ "vertical-align": "-1.37px" });
  expect(inlineTextStyleDeclarations({ baselineShiftPx: 0 })).toEqual({ "vertical-align": "0px" });
  expect(inlineTextStyleDeclarations({ baselineShiftPx: Infinity })).toBeUndefined();
});

import { normalizePageLayout } from "@/features/document/application/page-layout";
import { buildInlineRichTextDom } from "@/features/rendering/adapters/rich-text-dom";

it("keeps baseline shifts in running regions and projects it into static DOM", () => {
  for (const region of ["header", "footer"] as const) {
    const layout = normalizePageLayout({ [region]: { enabled: true, blocks: [{ type: "paragraph", id: "running", children: [{ type: "text", text: "見出し", baselineShiftPx: 1.4457 }] }] } });
    const node = layout[region]!.blocks![0];
    expect(node).toMatchObject({ children: [{ baselineShiftPx: 1.4457 }] });
    const dom = buildInlineRichTextDom([{ type: "text", text: "見出し", baselineShiftPx: 1.4457 }], { keyPrefix: "test" });
    expect(JSON.stringify(dom)).toContain('"vertical-align":"1.4457px"');
  }
});
