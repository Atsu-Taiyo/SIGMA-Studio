import { describe, expect, it } from "vitest";

import {
  getResizeHandleSet,
  getSelectionResizeFrame,
  getShapeBounds,
  getTextShapeFontSizePt,
  MIN_TEXT_SHAPE_WIDTH,
  resizeBoxShape,
  resizeBounds,
  resizeRotatedShapeToVisualBounds,
  resizeShapesToBounds,
} from "@/features/drawing";

import type { MeasuredBlock } from "./anchor";
import { reanchorShapesByPosition } from "./reanchor-model";
import { buildInsertShape } from "./shapes/create-shape";
import type { OverlayShape } from "./types";

type TextShape = Extract<OverlayShape, { type: "text" }>;

function textShape(overrides: Partial<TextShape> = {}, props: Partial<TextShape["props"]> = {}): TextShape {
  return {
    id: "shape_text",
    type: "text",
    x: 100,
    y: 200,
    rotation: 0,
    props: {
      w: 160,
      h: 16,
      color: "#111827",
      size: "m",
      blocks: [{ type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] }],
      ...props,
    },
    ...overrides,
  };
}

/** The bounds a drag on `handle` produces, the way the interaction resolves them. */
function draggedBounds(shape: TextShape, handle: "e" | "w", dx: number) {
  return resizeBounds(getShapeBounds(shape), handle, dx, 0);
}

/** Where a turned box's top-left corner lands on the page (it spins around the box's centre). */
function rotatedTopLeftPagePoint(shape: TextShape): { x: number; y: number } {
  const bounds = getShapeBounds(shape);
  const dx = -bounds.w / 2;
  const dy = -bounds.h / 2;
  const cos = Math.cos(shape.rotation ?? 0);
  const sin = Math.sin(shape.rotation ?? 0);
  return {
    x: bounds.x + bounds.w / 2 + dx * cos - dy * sin,
    y: bounds.y + bounds.h / 2 + dx * sin + dy * cos,
  };
}

