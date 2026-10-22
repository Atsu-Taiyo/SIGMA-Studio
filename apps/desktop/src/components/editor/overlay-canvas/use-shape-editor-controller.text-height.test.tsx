// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { OverlayShape } from "./types";
import { useOverlayShapeEditorController } from "./use-shape-editor-controller";

/**
 * 図中テキストの箱の高さの報告が、保存する値と仮の値で書き分けられること。
 *
 * 段落の下余白をドラッグしている間は、箱を中身に追従させたいが履歴にも保存にも積みたくない。積むと、
 * 離した時の確定 (1 手) とは別の取り消し地点になり、ドラッグが何手にも割れる。
 */

const textShape: Extract<OverlayShape, { type: "text" }> = {
  id: "text_h",
  type: "text",
  x: 0,
  y: 0,
  props: { w: 200, h: 40, color: "#111827", size: "m", blocks: [] },
};

async function setup(shape: OverlayShape = textShape) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const updateShape = vi.fn();
  let api!: ReturnType<typeof useOverlayShapeEditorController>;
  function Harness() {
    api = useOverlayShapeEditorController({
      activeTextEditorRef: { current: null },
      selectShape: vi.fn(),
      transitionMode: vi.fn(),
      shapesRef: { current: [shape] },
      updateShape,
      updateGraphShapeSpec: vi.fn(),
      insertedTableFocusRef: { current: null },
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  return { api, updateShape };
}

describe("handleTextMeasuredHeight", () => {
  it("writes a measured height coalesced into the edit that caused it", async () => {
    const { api, updateShape } = await setup();

    api.handleTextMeasuredHeight(textShape.id, 64);

    expect(updateShape).toHaveBeenCalledWith(
      { id: textShape.id, type: "text", props: { h: 64 } },
      { history: "coalesce" },
    );
  });

  it("follows a preview height on screen only: no history, no save", async () => {
    const { api, updateShape } = await setup();

    api.handleTextMeasuredHeight(textShape.id, 64, { preview: true });

    expect(updateShape).toHaveBeenCalledTimes(1);
    expect(updateShape).toHaveBeenCalledWith({ id: textShape.id, type: "text", props: { h: 64 } }, undefined);
  });

  it("ignores a height that is within a pixel of the stored one", async () => {
    const { api, updateShape } = await setup();

    api.handleTextMeasuredHeight(textShape.id, 40.4, { preview: true });
    api.handleTextMeasuredHeight(textShape.id, 40.4);

    expect(updateShape).not.toHaveBeenCalled();
  });
});
