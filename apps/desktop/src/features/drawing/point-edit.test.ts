import { describe, expect, it } from "vitest";

import { updateShapePoint } from "./point-edit";
import type {
  OverlayArcShape,
  OverlayArrowShape,
  OverlayCalloutShape,
  OverlayGeoShape,
  OverlayLineShape,
} from "@/features/document";

function createArcShape(overrides: Partial<OverlayArcShape["props"]> = {}): OverlayArcShape {
  return {
    id: "shape_arc",
    type: "arc",
    x: 0,
    y: 0,
    rotation: 0,
    props: {
      kind: "arc",
      r: 100,
      rx: 100,
      ry: 100,
      startAngle: 0,
      endAngle: Math.PI / 2,
      color: "black",
      dash: "solid",
      size: "m",
      ...overrides,
    },
  };
}

function createCalloutShape(): OverlayCalloutShape {
  return {
    id: "shape_callout",
    type: "callout",
    x: 10,
    y: 20,
    props: {
      w: 160,
      h: 72,
      radius: 18,
      tail: {
        baseStart: { x: 36, y: 72 },
        baseEnd: { x: 68, y: 72 },
        tip: { x: 24, y: 100 },
      },
      blocks: [{ type: "paragraph", id: "point_edit_test_4", children: [] }],
      color: "black",
      size: "m",
      dash: "solid",
      strokeWidth: "m",
    },
  };
}

describe("updateShapePoint arc angle handles", () => {
  it("keeps the dragged angle free by default", () => {
    const shape = createArcShape();
    // 中心(100,100)から見て約13°方向
    const angle = (13 * Math.PI) / 180;
    const point = { x: 100 + Math.cos(angle) * 100, y: 100 + Math.sin(angle) * 100 };

    const next = updateShapePoint(shape, { type: "arc", endpoint: "end" }, point);

    expect(next.type).toBe("arc");
    expect((next as OverlayArcShape).props.endAngle).toBeCloseTo(angle);
  });

  it("snaps the dragged angle to 15 degree steps while shift is held", () => {
    const shape = createArcShape();
    const angle = (13 * Math.PI) / 180;
    const point = { x: 100 + Math.cos(angle) * 100, y: 100 + Math.sin(angle) * 100 };

    const next = updateShapePoint(shape, { type: "arc", endpoint: "end" }, point, true);

    expect((next as OverlayArcShape).props.endAngle).toBeCloseTo((15 * Math.PI) / 180);
  });

  it("snaps the parametric angle for elliptical arcs", () => {
    const shape = createArcShape({ rx: 200, ry: 100, r: 200 });
    // パラメトリック角 30° の楕円上の点(中心は (200,100))
    const parametric = (32 * Math.PI) / 180;
    const point = { x: 200 + Math.cos(parametric) * 200, y: 100 + Math.sin(parametric) * 100 };

    const next = updateShapePoint(shape, { type: "arc", endpoint: "start" }, point, true);

    expect((next as OverlayArcShape).props.startAngle).toBeCloseTo((30 * Math.PI) / 180);
  });

  it("snaps rotated arc handles to absolute page angles instead of rotation-relative steps", () => {
    const rotation = (7 * Math.PI) / 180;
    const localPointerAngle = (21 * Math.PI) / 180;
    const shape = {
      ...createArcShape(),
      rotation,
    };
    const point = {
      x: 100 + Math.cos(localPointerAngle) * 100,
      y: 100 + Math.sin(localPointerAngle) * 100,
    };

    const next = updateShapePoint(shape, { type: "arc", endpoint: "end" }, point, true) as OverlayArcShape;

    expect(next.props.endAngle).toBeCloseTo((23 * Math.PI) / 180);
    expect(next.props.endAngle + rotation).toBeCloseTo((30 * Math.PI) / 180);
  });
});

describe("updateShapePoint arc radius handle", () => {
  it("scales rx/ry proportionally while keeping the center fixed", () => {
    const shape = createArcShape({ rx: 200, ry: 100, r: 200 });
    // 中心 (200,100)、中間角45°上のハンドルを中心から2倍の距離へドラッグ
    const midAngle = Math.PI / 4;
    const handleVector = { x: Math.cos(midAngle) * 200, y: Math.sin(midAngle) * 100 };
    const point = { x: 200 + handleVector.x * 2, y: 100 + handleVector.y * 2 };

    const next = updateShapePoint(shape, { type: "arcRadius" }, point) as OverlayArcShape;

    expect(next.props.rx).toBeCloseTo(400);
    expect(next.props.ry).toBeCloseTo(200);
    expect(next.props.r).toBeCloseTo(400);
    // 中心固定 → バウンディング左上は再計算される
    expect(next.x).toBeCloseTo(200 - 400);
    expect(next.y).toBeCloseTo(100 - 200);
    // 角度は変えない
    expect(next.props.startAngle).toBeCloseTo(shape.props.startAngle);
    expect(next.props.endAngle).toBeCloseTo(shape.props.endAngle);
  });

  it("clamps to the minimum radius while preserving aspect", () => {
    const shape = createArcShape({ rx: 200, ry: 100, r: 200 });
    // 中心へ向かって距離0までドラッグ
    const next = updateShapePoint(shape, { type: "arcRadius" }, { x: 200, y: 100 }) as OverlayArcShape;

    expect(next.props.ry).toBeCloseTo(8);
    expect(next.props.rx).toBeCloseTo(16);
    expect((next.props.rx ?? 0) / (next.props.ry ?? 1)).toBeCloseTo(2);
  });
});

