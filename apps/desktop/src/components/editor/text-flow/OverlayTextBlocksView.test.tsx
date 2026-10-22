import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { OverlayTextBlock } from "@/features/document";

import { OverlayTextBlocksView } from "./OverlayTextBlocksView";
import type { TextFlowStaticBlockNode } from "./TextFlowStaticBlock";

function render(blocks: OverlayTextBlock[], selfContained = false): string {
  return renderToStaticMarkup(<OverlayTextBlocksView blocks={blocks} selfContained={selfContained} />);
}

describe("a shape's text drawn by the body's static renderer", () => {
  it("renders text, inline math, marks and boxed runs", () => {
    const html = render([{
      type: "paragraph",
      id: "p_1",
      align: "center",
      children: [
        { type: "text", text: "枠", marks: ["boxed", "underline"], boxedPaddingY: 2 },
        { type: "mathInline", id: "m_1", tex: "x", display: "inline" },
      ],
    }]);

    expect(html).toContain('<p style="text-align:center">');
    expect(html).toContain('class="boxed-text"');
    expect(html).toContain('class="sigma-underline-run"');
    expect(html).toContain('class="inline-math-node"');
    expect(html).toContain('data-tex="x"');
  });

  /**
   * `data-sigma-doc-id` is how the page surface finds a *body* block: the measurable-block selector
   * behind anchor candidates and the pagination measurement, and the page-window index, all select
   * on it. A figure's paragraphs are not body blocks, so this attribute must not appear here — if
   * it did, typing in the body would start re-anchoring against text drawn inside a diagram.
   */
  /**
   * An unaligned block writes no alignment at all, exactly as the editing surface (ProseMirror)
   * does. The shape's box sets none either, so leaving it to the cascade is what keeps the two
   * projections identical across focus — see `inline-dom-parity.test.tsx`.
   */
  it("writes no alignment for a block that has none", () => {
    expect(render([{ type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] }]))
      .not.toContain("text-align");
  });

  it("emits no document block ids", () => {
    const html = render([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] },
      {
        type: "list",
        id: "list_1",
        listType: "bullet",
        items: [{
          type: "listItem",
          id: "li_1",
          children: [{ type: "text", text: "項目" }],
          continuations: [{ type: "paragraph", id: "p_cont", children: [{ type: "text", text: "続き" }] }],
          nested: [{
            type: "list",
            id: "list_2",
            listType: "bullet",
            items: [{ type: "listItem", id: "li_2", children: [{ type: "text", text: "入れ子" }] }],
          }],
        }],
      },
    ]);

    expect(html).not.toContain("data-sigma-doc-id");
  });

  it("draws a list as a real list, with the body's own marker attributes", () => {
    const bullet = render([{
      type: "list",
      id: "list_1",
      listType: "bullet",
      items: [
        { type: "listItem", id: "li_1", children: [{ type: "text", text: "一" }] },
        { type: "listItem", id: "li_2", children: [{ type: "text", text: "二" }] },
      ],
    }]);
    const paren = render([{
      type: "list",
      id: "list_2",
      listType: "ordered",
      markerStyle: "paren",
      items: [{ type: "listItem", id: "li_3", children: [{ type: "text", text: "一" }] }],
    }]);

    expect(bullet).toContain("<ul>");
    expect(bullet.match(/<li>/g)).toHaveLength(2);
    expect(paren).toContain('<ol data-list-marker="paren">');
    expect(render([{
      type: "list",
      id: "list_3",
      listType: "ordered",
      items: [{ type: "listItem", id: "li_4", children: [] }],
    }])).not.toContain("data-list-marker");
  });

  it("draws the blocks a list item carries under its marker", () => {
    const html = render([{
      type: "list",
      id: "list_1",
      listType: "bullet",
      items: [{
        type: "listItem",
        id: "li_1",
        children: [{ type: "text", text: "項目" }],
        continuations: [{ type: "paragraph", id: "p_cont", children: [{ type: "text", text: "続き" }] }],
        nested: [{
          type: "list",
          id: "list_2",
          listType: "bullet",
          items: [{ type: "listItem", id: "li_2", children: [{ type: "text", text: "入れ子" }] }],
        }],
      }],
    }]);

    expect(html).toContain("続き");
    expect(html).toContain("入れ子");
  });

  // Print, PDF and the SVG export all read this markup, so a blank line has to survive here too —
  // an empty `<p>` draws no line box and would drop the author's blank line from the output.
  it("gives a blank block a line box", () => {
    const html = render([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "うえ" }] },
      { type: "paragraph", id: "p_2", children: [] },
      { type: "paragraph", id: "p_3", children: [{ type: "text", text: "した" }] },
    ]);

    expect(html).toContain("<br/>");
  });

  /**
   * The SVG export's `<foreignObject>` is viewed without the stylesheet, so the block typography
   * has to travel with the markup. `rich-text-self-contained.test.ts` is what holds these values
   * to the CSS rules they stand in for.
   */
  it("inlines the block typography when the output must stand alone", () => {
    const html = render([
      {
        type: "paragraph",
        id: "p_1",
        children: [
          { type: "text", text: "枠", marks: ["boxed"] },
          { type: "mathInline", id: "m_1", tex: "x", display: "inline" },
        ],
      },
      {
        type: "list",
        id: "list_1",
        listType: "bullet",
        items: [{ type: "listItem", id: "li_1", children: [{ type: "text", text: "一" }] }],
      },
    ], true);

    expect(html).toContain('<p style="margin:0">');
    expect(html).toContain('<ul style="margin:0;padding-inline-start:1.6em">');
    expect(html).toContain("white-space:pre-wrap");
    // The boxed frame is inlined the way the stylesheet writes it — reading the custom properties
    // with a fallback, so a variant or tone attribute still wins wherever the stylesheet is there.
    expect(html).toContain("border:var(--boxed-text-border-width, 1px)");
    expect(html).toContain('class="inline-math-node" style="margin:0"');
    // The classes stay on the markup as well, so the same string renders correctly in the app.
    expect(html).toContain('class="boxed-text"');
  });

  /**
   * The three blocks a shape gained, drawn by the same renderer the body uses — and carrying the
   * same class names the editing surface puts on them, so a quote keeps its rule and a code block
   * its colours when the shape loses focus.
   */
  it("draws a quote, a code block and a rule the way the editing surface does", () => {
    const html = render([
      {
        type: "quote",
        id: "quote_1",
        blocks: [{ type: "paragraph", id: "quote_p", children: [{ type: "text", text: "引用" }] }],
      },
      { type: "codeBlock", id: "code_1", language: "typescript", children: [{ type: "text", text: "const a = 1;" }] },
      { type: "divider", id: "divider_1" },
    ]);

    expect(html).toContain('<blockquote class="print-quote">');
    expect(html).toContain('class="print-code"');
    expect(html).toContain('class="print-divider"');
    expect(html).toContain("引用");
    // The source is split into highlighted spans, which is the point of carrying the class: the
    // static view colours code the same way the focused editor does.
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('data-code-language="typescript"');
    // Still not body blocks: the page surface must not find them as anchor or pagination units.
    expect(html).not.toContain("data-sigma-doc-id");
  });

  /**
   * The SVG export leaves the stylesheet behind, so a `blockquote`'s 40px UA indent or a `pre`'s
   * own font size would reflow the figure away from what the app draws. Everything the shape scope
   * gives these three has to travel inline.
   */
  it("inlines the quote, code and divider typography when it is self-contained", () => {
    const html = render([
      {
        type: "quote",
        id: "quote_1",
        blocks: [{ type: "paragraph", id: "quote_p", children: [{ type: "text", text: "引用" }] }],
      },
      { type: "codeBlock", id: "code_1", children: [{ type: "text", text: "code" }] },
      { type: "divider", id: "divider_1" },
    ], true);

    expect(html).toMatch(/<blockquote[^>]*style="[^"]*border-left:3px solid/);
    expect(html).toMatch(/<pre[^>]*style="[^"]*background:#f7f8fa/);
    expect(html).toMatch(/<hr[^>]*style="[^"]*border-top:1px solid/);
  });

  it("carries the dark code theme into a self-contained render", () => {
    const html = render([{
      type: "codeBlock",
      id: "code_dark",
      theme: "dark",
      children: [{ type: "text", text: "code" }],
    }], true);

    // Inline styles beat the theme's own CSS rule, so the choice has to travel with the block.
    expect(html).toMatch(/<pre[^>]*style="[^"]*background:#171717/);
    expect(html).toContain('data-code-theme="dark"');
  });

  /**
   * A shape can hold exactly what this renderer can draw. The two sets are written down in
   * different layers — the model cannot import the component — so they are pinned to each other
   * here instead of being kept in step by hand.
   */
  describe("space after a block", () => {
    const paragraph = (spaceAfterPx?: number): OverlayTextBlock => ({
      type: "paragraph",
      id: "p_sp",
      ...(spaceAfterPx ? { spaceAfterPx } : {}),
      children: [{ type: "text", text: "余白" }],
    });

    it("writes the shared custom property, and nothing at all for an untouched block", () => {
      expect(render([paragraph(14)])).toContain("--sigma-doc-space-after:14px");
      expect(render([paragraph()])).not.toContain("space-after");
    });

    it("leaves the padding to the stylesheet on the app surfaces", () => {
      expect(render([paragraph(14)])).not.toContain("padding-bottom");
    });

    it("inlines the padding when the output has no stylesheet (the exported SVG)", () => {
      const html = render([
        paragraph(14),
        { type: "heading", id: "h_sp", level: 2, spaceAfterPx: 6, children: [{ type: "text", text: "見出し" }] },
        { type: "divider", id: "d_sp", spaceAfterPx: 4 },
      ], true);

      expect(html).toMatch(/<p style="[^"]*padding-bottom:14px/);
      expect(html).toMatch(/<h2 style="[^"]*padding-bottom:6px/);
      expect(html).toMatch(/<hr[^>]*style="[^"]*padding-bottom:4px/);
    });

    it("does not pad a quote or a code block, which draw their frame around the padding", () => {
      const html = render([
        { type: "quote", id: "q_sp", spaceAfterPx: 20, blocks: [{ type: "paragraph", id: "qp_sp", children: [{ type: "text", text: "引用" }] }] },
        { type: "codeBlock", id: "c_sp", spaceAfterPx: 20, children: [{ type: "text", text: "a" }] },
      ], true);

      expect(html).not.toContain("padding-bottom");
    });

    it("draws a list's space on the list, and an item's space under its last owned line", () => {
      const html = render([{
        type: "list",
        id: "l_sp",
        listType: "bullet",
        spaceAfterPx: 8,
        items: [
          { type: "listItem", id: "li_a", spaceAfterPx: 9, children: [{ type: "text", text: "単独" }] },
          {
            type: "listItem",
            id: "li_b",
            spaceAfterPx: 11,
            children: [{ type: "text", text: "先頭" }],
            continuations: [
              { type: "paragraph", id: "c_1", children: [{ type: "text", text: "続き1" }] },
              { type: "paragraph", id: "c_2", children: [{ type: "text", text: "続き2" }] },
            ],
          },
        ],
      }], true);

      expect(html).toMatch(/<ul style="[^"]*padding-bottom:8px/);
      // 継続行の無い項目は、先頭行が最後の所有本文。
      expect(html).toMatch(/<span style="[^"]*padding-bottom:9px[^"]*" data-sigma-doc-list-item-text/);
      // 継続行のある項目は、最後の継続行だけが引き受ける (先頭行・途中の継続行は押さない)。
      expect(html.match(/padding-bottom:11px/g)).toHaveLength(1);
      expect(html).toMatch(/<p style="[^"]*padding-bottom:11px[^"]*">続き2/);
      expect(html).toMatch(/--sigma-doc-list-item-space-after:11px/);
    });
  });

  it("accepts exactly the blocks a shape can hold", () => {
    expectTypeOf<OverlayTextBlock>().toEqualTypeOf<TextFlowStaticBlockNode>();
  });
});
