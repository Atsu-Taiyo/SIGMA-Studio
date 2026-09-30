import { describe, expect, it } from "vitest";

import type { OverlaySelectionSummary } from "@/components/editor/page-overlay-types";
import type { OverlayShape } from "@/components/editor/overlay-canvas/types";

import {
  fillPreviewPatch,
  planShapeTools,
  readSharedOpacity,
  readSharedStrokeColor,
  readSharedStrokeOpacity,
  strokeColorPatch,
  strokePreviewPatch,
} from "./model";

function summary(shapes: OverlayShape[], patch: Partial<OverlaySelectionSummary> = {}): OverlaySelectionSummary {
  return {
    selectedCount: shapes.length,
    selectedShapeIds: shapes.map((shape) => shape.id),
    selectedShapes: shapes,
    selectedAssets: {},
    locked: false,
    hidden: false,
    grouped: false,
    canAlign: shapes.length >= 2,
    canDistribute: shapes.length >= 3,
    canStyleStroke: false,
    canStyleFill: false,
    canStyleLine: false,
    canStyleLineEndpoints: false,
    arrowheadStart: null,
    arrowheadEnd: null,
    fill: { kind: "unavailable" },
    ...patch,
  };
}

const image = { id: "img", type: "image", x: 0, y: 0, props: { assetId: "a", w: 10, h: 10 } } as OverlayShape;
const croppedImage = {
  id: "img2", type: "image", x: 0, y: 0,
  props: { assetId: "a", w: 10, h: 10, crop: { topLeft: { x: 0, y: 0 }, bottomRight: { x: 0.5, y: 0.5 } } },
} as OverlayShape;
const rect = {
  id: "rect", type: "geo", x: 0, y: 0, opacity: 0.5,
  props: { geo: "rectangle", w: 10, h: 10, color: "#111111", fill: "none", dash: "solid", size: "m" },
} as unknown as OverlayShape;
const line = {
  id: "line", type: "line", x: 0, y: 0,
  props: { kind: "straight", points: [], color: "#111111", dash: "solid", size: "m" },
} as unknown as OverlayShape;
const text = { id: "text", type: "text", x: 0, y: 0, props: { w: 10, h: 10, color: "#111111", size: "m", blocks: [] } } as unknown as OverlayShape;

describe("planShapeTools", () => {
  it("offers crop, replace and reset only for a single image", () => {
    expect(planShapeTools(summary([image])).image).toEqual({ hasCrop: false });
    expect(planShapeTools(summary([croppedImage])).image).toEqual({ hasCrop: true });
    expect(planShapeTools(summary([image, rect])).image).toBeNull();
    expect(planShapeTools(summary([rect])).image).toBeNull();
  });

  it("lets a single rectangle change type, fill and stroke but hides line endpoints", () => {
    const plan = planShapeTools(summary([rect], { canStyleStroke: true, canStyleFill: true, canStyleLine: true }));
    expect(plan).toMatchObject({ shapeType: true, stroke: true, fill: true, lineStyle: true, lineEndpoints: false, single: true });
  });

  it("offers endpoints for an open line", () => {
    const plan = planShapeTools(summary([line], { canStyleStroke: true, canStyleLine: true, canStyleLineEndpoints: true }));
    expect(plan).toMatchObject({ shapeType: true, fill: false, lineEndpoints: true });
  });

  it("gives a text shape the text tools and nothing else shape-specific", () => {
    expect(planShapeTools(summary([text]))).toMatchObject({ text: true, shapeType: false, stroke: false });
  });

  it("leaves the whole-shape opacity to the colour palettes for anything that has a fill or a stroke", () => {
    // `rect` is stored at 0.5 here, so the un-gated answer would be true; the palettes are the way in.
    const opaque = { ...rect, opacity: undefined } as OverlayShape;
    expect(planShapeTools(summary([opaque], { canStyleStroke: true, canStyleFill: true })).opacity).toBe(false);
    expect(planShapeTools(summary([line], { canStyleStroke: true })).opacity).toBe(false);
  });

  it("keeps the whole-shape opacity for shapes with no colour palette to carry it", () => {
    expect(planShapeTools(summary([image])).opacity).toBe(true);
    expect(planShapeTools(summary([text])).opacity).toBe(true);
  });

  it("keeps a way to undo a whole-shape opacity that a figure already stores", () => {
    // Set by the old button or by a document written elsewhere: the palettes do not edit it, so
    // hiding the only control that does would strand the value.
    expect(planShapeTools(summary([rect], { canStyleStroke: true, canStyleFill: true })).opacity).toBe(true);
    // A disagreeing selection cannot say it is at 1 either.
    expect(planShapeTools(summary([rect, line], { canStyleStroke: true })).opacity).toBe(true);
  });

  it("groups and aligns only multi-selections", () => {
    expect(planShapeTools(summary([rect, line]))).toMatchObject({ group: true, align: true, distribute: false, single: false });
    expect(planShapeTools(summary([rect, line, image]))).toMatchObject({ distribute: true });
    expect(planShapeTools(summary([rect]))).toMatchObject({ group: false, ungroup: false, align: false });
  });
});

