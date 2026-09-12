import { describe, expect, it } from "vitest";

import {
  createInitialOverlayInteractionMode,
  getEditingShapeId,
  getGraphFillPickShapeId,
  getOverlayTool,
  getOriginPickShapeId,
  isInitialOriginPickMode,
  overlayInteractionModeReducer,
} from "./interaction-mode";
import type { OverlayShape } from "./types";

const textShape: OverlayShape = {
  id: "shape_text",
  type: "text",
  x: 10,
  y: 20,
  rotation: 0,
  props: {
    w: 220,
    h: 16,
    blocks: [{ type: "paragraph", id: "interaction_mode_test_30", children: [{ type: "text", text: "Text" }] }],
    color: "black",
    size: "m",
  },
};

describe("overlay interaction mode", () => {
  it("tracks tool and editing shape state explicitly", () => {
    let mode = createInitialOverlayInteractionMode();

    mode = overlayInteractionModeReducer(mode, { type: "setTool", tool: { kind: "select" } });
    expect(getOverlayTool(mode)).toEqual({ kind: "select" });
    expect(getEditingShapeId(mode)).toBeNull();

    mode = overlayInteractionModeReducer(mode, { type: "editText", shapeId: textShape.id });
    expect(mode.id).toBe("overlay.textEditing");
    expect(getOverlayTool(mode)).toEqual({ kind: "select" });
    expect(getEditingShapeId(mode)).toBe(textShape.id);

    mode = overlayInteractionModeReducer(mode, { type: "select" });
    expect(mode.id).toBe("overlay.select");
    expect(getEditingShapeId(mode)).toBeNull();
  });

  it("retains the active tool across interaction transitions", () => {
    let mode = createInitialOverlayInteractionMode();
    mode = overlayInteractionModeReducer(mode, {
      type: "setTool",
      tool: { kind: "insert", command: "rectangle" },
    });

    expect(getOverlayTool(mode)).toEqual({ kind: "insert", command: "rectangle" });

    mode = overlayInteractionModeReducer(mode, {
      type: "startInsertDrag",
      tool: { kind: "insert", command: "rectangle" },
      start: { x: 0, y: 0 },
    });
    expect(mode.id).toBe("overlay.insertDrag");

    mode = overlayInteractionModeReducer(mode, { type: "select" });
    expect(mode.id).toBe("overlay.select");
    expect(getOverlayTool(mode)).toEqual({ kind: "insert", command: "rectangle" });
  });

  it("keeps the same mode object when selecting while already in select mode", () => {
    const mode = createInitialOverlayInteractionMode();

    expect(overlayInteractionModeReducer(mode, { type: "select" })).toBe(mode);
  });

  it("keeps interaction snapshots in the mode until completion", () => {
    const mode = overlayInteractionModeReducer(
      createInitialOverlayInteractionMode(),
      { type: "startMove", shapes: [textShape], start: { x: 10, y: 20 } },
    );

    expect(mode).toMatchObject({
      id: "overlay.move",
      shapes: [textShape],
      start: { x: 10, y: 20 },
    });
  });

  it("represents graph origin picking separately from normal selection", () => {
    const mode = overlayInteractionModeReducer(
      createInitialOverlayInteractionMode(),
      { type: "pickOrigin", shapeId: "shape_graph" },
    );

    expect(mode.id).toBe("overlay.originPicking");
    expect(getOriginPickShapeId(mode)).toBe("shape_graph");
    expect(isInitialOriginPickMode(mode)).toBe(false);
  });

  it("marks origin picking from graph insertion as initial", () => {
    const mode = overlayInteractionModeReducer(
      createInitialOverlayInteractionMode(),
      { type: "pickOrigin", shapeId: "shape_graph", initial: true },
    );

    expect(mode.id).toBe("overlay.originPicking");
    expect(getOriginPickShapeId(mode)).toBe("shape_graph");
    expect(isInitialOriginPickMode(mode)).toBe(true);
  });

  it("represents graph fill picking separately from normal selection", () => {
    const mode = overlayInteractionModeReducer(
      createInitialOverlayInteractionMode(),
      { type: "pickGraphFill", shapeId: "shape_graph" },
    );

    expect(mode.id).toBe("overlay.graphFillPicking");
    expect(getGraphFillPickShapeId(mode)).toBe("shape_graph");
  });
});
