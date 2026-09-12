import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OverlayGraphShape, OverlayShape } from "@/features/document";
import type { AiEditingShapeLockWithLabel } from "@/lib/ai/ai-editing-block-locks";

import {
  AiShapeEditGuardOverlay,
  buildAiOverlayEditorExtensions,
} from "./editor-extensions";

function shapeLock(
  provider: AiEditingShapeLockWithLabel["provider"],
  overrides: Partial<AiEditingShapeLockWithLabel> = {},
): AiEditingShapeLockWithLabel {
  return {
    documentId: "document-1",
    shapeId: "shape-1",
    provider,
    runId: "run-1",
    roomId: "room-1",
    lockedAt: 1,
    sessionLabel: "図形を修正",
    ...overrides,
  };
}

/** A graph plus the id of the axis label it owns as a separate sibling shape. */
function graphShape(id: string, labelShapeId: string): OverlayGraphShape {
  return {
    id,
    type: "graph2dShape",
    x: 0,
    y: 0,
    rotation: 0,
    props: {
      boundsMode: "plot",
      w: 300,
      h: 180,
      axisLabelTextShapeIds: { x: labelShapeId },
      spec: {
        kind: "cartesian",
        title: "",
        width: 364,
        height: 232,
        viewBox: { xMin: "-5", xMax: "5", yMin: "-3", yMax: "3" },
        axes: { grid: false, showX: true, showY: true, xLabel: "x" },
        curves: [],
        points: [],
      },
    },
  };
}

function groupShape(id: string, size: { w: number; h: number }): OverlayShape {
  return { id, type: "group", x: 0, y: 0, props: size };
}

function rectShape(
  id: string,
  parentId: string | undefined,
  size: { w: number; h: number },
): OverlayShape {
  return {
    id,
    type: "geo",
    x: 0,
    y: 0,
    ...(parentId ? { parentId } : {}),
    props: {
      ...size,
      geo: "rectangle",
      fill: "none",
      color: "#111111",
      labelColor: "#111111",
      dash: "solid",
      size: "m",
    },
  };
}