describe("updateShapePoint non-arc handles", () => {
  it("updates the triangle apex in shape-local coordinates", () => {
    const shape = createGeoShape({
      geo: "triangle",
      w: 100,
      h: 80,
      apexX: 50,
    });

    const next = updateShapePoint(
      shape,
      { type: "triangleApex" },
      { x: 85, y: 20 },
    ) as OverlayGeoShape;

    expect(next.props.apexX).toBe(75);
  });

  it("updates block-arrow head length and shaft width ratios", () => {
    const shape = createGeoShape({
      geo: "blockArrow",
      w: 100,
      h: 80,
      headLengthRatio: 0.32,
      shaftRatio: 0.42,
    });

    const withHead = updateShapePoint(
      shape,
      { type: "blockArrowHead" },
      { x: 80, y: 60 },
    ) as OverlayGeoShape;
    const withShaft = updateShapePoint(
      withHead,
      { type: "blockArrowShaft" },
      { x: 60, y: 36 },
    ) as OverlayGeoShape;

    expect(withHead.props.headLengthRatio).toBe(0.3);
    expect(withShaft.props.shaftRatio).toBe(0.6);
  });

  it("stores line and arrow handles in shape-local coordinates", () => {
    const line: OverlayLineShape = {
      id: "line",
      type: "line",
      x: 10,
      y: 20,
      props: {
        kind: "polyline",
        points: [{ x: 0, y: 0 }, { x: 40, y: 0 }],
        closed: false,
        color: "black",
        dash: "solid",
        size: "m",
      },
    };
    const arrow: OverlayArrowShape = {
      id: "arrow",
      type: "arrow",
      x: 10,
      y: 20,
      props: {
        start: { x: 0, y: 0 },
        end: { x: 40, y: 0 },
        arrowheadEnd: "arrow",
        fill: "none",
        color: "black",
        labelColor: "black",
        dash: "solid",
        size: "m",
      },
    };

    const nextLine = updateShapePoint(
      line,
      { type: "line", index: 1 },
      { x: 30, y: 50 },
    ) as OverlayLineShape;
    const nextArrow = updateShapePoint(
      arrow,
      { type: "arrow", endpoint: "end" },
      { x: 50, y: 60 },
    ) as OverlayArrowShape;

    expect(nextLine.props.points[1]).toEqual({ x: 20, y: 30 });
    expect(nextArrow.props.end).toEqual({ x: 40, y: 40 });
  });

  it("moves the callout tip freely and centers both bases on the nearest edge", () => {
    const shape = createCalloutShape();
    const next = updateShapePoint(
      shape,
      { type: "calloutTailTip" },
      { x: 210, y: 56 },
    ) as OverlayCalloutShape;

    expect(next.props.tail.tip).toEqual({ x: 200, y: 36 });
    expect(next.props.tail.baseStart).toEqual({ x: 160, y: 20 });
    expect(next.props.tail.baseEnd).toEqual({ x: 160, y: 52 });
  });

  it("moves one callout base independently to the nearest body edge", () => {
    const shape = createCalloutShape();
    const next = updateShapePoint(
      shape,
      { type: "calloutTailBase", endpoint: "start" },
      { x: 190, y: 60 },
    ) as OverlayCalloutShape;

    expect(next.props.tail.baseStart).toEqual({ x: 160, y: 40 });
    expect(next.props.tail.baseEnd).toEqual(shape.props.tail.baseEnd);
  });

  it("changes the callout corner radius without moving the tail", () => {
    const shape = createCalloutShape();
    const ratio = 1 - Math.SQRT1_2;
    const next = updateShapePoint(
      shape,
      { type: "calloutCornerRadius" },
      { x: shape.x + 30 * ratio, y: shape.y + 30 * ratio },
    ) as OverlayCalloutShape;

    expect(next.props.radius).toBeCloseTo(30);
    expect(next.props.tail).toEqual(shape.props.tail);
  });
});

function createGeoShape(
  props: Pick<OverlayGeoShape["props"], "geo" | "w" | "h"> &
    Partial<Omit<OverlayGeoShape["props"], "geo" | "w" | "h">>,
): OverlayGeoShape {
  return {
    id: "geo",
    type: "geo",
    x: 10,
    y: 20,
    props: {
      ...props,
      fill: props.fill ?? "none",
      color: props.color ?? "black",
      labelColor: props.labelColor ?? "black",
      dash: props.dash ?? "solid",
      size: props.size ?? "m",
    },
  };
}
