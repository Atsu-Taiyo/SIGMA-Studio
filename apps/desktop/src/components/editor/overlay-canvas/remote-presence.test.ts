import { describe, expect, it } from "vitest";
import type { OverlayShape } from "@/features/document";
import { getShapeRotationPivot, getShapesVisualBounds } from "@/features/drawing";
import type { RemoteSessionOverlayPresence } from "@/features/document-session/contracts";
import {
  getRemoteOverlayPresenceLabelBounds,
  getRemoteOverlayPresenceFrameStyle,
  resolveRemoteOverlayPresenceFrames,
} from "../OverlayCanvasEditorClient";

function participant(selectedShapeIds: string[]): RemoteSessionOverlayPresence {
  return {
    actorId: "actor",
    clientId: "client",
    displayName: "利用者",
    selectedShapeIds,
  };
}

function rectangle(id: string, x: number, y: number, overrides: Partial<OverlayShape> = {}): OverlayShape {
  return {
    id,
    type: "geo",
    x,
    y,
    ...overrides,
    props: {
      w: 120,
      h: 40,
      geo: "rectangle",
      fill: "none",
      color: "#111111",
      label: "回転ラベル",
      labelColor: "#111111",
      dash: "solid",
      size: "m",
      ...(overrides.props as Record<string, unknown> | undefined),
    },
  } as OverlayShape;
}

describe("remote overlay presence geometry", () => {
  it("uses the existing shape pivot for a rotated labelled selection", () => {
    const shape = rectangle("rotated", 100, 200, { rotation: Math.PI / 3 });
    const frame = resolveRemoteOverlayPresenceFrames(participant([shape.id]), [shape])[0];
    const pivot = getShapeRotationPivot(shape);
    expect(frame.pivot).toEqual(pivot);
    expect(getRemoteOverlayPresenceFrameStyle(frame)).toMatchObject({
      transform: `rotate(${Math.PI / 3}rad)`,
      transformOrigin: `${pivot.x - frame.x}px ${pivot.y - frame.y}px`,
    });
    expect(getRemoteOverlayPresenceLabelBounds([frame]).y).toBeLessThan(frame.y);
  });

  it("uses a rotated group's expanded visual AABB without applying child rotation twice", () => {
    const group = { id: "group", type: "group", x: 0, y: 0, props: { w: 1, h: 1 } } as OverlayShape;
    const first = rectangle("first", 80, 120, { parentId: group.id, rotation: Math.PI / 4 });
    const second = rectangle("second", 240, 180, { parentId: group.id, rotation: -Math.PI / 6 });
    const shapes = [group, first, second];
    const frame = resolveRemoteOverlayPresenceFrames(participant([group.id]), shapes)[0];
    expect(frame).toMatchObject(getShapesVisualBounds([group], shapes)!);
    expect(frame.rotation).toBeUndefined();
    expect(getRemoteOverlayPresenceFrameStyle(frame).transform).toBeUndefined();
  });

  it("drops preview frames for deleted shapes and resolves the surviving selection", () => {
    const live = rectangle("live", 10, 20);
    const remote = {
      ...participant([live.id]),
      preview: { kind: "move" as const, shapes: [{ id: "deleted", x: 0, y: 0, w: 10, h: 10 }] },
    };
    expect(resolveRemoteOverlayPresenceFrames(remote, [live]).map((frame) => frame.id)).toEqual([live.id]);
    expect(resolveRemoteOverlayPresenceFrames(remote, []).map((frame) => frame.id)).toEqual([]);
  });
});
