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
