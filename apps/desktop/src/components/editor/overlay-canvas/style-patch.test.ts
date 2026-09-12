import { describe, expect, it } from "vitest";

import { applyStylePatchToShape, canShapeStyleFill, sharedFill } from "./style-patch";
import type { OverlayShape } from "./types";

/**
 * The toolbar used to show "the last value applied" rather than the selection's own fill, so
 * reopening the palette on a saved figure showed the wrong colour and a mixed selection showed one
 * arbitrary shape's value. `sharedFill` is what makes the toolbar read the document.
 */

function rectangle(props: Partial<Record<string, unknown>> = {}): OverlayShape {
  return {
    id: `shape_${Math.random().toString(36).slice(2)}`,
    type: "geo",
    x: 0,
    y: 0,
    props: {
      geo: "rectangle",
      w: 100,
      h: 60,
      fill: "solid",
      fillColor: "#ff0000",
      color: "#111827",
      labelColor: "#111827",
      dash: "solid",
      size: "m",
      ...props,
    },
  } as OverlayShape;
}

function sector(props: Partial<Record<string, unknown>> = {}): OverlayShape {
  return {
    id: "shape_sector",
    type: "arc",
    x: 0,
    y: 0,
    props: {
      kind: "sector",
      r: 40,
      startAngle: 0,
      endAngle: Math.PI / 2,
      fill: "solid",
      fillColor: "#ff0000",
      color: "#111827",
      dash: "solid",
      size: "m",
      ...props,
    },
  } as OverlayShape;
}

function closedPolyline(props: Partial<Record<string, unknown>> = {}): OverlayShape {
  return {
    id: "shape_closed",
    type: "line",
    x: 0,
    y: 0,
    props: {
      kind: "polyline",
      points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 30 }],
      closed: true,
      fill: "solid",
      fillColor: "#ff0000",
      color: "#111827",
      labelColor: "#111827",
      dash: "solid",
      size: "m",
      ...props,
    },
  } as OverlayShape;
}

const textShape = {
  id: "shape_text",
  type: "text",
  x: 0,
  y: 0,
  props: { w: 100, h: 16, blocks: [], color: "#111827", size: "m" },
} as OverlayShape;

describe("sharedFill", () => {
  it("reports the shared colour and opacity when every shape agrees", () => {
    const shapes = [
      rectangle({ fillOpacity: 0.35 }),
      sector({ fillOpacity: 0.35 }),
      closedPolyline({ fillOpacity: 0.35 }),
    ];

    expect(sharedFill(shapes)).toEqual({ kind: "solid", fillColor: "#ff0000", fillOpacity: 0.35 });
  });

  it("treats an omitted opacity as fully opaque, so it matches an explicit 1", () => {
    expect(sharedFill([rectangle(), rectangle({ fillOpacity: 1 })]))
      .toEqual({ kind: "solid", fillColor: "#ff0000", fillOpacity: 1 });
  });

  it("keeps a fully transparent fill apart from no fill at all", () => {
    // The core of the feature: a 0% red rectangle still has a colour to reopen and edit, while an
    // unfilled one has none. Collapsing these would make 0% unreachable.
    expect(sharedFill([rectangle({ fillOpacity: 0 })]))
      .toEqual({ kind: "solid", fillColor: "#ff0000", fillOpacity: 0 });
    expect(sharedFill([rectangle({ fill: "none" })])).toEqual({ kind: "none" });
    expect(sharedFill([rectangle({ fillOpacity: 0 }), rectangle({ fill: "none" })]))
      .toEqual({ kind: "mixed" });
  });

  it("reports mixed when only the opacity differs", () => {
    expect(sharedFill([rectangle({ fillOpacity: 0.2 }), rectangle({ fillOpacity: 0.8 })]))
      .toEqual({ kind: "mixed" });
  });

  it("reports mixed when only the colour differs", () => {
    expect(sharedFill([rectangle(), rectangle({ fillColor: "#00ff00" })])).toEqual({ kind: "mixed" });
  });

  it("falls back to the stroke colour for a filled shape that stored no fill colour", () => {
    expect(sharedFill([rectangle({ fillColor: undefined, color: "#123456" })]))
      .toEqual({ kind: "solid", fillColor: "#123456", fillOpacity: 1 });
  });

  it("ignores shapes that cannot take a fill", () => {
    expect(sharedFill([textShape, rectangle({ fillOpacity: 0.5 })]))
      .toEqual({ kind: "solid", fillColor: "#ff0000", fillOpacity: 0.5 });
    expect(sharedFill([textShape])).toEqual({ kind: "unavailable" });
    expect(sharedFill([])).toEqual({ kind: "unavailable" });
  });

  it("reports mixed when a group member disagrees with the top-level selection", () => {
    // Confirming writes through groups, so the summary has to read the expanded set. Reading only
    // the top level would show one value for a mixed selection and then overwrite the member.
    const member = { ...rectangle({ fillOpacity: 0.2 }), id: "shape_member", parentId: "shape_group" } as OverlayShape;

    expect(sharedFill([rectangle({ fillOpacity: 1 }), member])).toEqual({ kind: "mixed" });
  });

  it("covers exactly the shapes the fill controls are enabled for", () => {
    // `canShapeStyleFill` decides whether the toolbar button is live; `sharedFill` decides what it
    // shows. If the two disagreed, an enabled button would report "unavailable".
    for (const shape of [rectangle(), sector(), closedPolyline()]) {
      expect(canShapeStyleFill(shape)).toBe(true);
      expect(sharedFill([shape]).kind).not.toBe("unavailable");
    }
    const openArc = sector({ kind: "arc" });
    const openPolyline = closedPolyline({ closed: false });
    for (const shape of [textShape, openArc, openPolyline]) {
      expect(canShapeStyleFill(shape)).toBe(false);
      expect(sharedFill([shape])).toEqual({ kind: "unavailable" });
    }
  });
});

describe("applying a fill patch", () => {
  it.each([
    ["geo", rectangle],
    ["sector", sector],
    ["closed line", closedPolyline],
  ])("writes a zero opacity onto a %s instead of dropping it", (_label, make) => {
    const patched = applyStylePatchToShape(make(), { fill: "solid", fillColor: "#0000ff", fillOpacity: 0 });

    expect(sharedFill([patched])).toEqual({ kind: "solid", fillColor: "#0000ff", fillOpacity: 0 });
  });

  it("keeps the stored opacity when a patch changes only the colour", () => {
    // The colour shortcuts and the palette swatches deliberately omit `fillOpacity` so that picking
    // a new colour does not silently reset a figure back to opaque.
    const patched = applyStylePatchToShape(rectangle({ fillOpacity: 0.4 }), { fill: "solid", fillColor: "#0000ff" });

    expect(sharedFill([patched])).toEqual({ kind: "solid", fillColor: "#0000ff", fillOpacity: 0.4 });
  });
});