describe("buildAiOverlayEditorExtensions", () => {
  it("projects live locks and reserved proposal targets into generic overlay contracts", () => {
    const extensions = buildAiOverlayEditorExtensions({
      liveShapeLocks: [
        shapeLock("chatgpt", {
          shapeId: "shape-1",
          runId: "run-1",
          roomId: "room-1",
          sessionLabel: "会話A",
        }),
        shapeLock("claude", {
          shapeId: "shape-2",
          runId: "run-1",
          roomId: "room-1",
          sessionLabel: "会話A",
        }),
      ],
      reservedShapeIds: new Set(["shape-2", "shape-3"]),
    });

    expect([...extensions.overlayEditPolicy.lockedShapeIds]).toEqual([
      "shape-1",
      "shape-2",
      "shape-3",
    ]);
    expect([...extensions.overlayShapeDecorations.keys()]).toEqual([
      "shape-1",
      "shape-2",
      "shape-3",
    ]);
    expect(extensions.overlayShapeDecorations.get("shape-3")).toEqual({
      className: "ai-edit-locked-shape",
    });
    expect(renderToStaticMarkup(
      <>{extensions.overlayShapeDecorations.get("shape-1")?.content}</>,
    )).toContain("AIを停止して編集(会話A)");
  });

  it("keeps the first live lock when one shape is owned by more than one run", () => {
    const extensions = buildAiOverlayEditorExtensions({
      liveShapeLocks: [
        shapeLock("chatgpt", {
          runId: "run-1",
          roomId: "room-1",
          sessionLabel: "最初の実行",
        }),
        shapeLock("claude", {
          runId: "run-2",
          roomId: "room-2",
          sessionLabel: "後の実行",
        }),
      ],
      reservedShapeIds: [],
    });
    const html = renderToStaticMarkup(
      <>{extensions.overlayShapeDecorations.get("shape-1")?.content}</>,
    );

    expect(extensions.overlayShapeDecorations.size).toBe(1);
    expect(html).toContain("AIを停止して編集(最初の実行)");
    expect(html).not.toContain("後の実行");
  });

  it("locks a graph's own label shapes with the veil but no second stop button", () => {
    const extensions = buildAiOverlayEditorExtensions({
      liveShapeLocks: [shapeLock("chatgpt", { shapeId: "graph-1", sessionLabel: "会話A" })],
      reservedShapeIds: ["graph-2"],
      shapes: [
        graphShape("graph-1", "graph-1-label"),
        graphShape("graph-2", "graph-2-label"),
        graphShape("graph-3", "graph-3-label"),
      ],
    });

    expect([...extensions.overlayEditPolicy.lockedShapeIds].sort()).toEqual([
      "graph-1",
      "graph-1-label",
      "graph-2",
      "graph-2-label",
    ]);
    const labelHtml = renderToStaticMarkup(
      <>{extensions.overlayShapeDecorations.get("graph-1-label")?.content}</>,
    );
    expect(labelHtml).toContain("ai-edit-lock-shape-veil");
    expect(labelHtml).not.toContain("AIを停止して編集");
    // A pending-proposal reservation stays veil-free, on the graph and its label alike.
    expect(extensions.overlayShapeDecorations.get("graph-2-label")).toEqual({
      className: "ai-edit-locked-shape",
    });
  });

  it("keeps the live stop button on a label the AI is editing directly", () => {
    const extensions = buildAiOverlayEditorExtensions({
      liveShapeLocks: [
        shapeLock("chatgpt", { shapeId: "graph-1", sessionLabel: "会話A" }),
        shapeLock("chatgpt", { shapeId: "graph-1-label", sessionLabel: "会話A" }),
      ],
      reservedShapeIds: [],
      shapes: [graphShape("graph-1", "graph-1-label")],
    });

    expect(renderToStaticMarkup(
      <>{extensions.overlayShapeDecorations.get("graph-1-label")?.content}</>,
    )).toContain("AIを停止して編集(会話A)");
  });

  it("veils a locked group's members and puts the stop button on the largest of them", () => {
    const extensions = buildAiOverlayEditorExtensions({
      liveShapeLocks: [shapeLock("chatgpt", { shapeId: "group-1", sessionLabel: "会話A" })],
      reservedShapeIds: [],
      shapes: [
        groupShape("group-1", { w: 200, h: 120 }),
        rectShape("small", "group-1", { w: 40, h: 20 }),
        rectShape("large", "group-1", { w: 200, h: 120 }),
      ],
    });

    expect([...extensions.overlayEditPolicy.lockedShapeIds].sort()).toEqual([
      "group-1",
      "large",
      "small",
    ]);
    // The group itself never reaches the canvas, so decorating it would show nothing.
    expect(extensions.overlayShapeDecorations.has("group-1")).toBe(false);
    expect(renderToStaticMarkup(
      <>{extensions.overlayShapeDecorations.get("large")?.content}</>,
    )).toContain("AIを停止して編集(会話A)");
    const smallHtml = renderToStaticMarkup(
      <>{extensions.overlayShapeDecorations.get("small")?.content}</>,
    );
    expect(smallHtml).toContain("ai-edit-lock-shape-veil");
    expect(smallHtml).not.toContain("AIを停止して編集");
  });

  it("reserves a grouped graph's labels through both ownership edges", () => {
    const extensions = buildAiOverlayEditorExtensions({
      liveShapeLocks: [],
      reservedShapeIds: ["group-1"],
      shapes: [
        groupShape("group-1", { w: 300, h: 180 }),
        { ...graphShape("graph-1", "graph-1-label"), parentId: "group-1" },
        rectShape("graph-1-label", undefined, { w: 30, h: 12 }),
      ],
    });

    expect([...extensions.overlayEditPolicy.lockedShapeIds].sort()).toEqual([
      "graph-1",
      "graph-1-label",
      "group-1",
    ]);
  });

  it("returns empty generic contracts when no shape is owned or reserved", () => {
    const extensions = buildAiOverlayEditorExtensions({
      liveShapeLocks: [],
      reservedShapeIds: [],
    });

    expect(extensions.overlayEditPolicy.lockedShapeIds.size).toBe(0);
    expect(extensions.overlayShapeDecorations.size).toBe(0);
  });
});

describe("AiShapeEditGuardOverlay", () => {
  it("shows the running provider mark beside the shape lock action", () => {
    const html = renderToStaticMarkup(
      <AiShapeEditGuardOverlay lock={shapeLock("claude")} />,
    );

    expect(html).toContain("ai-edit-lock-shape-provider-logo");
    expect(html).toContain("ai-working-provider-icon");
    expect(html).toContain("ui-shimmer-icon");
    expect(html).toContain('fill="#D97757"');
    expect(html).toContain("AIを停止して編集(図形を修正)");
  });

  it("omits the provider slot when the run has no provider identity", () => {
    const html = renderToStaticMarkup(
      <AiShapeEditGuardOverlay lock={shapeLock(null)} />,
    );

    expect(html).not.toContain("ai-edit-lock-shape-provider-logo");
    expect(html).not.toContain("ai-working-provider-icon");
    expect(html).toContain("AIを停止して編集(図形を修正)");
  });
});
