import { describe, expect, it } from "vitest";

import {
  resolveShapeAnchorPositions,
  TEXT_ASCENT_EM,
  TEXT_DESCENT_EM,
} from "@/features/drawing";
import { measureTexBoxEm } from "@/features/rendering/adapters";
import { ptToPx } from "@/lib/font-size-units";
import { DEFAULT_MATH_RENDER_ENVIRONMENT } from "@/lib/math-environment";
import { cloneOverlayShapesForPaste } from "@/lib/editor-clipboard";

import type { OverlayGraphShape, OverlayShape, OverlayShapeId } from "../types";
import {
  getExistingGraphLabelTextShapeIds,
  materializeMissingGraphOwnedTextLabels,
  syncGraphOwnedLabelTextShapePositions,
} from "./graph-labels";

type TextShape = Extract<OverlayShape, { type: "text" }>;

/**
 * A graph label is a text shape the graph owns, and since WI-1 a text shape's width is the
 * author's: nothing re-fits it to its content afterwards. A label has no author, so the width has
 * to be right the moment it is created — which is what these tests are about.
 */
describe("graph-owned label creation", () => {
  /**
   * The contract, stated once: a label's stored box is the box its formula renders in. Width is
   * KaTeX's own, scaled by the label's font size; height is the line box that formula sits on,
   * floored on each side by plain text's ascent and descent.
   */
  it("stores the box its formula renders in", () => {
    for (const label of materializeTestGraph().filter(isTextShape)) {
      const fontSizePx = ptToPx(label.props.fontSize ?? 0);
      const metrics = measureTexBoxEm(labelTex(label), DEFAULT_MATH_RENDER_ENVIRONMENT);
      const lineBoxEm = Math.max(TEXT_ASCENT_EM, metrics.ascentEm) + Math.max(TEXT_DESCENT_EM, metrics.descentEm);

      // `measureGraphLabelTex` floors the width at 8px so a single thin glyph still leaves
      // something to grab.
      expect(label.props.w).toBe(Math.max(8, Math.ceil(metrics.widthEm * fontSizePx)));
      expect(label.props.h).toBe(Math.ceil(fontSizePx * lineBoxEm));
    }
  });

  /**
   * What that is worth on the case it used to cost the most. Before the label measured its own
   * formula, a surface with no registered estimator flattened the TeX into plain characters, so
   * `\frac{1}{2}` was sized as the eleven characters of its source on a single line: far too wide
   * and only half tall enough. A box, not a string, disagrees with that on both axes.
   */
  it("measures a fraction as a box, not as its source characters", () => {
    const graph = withAxisLabels(createTestGraph(), { xLabel: "\\frac{1}{2}" });
    const label = materializeTestGraph(graph)
      .filter(isTextShape)
      .find((shape) => labelTex(shape) === "\\frac{1}{2}");
    expect(label).toBeDefined();

    const fontSizePx = ptToPx(label!.props.fontSize ?? 0);
    // The estimator read every latin glyph as a flat 0.58em and every line as exactly one line.
    const flattenedWidth = Math.ceil("\\frac{1}{2}".length * 0.58 * fontSizePx);
    const oneLine = Math.ceil(fontSizePx);

    expect(label!.props.h).toBeGreaterThan(oneLine);
    expect(label!.props.w).toBeLessThan(flattenedWidth / 2);
  });
});

/**
 * A graph and its labels are separate shapes joined only by ids on the graph and an anchor on the
 * label. Both directions have to survive every graph-level operation, and both have gone missing
 * before (see the AI-lock leak this pattern exists to prevent).
 */
