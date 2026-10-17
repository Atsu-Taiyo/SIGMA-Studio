// @vitest-environment happy-dom
import type { OverlayGraphShape, OverlayShape, PageOverlay } from "@/features/document";
import { createGraph2DSpecPreset } from "@/lib/graph2d";
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useOverlaySnapshotState } from "./use-snapshot-state";

/**
 * #207: 図形の編集面を開いた瞬間、本文に付いた図形が保存時の位置へ戻って見えた。
 *
 * 編集面は、開いたときのレイアウト effect で本文の実測から図形の位置を解き直す
 * (`OverlayCanvasEditorClient` の `syncAnchoredShapesToRects`)。その effect は `shapesRef` を
 * 先へ進めてから `setShapes` するので、描き直しまでの間は ref のほうが state より新しい。
 * 同じコミットの受動 effect が「state を ref へ写す」と、ref が保存位置のまま (解く前) へ
 * 巻き戻り、それを読んだグラフのラベル整合が `setShapes` して、解いた位置を上書きしていた。
 * 本文が動く (Enter) までアンカーは解き直されないので、改行すると戻って見えた。
 */
const STORED_Y = 0;
const RESOLVED_Y = 320;

const anchored: OverlayShape = {
  id: "anchored",
  type: "geo",
  x: 120,
  y: STORED_Y,
  anchor: { type: "block", blockId: "paragraph", dy: 4 },
  props: { w: 120, h: 60, geo: "rectangle", fill: "none", color: "#1133cc", labelColor: "#111111", dash: "solid", size: "m" },
};

/** 軸ラベルの文字を持つのに、ラベルの文字図形がまだ無いグラフ。開くと整合がラベルを作る。 */
function graphNeedingLabels(): OverlayGraphShape {
  const spec = createGraph2DSpecPreset("blank");
  return {
    id: "graph",
    type: "graph2dShape",
    x: 300,
    y: 600,
    anchor: { type: "page" },
    props: { boundsMode: "plot", w: spec.width, h: spec.height, spec: { ...spec, axes: { ...spec.axes, xLabel: "x", yLabel: "y" } } },
  };
}

function overlay(shapes: OverlayShape[]): PageOverlay {
  return { overlaySnapshot: { version: 1, shapes, assets: {} } };
}

function resolveAnchored(shapes: OverlayShape[]): OverlayShape[] {
  return shapes.map((shape) => shape.anchor?.type === "block" ? { ...shape, y: RESOLVED_Y } : shape);
}

function harness(strict: boolean) {
  let api!: ReturnType<typeof useOverlaySnapshotState>;
  const host = document.createElement("div");
  const root = createRoot(host);

  function Harness({ source }: { source: PageOverlay }) {
    const state = useOverlaySnapshotState({
      overlay: source,
      canvasWidth: 800,
      canvasHeight: 2000,
      documentId: "doc",
      externalRevision: 0,
      onChange: vi.fn(),
    });
    const { shapesRef, setShapes } = state;
    // 編集面を開いたときのアンカー解決と同じ形: ref を先に進めてから setShapes する。
    useLayoutEffect(() => {
      if (!shapesRef.current.some((shape) => shape.anchor?.type === "block" && shape.y !== RESOLVED_Y)) {
        return;
      }
      const resolved = resolveAnchored(shapesRef.current);
      shapesRef.current = resolved;
      setShapes(resolved);
    }, [setShapes, shapesRef]);
    api = state;
    return null;
  }

  return {
    current: () => api,
    render: async (source: PageOverlay) => {
      await act(async () => root.render(strict ? <StrictMode><Harness source={source} /></StrictMode> : <Harness source={source} />));
    },
    unmount: async () => act(async () => root.unmount()),
  };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("useOverlaySnapshotState keeps a position resolved while the editor mounts (#207)", () => {
  for (const strict of [false, true]) {
    it(`does not roll the anchored shape back to its stored y when graph labels are reconciled${strict ? " (StrictMode)" : ""}`, async () => {
      const h = harness(strict);
      await h.render(overlay([anchored, graphNeedingLabels()]));

      const { shapes, shapesRef } = h.current();
      // 整合は実際に走った (ラベルが足された) のに、
      expect(shapes.filter((shape) => shape.type === "text").length).toBeGreaterThan(0);
      // 解いた位置は残る。state と ref は同じ図形を指す。
      expect(shapes.find((shape) => shape.id === "anchored")?.y).toBe(RESOLVED_Y);
      expect(shapesRef.current).toBe(shapes);
      await h.unmount();
    });
  }

  it("still copies a committed state into the ref when nothing moved the ref ahead", async () => {
    const h = harness(false);
    await h.render(overlay([{ ...anchored, anchor: { type: "page" } }]));
    const next = [{ ...h.current().shapesRef.current[0], x: 999 }];
    // ref を書かない setShapes (保険の経路)。コミットした state が ref へ写る。
    await act(async () => h.current().setShapes(next));
    expect(h.current().shapesRef.current).toBe(next);
    await h.unmount();
  });
});