describe("resizing a text shape", () => {
  it("changes only the width from the east handle, and never the type size", () => {
    const shape = textShape();

    const resized = resizeBoxShape(shape, draggedBounds(shape, "e", 90)) as TextShape;

    expect(resized.x).toBe(shape.x);
    expect(resized.y).toBe(shape.y);
    expect(resized.props.w).toBe(250);
    expect(getTextShapeFontSizePt(resized)).toBe(getTextShapeFontSizePt(shape));
    expect(resized.props.size).toBe(shape.props.size);
  });

  it("moves the left edge and the width together from the west handle", () => {
    const shape = textShape();

    const resized = resizeBoxShape(shape, draggedBounds(shape, "w", -40)) as TextShape;

    expect(resized.x).toBe(60);
    expect(resized.props.w).toBe(200);
    // The right edge is what the author is not dragging, so it stays where it was.
    expect(resized.x + resized.props.w).toBe(shape.x + shape.props.w);
  });

  /**
   * Dragging the left edge past the minimum used to keep sliding the box: `x` followed the pointer
   * while `w` stopped at the clamp, so the shape walked away leftwards under the cursor.
   */
  it("pins the edge it is not dragging when the width clamps", () => {
    const shape = textShape();
    const rightEdge = shape.x + shape.props.w;

    // Both drags leave a width under the minimum without crossing the far edge (past it the box
    // flips, which is the normal behaviour of every shape and not the clamp).
    const far = resizeBoxShape(shape, draggedBounds(shape, "w", 155)) as TextShape;
    const farther = resizeBoxShape(shape, draggedBounds(shape, "w", 158)) as TextShape;

    expect(far.props.w).toBe(MIN_TEXT_SHAPE_WIDTH);
    expect(farther.props.w).toBe(MIN_TEXT_SHAPE_WIDTH);
    expect(far.x).toBe(rightEdge - MIN_TEXT_SHAPE_WIDTH);
    expect(farther.x).toBe(far.x);
  });

  it("clamps an east drag to the minimum width without moving the box", () => {
    const shape = textShape();

    const resized = resizeBoxShape(shape, draggedBounds(shape, "e", -155)) as TextShape;

    expect(resized.props.w).toBe(MIN_TEXT_SHAPE_WIDTH);
    expect(resized.x).toBe(shape.x);
  });

  /**
   * PR #447: a shape's position is held in two places — `x`/`y` and the anchor's offset — and the
   * anchor wins when the document is read back. A resize that moved `x` without re-anchoring
   * looked right until the next load, then snapped back.
   */
  it("survives the save round trip after a west-edge resize", () => {
    const blocks: MeasuredBlock[] = [{ id: "block_1", top: 150, left: 0, width: 600 }];
    const shape = textShape({
      anchor: { type: "block", blockId: "block_1", dy: 50, dx: 100 },
    });

    const resized = resizeBoxShape(shape, draggedBounds(shape, "w", -40)) as TextShape;
    const [reanchored] = reanchorShapesByPosition([resized], new Set([resized.id]), blocks) as TextShape[];

    expect(reanchored.x).toBe(60);
    // The stored offset is what the loader reads, so it has to describe the new position.
    expect(reanchored.anchor).toEqual({ type: "block", blockId: "block_1", dx: 60, dy: 50 });
  });

  /**
   * A turned shape resizes through the rotated path, which holds the edge opposite the handle
   * fixed on the page. Widening it must still be a width change and nothing else — the earlier
   * behaviour scaled the glyphs, which on a rotated shape also moved the box under the pointer.
   */
  it("keeps a rotated shape's width resize a width change", () => {
    const shape = textShape({ rotation: Math.PI / 4 });
    const frame = getSelectionResizeFrame([shape], [shape])!;

    const resized = resizeRotatedShapeToVisualBounds(
      shape,
      frame,
      resizeBounds(frame.visual, "e", 60, 0),
      "e",
    ) as TextShape;

    expect(resized.props.w).toBeGreaterThan(shape.props.w);
    expect(resized.rotation).toBe(shape.rotation);
    expect(getTextShapeFontSizePt(resized)).toBe(getTextShapeFontSizePt(shape));
    expect(resized.props.size).toBe(shape.props.size);
  });

  /**
   * The rotated path holds the *midpoint* of the edge opposite the handle, so a height that
   * changed mid-resize would move the box by half of that change along its local vertical rather
   * than growing downwards. It does not, and this pins why: both measurements derive the height
   * from the content, so the stored `props.h` catching up (16 → 48 here) is invisible to the fixed
   * point. A height that genuinely changes arrives later from the DOM and is corrected at the
   * `updateShape` funnel by `preserveRotatedTextResizeTopLeft`.
   */
  it("grows a rotated shape's derived height without moving the box", () => {
    const paragraph = (id: string, text: string) => ({
      type: "paragraph" as const,
      id,
      children: [{ type: "text" as const, text }],
    });
    // Three paragraphs against a stored one-line height: the resize itself re-derives 16 → 48.
    const shape = textShape({ rotation: Math.PI / 4 }, {
      blocks: [paragraph("p_1", "あ"), paragraph("p_2", "い"), paragraph("p_3", "う")],
    });
    const frame = getSelectionResizeFrame([shape], [shape])!;

    const resized = resizeRotatedShapeToVisualBounds(
      shape,
      frame,
      resizeBounds(frame.visual, "e", 40, 0),
      "e",
    ) as TextShape;

    const before = rotatedTopLeftPagePoint(shape);
    const after = rotatedTopLeftPagePoint(resized);

    expect(resized.props.h).toBe(48);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  /**
   * A shape inside a group is drawn at its stored coordinates — the group's own anchor is what
   * hangs the whole thing off the body, and members inherit it rather than carrying one of their
   * own. So a member's resize has to survive the two passes that run after it: re-anchoring (which
   * skips members) and the load-time resolve (which re-derives every member's `x`/`y`).
   */
  it("keeps a group member where the resize put it, through re-anchor and resolve", () => {
    const blocks: MeasuredBlock[] = [{ id: "block_1", top: 150, left: 0, width: 600 }];
    const group: OverlayShape = {
      id: "group_1",
      type: "group",
      x: 100,
      y: 200,
      rotation: 0,
      anchor: { type: "block", blockId: "block_1", dy: 50, dx: 100 },
      props: { w: 160, h: 16 },
    };
    const member = textShape({ parentId: "group_1" });

    const resized = resizeBoxShape(member, draggedBounds(member, "w", -40)) as TextShape;
    // `reanchorShapesByPosition` runs the whole save pass: members inherit the group's anchor and
    // every position is then re-derived from the anchors, which is where a member that only wrote
    // `x` would snap back.
    const saved = reanchorShapesByPosition([group, resized], new Set([resized.id]), blocks);
    const savedMember = saved.find((shape) => shape.id === member.id) as TextShape;

    expect(savedMember.x).toBe(60);
    expect(savedMember.props.w).toBe(200);
    expect(savedMember.parentId).toBe("group_1");
  });
});

describe("resizing a selection that contains a text shape", () => {
  /**
   * Scaling a group used to scale the glyphs with it. A text shape only takes the horizontal
   * factor now: its height comes from its content, and its type size is not geometry.
   */
  it("applies the horizontal factor only", () => {
    const shape = textShape();
    const from = { x: 100, y: 200, w: 160, h: 16 };
    const to = { x: 100, y: 200, w: 320, h: 64 };

    const [resized] = resizeShapesToBounds([shape], from, to) as TextShape[];

    expect(resized.props.w).toBe(320);
    expect(getTextShapeFontSizePt(resized)).toBe(getTextShapeFontSizePt(shape));
    // The vertical factor is 4×; the height stays the content's, so it is not 64.
    expect(resized.props.h).toBe(shape.props.h);
  });

  /**
   * The clamp pins the edge the author is not dragging, which on a single shape is read off the
   * bounds. A scaled selection moves *both* edges, and treating that as a west drag would pin the
   * member's right edge and pop it out of the box the rest of the selection is following.
   */
  it("keeps a member that scales below the minimum inside the scaled box", () => {
    const shape = textShape();
    const from = { x: 100, y: 200, w: 160, h: 16 };
    const to = { x: 100, y: 200, w: 4, h: 16 };

    const [resized] = resizeShapesToBounds([shape], from, to) as TextShape[];

    expect(resized.props.w).toBe(MIN_TEXT_SHAPE_WIDTH);
    expect(resized.x).toBe(100);
  });
});

describe("the handles a selection offers", () => {
  it("gives a text shape its two width handles and nothing else", () => {
    expect(getResizeHandleSet([{ type: "text" }])).toEqual({ hitOnly: [], visible: ["e", "w"] });
  });

  it("keeps every other single selection on the handles it had", () => {
    expect(getResizeHandleSet([{ type: "tableShape" }]).visible).toEqual(["nw", "ne", "sw", "se"]);
    expect(getResizeHandleSet([{ type: "arc" }])).toEqual({
      hitOnly: ["n", "e", "s", "w"],
      visible: ["nw", "ne", "sw", "se"],
    });
    expect(getResizeHandleSet([{ type: "geo" }]).visible).toHaveLength(8);
  });

  it("offers the full set for a multi-shape selection, text included", () => {
    expect(getResizeHandleSet([{ type: "text" }, { type: "geo" }]).visible).toHaveLength(8);
  });
});

describe("creating a text shape", () => {
  it("takes the drag width when the author dragged one", () => {
    const shape = buildInsertShape(
      { kind: "insert", command: "text" },
      { x: 20, y: 30 },
      { x: 260, y: 44 },
      "shape_new",
    ) as TextShape;

    expect(shape.props.w).toBe(240);
    expect(shape.props.h).toBe(16);
  });

  /**
   * A click is a drag of no width. The box still has to be usable straight away — the width is the
   * author's from the first moment now, so there is no "fits the content" fallback behind it.
   */
  it("takes the default width from a click", () => {
    const shape = buildInsertShape(
      { kind: "insert", command: "text" },
      { x: 20, y: 30 },
      { x: 20, y: 30 },
      "shape_new",
    ) as TextShape;

    expect(shape.props.w).toBe(192);
    expect(shape.props.w).toBeGreaterThan(MIN_TEXT_SHAPE_WIDTH);
  });

  /**
   * A narrow drag is still a width the author asked for, widened to the narrowest box the model
   * allows. The same builder draws the ghost that follows the pointer, so substituting the default
   * here would make every text drag start as a wide box that then snaps to the pointer.
   */
  it("keeps a narrow drag narrow instead of jumping to the default", () => {
    const shape = buildInsertShape(
      { kind: "insert", command: "text" },
      { x: 20, y: 30 },
      { x: 23, y: 74 },
      "shape_new",
    ) as TextShape;

    expect(shape.props.w).toBe(MIN_TEXT_SHAPE_WIDTH);
  });
});
