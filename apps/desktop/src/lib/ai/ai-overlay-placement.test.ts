import { describe, expect, it } from "vitest";

import {
  anchorAbsoluteShape,
  getAiOverlayBlockRects,
  resolveAiOverlayPlacement,
  type AiOverlayPlacementInput,
} from "./ai-overlay-placement";
import { resolveShapePosition } from "@/features/drawing";
import type { EstimatedBlockRect, OverlayGeoShape, SigmaBlock, SigmaDocument } from "@/features/document";

const BLOCK_ID = "p_anchor";

function blockRects(rect: Partial<EstimatedBlockRect> = {}): Map<string, EstimatedBlockRect> {
  return new Map([[BLOCK_ID, {
    id: BLOCK_ID,
    left: 100,
    top: 800,
    width: 480,
    height: 40,
    ...rect,
  }]]);
}

function createDocument(content: SigmaBlock[] = []): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_ai_overlay_placement",
    metadata: { title: "AI図形配置" },
    content,
    outputProfiles: {
      student: { showSolutions: false, showHints: false },
      teacher: { showSolutions: true, showHints: true },
      answerBook: { onlySolutions: true, includeAnswers: true },
    },
  };
}

function placement(overrides: Partial<AiOverlayPlacementInput> = {}) {
  return resolveAiOverlayPlacement({
    document: createDocument(),
    blockRects: blockRects(),
    anchorBlockId: BLOCK_ID,
    ...overrides,
  });
}