describe("graph-owned label ownership", () => {
  it("reports every materialized label as owned by its graph", () => {
    const shapes = materializeTestGraph();
    const graph = shapes.find(isGraphShape)!;

    expect(getExistingGraphLabelTextShapeIds(graph, shapes).sort())
      .toEqual(shapes.filter(isTextShape).map((shape) => shape.id).sort());
  });

  it("keeps the labels owned after the graph is duplicated", () => {
    const shapes = materializeTestGraph();
    const labelCount = shapes.filter(isTextShape).length;

    const copy = cloneOverlayShapesForPaste({
      type: "application/sigma-studio",
      version: 1,
      kind: "overlayShapes",
      shapes,
      assets: {},
    });
    const copiedGraph = copy.shapes.find(isGraphShape)!;
    const copiedLabelIds = copy.shapes.filter(isTextShape).map((shape) => shape.id);

    // Every label came along, the copy points at the *copies*, and nothing still points back at
    // the original — a duplicate that kept the old ids would drag the original's labels around.
    expect(copiedLabelIds).toHaveLength(labelCount);
    expect(getExistingGraphLabelTextShapeIds(copiedGraph, copy.shapes).sort()).toEqual([...copiedLabelIds].sort());
    expect(copiedLabelIds.some((id) => shapes.some((shape) => shape.id === id))).toBe(false);
  });

  /**
   * The ids inside a spec are not all app-generated — an AI tool passes an author's id through as
   * written — so a curve really can be called `x`. The paste renames spec ids, and rewriting the
   * ownership keys with that renaming must not reach the axis map, whose keys are the fixed
   * `"x"`/`"y"`/`"origin"`: renaming one of those disowns the axis label, and the graph then fails
   * validation on reopen because the key is no longer one of the three.
   */
  it("keeps the axis label owned when a curve is named like an axis", () => {
    const shapes = materializeTestGraph(withCurveId(createTestGraph(), "x"));

    const copy = cloneOverlayShapesForPaste({
      type: "application/sigma-studio",
      version: 1,
      kind: "overlayShapes",
      shapes,
      assets: {},
    });
    const copiedGraph = copy.shapes.find(isGraphShape)!;

    expect(Object.keys(copiedGraph.props.axisLabelTextShapeIds ?? {}).sort()).toEqual(["origin", "x", "y"]);
    expect(getExistingGraphLabelTextShapeIds(copiedGraph, copy.shapes)).toHaveLength(EXPECTED_LABEL_COUNT);
  });

  /** Two elements arriving under one id are still two elements, and must not be merged into one. */
  it("gives two points that share an id two different ids", () => {
    const graph = createTestGraph();
    const duplicated: OverlayGraphShape = {
      ...graph,
      props: {
        ...graph.props,
        spec: {
          ...graph.props.spec,
          points: [
            { id: "point_p", x: "1", y: "1", label: "P" },
            { id: "point_p", x: "2", y: "2", label: "Q" },
          ],
        },
      },
    };

    const copy = cloneOverlayShapesForPaste({
      type: "application/sigma-studio",
      version: 1,
      kind: "overlayShapes",
      shapes: [duplicated],
      assets: {},
    });
    const copiedPointIds = (copy.shapes.find(isGraphShape)!.props.spec.points ?? []).map((point) => point.id);

    expect(new Set(copiedPointIds).size).toBe(2);
  });
});

/**
 * T5: a graph label hangs off its graph by `anchor: {type:"shape", rx, ry}` — a *ratio* of the
 * graph's box, not a fixed offset — so the label keeps its place on the plot when the graph is
 * moved or resized. `resolveShapeAnchorPositions` is what re-derives `x`/`y` from that anchor.
 */
describe("graph-owned label follow", () => {
  it("keeps point and annotation labels visible after an unrelated graph settings edit", () => {
    const shapes = materializeTestGraph();
    const graph = shapes.find(isGraphShape)!;
    expect(graph.props.spec.points?.[0]).not.toHaveProperty("label");
    expect(graph.props.spec.annotations?.[0]?.text).toBe("");

    const changedGraph: OverlayGraphShape = {
      ...graph,
      props: {
        ...graph.props,
        spec: {
          ...graph.props.spec,
          axes: { ...graph.props.spec.axes, grid: !graph.props.spec.axes.grid },
        },
      },
    };
    const changedShapes = shapes.map((shape) => (
      shape.id === graph.id ? changedGraph : shape
    ));
    const synced = syncGraphOwnedLabelTextShapePositions(changedShapes, changedGraph);

    expect(synced.filter(isTextShape)).toHaveLength(EXPECTED_LABEL_COUNT);
    expect(synced.filter(isTextShape).every((shape) => !shape.hidden)).toBe(true);
    expect(getExistingGraphLabelTextShapeIds(changedGraph, synced)).toHaveLength(EXPECTED_LABEL_COUNT);
  });

  it("follows the graph when it moves", () => {
    const shapes = materializeTestGraph();
    const before = labelPositionsById(resolveShapeAnchorPositions(shapes));

    const moved = resolveShapeAnchorPositions(shapes.map((shape) => (
      isGraphShape(shape) ? { ...shape, x: shape.x + 120, y: shape.y - 40 } : shape
    )));

    for (const [id, position] of Object.entries(labelPositionsById(moved))) {
      expect(position.x - before[id].x).toBeCloseTo(120, 6);
      expect(position.y - before[id].y).toBeCloseTo(-40, 6);
    }
  });

  it("keeps a label at its ratio of the plot when the graph is resized", () => {
    const shapes = materializeTestGraph();
    const resolved = resolveShapeAnchorPositions(shapes);
    const graph = resolved.find(isGraphShape)!;
    const ratioLabel = resolved.filter(isTextShape).find((shape) => (
      shape.anchor?.type === "shape" && typeof shape.anchor.rx === "number"
    ))!;
    const anchor = ratioLabel.anchor as Extract<NonNullable<OverlayShape["anchor"]>, { type: "shape" }>;

    const widened = resolveShapeAnchorPositions(resolved.map((shape) => (
      isGraphShape(shape)
        ? { ...shape, props: { ...shape.props, w: shape.props.w * 2, h: shape.props.h * 2 } }
        : shape
    )));
    const followed = widened.find((shape) => shape.id === ratioLabel.id)!;

    expect(followed.x).toBeCloseTo(graph.x + graph.props.w * 2 * (anchor.rx ?? 0) + anchor.dx, 6);
    expect(followed.y).toBeCloseTo(graph.y + graph.props.h * 2 * (anchor.ry ?? 0) + anchor.dy, 6);
  });

  /**
   * The other half of T5: `props.h` on a label is a derived cache the DOM measurement writes back.
   * It describes the label's own box, so it must not disturb the ratio the label hangs from — a
   * label that drifted every time its text was measured would walk off the plot.
   */
  it("does not move anything when a label's measured height is written back", () => {
    const shapes = resolveShapeAnchorPositions(
      materializeTestGraph(),
    );
    const before = labelPositionsById(shapes);

    const remeasured = resolveShapeAnchorPositions(shapes.map((shape) => (
      isTextShape(shape) ? { ...shape, props: { ...shape.props, h: shape.props.h + 17 } } : shape
    )));

    expect(labelPositionsById(remeasured)).toEqual(before);
    expect(remeasured.find(isGraphShape)).toEqual(shapes.find(isGraphShape));
  });
});

