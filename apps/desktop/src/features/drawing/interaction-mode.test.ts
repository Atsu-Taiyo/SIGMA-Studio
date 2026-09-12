import { describe, expect, it } from "vitest";

import type { OverlayShape } from "@/features/document";

import {
  createInitialOverlayInteractionMode,
  getEditingShapeId,
  getMoveOffset,
  overlayInteractionModeReducer,
  resolveMovePointerUp,
  resolveRotatePointerDelta,
  type OverlayInteractionMode,
} from "./interaction-mode";

const textShape: Extract<OverlayShape, { type: "text" }> = {
  id: "shape_text",
  type: "text",
  x: 10,
  y: 20,
  props: {
    w: 120,
    h: 16,
    blocks: [{ type: "paragraph", id: "interaction_mode_test_6", children: [{ type: "text", text: "Text" }] }],
    color: "black",
    size: "m",
  },
};

const tableShape: Extract<OverlayShape, { type: "tableShape" }> = {
  id: "shape_table",
  type: "tableShape",
  x: 10,
  y: 20,
  props: {
    w: 120,
    h: 80,
    table: {
      version: 1,
      kind: "plain",
      columns: [],
      rows: [],
      cells: [],
      grid: {
        borderColor: "#111827",
        borderWidth: 1,
      },
      defaultCellStyle: {},
    },
  },
};

describe("overlay move interaction mode", () => {
  it("owns the live move offset and discards it when the mode completes", () => {
    const started = startMove([textShape]);
    expect(started.offset).toBeNull();
    expect(getMoveOffset(started)).toBeNull();

    const offset = { x: 18, y: -7 };
    const updated = overlayInteractionModeReducer(started, { type: "updateMove", offset });
    expect(updated).not.toBe(started);
    expect(getMoveOffset(updated)).toBe(offset);

    const repeated = overlayInteractionModeReducer(updated, {
      type: "updateMove",
      offset: { x: 18, y: -7 },
    });
    expect(repeated).toBe(updated);

    const completed = overlayInteractionModeReducer(updated, { type: "select" });
    expect(completed.id).toBe("overlay.select");
    expect(getMoveOffset(completed)).toBeNull();
  });

  it("ignores move updates outside a move session", () => {
    const selected = createInitialOverlayInteractionMode();

    expect(overlayInteractionModeReducer(selected, {
      type: "updateMove",
      offset: { x: 12, y: 8 },
    })).toBe(selected);
  });

  it("uses raw release distance for click-to-edit even when the preview offset snapped away", () => {
    const started = startMove([textShape], "text");
    const snappedOffset = { x: 40, y: 20 };
    const updated = overlayInteractionModeReducer(started, {
      type: "updateMove",
      offset: snappedOffset,
    });
    expect(updated.id).toBe("overlay.move");
    if (updated.id !== "overlay.move") {
      throw new Error("Expected move mode");
    }

    expect(resolveMovePointerUp(updated, { x: 12, y: 20 })).toEqual({
      kind: "edit",
      editor: "text",
      shapeId: textShape.id,
    });
  });

  it("commits the snapped offset when raw release distance reaches the edit threshold", () => {
    const started = startMove([textShape], "text");
    const snappedOffset = { x: 40, y: 20 };
    const updated = overlayInteractionModeReducer(started, {
      type: "updateMove",
      offset: snappedOffset,
    });
    expect(updated.id).toBe("overlay.move");
    if (updated.id !== "overlay.move") {
      throw new Error("Expected move mode");
    }

    const resolution = resolveMovePointerUp(updated, { x: 13, y: 20 });
    expect(resolution).toEqual({ kind: "commit", offset: snappedOffset });
    if (resolution.kind === "commit") {
      expect(resolution.offset).toBe(snappedOffset);
    }
  });

  it("preserves table click-to-edit targeting", () => {
    const started = startMove([tableShape], "table");

    expect(resolveMovePointerUp(started, { x: 10, y: 22 })).toEqual({
      kind: "edit",
      editor: "table",
      shapeId: tableShape.id,
    });
  });

  it("does not commit a missing or zero move offset", () => {
    const started = startMove([textShape]);
    expect(resolveMovePointerUp(started, { x: 30, y: 20 })).toEqual({ kind: "noop" });

    const zeroOffset = overlayInteractionModeReducer(started, {
      type: "updateMove",
      offset: { x: 0, y: 0 },
    });
    expect(zeroOffset.id).toBe("overlay.move");
    if (zeroOffset.id !== "overlay.move") {
      throw new Error("Expected move mode");
    }
    expect(resolveMovePointerUp(zeroOffset, { x: 30, y: 20 })).toEqual({ kind: "noop" });
  });
});

describe("overlay 3D viewport editing mode", () => {
  it("owns direct manipulation separately from moving the placed shape", () => {
    const selected = createInitialOverlayInteractionMode();
    const editing = overlayInteractionModeReducer(selected, {
      type: "editGraph3D",
      shapeId: "shape_graph3d",
    });

    expect(editing).toEqual({
      id: "overlay.graph3dEditing",
      tool: { kind: "select" },
      shapeId: "shape_graph3d",
    });
    expect(getEditingShapeId(editing)).toBe("shape_graph3d");
    expect(getEditingShapeId(overlayInteractionModeReducer(editing, { type: "select" }))).toBeNull();
  });
});

describe("overlay rotate interaction mode", () => {
  it("normalizes the pointer angle delta across the signed angle boundary", () => {
    const mode = startRotate([textShape], degrees(170));

    expect(resolveRotatePointerDelta(mode, pointAtDegrees(-170), false)).toBeCloseTo(degrees(20));
  });

  it("snaps a single shape's final page rotation to an absolute step", () => {
    const mode = startRotate([{ ...textShape, rotation: degrees(7) }]);

    expect(resolveRotatePointerDelta(mode, pointAtDegrees(20), true)).toBeCloseTo(degrees(23));
  });

  it("preserves the neutral snapping baseline for a multi-shape selection", () => {
    const mode = startRotate([
      { ...textShape, id: "shape_first", rotation: degrees(7) },
      { ...textShape, id: "shape_second", rotation: degrees(7) },
    ]);

    expect(resolveRotatePointerDelta(mode, pointAtDegrees(20), true)).toBeCloseTo(degrees(15));
  });
});

function startMove(
  shapes: OverlayShape[],
  editOnPointerUp?: "text" | "table",
): Extract<OverlayInteractionMode, { id: "overlay.move" }> {
  const mode = overlayInteractionModeReducer(createInitialOverlayInteractionMode(), {
    type: "startMove",
    shapes,
    start: { x: 10, y: 20 },
    editOnPointerUp,
  });
  if (mode.id !== "overlay.move") {
    throw new Error("Expected move mode");
  }
  return mode;
}

function startRotate(
  shapes: OverlayShape[],
  startAngle = 0,
): Extract<OverlayInteractionMode, { id: "overlay.rotate" }> {
  const mode = overlayInteractionModeReducer(createInitialOverlayInteractionMode(), {
    type: "startRotate",
    shapes,
    center: { x: 0, y: 0 },
    startAngle,
  });
  if (mode.id !== "overlay.rotate") {
    throw new Error("Expected rotate mode");
  }
  return mode;
}

function pointAtDegrees(angle: number): { x: number; y: number } {
  const radians = degrees(angle);
  return {
    x: Math.cos(radians) * 100,
    y: Math.sin(radians) * 100,
  };
}

function degrees(angle: number): number {
  return angle * Math.PI / 180;
}
