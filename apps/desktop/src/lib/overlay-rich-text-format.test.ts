import { getOverlayTextFormatState, overlayTextBlockInlineRuns } from "@/features/document";
import { describe, expect, it } from "vitest";

import type { InlineNode, OverlayTextBlock } from "@/features/document";
import { formatOverlayTextBlocks, fontSizeToOverlaySize } from "@/lib/overlay-rich-text-format";

const doc = (text: string): OverlayTextBlock[] => ([{ type: "paragraph", id: "overlay_rich_text_format_test_63", children: [{ type: "text", text }] }]);

const mathDoc = (): OverlayTextBlock[] => ([{
    type: "paragraph", id: "overlay_rich_text_format_test_64",
    children: [{
      type: "mathInline",
      id: "m1",
      tex: "\\frac{1}{x}",
      display: "inline",
    }],
  }]);

function firstInline(blocks: OverlayTextBlock[]): InlineNode {
  const block = blocks[0];
  if (block.type === "list") {
    return block.items[0].children[0];
  }
  return overlayTextBlockInlineRuns(block)[0];
}

describe("formatOverlayTextBlocks", () => {
  it("sets a numeric size on every run in a selected shape, including math and nested blocks", () => {
    const blocks: OverlayTextBlock[] = [{ type: "quote", id: "quote", blocks: [{
      type: "paragraph", id: "paragraph", children: [
        { type: "text", text: "注記", fontSize: 7.5, marks: ["bold"] },
        { type: "mathInline", id: "math", tex: "x", display: "inline" },
      ],
    }] }];
    const resized = formatOverlayTextBlocks(blocks, "fontSize", "13.5");
    expect(overlayTextBlockInlineRuns(resized[0])).toEqual([
      { type: "text", text: "注記", fontSize: 13.5, marks: ["bold"] },
      { type: "mathInline", id: "math", tex: "x", display: "inline", fontSize: 13.5 },
    ]);
    expect(overlayTextBlockInlineRuns(blocks[0])[0].fontSize).toBe(7.5);
    expect(formatOverlayTextBlocks(blocks, "fontSize", "invalid")).toEqual(blocks);
  });

  it("toggles semantic marks over the whole document", () => {
    const formatted = formatOverlayTextBlocks(doc("Text"), "bold");
    expect(firstInline(formatted).marks).toEqual(["bold"]);
    expect(firstInline(formatOverlayTextBlocks(formatted, "bold")).marks).toBeUndefined();
  });

  it("sets semantic inline style fields directly", () => {
    const colored = formatOverlayTextBlocks(doc("Text"), "color", "#ff0000");
    const highlighted = formatOverlayTextBlocks(colored, "backgroundColor", "#fff3c2");
    const withFont = formatOverlayTextBlocks(highlighted, "fontFamily", "serif");
    expect(firstInline(withFont)).toMatchObject({
      color: "#ff0000",
      backgroundColor: "#fff3c2",
      fontFamily: "serif",
    });
  });

  it("sets boxed text padding and variants as semantic fields", () => {
    const padded = formatOverlayTextBlocks(doc("Text"), "boxedPaddingY", "4");
    expect(firstInline(padded)).toMatchObject({ marks: ["boxed"], boxedPaddingY: 4 });

    const rounded = formatOverlayTextBlocks(padded, "boxedVariant", "oval");
    expect(firstInline(rounded)).toMatchObject({
      marks: ["boxed"],
      boxedPaddingY: 4,
      boxedVariant: "oval",
    });

    const frame = formatOverlayTextBlocks(rounded, "boxedVariant", "frame");
    expect(firstInline(frame).boxedVariant).toBeUndefined();
  });

  it("supports underline and boxed formatting on inline math only", () => {
    const underlined = formatOverlayTextBlocks(mathDoc(), "underline");
    expect(firstInline(underlined).marks).toEqual(["underline"]);
    expect(firstInline(formatOverlayTextBlocks(underlined, "underline")).marks).toBeUndefined();

    const boxed = formatOverlayTextBlocks(mathDoc(), "boxedPaddingY", "5");
    expect(firstInline(boxed)).toMatchObject({ marks: ["boxed"], boxedPaddingY: 5 });

    const oval = formatOverlayTextBlocks(mathDoc(), "boxedVariant", "oval");
    expect(firstInline(oval)).toMatchObject({ marks: ["boxed"], boxedVariant: "oval" });

    expect(firstInline(formatOverlayTextBlocks(mathDoc(), "bold")).marks).toBeUndefined();
    expect(firstInline(formatOverlayTextBlocks(mathDoc(), "italic")).marks).toBeUndefined();
  });

  it("removes the box from a whole shape and keeps the formula and every other format", () => {
    // Issue #210: a box put on a shape's formula could never be taken off again.
    const blocks: OverlayTextBlock[] = [{
      type: "paragraph", id: "boxed_shape", children: [
        { type: "text", text: "注記", marks: ["bold", "boxed"], boxedPaddingY: 3, boxedVariant: "oval", color: "#d00000" },
        { type: "mathInline", id: "m_boxed", tex: "\\frac{1}{x}", display: "inline", semanticRole: "expression",
          marks: ["underline", "boxed"], underlineStyle: "wavy", boxedPaddingY: 3, boxedVariant: "oval", boxedTone: "blue", fontSize: 14 },
      ],
    }];
    expect(getOverlayTextFormatState(blocks)).toEqual({
      bold: true, italic: false, underline: false, boxed: true, boxedPaddingY: 3, boxedVariant: "oval",
    });

    const unboxed = formatOverlayTextBlocks(blocks, "boxed");
    expect(overlayTextBlockInlineRuns(unboxed[0])).toEqual([
      { type: "text", text: "注記", marks: ["bold"], color: "#d00000" },
      { type: "mathInline", id: "m_boxed", tex: "\\frac{1}{x}", display: "inline", semanticRole: "expression",
        marks: ["underline"], underlineStyle: "wavy", fontSize: 14 },
    ]);
    expect(getOverlayTextFormatState(unboxed)).toMatchObject({ bold: true, boxed: false, boxedPaddingY: 0, boxedVariant: "frame" });

    // Boxing it again goes through the same commands the toolbar sends for "add".
    const reboxed = formatOverlayTextBlocks(unboxed, "boxedPaddingY", "3");
    expect(getOverlayTextFormatState(reboxed)).toMatchObject({ boxed: true, boxedPaddingY: 3 });
    expect(overlayTextBlockInlineRuns(reboxed[0])[1]).toMatchObject({ tex: "\\frac{1}{x}", marks: ["underline", "boxed"] });
  });

  it("removes the box from a shape that holds only a boxed formula", () => {
    const boxed = formatOverlayTextBlocks(mathDoc(), "boxedPaddingY", "0");
    expect(getOverlayTextFormatState(boxed).boxed).toBe(true);
    const unboxed = formatOverlayTextBlocks(boxed, "boxed");
    expect(firstInline(unboxed)).toEqual(firstInline(mathDoc()));
    expect(getOverlayTextFormatState(unboxed).boxed).toBe(false);
  });

  it("toggles a partly formatted shape one way instead of swapping its runs", () => {
    const blocks: OverlayTextBlock[] = [{
      type: "paragraph", id: "partly_boxed", children: [
        { type: "text", text: "前" },
        { type: "mathInline", id: "m_partly", tex: "x", display: "inline", marks: ["boxed"] },
      ],
    }];
    expect(getOverlayTextFormatState(blocks).boxed).toBe(false);
    const boxed = formatOverlayTextBlocks(blocks, "boxed");
    expect(overlayTextBlockInlineRuns(boxed[0]).map((run) => run.marks)).toEqual([["boxed"], ["boxed"]]);

    const partlyBold: OverlayTextBlock[] = [{
      type: "paragraph", id: "partly_bold", children: [
        { type: "text", text: "太", marks: ["bold"] },
        { type: "text", text: "細" },
      ],
    }];
    expect(getOverlayTextFormatState(partlyBold).bold).toBe(false);
    expect(overlayTextBlockInlineRuns(formatOverlayTextBlocks(partlyBold, "bold")[0]).map((run) => run.marks))
      .toEqual([["bold"], ["bold"]]);
  });

  it("leaves formulas out of bold and italic, and line-break-only runs out of every toggle", () => {
    const blocks: OverlayTextBlock[] = [{
      type: "paragraph", id: "bold_with_math", children: [
        { type: "text", text: "太字", marks: ["bold", "italic"] },
        { type: "text", text: "\n" },
        { type: "mathInline", id: "m_plain", tex: "y", display: "inline" },
      ],
    }];
    expect(getOverlayTextFormatState(blocks)).toMatchObject({ bold: true, italic: true, boxed: false });
    const unbolded = formatOverlayTextBlocks(blocks, "bold");
    expect(overlayTextBlockInlineRuns(unbolded[0]).map((run) => run.marks)).toEqual([["italic"], undefined, undefined]);
    expect(getOverlayTextFormatState(mathDoc())).toMatchObject({ bold: false, italic: false, boxed: false });
  });

  it("sets semantic paragraph alignment", () => {
    const formatted = formatOverlayTextBlocks(doc("Text"), "textAlign", "center");
    expect(formatted[0].type === "paragraph" ? formatted[0].align : undefined).toBe("center");
  });

  it("reaches the runs inside a list item", () => {
    const list: OverlayTextBlock[] = [{
      type: "list",
      id: "list_1",
      listType: "bullet",
      items: [{ type: "listItem", id: "li_1", children: [{ type: "text", text: "項目" }] }],
    }];

    expect(firstInline(formatOverlayTextBlocks(list, "bold")).marks).toEqual(["bold"]);
  });
});

describe("fontSizeToOverlaySize", () => {
  it("maps toolbar font sizes to overlay text sizes", () => {
    expect(fontSizeToOverlaySize(10)).toBe("s");
    expect(fontSizeToOverlaySize(12)).toBe("m");
    expect(fontSizeToOverlaySize(15)).toBe("l");
    expect(fontSizeToOverlaySize(18)).toBe("xl");
  });
});