/** x, y and origin axis labels, one point label, one annotation label, one formula label. */
const EXPECTED_LABEL_COUNT = 6;

/**
 * Materializes the fixture's labels and refuses to continue if there are none.
 *
 * Every assertion below reads the labels out of the returned array, and all of them — the loops,
 * the two `map().toEqual(map())` comparisons, the sorted-id comparison — are satisfied by an empty
 * one. Without this the whole file would go quietly green the day labels stop being created.
 */
function materializeTestGraph(graph: OverlayGraphShape = createTestGraph()): OverlayShape[] {
  const shapes = materializeMissingGraphOwnedTextLabels([graph], createSequentialShapeId());
  expect(shapes.filter(isTextShape)).toHaveLength(EXPECTED_LABEL_COUNT);
  return shapes;
}

function isTextShape(shape: OverlayShape): shape is TextShape {
  return shape.type === "text";
}

function isGraphShape(shape: OverlayShape): shape is OverlayGraphShape {
  return shape.type === "graph2dShape";
}

/** The TeX a label carries — every graph label is a single inline formula. */
function labelTex(label: TextShape): string {
  for (const block of label.props.blocks) {
    if (block.type === "paragraph" || block.type === "heading") {
      for (const child of block.children) {
        if (child.type === "mathInline") {
          return child.tex;
        }
      }
    }
  }
  return "";
}

function labelPositionsById(shapes: OverlayShape[]): Record<string, { x: number; y: number }> {
  return Object.fromEntries(shapes.filter(isTextShape).map((shape) => [shape.id, { x: shape.x, y: shape.y }]));
}

function createSequentialShapeId(): () => OverlayShapeId {
  let index = 0;
  return () => `label_${index += 1}`;
}

function withCurveId(graph: OverlayGraphShape, id: string): OverlayGraphShape {
  return {
    ...graph,
    props: {
      ...graph.props,
      spec: {
        ...graph.props.spec,
        curves: graph.props.spec.curves.map((curve) => ({ ...curve, id })),
      },
    },
  };
}

function withAxisLabels(graph: OverlayGraphShape, axes: { xLabel: string }): OverlayGraphShape {
  return {
    ...graph,
    props: {
      ...graph.props,
      spec: { ...graph.props.spec, axes: { ...graph.props.spec.axes, ...axes } },
    },
  };
}

function createTestGraph(): OverlayGraphShape {
  return {
    id: "graph_1",
    type: "graph2dShape",
    x: 100,
    y: 80,
    rotation: 0,
    props: {
      boundsMode: "plot",
      w: 300,
      h: 180,
      spec: {
        kind: "cartesian",
        title: "",
        width: 364,
        height: 232,
        viewBox: {
          xMin: "-5",
          xMax: "5",
          yMin: "-3",
          yMax: "3",
        },
        axes: {
          grid: false,
          showX: true,
          showY: true,
          xLabel: "x",
          yLabel: "y",
          originLabel: "O",
        },
        showFormulaLabels: true,
        curves: [{
          id: "curve_f",
          expr: "x",
          label: "y = x",
          color: "#2563eb",
        }],
        points: [{
          id: "point_p",
          x: "1",
          y: "1",
          label: "P",
          labelPlacement: "ne",
        }],
        annotations: [{
          id: "annotation_a",
          x: "2",
          y: "2",
          text: "A",
        }],
      },
    },
  };
}
