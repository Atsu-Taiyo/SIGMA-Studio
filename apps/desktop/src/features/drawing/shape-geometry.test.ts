import { describe, expect, it } from "vitest";

import type {
  OverlayArcShape,
  OverlayArrowShape,
  OverlayCalloutShape,
  OverlayGeoShape,
  OverlayGraphShape,
  OverlayGraph3DShape,
  OverlayLineShape,
  OverlayTableShape,
  OverlayTextShape,
} from "@/features/document";
import {
  getGraphPlotBox,
  getShapeBounds,
  getShapeDimensionBounds,
  getShapeRotation,
  getShapeSelectionBounds,
  getTextShapeFontSizePt,
  getTextShapeRenderedFontSizePx,
  hitTestShape,
  resizeBoxShape,
} from ".";

function graphShape(): OverlayGraphShape {
  return {
    id: "shape_graph",
    type: "graph2dShape",
    x: 40,
    y: 50,
    props: {
      boundsMode: "plot",
      w: 296,
      h: 188,
      spec: {
        kind: "cartesian",
        title: "",
        width: 360,
        height: 240,
        viewBox: {
          xMin: "-5",
          xMax: "5",
          yMin: "-5",
          yMax: "5",
        },
        axes: {
          grid: false,
          showX: true,
          showY: true,
        },
        curves: [],
      },
    },
  };
}

function graph3DShape(): OverlayGraph3DShape {
  return {
    id: "shape_graph3d",
    type: "graph3dShape",
    x: 40,
    y: 50,
    props: {
      w: 320,
      h: 220,
      spec: {
        version: 1,
        parameters: [],
        objects: [],
        cuts: [],
        regions: [],
        annotations: [],
        camera: {
          projection: "perspective",
          position: { x: 5, y: -6, z: 4 },
          target: { x: 0, y: 0, z: 0 },
          up: { x: 0, y: 0, z: 1 },
        },
        view: {
          coordinateSystem: "zUp",
          showAxes: true,
          showGrid: true,
          showAxisLabels: true,
          backgroundColor: "#ffffff",
        },
      },
    },
  };
}

