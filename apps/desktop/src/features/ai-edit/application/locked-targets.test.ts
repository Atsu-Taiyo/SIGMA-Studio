import { describe, expect, it } from "vitest";

import type { OverlayGraphShape } from "@/features/document";

import {
  describeAiLockedTargets,
  isAiLockedBlock,
  isAiLockedShapeSelection,
  mergeAiLockedTargets,
} from "./locked-targets";
import {
  aiActiveRunBlockedMessage,
  aiPendingProposalBlockedMessage,
} from "../adapters/tiptap/edit-lock-adapter";

describe("mergeAiLockedTargets", () => {
  it("unions live-run targets with pending-proposal reservations", () => {
    const targets = mergeAiLockedTargets(
      ["run-block"],
      ["run-shape"],
      { blockIds: ["pending-block"], shapeIds: ["pending-shape"] },
    );

    expect([...targets.blockIds].sort()).toEqual(["pending-block", "run-block"]);
    expect([...targets.shapeIds].sort()).toEqual(["pending-shape", "run-shape"]);
  });

  it("keeps the live-run subset distinguishable from pending reservations", () => {
    const targets = mergeAiLockedTargets(
      ["run-block"],
      [],
      { blockIds: ["run-block", "pending-block"], shapeIds: [] },
    );

    expect([...targets.runBlockIds]).toEqual(["run-block"]);
    expect(targets.blockIds.has("pending-block")).toBe(true);
    expect(targets.runBlockIds.has("pending-block")).toBe(false);
  });

  it("dedupes a target held by a run and its own pending proposal", () => {
    const targets = mergeAiLockedTargets(
      ["shared"],
      [],
      { blockIds: ["shared"], shapeIds: [] },
    );

    expect([...targets.blockIds]).toEqual(["shared"]);
  });

  it("reserves a locked graph's own label shapes, for a run and for a proposal alike", () => {
    const shapes = [graphWithLabels("graph_run", ["run_axis_label"]), graphWithLabels("graph_pending", ["pending_axis_label"])];

    const runTargets = mergeAiLockedTargets([], ["graph_run"], { blockIds: [], shapeIds: [] }, shapes);
    expect([...runTargets.shapeIds].sort()).toEqual(["graph_run", "run_axis_label"]);
    // Held by the run, so the refusal can offer the stop button.
    expect([...runTargets.runShapeIds].sort()).toEqual(["graph_run", "run_axis_label"]);

    const pendingTargets = mergeAiLockedTargets(
      [],
      [],
      { blockIds: [], shapeIds: ["graph_pending"] },
      shapes,
    );
    expect([...pendingTargets.shapeIds].sort()).toEqual(["graph_pending", "pending_axis_label"]);
    expect([...pendingTargets.runShapeIds]).toEqual([]);
  });

  it("leaves an unrelated graph's labels editable", () => {
    const targets = mergeAiLockedTargets(
      [],
      ["graph_a"],
      { blockIds: [], shapeIds: [] },
      [graphWithLabels("graph_a", ["label_a"]), graphWithLabels("graph_b", ["label_b"])],
    );

    expect(targets.shapeIds.has("label_b")).toBe(false);
  });
});

describe("isAiLockedBlock / isAiLockedShapeSelection", () => {
  it("keeps the body toolbar available for a partially reserved paragraph", () => {
    const partial = mergeAiLockedTargets(["p1"], [], { blockIds: [], shapeIds: [] }, [], new Map([
      ["p1", [{ baselineText: "前対象後", ranges: [{ from: 1, to: 3 }], inlineMathIds: [] }]],
    ]));
    expect(isAiLockedBlock(partial, "p1")).toBe(false);
    const pending = mergeAiLockedTargets(["p1"], [], { blockIds: ["p1"], shapeIds: [] }, [], partial.contentReservations);
    expect(isAiLockedBlock(pending, "p1")).toBe(true);
  });
  const targets = mergeAiLockedTargets(["b1"], ["s1"], { blockIds: [], shapeIds: [] });

  it("matches only locked ids and tolerates an empty selection", () => {
    expect(isAiLockedBlock(targets, "b1")).toBe(true);
    expect(isAiLockedBlock(targets, "b2")).toBe(false);
    expect(isAiLockedBlock(targets, null)).toBe(false);
    expect(isAiLockedShapeSelection(targets, ["s2", "s1"])).toBe(true);
    expect(isAiLockedShapeSelection(targets, ["s2"])).toBe(false);
    expect(isAiLockedShapeSelection(targets, [])).toBe(false);
  });
});

describe("describeAiLockedTargets", () => {
  it("points at the stop button when a live run holds the target", () => {
    const targets = mergeAiLockedTargets(["b1"], [], { blockIds: [], shapeIds: [] });

    expect(describeAiLockedTargets(targets, { blockIds: ["b1"], shapeIds: [] }))
      .toBe(aiActiveRunBlockedMessage());
  });

  it("points at the apply/discard decision for a pending-proposal reservation", () => {
    const targets = mergeAiLockedTargets([], [], { blockIds: ["b1"], shapeIds: [] });

    expect(describeAiLockedTargets(targets, { blockIds: ["b1"], shapeIds: [] }))
      .toBe(aiPendingProposalBlockedMessage());
  });

  it("reports the stoppable run when a change straddles both sources", () => {
    const targets = mergeAiLockedTargets([], ["s1"], { blockIds: ["b1"], shapeIds: [] });

    expect(describeAiLockedTargets(targets, { blockIds: ["b1"], shapeIds: ["s1"] }))
      .toBe(aiActiveRunBlockedMessage());
  });
});

/** A graph whose axis label lives in a separate, individually draggable shape. */
function graphWithLabels(id: string, labelShapeIds: string[]): OverlayGraphShape {
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
      axisLabelTextShapeIds: { x: labelShapeIds[0] },
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
