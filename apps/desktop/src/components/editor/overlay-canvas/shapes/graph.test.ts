import { overlayTextBlocksToInlineNodes } from "@/features/document";
import { describe, expect, it } from "vitest";

import {
  createGraph2DSpecPreset,
  cropGraphSpecToSvgBox,
  getGraphNumericRange,
  getGraphPlotBox,
  mapGraphPoint,
} from "@/lib/graph2d";

import {
  createGraphAxisLabelShapeEntries,
  createGraphAnnotationLabelShapeEntries,
  createGraphFormulaLabelShapeEntries,
  createGraphFormulaLabelShapes,
  getGraphCropPositionPatch,
  getGraphRenderLayout,
  getGraphOwnedLabelTextSyncedProps,
  getGraphOwnedTextLabelCropSyncPatch,
  createGraphPointLabelShapeEntries,
  createGraphShapeFromPlotBounds,
  createGraphShapeProps,
  isGraphLabelTextShape,
} from "./graph";
import { resolveShapeAnchorPositions } from "../anchor";
import type { OverlayGraphShape, OverlayTextShape } from "../types";
import type { Graph2DSpec } from "@/types/sigma-doc";

describe("overlay graph shapes", () => {
  it("creates blank graphs by default", () => {
    const props = createGraphShapeProps();

    expect(props.spec.curves).toEqual([]);
    expect(props.spec.axes.grid).toBe(false);
    expect(props.spec.axes.showTicks).toBe(false);
    expect(props.spec.axes.xLabel).toBe("");
    expect(props.spec.axes.yLabel).toBe("");
    expect(props.spec.axes.originLabel).toBe("");
  });

  it("creates default graphs with equal x/y unit lengths (1:1)", () => {
    const props = createGraphShapeProps("blank");
    const range = getGraphNumericRange(props.spec);
    const xUnit = props.w / (range.xMax - range.xMin);
    const yUnit = props.h / (range.yMax - range.yMin);

    expect(xUnit).toBeCloseTo(yUnit, 6);
  });

  it("creates inserted graphs from the chosen plot area with quiet axis defaults", () => {
    const shape = createGraphShapeFromPlotBounds(
      "graph_inserted",
      { x: 120, y: 140, w: 300, h: 170 },
      "quadratic",
    );
    const plotBox = getGraphPlotBox(shape.props.spec);
    const range = getGraphNumericRange(shape.props.spec);

    expect(shape.x).toBe(120);
    expect(shape.y).toBe(140);
    expect(shape.props.w).toBe(300);
    expect(shape.props.h).toBe(170);
    expect(getGraphRenderLayout(shape).renderBounds).toEqual({
      x: 120 - plotBox.left,
      y: 140 - plotBox.top,
      w: 300 + plotBox.left + plotBox.right,
      h: 170 + plotBox.top + plotBox.bottom,
    });
    expect(shape.props.spec.axes.grid).toBe(false);
    expect(shape.props.spec.axes.showTicks).toBe(false);
    expect(shape.props.spec.curves).toHaveLength(1);
    // x 範囲は保ったまま、ドラッグしたプロット領域に対して 1:1 になるよう y 範囲が調整される。
    expect(range.xMin).toBeCloseTo(-1);
    expect(range.xMax).toBeCloseTo(5);
    expect((range.yMin + range.yMax) / 2).toBeCloseTo(3);
    const xUnit = 300 / (range.xMax - range.xMin);
    const yUnit = 170 / (range.yMax - range.yMin);
    expect(xUnit).toBeCloseTo(yUnit, 6);
  });

  it("moves the graph shape to the cropped plot position", () => {
    const shape = createGraphShapeFromPlotBounds(
      "graph_cropped",
      { x: 120, y: 140, w: 300, h: 170 },
      "line",
    );
    const plotBox = getGraphPlotBox(shape.props.spec);

    const patch = getGraphCropPositionPatch(shape, {
      left: plotBox.left + 72,
      top: plotBox.top + 36,
      width: 180,
      height: 96,
    });

    expect(patch).toEqual({
      x: shape.x + 72,
      y: shape.y + 36,
    });
  });

  it("rotates the cropped plot offset with the graph shape", () => {
    const shape: OverlayGraphShape = {
      ...createGraphShapeFromPlotBounds(
        "graph_rotated_crop",
        { x: 120, y: 140, w: 300, h: 170 },
        "line",
      ),
      rotation: Math.PI / 2,
    };
    const plotBox = getGraphPlotBox(shape.props.spec);

    const patch = getGraphCropPositionPatch(shape, {
      left: plotBox.left + 72,
      top: plotBox.top + 36,
      width: 180,
      height: 96,
    });

    expect(patch.x).toBeCloseTo(shape.x - 36);
    expect(patch.y).toBeCloseTo(shape.y + 72);
  });

  it("creates default axis labels as graph-anchored text shapes", () => {
    const shape = createGraphShapeFromPlotBounds(
      "graph_inserted",
      { x: 120, y: 140, w: 300, h: 170 },
      "blank",
    );
    let index = 0;
    const labels = createGraphAxisLabelShapeEntries(shape, () => `axis_label_${index += 1}`);

    expect(labels.map((entry) => entry.key)).toEqual(["x", "y", "origin"]);
    expect(labels.map((entry) => entry.shape.anchor)).toEqual([
      expect.objectContaining({ type: "shape", shapeId: shape.id }),
      expect.objectContaining({ type: "shape", shapeId: shape.id }),
      expect.objectContaining({ type: "shape", shapeId: shape.id }),
    ]);
    expect(overlayTextBlocksToInlineNodes(labels[0].shape.props.blocks).find((node) => node.type === "mathInline")?.tex).toBe("x");
    expect(overlayTextBlocksToInlineNodes(labels[1].shape.props.blocks).find((node) => node.type === "mathInline")?.tex).toBe("y");
    expect(overlayTextBlocksToInlineNodes(labels[2].shape.props.blocks).find((node) => node.type === "mathInline")?.tex).toBe("\\mathrm{O}");
    expect(overlayTextBlocksToInlineNodes(labels[0].shape.props.blocks)[0]?.type).toBe("mathInline");
    expect(labels.every((entry) => entry.shape.props.fontSize === 10)).toBe(true);
    expect(labels.map((entry) => ({ w: entry.shape.props.w, h: entry.shape.props.h }))).toEqual([
      // Widths now come from the KaTeX-backed math metrics port (PR: math box height/width fix)
      // instead of the old flat per-character heuristic, so "x"/"y"/"O" each get their own
      // (slightly different) real glyph width; height stays 14 since none of these are
      // structural formulas needing extra ascent/descent.
      { w: 9, h: 14 },
      { w: 8, h: 14 },
      // \mathrm{O} renders an upright "O", which is real-metric wider than the old heuristic's
      // flat per-character estimate.
      { w: 11, h: 14 },
    ]);
    expect(shape.props.spec.axes.xLabel).toBe("");
    expect(shape.props.spec.axes.yLabel).toBe("");
  });

  it("syncs w/h (not just richText) when an axis label's tex changes size", () => {
    // Regression test: editing an axis label used to patch only `richText` onto the existing
    // text shape, leaving `w`/`h` pinned at whatever the label's very first render measured --
    // so a short label ("x") replaced by a much wider one kept the old, now-too-small box.
    const shape = createGraphShapeFromPlotBounds(
      "graph_inserted",
      { x: 120, y: 140, w: 300, h: 170 },
      "blank",
    );
    let index = 0;
    const shortLabel = createGraphAxisLabelShapeEntries(shape, () => `axis_label_${index += 1}`, {
      keys: ["x"],
      labelsByKey: { x: "s" },
    })[0].shape;
    const wideLabel = createGraphAxisLabelShapeEntries(shape, () => `axis_label_${index += 1}`, {
      keys: ["x"],
      labelsByKey: { x: "\\dfrac{alpha}{beta}" },
    })[0].shape;

    expect(wideLabel.props.w).toBeGreaterThan(shortLabel.props.w);
    expect(wideLabel.props.h ?? 0).toBeGreaterThan(shortLabel.props.h ?? 0);

    const synced = getGraphOwnedLabelTextSyncedProps(wideLabel.props);
    expect(synced.w).toBe(wideLabel.props.w);
    expect(synced.h).toBe(wideLabel.props.h);
    expect(synced.blocks).toEqual(wideLabel.props.blocks);
    expect(synced.color).toBe(wideLabel.props.color);
    expect(synced.size).toBe(wideLabel.props.size);
  });

  it("creates customized axis label text shapes", () => {
    const shape = createGraphShapeFromPlotBounds(
      "graph_inserted",
      { x: 120, y: 140, w: 300, h: 170 },
      "blank",
    );
    let index = 0;
    const labels = createGraphAxisLabelShapeEntries(shape, () => `axis_label_${index += 1}`, {
      keys: ["x", "y"],
      labelsByKey: { x: "s", y: "t" },
    });

    expect(labels.map((entry) => entry.key)).toEqual(["x", "y"]);
    expect(overlayTextBlocksToInlineNodes(labels[0].shape.props.blocks).find((node) => node.type === "mathInline")?.tex).toBe("s");
    expect(overlayTextBlocksToInlineNodes(labels[1].shape.props.blocks).find((node) => node.type === "mathInline")?.tex).toBe("t");
  });

  it("creates point and annotation labels as graph-anchored text shapes", () => {
    const props = createGraphShapeProps("quadratic");
    const graphShape: OverlayGraphShape = {
      id: "graph_with_point_labels",
      type: "graph2dShape",
      x: 40,
      y: 48,
      props: {
        ...props,
        spec: {
          ...props.spec,
          annotations: [{ id: "annotation_f", x: "1", y: "2", text: "F" }],
        },
      },
    };

    let index = 0;
    const pointLabels = createGraphPointLabelShapeEntries(graphShape, () => `point_label_${index += 1}`);
    const annotationLabels = createGraphAnnotationLabelShapeEntries(graphShape, () => `annotation_label_${index += 1}`);

    expect(pointLabels.map((entry) => entry.pointId)).toEqual(["point_x2", "point_x3"]);
    expect(annotationLabels.map((entry) => entry.annotationId)).toEqual(["annotation_f"]);
    expect(pointLabels[0].shape.anchor).toEqual(expect.objectContaining({ type: "shape", shapeId: graphShape.id }));
    expect(annotationLabels[0].shape.anchor).toEqual(expect.objectContaining({ type: "shape", shapeId: graphShape.id }));
    expect(overlayTextBlocksToInlineNodes(pointLabels[0].shape.props.blocks).find((node) => node.type === "mathInline")?.tex).toBe("2");
    expect(overlayTextBlocksToInlineNodes(annotationLabels[0].shape.props.blocks).find((node) => node.type === "mathInline")?.tex).toBe("F");
    expect(pointLabels[0].shape.props.fontSize).toBe(10);
    expect(annotationLabels[0].shape.props.fontSize).toBe(10);
  });

  it("maps an explicit point labelPlacement to the requested compass-direction offset", () => {
    // GRAPH_LABEL_GAP is a private constant in graph.ts; mirrored here to check the offset formula.
    const GRAPH_LABEL_GAP = 10;
    const spec: Graph2DSpec = {
      kind: "cartesian",
      title: "",
      width: 300,
      height: 300,
      viewBox: { xMin: "-5", xMax: "5", yMin: "-5", yMax: "5" },
      axes: { grid: false, showX: true, showY: true, showTicks: false },
      curves: [],
      points: [{ id: "point_sw", x: "1", y: "1", label: "P", labelPlacement: "sw" }],
    };
    const graphShape: OverlayGraphShape = {
      id: "graph_explicit_placement",
      type: "graph2dShape",
      x: 0,
      y: 0,
      props: { w: spec.width, h: spec.height, spec },
    };

    const [entry] = createGraphPointLabelShapeEntries(graphShape, () => "point_label_sw");
    const plotBox = getGraphPlotBox(spec);
    const range = getGraphNumericRange(spec);
    const mapped = mapGraphPoint(1, 1, range, spec, plotBox);
    const width = entry.shape.props.w;

    // "sw" (南西) は点の左下: 左に width+gap、下に gap の位置にラベル矩形の左上が来る。
    expect(entry.shape.x - graphShape.x).toBeCloseTo(mapped.x - GRAPH_LABEL_GAP - width);
    expect(entry.shape.y - graphShape.y).toBeCloseTo(mapped.y + GRAPH_LABEL_GAP);
  });

  it("auto-places a point label away from a curve that runs through the default north-east slot", () => {
    // 点の右上 (NE) だけに存在する曲線区間を作り、既定候補 "ne" が避けられることを確認する。
    const spec: Graph2DSpec = {
      kind: "cartesian",
      title: "",
      width: 300,
      height: 300,
      viewBox: { xMin: "-5", xMax: "5", yMin: "-5", yMax: "5" },
      axes: { grid: false, showX: true, showY: true, showTicks: false },
      curves: [{
        id: "curve_ne_only",
        expr: "x + 1",
        mode: "yOfX",
        color: "#0d0d0d",
        domain: { min: "2", max: "2.8" },
      }],
      points: [{ id: "point_auto", x: "2", y: "2", label: "P", color: "#0d0d0d" }],
    };
    const graphShape: OverlayGraphShape = {
      id: "graph_auto_placement",
      type: "graph2dShape",
      x: 0,
      y: 0,
      props: { w: spec.width, h: spec.height, spec },
    };

    const [entry] = createGraphPointLabelShapeEntries(graphShape, () => "point_label_auto");
    const plotBox = getGraphPlotBox(spec);
    const range = getGraphNumericRange(spec);
    const mapped = mapGraphPoint(2, 2, range, spec, plotBox);
    const height = entry.shape.props.h ?? 0;
    const localX = entry.shape.x - graphShape.x;
    const localY = entry.shape.y - graphShape.y;

    // 既定 (曲線が無い場合) の "ne" 位置なら、ラベルは点の右・上に来る。
    const wouldBeNe = localX > mapped.x && localY + height < mapped.y;
    expect(wouldBeNe).toBe(false);
  });

  it("keeps point labels following the graph through move and resize", () => {
    const props = createGraphShapeProps("quadratic");
    const graphShape: OverlayGraphShape = {
      id: "graph_follow",
      type: "graph2dShape",
      x: 100,
      y: 100,
      props,
    };

    let index = 0;
    const [labelEntry] = createGraphPointLabelShapeEntries(graphShape, () => `point_label_${(index += 1)}`);
    const label = labelEntry.shape;

    // ラベルはグラフへ rx/ry 付きの shape アンカーで紐づき、平行移動・拡大の両方に追従する。
    expect(label.anchor).toMatchObject({ type: "shape", shapeId: graphShape.id });
    expect(label.anchor?.type === "shape" && typeof label.anchor.rx === "number").toBe(true);

    // 移動: グラフを (+60, +40) ずらすと、解決後のラベルも同じだけ動く。
    const movedGraph = { ...graphShape, x: graphShape.x + 60, y: graphShape.y + 40 };
    const movedLabel = resolveShapeAnchorPositions([movedGraph, label])[1];
    expect(movedLabel.x).toBeCloseTo(label.x + 60);
    expect(movedLabel.y).toBeCloseTo(label.y + 40);

    // リサイズ: 幅・高さを 2 倍にすると、グラフ原点からの相対位置も約 2 倍になり点に追従する。
    const resizedGraph = {
      ...graphShape,
      props: { ...graphShape.props, w: graphShape.props.w * 2, h: graphShape.props.h * 2 },
    };
    const resizedLabel = resolveShapeAnchorPositions([resizedGraph, label])[1];
    expect(resizedLabel.x - graphShape.x).toBeCloseTo((label.x - graphShape.x) * 2);
    expect(resizedLabel.y - graphShape.y).toBeCloseTo((label.y - graphShape.y) * 2);
  });

  it("keeps point label page positions fixed during graph crop preview updates", () => {
    const graphShape = createGraphShapeWithQuadraticPointLabels("graph_crop_preview");
    const label = movedPointLabel(graphShape, { x: 12, y: -8 });
    const cropBox = cropBoxForGraphRange(graphShape, { xMin: 1, xMax: 2.5, yMin: -1, yMax: 2 });
    const nextSpec = cropGraphSpecToSvgBox(graphShape.props.spec, cropBox);
    expect(nextSpec).not.toBeNull();
    const nextGraph = graphWithSpec(graphShape, nextSpec!);
    const [template] = createGraphPointLabelShapeEntries(nextGraph, () => "point_label_template", {
      pointIds: ["point_x2"],
    });

    const patch = getGraphOwnedTextLabelCropSyncPatch(nextGraph, label, template.shape);
    const resolvedLabel = resolveShapeAnchorPositions([nextGraph, { ...label, ...patch } as OverlayTextShape])[1];

    expect(patch.hidden).toBeUndefined();
    expect(resolvedLabel.x).toBeCloseTo(label.x);
    expect(resolvedLabel.y).toBeCloseTo(label.y);
  });

  it("keeps point label page positions fixed after graph crop commit resizes the graph", () => {
    const graphShape = createGraphShapeWithQuadraticPointLabels("graph_crop_commit");
    const label = movedPointLabel(graphShape, { x: 18, y: 10 });
    const cropBox = cropBoxForGraphRange(graphShape, { xMin: 1, xMax: 2.5, yMin: -1, yMax: 2 });
    const nextSpec = cropGraphSpecToSvgBox(graphShape.props.spec, cropBox, { resizeToCrop: true });
    expect(nextSpec).not.toBeNull();
    const nextGraph = graphWithSpec(graphShape, nextSpec!, getGraphCropPositionPatch(graphShape, cropBox));
    const [template] = createGraphPointLabelShapeEntries(nextGraph, () => "point_label_template", {
      pointIds: ["point_x2"],
    });

    const patch = getGraphOwnedTextLabelCropSyncPatch(nextGraph, label, template.shape);
    const resolvedLabel = resolveShapeAnchorPositions([nextGraph, { ...label, ...patch } as OverlayTextShape])[1];

    expect(nextGraph.x).not.toBe(graphShape.x);
    expect(nextGraph.props.w).not.toBe(graphShape.props.w);
    expect(patch.anchor).not.toEqual(label.anchor);
    expect(resolvedLabel.x).toBeCloseTo(label.x);
    expect(resolvedLabel.y).toBeCloseTo(label.y);
  });

  it("hides point labels that fall outside the cropped graph range", () => {
    const graphShape = createGraphShapeWithQuadraticPointLabels("graph_crop_hide");
    const label = movedPointLabel(graphShape, { x: 12, y: -8 });
    const cropBox = cropBoxForGraphRange(graphShape, { xMin: 3.2, xMax: 4.5, yMin: 1, yMax: 5 });
    const nextSpec = cropGraphSpecToSvgBox(graphShape.props.spec, cropBox);
    expect(nextSpec).not.toBeNull();
    const nextGraph = graphWithSpec(graphShape, nextSpec!);
    const templates = createGraphPointLabelShapeEntries(nextGraph, () => "point_label_template", {
      pointIds: ["point_x2"],
    });

    const patch = getGraphOwnedTextLabelCropSyncPatch(nextGraph, label, templates[0]?.shape ?? null);

    expect(templates).toHaveLength(0);
    expect(patch).toEqual({ hidden: true });
  });

  it("creates movable text labels from graph curve labels", () => {
    const props = createGraphShapeProps("line");
    const graphShape: OverlayGraphShape = {
      id: "graph_1",
      type: "graph2dShape",
      x: 40,
      y: 48,
      props: {
        ...props,
        spec: {
          ...props.spec,
          curves: [
            createGraph2DSpecPreset("line").curves[0],
            createGraph2DSpecPreset("sine").curves[0],
          ],
        },
      },
    };

    let index = 0;
    const labels = createGraphFormulaLabelShapes(
      graphShape,
      () => `label_${index += 1}`,
      { width: 800, height: 600 },
    );

    expect(labels).toHaveLength(2);
    expect(labels.map((label) => label.type)).toEqual(["text", "text"]);
    expect(labels[0].anchor).toEqual(expect.objectContaining({ type: "shape", shapeId: graphShape.id }));
    expect(labels[0].x).toBeGreaterThan(graphShape.x + graphShape.props.w);
    expect(labels[1].y).toBeGreaterThan(labels[0].y);
    expect(overlayTextBlocksToInlineNodes(labels[0].props.blocks).find((node) => node.type === "mathInline")?.tex).toBe("y = 2x+1");
    expect(overlayTextBlocksToInlineNodes(labels[1].props.blocks).find((node) => node.type === "mathInline")?.tex).toBe("y = \\sin(x)");
    expect(labels.every((label) => label.props.fontSize === 12)).toBe(true);
  });

  it("creates two-line parametric labels", () => {
    const props = createGraphShapeProps("parametric");
    const graphShape: OverlayGraphShape = {
      id: "graph_parametric",
      type: "graph2dShape",
      x: 40,
      y: 48,
      props,
    };

    const labels = createGraphFormulaLabelShapes(
      graphShape,
      () => "label_parametric",
      { width: 800, height: 600 },
    );

    expect(labels).toHaveLength(1);
    // 共有計測器 (KaTeX/MathLive 実測、math box height/width fix PR) が \begin{cases}...\end{cases}
    // の実ボックス高さ (2段のケース記法+丸括弧つき三角関数、余白込み) を測る。旧字数ヒューリスティック
    // は「\\ 改行 = 2行 * 1行分の高さ」で32pxに過小評価していた。
    expect(labels[0].props.h).toBe(51);
    expect(overlayTextBlocksToInlineNodes(labels[0].props.blocks).find((node) => node.type === "mathInline")?.tex).toBe(
      "\\begin{cases} x = \\cos(t) \\\\ y = \\sin(t) \\end{cases}",
    );
  });

  it("creates formula label entries for selected curves", () => {
    const props = createGraphShapeProps("line");
    const graphShape: OverlayGraphShape = {
      id: "graph_labels",
      type: "graph2dShape",
      x: 40,
      y: 48,
      props: {
        ...props,
        spec: {
          ...props.spec,
          curves: [
            createGraph2DSpecPreset("line").curves[0],
            createGraph2DSpecPreset("sine").curves[0],
          ],
        },
      },
    };

    const entries = createGraphFormulaLabelShapeEntries(
      graphShape,
      () => "label_selected",
      { width: 800, height: 600 },
      { curveIds: ["curve_sine"] },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].curveId).toBe("curve_sine");
    expect(overlayTextBlocksToInlineNodes(entries[0].shape.props.blocks).find((node) => node.type === "mathInline")?.tex).toBe("y = \\sin(x)");
  });

  it("identifies graph-owned text labels", () => {
    const props = createGraphShapeProps("line");
    const graphShape: OverlayGraphShape = {
      id: "graph_with_labels",
      type: "graph2dShape",
      x: 40,
      y: 48,
      props,
    };
    const axisLabel = createGraphAxisLabelShapeEntries(graphShape, () => "axis_label_x", { keys: ["x"] })[0].shape;
    const formulaLabel = createGraphFormulaLabelShapes(
      graphShape,
      () => "formula_label",
      { width: 800, height: 600 },
    )[0];
    const unkeyedFormulaLabel = {
      ...formulaLabel,
      id: "unkeyed_formula_label",
    };
    const freeText = {
      ...formulaLabel,
      id: "free_text",
    };
    const graphWithLabelIds: OverlayGraphShape = {
      ...graphShape,
      props: {
        ...graphShape.props,
        axisLabelTextShapeIds: { x: axisLabel.id },
        pointLabelTextShapeIdsByPointId: { point_1: "point_label" },
        annotationTextShapeIdsByAnnotationId: { annotation_1: "annotation_label" },
        labelTextShapeIdsByCurveId: { [graphShape.props.spec.curves[0].id]: formulaLabel.id },
        labelTextShapeIds: [unkeyedFormulaLabel.id],
      },
    };
    const pointLabel = { ...formulaLabel, id: "point_label" };
    const annotationLabel = { ...formulaLabel, id: "annotation_label" };
    const shapes = [graphWithLabelIds, axisLabel, formulaLabel, unkeyedFormulaLabel, pointLabel, annotationLabel, freeText];

    expect(isGraphLabelTextShape(axisLabel, shapes)).toBe(true);
    expect(isGraphLabelTextShape(formulaLabel, shapes)).toBe(true);
    expect(isGraphLabelTextShape(unkeyedFormulaLabel, shapes)).toBe(true);
    expect(isGraphLabelTextShape(pointLabel, shapes)).toBe(true);
    expect(isGraphLabelTextShape(annotationLabel, shapes)).toBe(true);
    expect(isGraphLabelTextShape(freeText, shapes)).toBe(false);
    expect(isGraphLabelTextShape(graphWithLabelIds, shapes)).toBe(false);
  });
});

