// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { cropGraphSpecToSvgBox, getGraphNumericRange, getGraphPlotBox, mapGraphPoint } from "@/lib/graph2d";

import { resolveShapeAnchorPositions } from "./anchor";
import { createInitialOverlayInteractionMode } from "./interaction-mode";
import {
  createGraphPointLabelShapeEntries,
  createGraphShapeProps,
  getGraphCropPositionPatch,
} from "./shapes/graph";
import { withGraphPointLabelTextShapeIds } from "./shapes/graph-labels";
import type { OverlayGraphShape, OverlayShape, OverlayTextShape } from "./types";
import { useOverlayMutations } from "./use-overlay-mutations";

/**
 * 切り取りの確定は、`setShapes` の更新関数を積むだけでは足りない。
 *
 * ページ本文をクリックして切り取りを終えると、編集面は次の描画の前に外れる。積んだだけの更新は
 * 実行されず、確定した結果が丸ごと消えた (切り取った範囲が元の横幅へ引き伸ばされて見えた)。
 * そのため確定は `commit: true` で、その場で `shapesRef` を更新し、すぐ文書へ書く。
 * ここでは「描画を待たずに」起きることを固定する。
 */

function graphShape(): OverlayGraphShape {
  return { id: "graph_crop", type: "graph2dShape", x: 100, y: 80, props: createGraphShapeProps("quadratic") };
}

function setup(shapes: OverlayShape[]) {
  const shapesRef = { current: shapes };
  const setShapes = vi.fn();
  const commitOverlayChangeNow = vi.fn();
  const queueOverlaySave = vi.fn();
  const explicitlySavedShapeStatesRef = { current: new WeakSet<OverlayShape[]>() };
  let api!: ReturnType<typeof useOverlayMutations>;
  function Harness() {
    api = useOverlayMutations({
      setRegionSelection: vi.fn(),
      shapesRef,
      selectedIdsRef: { current: [] },
      setSelectedIds: vi.fn(),
      onSelectedCountChange: undefined,
      focusedGroupIdRef: { current: null },
      transitionMode: vi.fn(),
      modeRef: { current: createInitialOverlayInteractionMode() },
      activeTextEditorRef: { current: null },
      explicitlySavedShapeStatesRef,
      setShapes,
      commitOverlayChangeNow,
      queueOverlaySave,
      anchorMeasurementsRef: { current: { rects: new Map(), ordered: [] } },
    });
    return null;
  }
  const mount = async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness />));
    return { api, root };
  };
  return { shapesRef, setShapes, commitOverlayChangeNow, queueOverlaySave, explicitlySavedShapeStatesRef, mount };
}

