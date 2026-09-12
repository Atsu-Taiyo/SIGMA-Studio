import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { tiptapNodesToInlineNodes } from "@/lib/tiptap-adapter";

import { InlineContent, renderInlineContent } from "./InlineContent";

describe("React inline-content rendering adapter", () => {
  it("renders inline math with the same body math wrapper", () => {
    const html = renderToStaticMarkup(
      <>{renderInlineContent([
        { type: "text", text: "面積は " },
        { type: "mathInline", id: "m_1", tex: "x^2", display: "inline" },
      ])}</>,
    );

    expect(html).toContain("inline-math-node");
    expect(html).toContain("math-preview-inline");
    expect(html).toContain('data-sigma-doc-math-inline=""');
    expect(html).toContain('data-id="m_1"');
  });

  it("renders text marks like the document body", () => {
    const html = renderToStaticMarkup(
      <>{renderInlineContent([
        { type: "text", text: "太字", marks: ["bold"] },
        { type: "text", text: "斜体", marks: ["italic"] },
        { type: "text", text: "下線", marks: ["underline"] },
      ])}</>,
    );

    expect(html).toContain("<strong>太字</strong>");
    expect(html).toContain("<em>斜体</em>");
    expect(html).toContain('class="sigma-underline-run"');
    expect(html).toContain(">下線</span>");
  });

  it("renders adjacent underlined text and math as one underline run", () => {
    const html = renderToStaticMarkup(
      <>{renderInlineContent([
        { type: "text", text: "辺", marks: ["underline"] },
        { type: "mathInline", id: "m_underlined", tex: "\\overline{PQ}", display: "inline", marks: ["underline"] },
        { type: "text", text: "です", marks: ["underline"] },
      ])}</>,
    );

    expect(html).toContain('class="sigma-underline-run"');
    expect(html).toContain('data-id="m_underlined"');
    expect(html).not.toContain("<u>");
  });

  it("does not connect underline runs across unmarked content", () => {
    const html = renderToStaticMarkup(
      <>{renderInlineContent([
        { type: "text", text: "A", marks: ["underline"] },
        { type: "text", text: " " },
        { type: "mathInline", id: "m_split", tex: "x", display: "inline", marks: ["underline"] },
      ])}</>,
    );

    expect(html.match(/class="sigma-underline-run"/g)).toHaveLength(2);
  });

  it("renders boxed runs with variant and tone attributes", () => {
    const html = renderToStaticMarkup(
      <>{renderInlineContent([
        { type: "text", text: "枠", marks: ["boxed"], boxedVariant: "shade", boxedTone: "blue" },
        { type: "mathInline", id: "m_2", tex: "a+b", display: "inline", marks: ["boxed"], boxedVariant: "shade", boxedTone: "blue" },
      ])}</>,
    );

    expect(html).toContain("boxed-text");
    expect(html).toContain('data-sigma-doc-boxed-variant="shade"');
    expect(html).toContain('data-sigma-doc-boxed-tone="blue"');
    expect(html).toContain('data-boxed-run-id="inline-boxed-run-0"');
    expect(html).toContain('data-boxed-run-connect-right="true"');
    expect(html).toContain('data-boxed-run-connect-left="true"');
    expect(html).toContain("boxed-inline-math");
  });

  it("keeps unboxed visible spaces from connecting boxed segments", () => {
    const html = renderToStaticMarkup(
      <>{renderInlineContent([
        { type: "text", text: "A", marks: ["boxed"] },
        { type: "text", text: " " },
        { type: "mathInline", id: "m_gap", tex: "x", display: "inline", marks: ["boxed"] },
      ])}</>,
    );

    expect(html).toContain('data-boxed-run-id="inline-boxed-run-0"');
    expect(html).toContain('data-boxed-run-id="inline-boxed-run-1"');
    expect(html).not.toContain("data-boxed-run-connect-left");
    expect(html).not.toContain("data-boxed-run-connect-right");
  });

  it("renders mixed Tiptap text and math through the same boxed run path as body text", () => {
    const inlineNodes = tiptapNodesToInlineNodes([
      { type: "text", text: "辺", marks: [{ type: "boxed", attrs: { paddingY: 2, variant: "double" } }] },
      { type: "mathInline", attrs: { id: "m_mixed", tex: "\\overline{PQ}" }, marks: [{ type: "boxed", attrs: { paddingY: 2, variant: "double", math: true } }] },
      { type: "text", text: "です", marks: [{ type: "boxed", attrs: { paddingY: 2, variant: "double" } }] },
    ]);
    const html = renderToStaticMarkup(<>{renderInlineContent(inlineNodes, { keyPrefix: "overlay-preview" })}</>);

    expect(html).toContain("boxed-text");
    expect(html).toContain("boxed-inline-math");
    expect(html).toContain('data-sigma-doc-boxed-padding-y="2"');
    expect(html).toContain('data-sigma-doc-boxed-variant="double"');
    expect(html).toContain('data-boxed-run-id="overlay-preview-boxed-run-0"');
    expect(html).toContain('data-boxed-run-connect-right="true"');
    expect(html).toContain('data-boxed-run-connect-left="true"');
    expect(html).toContain('data-id="m_mixed"');
  });
});

describe("inline content CSS injection", () => {
  // This component is also rendered through `renderToStaticMarkup` for the SVG export (table cell
  // paragraphs and trend labels), where React writes style object values into the attribute
  // without escaping `;`. The live DOM never shows this because CSSOM discards the malformed
  // value, so the exported string is what has to be measured.
  const INJECTED = "red;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#fff;z-index:2147483647";

  it("drops an injected inline color instead of writing extra declarations", () => {
    const html = renderToStaticMarkup(
      <>{renderInlineContent([{ type: "text", text: "x", color: INJECTED }])}</>,
    );

    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("z-index:2147483647");
  });

  it("drops an injected inline fontFamily and backgroundColor", () => {
    const html = renderToStaticMarkup(
      <>{renderInlineContent([{
        type: "text",
        text: "x",
        backgroundColor: INJECTED,
        fontFamily: "serif;}html{display:none",
      }])}</>,
    );

    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("display:none");
  });

  it("keeps the inline styling the settings UI produces", () => {
    const html = renderToStaticMarkup(
      <>{renderInlineContent([{
        type: "text",
        text: "x",
        color: "#1f2937",
        fontFamily: "KaTeX_Main, serif",
      }])}</>,
    );

    expect(html).toContain("color:#1f2937");
    expect(html).toContain("KaTeX_Main, serif");
  });
});

describe("InlineContent", () => {
  it("wraps content in the shared rich-inline-content class", () => {
    const html = renderToStaticMarkup(
      <InlineContent nodes={[{ type: "text", text: "hello" }]} />,
    );

    expect(html).toContain("rich-inline-content");
  });
});
