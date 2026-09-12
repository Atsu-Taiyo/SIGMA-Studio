import { describe, expect, it } from "vitest";

import type { OverlayCalloutShape, OverlayTextBlock, OverlayTextShape } from "@/features/document";

import { CALLOUT_TEXT_PADDING } from "./text-shape-font";
import { getCalloutBodySize, getTextShapeEffectiveSize } from "./overlay-text-box";

let blockId = 0;

function blocksOf(text: string): OverlayTextBlock[] {
  return [{
    type: "paragraph",
    id: `p_${blockId += 1}`,
    children: [{ type: "text", text }],
  }];
}

function listOf(...items: string[]): OverlayTextBlock[] {
  return [{
    type: "list",
    id: `list_${blockId += 1}`,
    listType: "bullet",
    items: items.map((text) => ({
      type: "listItem",
      id: `li_${blockId += 1}`,
      children: [{ type: "text", text }],
    })),
  }];
}

function textShape(props: Partial<OverlayTextShape["props"]> = {}): OverlayTextShape {
  return {
    id: "text",
    type: "text",
    x: 0,
    y: 0,
    props: {
      w: 100,
      h: 16,
      blocks: blocksOf("a"),
      color: "black",
      size: "m",
      ...props,
    },
  };
}

describe("getTextShapeEffectiveSize", () => {
  it("keeps the user's width, clamped to the minimum", () => {
    expect(getTextShapeEffectiveSize(textShape({ w: 240 })).w).toBe(240);
    expect(getTextShapeEffectiveSize(textShape({ w: 1 })).w).toBe(8);
  });

  it("keeps the stored height when it already covers the content", () => {
    expect(getTextShapeEffectiveSize(textShape({ w: 200, h: 400 })).h).toBe(400);
  });

  it("floors the height at one line box per hard line, so a stale cache cannot clip", () => {
    // Three lines from the content's own breaks; the stored 16 is one line box behind.
    const shape = textShape({ w: 200, h: 16, blocks: blocksOf("a\nb\nc") });

    expect(getTextShapeEffectiveSize(shape).h).toBe(48);
  });

  it("counts one line per list item in that floor", () => {
    const shape = textShape({ w: 200, h: 16, blocks: listOf("a", "b", "c") });

    expect(getTextShapeEffectiveSize(shape).h).toBe(48);
  });

  it("does not change the height when the width changes (the font size is independent)", () => {
    const narrow = textShape({ w: 32, h: 16, blocks: blocksOf("ああああああああああ") });
    const wide = textShape({ w: 320, h: 16, blocks: blocksOf("ああああああああああ") });

    expect(getTextShapeEffectiveSize(narrow).h).toBe(getTextShapeEffectiveSize(wide).h);
  });

  it("feeds fontSize and size into the line-box floor", () => {
    const text = blocksOf("a\nb\nc");

    const small = textShape({ h: 1, size: "s", blocks: text });
    const large = textShape({ h: 1, size: "l", blocks: text });
    expect(getTextShapeEffectiveSize(large).h).toBeGreaterThan(getTextShapeEffectiveSize(small).h);

    const basePt = textShape({ h: 1, size: "m", fontSize: 9, blocks: text });
    const biggerPt = textShape({ h: 1, size: "m", fontSize: 30, blocks: text });
    expect(getTextShapeEffectiveSize(biggerPt).h).toBeGreaterThan(getTextShapeEffectiveSize(basePt).h);
  });

  it("never mutates the shape it measures", () => {
    const shape = textShape({ w: 32, h: 16, blocks: blocksOf("ああああああああああ") });
    const before = structuredClone(shape);

    getTextShapeEffectiveSize(shape);

    expect(shape).toEqual(before);
  });
});

function calloutShape(props: Partial<OverlayCalloutShape["props"]> = {}): OverlayCalloutShape {
  return {
    id: "callout",
    type: "callout",
    x: 0,
    y: 0,
    props: {
      w: 160,
      h: 72,
      radius: 18,
      tail: {
        baseStart: { x: 36, y: 72 },
        baseEnd: { x: 68, y: 72 },
        tip: { x: 24, y: 100 },
      },
      blocks: blocksOf("a"),
      color: "black",
      size: "m",
      dash: "solid",
      strokeWidth: "m",
      ...props,
    },
  };
}

describe("getCalloutBodySize", () => {
  it("never grows the width past the stored value", () => {
    const shape = calloutShape({ blocks: blocksOf("説明".repeat(30)) });

    expect(getCalloutBodySize(shape).w).toBe(shape.props.w);
  });

  it("grows the height to fit the content's own lines plus padding on both sides", () => {
    const shape = calloutShape({ h: 40, blocks: blocksOf("a\nb\nc\nd") });

    const body = getCalloutBodySize(shape);

    expect(body.h).toBe(4 * 16 + CALLOUT_TEXT_PADDING * 2);
    expect(body.h).toBeGreaterThan(shape.props.h);
  });

  it("never shrinks below the stored height (grow-only)", () => {
    const shape = calloutShape({ h: 400, blocks: blocksOf("short") });

    expect(getCalloutBodySize(shape).h).toBe(400);
  });

  it("never mutates the shape it measures", () => {
    const shape = calloutShape({ blocks: blocksOf("説明".repeat(20)) });
    const before = structuredClone(shape);

    getCalloutBodySize(shape);

    expect(shape).toEqual(before);
  });
});
