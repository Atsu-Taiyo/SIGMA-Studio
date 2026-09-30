import { describe, expect, it } from "vitest";

import { changeOverlayShapeType } from "./shape-type-change";
import type { OverlayGeoShape } from "./types";

const source: OverlayGeoShape = {
  id: "shape_source",
  type: "geo",
  x: 40,
  y: 60,
  rotation: Math.PI / 6,
  stackLayer: "foreground",
  anchor: { type: "page" },
  props: {
    w: 180,
    h: 120,
    geo: "triangle",
    apexX: 70,
    fill: "solid",
    color: "#123456",
    fillColor: "#abcdef",
    fillOpacity: 0.6,
    labelColor: "#111111",
    dash: "dashed",
    size: "l",
    label: "ABC",
  },
};

describe("changeOverlayShapeType", () => {
  it("preserves identity, bounds, rotation, anchor, style, and label", () => {
    const changed = changeOverlayShapeType(source, "dodecagon");

    expect(changed).toMatchObject({
      id: source.id,
      type: "geo",
      x: source.x,
      y: source.y,
      rotation: source.rotation,
      stackLayer: source.stackLayer,
      anchor: source.anchor,
      props: {
        w: source.props.w,
        h: source.props.h,
        geo: "regularPolygon",
        polygonSides: 12,
        color: source.props.color,
        fillColor: source.props.fillColor,
        fillOpacity: source.props.fillOpacity,
        dash: source.props.dash,
        size: source.props.size,
        label: source.props.label,
        labelColor: source.props.labelColor,
      },
    });
  });

  it("changes a box shape to an arc inside the same bounds", () => {
    const changed = changeOverlayShapeType(source, "sector");

    expect(changed).toMatchObject({
      id: source.id,
      type: "arc",
      x: source.x,
      y: source.y,
      props: {
        kind: "sector",
        rx: source.props.w / 2,
        ry: source.props.h / 2,
      },
    });
  });

  it("preserves label color even when the source has no label yet", () => {
    const propsWithoutLabel = { ...source.props };
    delete propsWithoutLabel.label;
    const changed = changeOverlayShapeType({ ...source, props: propsWithoutLabel }, "hexagon");

    expect(changed).toMatchObject({
      type: "geo",
      props: {
        labelColor: source.props.labelColor,
      },
    });
    expect(changed?.type === "geo" ? changed.props.label : undefined).toBeUndefined();
  });
});

describe("changeOverlayShapeType with solids", () => {
  it("turns a plane shape into a solid inside the same bounds, keeping its line style for the visible edges", () => {
    const changed = changeOverlayShapeType(source, "pyramid4");

    expect(changed).toMatchObject({
      id: source.id,
      type: "geo",
      x: source.x,
      y: source.y,
      rotation: source.rotation,
      props: {
        geo: "pyramid",
        baseSides: 4,
        w: source.props.w,
        h: source.props.h,
        color: source.props.color,
        size: source.props.size,
        // 元の線種 (破線) が「見える辺の線種」になる。
        dash: "dashed",
      },
    });
    if (changed?.type !== "geo") throw new Error("Expected a geo shape");
    // 見えない辺も破線だが、見える辺の線種を上書きして全部そろえてしまってはいない。
    expect(changed.props.solidEdgeDash).toHaveLength(8);
    expect(changed.props.solidPoints).toBeUndefined();
  });

  it("keeps the hidden edges dashed when a solid line style is carried over as solid", () => {
    const solidSource: OverlayGeoShape = { ...source, props: { ...source.props, dash: "solid" } };
    const changed = changeOverlayShapeType(solidSource, "prism3");
    if (changed?.type !== "geo") throw new Error("Expected a geo shape");
    expect(new Set(changed.props.solidEdgeDash)).toEqual(new Set(["solid", "dashed"]));
  });

  it("turns a solid back into a plane shape, dropping the vertices and the per-edge styles", () => {
    const pyramid = changeOverlayShapeType(source, "pyramid3") as OverlayGeoShape;
    const moved: OverlayGeoShape = {
      ...pyramid,
      props: { ...pyramid.props, solidPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] },
    };
    const changed = changeOverlayShapeType(moved, "hexagon");
    if (changed?.type !== "geo") throw new Error("Expected a geo shape");
    expect(changed.props).toMatchObject({ geo: "regularPolygon", polygonSides: 6, dash: "dashed" });
    expect(changed.props.solidPoints).toBeUndefined();
    expect(changed.props.solidEdgeDash).toBeUndefined();
    expect(changed.props.baseSides).toBeUndefined();
  });

  it("changes one solid into another", () => {
    const pyramid = changeOverlayShapeType(source, "pyramid3") as OverlayGeoShape;
    const changed = changeOverlayShapeType(pyramid, "sphere");
    expect(changed).toMatchObject({ props: { geo: "sphere" } });
    expect(changed?.type === "geo" && changed.props.solidEdgeDash).toHaveLength(3);
  });
});
