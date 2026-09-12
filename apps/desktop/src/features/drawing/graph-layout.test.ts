import { describe, expect, it } from "vitest";

import type { OverlayGraphShape } from "@/features/document";

import { getGraphDisplaySpec, getGraphPlotBox } from "./graph-layout";

function graphShape(overrides: Partial<OverlayGraphShape["props"]> = {}): OverlayGraphShape {
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
        viewBox: { xMin: "-5", xMax: "5", yMin: "-5", yMax: "5" },
        axes: { grid: false, showX: true, showY: true },
        curves: [],
      },
      ...overrides,
    },
  } as OverlayGraphShape;
}

describe("getGraphDisplaySpec: identity", () => {
  it("同じ shape 参照からは同じ spec 参照が返る", () => {
    const shape = graphShape();
    const first = getGraphDisplaySpec(shape);
    const second = getGraphDisplaySpec(shape);
    // `Graph2DPreview` の memo はこの identity が保たれることに乗っている。
    expect(second).toBe(first);
  });

  it("内容が同じでも別 shape なら作り直す (値は等しい)", () => {
    const first = getGraphDisplaySpec(graphShape());
    const second = getGraphDisplaySpec(graphShape());
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it("shape を更新すると新しい spec が返る", () => {
    const before = getGraphDisplaySpec(graphShape());
    const after = getGraphDisplaySpec(graphShape({ w: 400 }));
    expect(after).not.toBe(before);
    expect(after.width).not.toBe(before.width);
  });
});

describe("getGraphDisplaySpec: 値", () => {
  it("plot 基準では plot box の分だけ spec の寸法を広げる", () => {
    const shape = graphShape();
    const plotBox = getGraphPlotBox(shape.props.spec);
    const spec = getGraphDisplaySpec(shape);
    expect(spec.width).toBe(shape.props.w + plotBox.left + plotBox.right);
    expect(spec.height).toBe(shape.props.h + plotBox.top + plotBox.bottom);
  });

  it("plot 基準でないときは shape の寸法をそのまま使う", () => {
    const shape = graphShape({ boundsMode: undefined });
    const spec = getGraphDisplaySpec(shape);
    expect(spec.width).toBe(shape.props.w);
    expect(spec.height).toBe(shape.props.h);
  });

  it("preserveSpecSize なら spec をそのまま返す", () => {
    const shape = graphShape({ preserveSpecSize: true });
    expect(getGraphDisplaySpec(shape)).toBe(shape.props.spec);
  });
});
