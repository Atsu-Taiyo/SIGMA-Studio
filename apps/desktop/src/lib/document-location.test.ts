import { describe, expect, it } from "vitest";
import type { SigmaCommentAnchor } from "@/features/document";
import { decodeDocumentLocation, encodeDocumentLocation } from "./document-location";

describe("document location", () => {
  it.each<SigmaCommentAnchor>([
    { type: "block", blockId: "日本語 & #" },
    { type: "inlineMath", blockId: "p", mathInlineId: "m" },
    { type: "textRange", start: { blockId: "p", offset: 2 }, end: { blockId: "q", offset: 5 }, quote: "" },
    { type: "overlayShape", shapeIds: ["shape-1", "shape-2"] },
    { type: "overlayMath", shapeId: "shape-1" },
    { type: "canvasRegion", bounds: { x: -10, y: 30, w: 500, h: 100 } },
  ])("round trips $type model coordinates", anchor => {
    expect(decodeDocumentLocation(encodeDocumentLocation(anchor))).toEqual(anchor);
  });
  it("keeps selected prose and formulas out of links", () => {
    const encoded = encodeDocumentLocation({ type: "textRange", start: { blockId: "p", offset: 0 }, end: { blockId: "p", offset: 2 }, quote: "private prose", mathTex: ["private formula"] });
    expect(encoded).not.toContain("private");
    expect(decodeDocumentLocation(encoded)).toMatchObject({ quote: "" });
  });
  it.each([null, "{", "x".repeat(1801), JSON.stringify({ type: "document" }), JSON.stringify({ type: "block", blockId: "" }), JSON.stringify({ type: "overlayMath" }), JSON.stringify({ type: "overlayShape", shapeIds: [] }), JSON.stringify({ type: "textRange", start: { blockId: "p", offset: -1 }, end: { blockId: "p", offset: 2 } })])("rejects invalid locations %s", value => {
    expect(decodeDocumentLocation(value)).toBeNull();
  });
});