/** 現在のグラフ範囲の座標で与えた領域を、その図の SVG 座標の枠にする (範囲の外を指せば拡大の枠)。 */
function boxForRange(shape: OverlayGraphShape, range: { xMin: number; xMax: number; yMin: number; yMax: number }) {
  const spec = shape.props.spec;
  const plotBox = getGraphPlotBox(spec);
  const current = getGraphNumericRange(spec);
  const topLeft = mapGraphPoint(range.xMin, range.yMax, current, spec, plotBox);
  const bottomRight = mapGraphPoint(range.xMax, range.yMin, current, spec, plotBox);
  return { left: topLeft.x, top: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
}

describe("updateGraphShapeSpec with commit", () => {
  it("updates the shapes and writes the document before any render happens", async () => {
    const graph = graphShape();
    const { shapesRef, setShapes, commitOverlayChangeNow, explicitlySavedShapeStatesRef, mount } = setup([graph]);
    const { api } = await mount();
    const box = boxForRange(graph, { xMin: 1, xMax: 3, yMin: -1, yMax: 4 });
    const spec = cropGraphSpecToSvgBox(graph.props.spec, box, { resizeToCrop: true })!;
    const patch = getGraphCropPositionPatch(graph, box);

    api.updateGraphShapeSpec(graph.id, spec, patch, { preserveGraphOwnedLabelPositions: true, commit: true });

    // `act` で描画を流す前の時点: 確定は参照にも文書にも届いている。
    const next = shapesRef.current[0] as OverlayGraphShape;
    expect(next).not.toBe(graph);
    expect(next.x).toBeCloseTo(patch.x!, 6);
    expect(next.y).toBeCloseTo(patch.y!, 6);
    expect(next.props.spec).toBe(spec);
    expect(next.props.boundsMode).toBe("plot");
    expect(next.props.w).toBeCloseTo(box.width, 6);
    expect(next.props.h).toBeCloseTo(box.height, 6);
    expect(commitOverlayChangeNow).toHaveBeenCalledTimes(1);
    expect(commitOverlayChangeNow).toHaveBeenCalledWith();
    // 配列そのものを渡す (更新関数ではない)。更新関数は描画されない限り実行されない。
    expect(setShapes).toHaveBeenCalledTimes(1);
    expect(setShapes).toHaveBeenCalledWith(shapesRef.current);
    // 保存の効果が同じ状態をもう一度保存しない。
    expect(explicitlySavedShapeStatesRef.current.has(shapesRef.current)).toBe(true);
  });

  it("does the same for a widening box: the shape grows toward the dragged side", async () => {
    const graph = graphShape();
    const { shapesRef, commitOverlayChangeNow, mount } = setup([graph]);
    const { api } = await mount();
    const plotBox = getGraphPlotBox(graph.props.spec);
    const base = boxForRange(graph, getGraphNumericRange(graph.props.spec));
    const box = { left: base.left - 70, top: base.top - 30, width: base.width + 70 + 40, height: base.height + 30 + 25 };
    const spec = cropGraphSpecToSvgBox(graph.props.spec, box, { resizeToCrop: true })!;

    api.updateGraphShapeSpec(graph.id, spec, getGraphCropPositionPatch(graph, box), { commit: true });

    const next = shapesRef.current[0] as OverlayGraphShape;
    expect(next.props.w).toBeCloseTo(graph.props.w + 110, 6);
    expect(next.props.h).toBeCloseTo(graph.props.h + 55, 6);
    // 左・上へ広げたぶん、図形の原点も左・上へ動く (元の部分は紙面の同じ場所に残る)。
    expect(next.x).toBeCloseTo(graph.x - 70, 6);
    expect(next.y).toBeCloseTo(graph.y - 30, 6);
    expect(plotBox.left).toBeGreaterThan(0);
    expect(commitOverlayChangeNow).toHaveBeenCalledTimes(1);
  });

  it("ignores a missing graph without writing anything", async () => {
    const graph = graphShape();
    const { shapesRef, setShapes, commitOverlayChangeNow, mount } = setup([graph]);
    const { api } = await mount();
    const before = shapesRef.current;

    api.updateGraphShapeSpec("no_such_graph", graph.props.spec, {}, { commit: true });

    expect(shapesRef.current).toBe(before);
    expect(setShapes).not.toHaveBeenCalled();
    expect(commitOverlayChangeNow).not.toHaveBeenCalled();
  });

  it("without commit it only queues an updater, which is what an unmounting editor drops", async () => {
    const graph = graphShape();
    const { shapesRef, setShapes, commitOverlayChangeNow, mount } = setup([graph]);
    const { api } = await mount();

    api.updateGraphShapeSpec(graph.id, graph.props.spec, { x: 140 });

    expect(commitOverlayChangeNow).not.toHaveBeenCalled();
    expect(shapesRef.current[0]).toBe(graph);
    expect(setShapes).toHaveBeenCalledTimes(1);
    const updater = setShapes.mock.calls[0][0] as (current: OverlayShape[]) => OverlayShape[];
    expect(typeof updater).toBe("function");
    const result = updater([graph]);
    expect((result[0] as OverlayGraphShape).x).toBe(140);
    expect(shapesRef.current).toBe(result);
  });
});

describe("graph-owned labels across a committed crop", () => {
  function withLabel() {
    const base = graphShape();
    const [entry] = createGraphPointLabelShapeEntries(base, () => "label_x2", { pointIds: ["point_x2"] });
    // 実際の編集経路と同じく、グラフ側にもラベルの図形 ID を持たせる (これが「グラフが持つラベル」の印)。
    const graph = withGraphPointLabelTextShapeIds(base, { point_x2: "label_x2" });
    return { graph, label: entry.shape };
  }

  function labelPage(shapes: OverlayShape[]): { x: number; y: number; hidden: boolean } {
    const label = resolveShapeAnchorPositions(shapes).find((shape): shape is OverlayTextShape => shape.id === "label_x2")!;
    return { x: label.x, y: label.y, hidden: label.hidden === true };
  }

  async function commitBox(box: { left: number; top: number; width: number; height: number }) {
    const { graph, label } = withLabel();
    const { shapesRef, mount } = setup([graph, label]);
    const { api } = await mount();
    const before = labelPage(shapesRef.current);
    const spec = cropGraphSpecToSvgBox(graph.props.spec, box, { resizeToCrop: true })!;
    api.updateGraphShapeSpec(graph.id, spec, getGraphCropPositionPatch(graph, box), {
      preserveGraphOwnedLabelPositions: true,
      commit: true,
    });
    return { before, after: labelPage(shapesRef.current), shapes: shapesRef.current };
  }

  it("keeps a label where it is on the page when the crop still contains its point", async () => {
    const { graph } = withLabel();
    const { before, after } = await commitBox(boxForRange(graph, { xMin: 1, xMax: 3.5, yMin: -1, yMax: 3 }));
    expect(after.hidden).toBe(false);
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
  });

  it("keeps a label where it is on the page when the graph is widened on every side", async () => {
    const { graph } = withLabel();
    const range = getGraphNumericRange(graph.props.spec);
    const { before, after } = await commitBox(boxForRange(graph, {
      xMin: range.xMin - 2,
      xMax: range.xMax + 3,
      yMin: range.yMin - 1,
      yMax: range.yMax + 4,
    }));
    expect(after.hidden).toBe(false);
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
  });

  it("hides a label whose point is cropped out", async () => {
    const { graph } = withLabel();
    const { after } = await commitBox(boxForRange(graph, { xMin: 3.2, xMax: 4.5, yMin: 1, yMax: 5 }));
    expect(after.hidden).toBe(true);
  });
});
