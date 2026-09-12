import { overlayTextBlockInlineRuns } from "@/features/document";
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
