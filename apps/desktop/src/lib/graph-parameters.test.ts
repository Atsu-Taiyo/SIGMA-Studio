import { describe, expect, it } from "vitest";
import type { Graph2DSpec, GraphCurve, GraphParameter } from "@/features/document";
import { isOverlayShape } from "@/features/document/overlay-validation";
import { resolveGraph2DParameters, resolveGraphParameterExpression } from "@/features/rendering/core";
import { findGraphCurveIntersections } from "./graph-intersection";
import { getGraphFillPath } from "./graph-fill";
import { buildFunctionPath, createGraph2DSpecPreset, cropGraphSpecToSvgBox, getGraphIssues, getGraphPlotBox } from "./graph2d";

const parameter: GraphParameter = { id: "p", name: "s", value: 2, min: -3, max: 3, animation: { durationMs: 1000, loop: "pingPong", playOnPage: true } };
function graph(curve: Partial<GraphCurve>): Graph2DSpec {
  return { ...createGraph2DSpecPreset("blank"), parameters: [parameter], curves: [{ id: "c", expr: "s*x", color: "#000000", ...curve }] };
}

describe("2D graph parameters", () => {
  it.each([
    { mode: "yOfX", expr: "s*x" },
    { mode: "xOfY", expr: "s*y" },
    { mode: "parametric", expr: "s*cos(t)", yExpr: "s*sin(t)", domain: { min: "0", max: "s*pi" } },
    { mode: "implicit", expr: "x^2+y^2=s^2" },
  ] as Partial<GraphCurve>[])("evaluates $mode using the stored parameter value", (curve) => {
    const source = graph(curve);
    const before = JSON.stringify(source);
    const resolved = resolveGraph2DParameters(source);
    expect(getGraphIssues(source, "graph")).toEqual([]);
    const path = buildFunctionPath(source.curves[0], source);
    expect(path).not.toBe("");
    expect(path).toBe(buildFunctionPath(resolved.curves[0], resolved));
    const changed = { ...source, parameters: [{ ...parameter, value: 1 }] };
    expect(buildFunctionPath(source.curves[0], changed)).not.toBe(path);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("binds complete identifiers and preserves functions, independent variables and scientific notation", () => {
    const parameters = [parameter, { ...parameter, name: "s2", value: -3 }, { ...parameter, name: "x", value: 99 }];
    expect(resolveGraphParameterExpression("sin(x)+S+s2+1e-3+x", parameters)).toBe("sin(x)+(2)+(-3)+1e-3+x");
  });

  it("uses parameters for intersections, fill boundaries and source-preserving crop", () => {
    const source = graph({ expr: "s*x" });
    source.curves.push({ id: "c2", expr: "1", color: "#000000" });
    const before = JSON.stringify(source);
    const intersections = findGraphCurveIntersections(source);
    expect(intersections).toHaveLength(1);
    expect(intersections[0].x).toBeCloseTo(0.5, 8);
    expect(intersections[0].y).toBeCloseTo(1, 8);
    const fill = { id: "fill", x: "0.1", y: "0.5" };
    const resolved = resolveGraph2DParameters(source);
    const path = getGraphFillPath(source, fill);
    expect(path).not.toBe("");
    expect(path).toBe(getGraphFillPath(resolved, fill));
    const plot = getGraphPlotBox(source);
    const cropped = cropGraphSpecToSvgBox(source, { left: plot.left + 5, top: plot.top + 5, width: 180, height: 140 });
    expect(cropped?.curves).toEqual(source.curves);
    expect(cropped?.parameters).toEqual(source.parameters);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("keeps parameter definitions through a saved overlay roundtrip and rejects corrupt values", () => {
    const shape = { id: "g", type: "graph2dShape", x: 0, y: 0, props: { w: 560, h: 320, spec: graph({}) } };
    const saved = JSON.parse(JSON.stringify(shape));
    expect(isOverlayShape(saved)).toBe(true);
    expect(saved.props.spec.parameters).toEqual([parameter]);
    for (const bad of [null, "2", Infinity]) {
      expect(isOverlayShape({ ...shape, props: { ...shape.props, spec: { ...shape.props.spec, parameters: [{ ...parameter, value: bad }] } } })).toBe(false);
    }
    const legacy = { ...shape, props: { ...shape.props, spec: createGraph2DSpecPreset("blank") } };
    expect(isOverlayShape(legacy)).toBe(true);
  });
});
