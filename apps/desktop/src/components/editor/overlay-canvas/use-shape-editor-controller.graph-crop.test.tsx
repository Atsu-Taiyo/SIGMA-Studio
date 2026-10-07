// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { createGraph2DSpecPreset, type GraphSpecChangeMeta } from "@/lib/graph2d";

import { createGraphShapeProps } from "./shapes/graph";
import type { OverlayGraphShape, OverlayShape } from "./types";
import { useOverlayShapeEditorController } from "./use-shape-editor-controller";

/**
 * 図形エディタが、グラフの変更を「切り取りの確定」と「それ以外」で書き分けること。
 *
 * - 切り取りの確定: 図形の位置を枠に合わせて動かし、ラベルの紙面位置を保ち、**その場で文書へ書く**
 *   (`commit: true`)。ここが外れると、本文のクリックで編集面が外れたときに確定が消える。
 * - それ以外 (設定パネルなど): 従来どおり、位置は動かさず、その場では書かない。
 */

const graph: OverlayGraphShape = { id: "graph_1", type: "graph2dShape", x: 100, y: 80, props: createGraphShapeProps("quadratic") };
const PLOT_LEFT = 46;
const PLOT_TOP = 18;

async function setup(shapes: OverlayShape[] = [graph]) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const updateGraphShapeSpec = vi.fn();
  const transitionMode = vi.fn();
  let api!: ReturnType<typeof useOverlayShapeEditorController>;
  function Harness() {
    api = useOverlayShapeEditorController({
      activeTextEditorRef: { current: null },
      selectShape: vi.fn(),
      transitionMode,
      shapesRef: { current: shapes },
      updateShape: vi.fn(),
      updateGraphShapeSpec,
      insertedTableFocusRef: { current: null },
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  return { api, updateGraphShapeSpec, transitionMode };
}

function cropMeta(cropBox: { left: number; top: number; width: number; height: number }): GraphSpecChangeMeta {
  return { source: "crop", cropBox, resizeToCrop: true };
}

describe("handleGraphSpecChange", () => {
  const spec = createGraph2DSpecPreset("quadratic");

  it("moves the graph by how far the crop box starts inside the plot, and commits at once", async () => {
    const { api, updateGraphShapeSpec } = await setup();

    api.handleGraphSpecChange(graph.id, spec, cropMeta({ left: PLOT_LEFT + 50, top: PLOT_TOP + 20, width: 200, height: 100 }));

    expect(updateGraphShapeSpec).toHaveBeenCalledTimes(1);
    expect(updateGraphShapeSpec).toHaveBeenCalledWith(
      graph.id,
      spec,
      { x: graph.x + 50, y: graph.y + 20 },
      { preserveGraphOwnedLabelPositions: true, commit: true },
    );
  });

  it("moves the graph toward the dragged side when the box was widened past the plot", async () => {
    const { api, updateGraphShapeSpec } = await setup();

    api.handleGraphSpecChange(graph.id, spec, cropMeta({ left: PLOT_LEFT - 40, top: PLOT_TOP - 30, width: 500, height: 300 }));

    expect(updateGraphShapeSpec).toHaveBeenCalledWith(
      graph.id,
      spec,
      { x: graph.x - 40, y: graph.y - 30 },
      { preserveGraphOwnedLabelPositions: true, commit: true },
    );
  });

  it("leaves the position alone for a box that starts at the plot corner", async () => {
    const { api, updateGraphShapeSpec } = await setup();

    api.handleGraphSpecChange(graph.id, spec, cropMeta({ left: PLOT_LEFT, top: PLOT_TOP, width: 300, height: 150 }));

    expect(updateGraphShapeSpec.mock.calls[0][2]).toEqual({ x: graph.x, y: graph.y });
  });

  it("does not move or commit anything for an ordinary spec change (settings panel, pickers)", async () => {
    const { api, updateGraphShapeSpec } = await setup();

    api.handleGraphSpecChange(graph.id, spec);

    expect(updateGraphShapeSpec).toHaveBeenCalledWith(
      graph.id,
      spec,
      {},
      { preserveGraphOwnedLabelPositions: false, commit: false },
    );
  });

  it("still commits a crop for a graph that is no longer there, without inventing a position", async () => {
    const { api, updateGraphShapeSpec } = await setup([]);

    api.handleGraphSpecChange(graph.id, spec, cropMeta({ left: PLOT_LEFT + 10, top: PLOT_TOP, width: 100, height: 100 }));

    expect(updateGraphShapeSpec).toHaveBeenCalledWith(
      graph.id,
      spec,
      {},
      { preserveGraphOwnedLabelPositions: true, commit: true },
    );
  });
});

describe("handleGraphCropEnd", () => {
  it("returns the editor to selection", async () => {
    const { api, transitionMode } = await setup();

    api.handleGraphCropEnd();

    expect(transitionMode).toHaveBeenCalledWith({ type: "select" });
  });
});
