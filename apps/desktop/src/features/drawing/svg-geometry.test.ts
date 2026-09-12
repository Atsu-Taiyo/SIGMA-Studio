import { describe, expect, it } from "vitest";

import type {
  Graph2DSpec,
  OverlayAsset,
  OverlayCalloutShape,
  OverlayGraphShape,
  OverlayShape,
} from "@/features/document";

import {
  getBlockArrowPolygonPoints,
  getCalloutPath,
  getCroppedImageLayout,
  getGraphRenderLayout,
  getImageCoverCrop,
  getLineMidpoint,
  getLinePolylinePoints,
  getLineSvgPath,
  getRegularPolygonPoints,
  isClosedPolyline,
  normalizeLineKind,
  normalizeRegularPolygonSides,
} from ".";

describe("drawing feature SVG geometry", () => {
  it("builds the same callout and block-arrow outlines used by live and static rendering", () => {
    const callout: OverlayCalloutShape = {
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
        blocks: [{ type: "paragraph", id: "svg_geometry_test_12", children: [] }],
        color: "black",
        size: "m",
        dash: "solid",
        strokeWidth: "m",
      },
    };

    expect(getCalloutPath(callout)).toContain("L 24 100");
    const arrowPoints = getBlockArrowPolygonPoints(100, 60, 0.3, 0.4, 2);
    expect(arrowPoints).toHaveLength(7);
    expect(arrowPoints[0]).toEqual({ x: 2, y: expect.closeTo(18.8) });
    expect(arrowPoints[2]).toEqual({ x: expect.closeTo(69.2), y: 2 });
    expect(arrowPoints[3]).toEqual({ x: 98, y: 30 });
    expect(arrowPoints[6]).toEqual({ x: 2, y: expect.closeTo(41.2) });
  });

  it("normalizes regular polygons to the requested inset bounds", () => {
    const points = getRegularPolygonPoints(100, 80, normalizeRegularPolygonSides(7), 1);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);

    expect(Math.min(...xs)).toBeCloseTo(1);
    expect(Math.max(...xs)).toBeCloseTo(99);
    expect(Math.min(...ys)).toBeCloseTo(1);
    expect(Math.max(...ys)).toBeCloseTo(79);
  });

  it("projects line points into stable SVG path and midpoint representations", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 12.345, y: 6.789 },
      { x: 30, y: 18 },
    ];

    expect(normalizeLineKind(undefined)).toBe("polyline");
    expect(isClosedPolyline("polyline", points, true)).toBe(true);
    expect(getLineSvgPath(points, "polyline")).toBe("M 0 0 L 12.35 6.79 L 30 18");
    expect(getLinePolylinePoints(points)).toBe("0,0 12.345,6.789 30,18");
    expect(getLineMidpoint(points)).toEqual({ x: 12.345, y: 6.789 });
  });

  it("resolves a cover crop and its full-image layout without DOM state", () => {
    const asset: OverlayAsset = {
      id: "asset",
      type: "image",
      props: {
        w: 800,
        h: 400,
        name: "wide.png",
        isAnimated: false,
        mimeType: "image/png",
        src: "data:image/png;base64,AAAA",
        fileSize: 4,
      },
    };
    const image = {
      id: "image",
      type: "image" as const,
      x: 10,
      y: 20,
      props: {
        assetId: asset.id,
        w: 200,
        h: 200,
      },
    } satisfies Extract<OverlayShape, { type: "image" }>;

    const crop = getImageCoverCrop(image, asset);
    expect(crop).toEqual({
      topLeft: { x: 0.25, y: 0 },
      bottomRight: { x: 0.75, y: 1 },
    });
    expect(getCroppedImageLayout(image, asset, crop)).toEqual({
      x: -100,
      y: 0,
      width: 400,
      height: 200,
    });
  });

  it("keeps graph plot bounds separate from render-only label margins", () => {
    const spec: Graph2DSpec = {
      kind: "cartesian",
      title: "",
      width: 364,
      height: 222,
      viewBox: {
        xMin: "-5",
        xMax: "5",
        yMin: "-3",
        yMax: "3",
      },
      axes: { grid: false },
      curves: [],
    };
    const graph: OverlayGraphShape = {
      id: "graph",
      type: "graph2dShape",
      x: 120,
      y: 140,
      props: {
        boundsMode: "plot",
        w: 300,
        h: 170,
        spec,
      },
    };

    expect(getGraphRenderLayout(graph)).toEqual({
      spec,
      plotBox: { left: 46, top: 18, right: 18, bottom: 34 },
      renderBounds: { x: 74, y: 122, w: 364, h: 222 },
      scaleX: 1,
      scaleY: 1,
    });
  });
});