function geoShape(x: number, y: number, anchor?: OverlayGeoShape["anchor"]): OverlayGeoShape {
  return {
    id: "shape_1",
    type: "geo",
    x,
    y,
    rotation: 0,
    ...(anchor ? { anchor } : {}),
    props: {
      w: 80,
      h: 40,
      geo: "rectangle",
      fill: "none",
      color: "black",
      fillColor: "#ffffff",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  };
}

describe("resolveAiOverlayPlacement", () => {
  it("turns absolute page coordinates into a block-relative anchor delta", () => {
    expect(placement({ x: 140, y: 860 })).toEqual({
      x: 140,
      y: 860,
      anchor: { type: "block", blockId: BLOCK_ID, dx: 40, dy: 60 },
    });
  });

  it("keeps a negative dy when the AI places a shape above the anchor block", () => {
    expect(placement({ x: 100, y: 700 }).anchor).toEqual({
      type: "block",
      blockId: BLOCK_ID,
      dx: 0,
      dy: -100,
    });
  });

  it("pulls an above-placement back onto the canvas instead of leaving it off-page", () => {
    // ページ先頭のブロック (top=68) に対する既定オフセット120pxは、そのままだと y=-52 に
    // なり図形が画面外へ出て選択もできない。デルタは「上に置く」意味を保ったまま、
    // 絶対座標が最小マージンを下回った分だけ引き戻す。
    const result = resolveAiOverlayPlacement({
      document: createDocument(),
      blockRects: blockRects({ top: 68 }),
      anchorBlockId: BLOCK_ID,
      placement: { anchorBlockId: BLOCK_ID, position: "above" },
    });

    expect(result.y).toBe(8);
    expect(result.anchor.dy).toBe(-60);
  });

  it("does not disturb an above-placement that already fits on the canvas", () => {
    const result = resolveAiOverlayPlacement({
      document: createDocument(),
      blockRects: blockRects({ top: 800 }),
      anchorBlockId: BLOCK_ID,
      placement: { anchorBlockId: BLOCK_ID, position: "above" },
    });

    expect(result.y).toBe(680);
    expect(result.anchor.dy).toBe(-120);
  });

  it("pulls a leftOf-placement back when the anchor block starts near the left edge", () => {
    const result = resolveAiOverlayPlacement({
      document: createDocument(),
      blockRects: blockRects({ left: 20 }),
      anchorBlockId: BLOCK_ID,
      placement: { anchorBlockId: BLOCK_ID, position: "leftOf", offsetX: 60 },
    });

    expect(result.x).toBe(8);
    expect(result.anchor.dx).toBe(-12);
  });

  it("falls back to the semantic default (直下24px) when x/y and placement are omitted", () => {
    expect(placement()).toEqual({
      x: 100,
      y: 824,
      anchor: { type: "block", blockId: BLOCK_ID, dx: 0, dy: 24 },
    });
  });

  it("uses only the supplied coordinate and defaults the other axis", () => {
    expect(placement({ y: 900 })).toEqual({
      x: 100,
      y: 900,
      anchor: { type: "block", blockId: BLOCK_ID, dx: 0, dy: 100 },
    });
    expect(placement({ x: 220 })).toEqual({
      x: 220,
      y: 824,
      anchor: { type: "block", blockId: BLOCK_ID, dx: 120, dy: 24 },
    });
  });

  it("derives dx/dy from placement without clamping the offsets", () => {
    expect(placement({
      placement: { anchorBlockId: BLOCK_ID, position: "above", offsetY: 40 },
    })).toEqual({
      x: 100,
      y: 760,
      anchor: { type: "block", blockId: BLOCK_ID, dx: 0, dy: -40 },
    });
    expect(placement({
      placement: { anchorBlockId: BLOCK_ID, position: "leftOf", offsetX: 60 },
    }).anchor).toMatchObject({ dx: -60, dy: 0 });
  });

  // スキーマは below/rightOf の offset を「ブロック端からの距離」と宣言している。
  // ブロックの高さ・幅を足さないと offset=8 が「ブロック上端から8px」になり、
  // 図形がアンカーブロックの本文に重なる。
  it("measures below/rightOf from the far edge of the anchor block", () => {
    expect(placement({
      placement: { anchorBlockId: BLOCK_ID, position: "below", offsetY: 8 },
    }).anchor).toMatchObject({ dx: 0, dy: 48 });
    expect(placement({
      placement: { anchorBlockId: BLOCK_ID, position: "below" },
    }).anchor).toMatchObject({ dy: 48 });
    expect(placement({
      placement: { anchorBlockId: BLOCK_ID, position: "rightOf" },
    }).anchor).toMatchObject({ dx: 488, dy: 0 });
  });

  it("keeps below/rightOf offsets usable when the anchor rect is unknown", () => {
    expect(resolveAiOverlayPlacement({
      document: createDocument(),
      blockRects: new Map(),
      anchorBlockId: BLOCK_ID,
      placement: { anchorBlockId: BLOCK_ID, position: "below", offsetY: 12 },
    }).anchor).toMatchObject({ dy: 12 });
  });

  it("anchors to placement.anchorBlockId rather than the insertion target", () => {
    const result = resolveAiOverlayPlacement({
      document: createDocument(),
      blockRects: blockRects(),
      anchorBlockId: "other_block",
      placement: { anchorBlockId: BLOCK_ID, position: "below" },
    });

    expect(result.anchor.blockId).toBe(BLOCK_ID);
  });

  it("keeps reserveSpace on the anchor only when it is specified", () => {
    expect(placement({ reserveSpace: true }).anchor).toMatchObject({ reserveSpace: true });
    expect("reserveSpace" in placement().anchor).toBe(false);
  });

  it("falls back to raw deltas when the anchor block rect cannot be estimated", () => {
    const result = resolveAiOverlayPlacement({
      document: createDocument(),
      blockRects: new Map(),
      anchorBlockId: BLOCK_ID,
    });

    expect(result).toEqual({
      x: 0,
      y: 24,
      anchor: { type: "block", blockId: BLOCK_ID, dx: 0, dy: 24 },
    });
    expect(resolveAiOverlayPlacement({
      document: createDocument(),
      blockRects: new Map(),
      anchorBlockId: BLOCK_ID,
      x: 140,
      y: 860,
    })).toEqual({
      x: 140,
      y: 860,
      anchor: { type: "block", blockId: BLOCK_ID, dx: 140, dy: 860 },
    });
  });

  it("satisfies the renderer invariant: resolveShapePosition reproduces the requested position", () => {
    const rects = blockRects();
    for (const input of [
      { x: 140, y: 860 },
      { x: 0, y: 0 },
      { x: 320, y: 1600 },
      {},
    ]) {
      const result = placement(input);
      const resolved = resolveShapePosition(
        { x: result.x, y: result.y, anchor: result.anchor },
        rects,
      );
      expect({ x: resolved.x, y: resolved.y }).toEqual({ x: result.x, y: result.y });
    }
  });
});

describe("anchorAbsoluteShape", () => {
  it("derives the anchor delta from the shape's absolute coordinates", () => {
    const result = anchorAbsoluteShape(geoShape(140, 860), {
      document: createDocument(),
      blockRects: blockRects(),
      anchorBlockId: BLOCK_ID,
    });

    expect(result.x).toBe(140);
    expect(result.y).toBe(860);
    expect(result.anchor).toEqual({ type: "block", blockId: BLOCK_ID, dx: 40, dy: 60 });
  });

  it("converts a page anchor into a block anchor that preserves the absolute position", () => {
    const result = anchorAbsoluteShape(geoShape(140, 860, { type: "page" }), {
      document: createDocument(),
      blockRects: blockRects(),
      anchorBlockId: BLOCK_ID,
    });

    expect(result.anchor).toEqual({ type: "block", blockId: BLOCK_ID, dx: 40, dy: 60 });
    expect(resolveShapePosition(result, blockRects())).toMatchObject({ x: 140, y: 860 });
  });

  it("keeps an existing block anchor when force is not requested", () => {
    const shape = geoShape(140, 860, { type: "block", blockId: "keep_me", dx: 1, dy: 2 });
    const result = anchorAbsoluteShape(shape, {
      document: createDocument(),
      blockRects: blockRects(),
      anchorBlockId: BLOCK_ID,
    });

    expect(result).toBe(shape);
  });

  it("preserves a shape-to-shape anchor even when force is requested", () => {
    const shape = geoShape(140, 860, { type: "shape", shapeId: "parent_shape", dx: 4, dy: 6 });
    const result = anchorAbsoluteShape(shape, {
      document: createDocument(),
      blockRects: blockRects(),
      anchorBlockId: BLOCK_ID,
      force: true,
    });

    expect(result).toBe(shape);
  });

  it("replaces an existing block anchor when force is requested", () => {
    const shape = geoShape(140, 860, { type: "block", blockId: "stale", dx: 1, dy: 2 });
    const result = anchorAbsoluteShape(shape, {
      document: createDocument(),
      blockRects: blockRects(),
      anchorBlockId: BLOCK_ID,
      force: true,
    });

    expect(result.anchor).toEqual({ type: "block", blockId: BLOCK_ID, dx: 40, dy: 60 });
  });

  it("keeps the shape's absolute coordinates as the anchor delta when the block rect is unknown", () => {
    const result = anchorAbsoluteShape(geoShape(140, 860), {
      document: createDocument(),
      blockRects: new Map(),
      anchorBlockId: BLOCK_ID,
    });

    expect(result.anchor).toEqual({ type: "block", blockId: BLOCK_ID, dx: 140, dy: 860 });
  });
});

describe("getAiOverlayBlockRects", () => {
  const paragraphDocument = createDocument([
    { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] },
  ]);

  it("memoizes the estimate per document instance", () => {
    expect(getAiOverlayBlockRects(paragraphDocument)).toBe(getAiOverlayBlockRects(paragraphDocument));
  });

  it("re-estimates for a different document instance", () => {
    const other = createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "別本文" }] },
    ]);

    expect(getAiOverlayBlockRects(other)).not.toBe(getAiOverlayBlockRects(paragraphDocument));
  });

  it("is used as the default rect source when blockRects is omitted", () => {
    const rect = getAiOverlayBlockRects(paragraphDocument).get("p_1")!;

    expect(resolveAiOverlayPlacement({
      document: paragraphDocument,
      anchorBlockId: "p_1",
      x: rect.left + 12,
      y: rect.top + 34,
    }).anchor).toMatchObject({ dx: 12, dy: 34 });

    const shape = geoShape(rect.left + 12, rect.top + 34);
    expect(anchorAbsoluteShape(shape, {
      document: paragraphDocument,
      anchorBlockId: "p_1",
    }).anchor).toMatchObject({ dx: 12, dy: 34 });
  });
});