function createGraphShapeWithQuadraticPointLabels(id: string): OverlayGraphShape {
  return {
    id,
    type: "graph2dShape",
    x: 100,
    y: 80,
    props: createGraphShapeProps("quadratic"),
  };
}

function movedPointLabel(graphShape: OverlayGraphShape, offset: { x: number; y: number }): OverlayTextShape {
  const [labelEntry] = createGraphPointLabelShapeEntries(graphShape, () => "point_label", {
    pointIds: ["point_x2"],
  });
  const label = labelEntry.shape;
  return {
    ...label,
    x: label.x + offset.x,
    y: label.y + offset.y,
    anchor: label.anchor?.type === "shape"
      ? {
          ...label.anchor,
          dx: label.anchor.dx + offset.x,
          dy: label.anchor.dy + offset.y,
        }
      : label.anchor,
  };
}

function cropBoxForGraphRange(
  graphShape: OverlayGraphShape,
  range: { xMin: number; xMax: number; yMin: number; yMax: number },
) {
  const spec = graphShape.props.spec;
  const plotBox = getGraphPlotBox(spec);
  const graphRange = getGraphNumericRange(spec);
  const topLeft = mapGraphPoint(range.xMin, range.yMax, graphRange, spec, plotBox);
  const bottomRight = mapGraphPoint(range.xMax, range.yMin, graphRange, spec, plotBox);
  return {
    left: topLeft.x,
    top: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
}

function graphWithSpec(
  graphShape: OverlayGraphShape,
  spec: OverlayGraphShape["props"]["spec"],
  patch: Partial<Pick<OverlayGraphShape, "x" | "y">> = {},
): OverlayGraphShape {
  return {
    ...graphShape,
    ...patch,
    props: {
      ...graphShape.props,
      spec,
      w: spec.width,
      h: spec.height,
    },
  };
}