describe("shared style readers", () => {
  it("reads opacity, treating a missing value as opaque", () => {
    expect(readSharedOpacity([rect])).toBe(0.5);
    expect(readSharedOpacity([line])).toBe(1);
    expect(readSharedOpacity([rect, line])).toBeNull();
  });

  it("reads the stroke opacity, treating a missing value as opaque and skipping shapes with no stroke", () => {
    const faded = { ...line, props: { ...(line as { props: object }).props, strokeOpacity: 0.4 } } as OverlayShape;
    expect(readSharedStrokeOpacity([line])).toBe(1);
    expect(readSharedStrokeOpacity([faded])).toBe(0.4);
    expect(readSharedStrokeOpacity([faded, image])).toBe(0.4);
    expect(readSharedStrokeOpacity([image])).toBeNull();
    expect(readSharedStrokeOpacity([faded, line])).toBeNull();
  });

  it("reads a stroke colour only from shapes that have a stroke", () => {
    expect(readSharedStrokeColor([rect, image])).toBe("#111111");
    expect(readSharedStrokeColor([image])).toBeNull();
    expect(readSharedStrokeColor([rect, { ...line, props: { ...(line as { props: object }).props, color: "#ff0000" } } as OverlayShape])).toBeNull();
  });
});

describe("colour palette patches", () => {
  it("keeps the chosen stroke opacity when a swatch changes only the colour", () => {
    expect(strokeColorPatch("#ff0000", 0.4)).toEqual({ color: "#ff0000" });
    expect(strokeColorPatch("#ff0000", 1)).toEqual({ color: "#ff0000" });
  });

  it("brings an invisible or disagreeing stroke back when a swatch changes its colour", () => {
    // 0% would answer a colour choice with no visible change; a mix has no single value to keep.
    expect(strokeColorPatch("#ff0000", 0)).toEqual({ color: "#ff0000", strokeOpacity: 1 });
    expect(strokeColorPatch("#ff0000", null)).toEqual({ color: "#ff0000", strokeOpacity: 1 });
  });

  it("previews the opacity slider without touching the colour", () => {
    // Writing a colour here would flatten a disagreeing selection onto one shape's value.
    expect(fillPreviewPatch({ color: null, opacity: 0.3 })).toEqual({ fillOpacity: 0.3 });
    expect(strokePreviewPatch({ color: null, opacity: 0.3 })).toEqual({ strokeOpacity: 0.3 });
  });

  it("previews a colour from the dialog together with its opacity", () => {
    expect(fillPreviewPatch({ color: "#33cc66", opacity: 0.35 }))
      .toEqual({ fill: "solid", fillColor: "#33cc66", fillOpacity: 0.35 });
    expect(strokePreviewPatch({ color: "#33cc66", opacity: 0.35 }))
      .toEqual({ color: "#33cc66", strokeOpacity: 0.35 });
  });
});