describe("overlay shape geometry", () => {
  it("treats a 3D material as a rotatable, selectable, resizable box", () => {
    const shape = graph3DShape();

    expect(hitTestShape(shape, { x: 200, y: 160 }, 0)).toBe(true);
    expect(hitTestShape(shape, { x: 20, y: 20 }, 0)).toBe(false);

    const resized = resizeBoxShape(shape, { x: 10, y: 20, w: 480, h: 300 });
    expect(resized).toMatchObject({
      type: "graph3dShape",
      x: 10,
      y: 20,
      props: { w: 480, h: 300 },
    });
  });

  it("uses the graph plot area as the selectable bounds", () => {
    const shape = graphShape();

    expect(getShapeBounds(shape)).toEqual({
      x: 40,
      y: 50,
      w: shape.props.w,
      h: shape.props.h,
    });
    expect(getShapeSelectionBounds(shape)).toEqual(getShapeBounds(shape));
    expect(getShapeDimensionBounds(shape)).toEqual(getShapeSelectionBounds(shape));
  });

  it("hits only the graph plot area, not tick-label margins", () => {
    const shape = graphShape();
    const selectionBounds = getShapeSelectionBounds(shape);

    expect(hitTestShape(shape, {
      x: selectionBounds.x + selectionBounds.w / 2,
      y: selectionBounds.y + selectionBounds.h / 2,
    }, 8)).toBe(true);
    expect(hitTestShape(shape, {
      x: selectionBounds.x + selectionBounds.w / 2,
      y: shape.y + shape.props.h + 10,
    }, 8)).toBe(false);
  });

  it("hit-tests triangle geometry when no margin is requested", () => {
    const shape: OverlayGeoShape = {
      id: "shape_triangle",
      type: "geo",
      x: 10,
      y: 10,
      props: {
        w: 100,
        h: 100,
        geo: "triangle",
        fill: "none",
        color: "black",
        labelColor: "black",
        dash: "solid",
        size: "m",
      },
    };

    expect(hitTestShape(shape, { x: 60, y: 40 }, 0)).toBe(true);
    expect(hitTestShape(shape, { x: 15, y: 15 }, 0)).toBe(false);
  });

  it("hit-tests triangle geometry using a moved apex", () => {
    const shape: OverlayGeoShape = {
      id: "shape_triangle",
      type: "geo",
      x: 10,
      y: 10,
      props: {
        w: 100,
        h: 100,
        geo: "triangle",
        apexX: 80,
        fill: "none",
        color: "black",
        labelColor: "black",
        dash: "solid",
        size: "m",
      },
    };

    expect(hitTestShape(shape, { x: 85, y: 30 }, 0)).toBe(true);
    expect(hitTestShape(shape, { x: 40, y: 30 }, 0)).toBe(false);
  });

  it("hit-tests a horizontally flipped triangle at its mirrored geometry", () => {
    const shape: OverlayGeoShape = {
      id: "shape_flipped_triangle",
      type: "geo",
      x: 10,
      y: 10,
      flipX: true,
      props: {
        w: 100,
        h: 100,
        geo: "triangle",
        apexX: 80,
        fill: "none",
        color: "black",
        labelColor: "black",
        dash: "solid",
        size: "m",
      },
    };

    expect(hitTestShape(shape, { x: 35, y: 30 }, 0)).toBe(true);
    expect(hitTestShape(shape, { x: 85, y: 30 }, 0)).toBe(false);
  });

  it("hit-tests filled block arrow geometry when no margin is requested", () => {
    const shape: OverlayGeoShape = {
      id: "shape_block_arrow",
      type: "geo",
      x: 10,
      y: 20,
      props: {
        w: 160,
        h: 80,
        geo: "blockArrow",
        headLengthRatio: 0.35,
        shaftRatio: 0.4,
        fill: "solid",
        color: "black",
        fillColor: "#bfdbfe",
        labelColor: "black",
        dash: "solid",
        size: "m",
      },
    };

    expect(hitTestShape(shape, { x: 150, y: 60 }, 0)).toBe(true);
    expect(hitTestShape(shape, { x: 30, y: 25 }, 0)).toBe(false);
  });

  it("hit-tests arc strokes by radius and angle sweep", () => {
    const shape: OverlayArcShape = {
      id: "shape_arc",
      type: "arc",
      x: 100,
      y: 100,
      props: {
        r: 50,
        startAngle: 0,
        endAngle: Math.PI / 2,
        color: "black",
        dash: "solid",
        size: "m",
      },
    };

    expect(hitTestShape(shape, { x: 185, y: 185 }, 0)).toBe(true);
    expect(hitTestShape(shape, { x: 100, y: 150 }, 0)).toBe(false);
    expect(hitTestShape(shape, { x: 150, y: 150 }, 0)).toBe(false);
  });

  it("hit-tests a rotated arc around the centre of what it draws", () => {
    // 弧の pivot は実描画の中心 (175,175) で、保存箱の中心 (150,150) ではない。90° 回すと
    // 弧上の点 (185,185) は (165,185) へ移る。旧 pivot なら (115,185) — 25px ずれる。
    const shape: OverlayArcShape = {
      id: "shape_arc",
      type: "arc",
      x: 100,
      y: 100,
      rotation: Math.PI / 2,
      props: {
        r: 50,
        startAngle: 0,
        endAngle: Math.PI / 2,
        color: "black",
        dash: "solid",
        size: "m",
      },
    };

    expect(hitTestShape(shape, { x: 165, y: 185 }, 0)).toBe(true);
    expect(hitTestShape(shape, { x: 115, y: 185 }, 0)).toBe(false);
  });

  it("hit-tests filled sector interiors and radial edges", () => {
    const shape: OverlayArcShape = {
      id: "shape_sector",
      type: "arc",
      x: 100,
      y: 100,
      props: {
        kind: "sector",
        r: 50,
        startAngle: 0,
        endAngle: Math.PI / 2,
        fill: "solid",
        fillColor: "#e5e7eb",
        color: "black",
        dash: "solid",
        size: "m",
      },
    };

    expect(hitTestShape(shape, { x: 175, y: 175 }, 0)).toBe(true);
    expect(hitTestShape(shape, { x: 175, y: 150 }, 0)).toBe(true);
    expect(hitTestShape(shape, { x: 150, y: 175 }, 0)).toBe(true);
    expect(hitTestShape(shape, { x: 125, y: 125 }, 0)).toBe(false);
  });

  it("hit-tests the interior of filled closed polylines only", () => {
    const shape: OverlayLineShape = {
      id: "shape_closed_polyline",
      type: "line",
      x: 10,
      y: 20,
      props: {
        kind: "polyline",
        points: [
          { x: 0, y: 0 },
          { x: 80, y: 0 },
          { x: 40, y: 60 },
        ],
        closed: true,
        fill: "none",
        color: "black",
        labelColor: "black",
        dash: "solid",
        size: "m",
      },
    };

    expect(hitTestShape(shape, { x: 50, y: 42 }, 0)).toBe(false);
    expect(hitTestShape({ ...shape, props: { ...shape.props, fill: "solid" } }, { x: 50, y: 42 }, 0)).toBe(true);
  });

  it("uses visible point extents for line and arrow dimension labels", () => {
    const line: OverlayLineShape = {
      id: "shape_line",
      type: "line",
      x: 10,
      y: 20,
      props: {
        kind: "polyline",
        points: [
          { x: 0, y: 0 },
          { x: 80, y: 0 },
          { x: 40, y: 60 },
        ],
        closed: false,
        fill: "none",
        color: "black",
        labelColor: "black",
        dash: "solid",
        size: "m",
      },
    };
    const arrow: OverlayArrowShape = {
      id: "shape_arrow",
      type: "arrow",
      x: 10,
      y: 20,
      props: {
        start: { x: 0, y: 0 },
        end: { x: 80, y: 0 },
        arrowheadEnd: "arrow",
        fill: "none",
        color: "black",
        labelColor: "black",
        dash: "solid",
        size: "m",
      },
    };

    expect(getShapeBounds(line)).toEqual({ x: 0, y: 10, w: 100, h: 80 });
    expect(getShapeDimensionBounds(line)).toEqual({ x: 10, y: 20, w: 80, h: 60 });
    expect(getShapeBounds(arrow)).toEqual({ x: 0, y: 10, w: 100, h: 20 });
    expect(getShapeDimensionBounds(arrow)).toEqual({ x: 10, y: 20, w: 80, h: 1 });
  });

  it("resizes graph plot bounds while preserving the outer label margins", () => {
    const shape = graphShape();
    const plotBox = getGraphPlotBox(shape.props.spec);
    const nextSelectionBounds = {
      ...getShapeSelectionBounds(shape),
      x: shape.x + 10,
      y: shape.y + 6,
      w: 320,
      h: 150,
    };

    const resized = resizeBoxShape(shape, nextSelectionBounds) as OverlayGraphShape;

    expect(resized.x).toBe(nextSelectionBounds.x);
    expect(resized.y).toBe(nextSelectionBounds.y);
    expect(resized.props.w).toBe(nextSelectionBounds.w);
    expect(resized.props.h).toBe(nextSelectionBounds.h);
    expect(resized.props.spec.width).toBe(resized.props.w + plotBox.left + plotBox.right);
    expect(resized.props.spec.height).toBe(resized.props.h + plotBox.top + plotBox.bottom);
  });

  it("scales a triangle apex when resizing the triangle", () => {
    const shape: OverlayGeoShape = {
      id: "shape_triangle",
      type: "geo",
      x: 10,
      y: 20,
      props: {
        w: 100,
        h: 80,
        geo: "triangle",
        apexX: 25,
        fill: "none",
        color: "black",
        labelColor: "black",
        dash: "solid",
        size: "m",
      },
    };

    const resized = resizeBoxShape(shape, { x: 30, y: 40, w: 200, h: 120 }) as OverlayGeoShape;

    expect(resized.x).toBe(30);
    expect(resized.y).toBe(40);
    expect(resized.props.w).toBe(200);
    expect(resized.props.h).toBe(120);
    expect(resized.props.apexX).toBe(50);
  });

  it("keeps resized arc bounds elliptical", () => {
    const shape: OverlayArcShape = {
      id: "shape_arc",
      type: "arc",
      x: 100,
      y: 100,
      props: {
        r: 50,
        startAngle: 0,
        endAngle: Math.PI,
        color: "black",
        dash: "solid",
        size: "m",
      },
    };

    const resized = resizeBoxShape(shape, { x: 10, y: 20, w: 80, h: 120 }) as OverlayArcShape;

    expect(resized.x).toBe(10);
    expect(resized.y).toBe(20);
    expect(resized.props.r).toBe(60);
    expect(resized.props.rx).toBe(40);
    expect(resized.props.ry).toBe(60);
    expect(getShapeBounds(resized)).toEqual({ x: 10, y: 20, w: 80, h: 120 });
  });

  it("treats table shapes as box-resizable but non-rotating in the renderer", () => {
    const shape: OverlayTableShape = {
      id: "shape_table",
      type: "tableShape",
      x: 20,
      y: 30,
      rotation: Math.PI / 4,
      props: {
        w: 240,
        h: 120,
        table: {
          version: 1,
          kind: "plain",
          columns: [],
          rows: [],
          cells: [],
          grid: {
            borderColor: "#111827",
            borderWidth: 1,
          },
          defaultCellStyle: {},
        },
      },
    };

    const resized = resizeBoxShape(shape, { x: 40, y: 50, w: 300, h: 160 }) as OverlayTableShape;

    expect(getShapeRotation(shape)).toBe(0);
    expect(getShapeBounds(shape)).toEqual({ x: 20, y: 30, w: 240, h: 120 });
    expect(resized.x).toBe(40);
    expect(resized.y).toBe(50);
    expect(resized.props.w).toBe(300);
    expect(resized.props.h).toBe(160);
  });

  it("allows box-resizable shapes to resize down to the tiny safety minimum", () => {
    const shape: OverlayGeoShape = {
      id: "shape_geo",
      type: "geo",
      x: 20,
      y: 30,
      props: {
        w: 240,
        h: 120,
        geo: "rectangle",
        fill: "none",
        color: "black",
        labelColor: "black",
        dash: "solid",
        size: "m",
      },
    };

    const resized = resizeBoxShape(shape, { x: 40, y: 50, w: 0.25, h: 0 }) as OverlayGeoShape;

    expect(resized.x).toBe(40);
    expect(resized.y).toBe(50);
    expect(resized.props.w).toBe(1);
    expect(resized.props.h).toBe(1);
  });

  it("uses the stored text box and moves only its width on resize", () => {
    const shape: OverlayTextShape = {
      id: "shape_text",
      type: "text",
      x: 20,
      y: 30,
      props: {
        w: 100,
        h: 16,
        color: "black",
        size: "m",
        blocks: [
            {
              type: "paragraph", id: "shape_geometry_test_1",
              children: [{ type: "text", text: "a" }],
            },
          ],
      },
    };

    expect(getShapeBounds(shape)).toEqual({ x: 20, y: 30, w: 100, h: 16 });
    expect(getShapeBounds({ ...shape, props: { ...shape.props, h: 54 } })).toEqual({ x: 20, y: 30, w: 100, h: 54 });
    expect(getShapeBounds({ ...shape, props: { ...shape.props, fontSize: 24 } })).toEqual({ x: 20, y: 30, w: 100, h: 32 });

    const pointSizedShape = { ...shape, props: { ...shape.props, fontSize: 10.5 } };
    expect(getTextShapeFontSizePt(pointSizedShape)).toBe(10.5);
    expect(getTextShapeRenderedFontSizePx(pointSizedShape)).toBe(14);
    // The stored height stays: the 14px line box is only the floor, and 16 already clears it.
    expect(getShapeBounds(pointSizedShape)).toEqual({ x: 20, y: 30, w: 100, h: 16 });
    expect(getShapeBounds({ ...pointSizedShape, props: { ...pointSizedShape.props, h: 1 } }))
      .toEqual({ x: 20, y: 30, w: 100, h: 14 });

    // Resizing moves the wrap width and nothing else: the font size is no longer part of the
    // geometry, and the height stays the stored derived value the DOM writes back.
    const resized = resizeBoxShape(shape, { x: 24, y: 34, w: 200, h: 48 }) as OverlayTextShape;
    expect(resized.props.w).toBe(200);
    expect(resized.props.h).toBe(16);
    expect(resized.props.fontSize).toBe(shape.props.fontSize);
    expect(resized.props.size).toBe("m");

    const clamped = resizeBoxShape(shape, { x: 24, y: 34, w: 1, h: 48 }) as OverlayTextShape;
    expect(clamped.props.w).toBe(8);
  });

  it("includes the free callout tip in bounds and scales all three tail points on resize", () => {
    const shape: OverlayCalloutShape = {
      id: "callout_resize",
      type: "callout",
      x: 20,
      y: 30,
      props: {
        w: 160,
        h: 72,
        radius: 18,
        tail: {
          baseStart: { x: 36, y: 72 },
          baseEnd: { x: 68, y: 72 },
          tip: { x: -20, y: 100 },
        },
        blocks: [{ type: "paragraph", id: "shape_geometry_test_2", children: [] }],
        color: "black",
        size: "m",
        dash: "solid",
        strokeWidth: "m",
      },
    };

    expect(getShapeBounds(shape)).toEqual({ x: 0, y: 30, w: 180, h: 100 });

    const resized = resizeBoxShape(shape, { x: 10, y: 40, w: 360, h: 200 }) as OverlayCalloutShape;
    expect(getShapeBounds(resized)).toEqual({ x: 10, y: 40, w: 360, h: 200 });
    expect(resized.props.w).toBe(320);
    expect(resized.props.h).toBe(144);
    expect(resized.props.tail.baseStart).toEqual({ x: 72, y: 144 });
    expect(resized.props.tail.baseEnd).toEqual({ x: 136, y: 144 });
    expect(resized.props.tail.tip).toEqual({ x: -40, y: 200 });
  });
});
