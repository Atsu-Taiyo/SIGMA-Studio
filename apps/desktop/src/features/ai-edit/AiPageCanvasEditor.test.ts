import { describe, expect, it } from "vitest";

import type { AiEditPreviewState } from "./model/preview";
import type { AiProposalAnchorCard, AiProposalContentHunk } from "./model/proposal-content";

import {
  deriveAiOverlayShapeClassNames,
  getAiProposalCardKey,
  getAiProposalCardMeasureRevision,
  getAiProposalConversationKey,
  getOverlayInsertionAnchorBlockId,
  resolveAiEditGhostShapes,
} from "./AiPageCanvasEditor";
import { deriveAiEditPreviewDiff } from "./model/preview";
import { DEFAULT_AI_PROPOSAL_DISPLAY_STATE } from "./model/proposal-display-state";
import type { MeasuredBlock } from "@/features/drawing";
import type { OverlayGeoShape, OverlayShape, OverlayTextShape } from "@/features/document";

function preview(operations: AiEditPreviewState["draft"]["operations"]): AiEditPreviewState {
  return {
    targetId: "left",
    draft: { summary: "提案", plan: [], warnings: [], operations },
    createdAt: 1,
    proposalIds: ["proposal-1"],
    baseRevision: 1,
    providers: [],
  };
}

describe("AI page canvas extension", () => {
  it("resolves only pure overlay insertions to their shared block column", () => {
    const insertion = preview([{
      operation: "insertOverlayShape",
      summary: "図形を挿入",
      targetId: "left",
      overlayShape: {
        id: "shape-1",
        type: "geo",
        x: 0,
        y: 0,
        anchor: { type: "block", blockId: "left", dx: 0, dy: 40 },
        props: {
          w: 80,
          h: 40,
          geo: "rectangle",
          fill: "none",
          color: "#111111",
          fillColor: "#ffffff",
          labelColor: "#111111",
          dash: "solid",
          size: "m",
        },
      },
      assets: {},
    }]);

    expect(getOverlayInsertionAnchorBlockId(insertion)).toBe("left");
    expect(getOverlayInsertionAnchorBlockId({
      ...insertion,
      shapeReplacements: [{ removedShapeId: "old", addedShapeId: "shape-1" }],
    })).toBeNull();
  });
});

describe("AI proposal cards in the page flow", () => {
  const roomPreview = (proposalIds: string[], roomId = "room-1"): AiEditPreviewState => ({
    ...preview([]),
    proposalIds,
    roomId,
    runId: `run-${proposalIds.length}`,
  });
  const hunk = (text: string): AiProposalContentHunk => ({
    anchorBlockId: "left",
    removed: [],
    added: [{ id: "added-1", type: "paragraph", children: [{ type: "text", text }] }],
    notes: [],
    operations: ["insertAfter"],
    numbering: {
      removed: { problems: new Map(), headings: new Map() },
      added: { problems: new Map([["problem-1", 2]]), headings: new Map() },
    },
  });
  const card = (text: string, proposalIds = ["proposal-1"]): AiProposalAnchorCard => ({
    preview: roomPreview(proposalIds),
    content: { hunks: [hunk(text)], shapes: [] },
  });

  it("keeps a card's key when a follow-up turn in the same room adds a proposal", () => {
    expect(getAiProposalCardKey("left", roomPreview(["proposal-1", "proposal-2"])))
      .toBe(getAiProposalCardKey("left", roomPreview(["proposal-1"])));
    expect(getAiProposalConversationKey(roomPreview(["proposal-1", "proposal-2"])))
      .toBe(getAiProposalConversationKey(roomPreview(["proposal-1"])));
  });

  it("separates cards of different rooms, anchors, runs and unattributed proposals", () => {
    const keys = [
      getAiProposalCardKey("left", roomPreview(["proposal-1"], "room-1")),
      getAiProposalCardKey("left", roomPreview(["proposal-2"], "room-2")),
      getAiProposalCardKey("right", roomPreview(["proposal-1"], "room-1")),
      getAiProposalCardKey("left", { ...preview([]), proposalIds: ["proposal-3"], runId: "run-a" }),
      getAiProposalCardKey("left", { ...preview([]), proposalIds: ["proposal-4", "proposal-5"] }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    // 帰属の無い提案は最初の提案で決まる (後から足されても変わらない)。
    expect(getAiProposalCardKey("left", { ...preview([]), proposalIds: ["proposal-4"] }))
      .toBe(keys[4]);
  });

  it("changes the measure revision only when the card's content changes", () => {
    const base = getAiProposalCardMeasureRevision(card("提案の本文"), "uniform");
    expect(base).not.toBe("");
    expect(getAiProposalCardMeasureRevision(card("提案の本文", ["proposal-1", "proposal-2"]), "uniform")).toBe(base);
    expect(getAiProposalCardMeasureRevision(card("提案の本文を書き換えた"), "uniform")).not.toBe(base);
    expect(getAiProposalCardMeasureRevision(card("提案の本文"), "texDefault")).not.toBe(base);
    const renumbered = card("提案の本文");
    renumbered.content.hunks[0].numbering.added = { problems: new Map([["problem-1", 3]]), headings: new Map() };
    expect(getAiProposalCardMeasureRevision(renumbered, "uniform")).not.toBe(base);
  });

  it("re-measures when the card's display state changes its height (content hidden, apply error)", () => {
    const base = getAiProposalCardMeasureRevision(card("提案の本文"), "uniform", DEFAULT_AI_PROPOSAL_DISPLAY_STATE);
    expect(getAiProposalCardMeasureRevision(card("提案の本文"), "uniform")).toBe(base);
    expect(getAiProposalCardMeasureRevision(card("提案の本文"), "uniform", {
      ...DEFAULT_AI_PROPOSAL_DISPLAY_STATE,
      contentHidden: true,
    })).not.toBe(base);
    expect(getAiProposalCardMeasureRevision(card("提案の本文"), "uniform", {
      ...DEFAULT_AI_PROPOSAL_DISPLAY_STATE,
      applyError: "失敗",
    })).not.toBe(base);
    // 破棄理由のポップオーバーは紙面の外 (body) に出るので、カードの高さは変わらない。
    expect(getAiProposalCardMeasureRevision(card("提案の本文"), "uniform", {
      ...DEFAULT_AI_PROPOSAL_DISPLAY_STATE,
      dismissReasonOpen: true,
    })).toBe(base);
  });
});

describe("deriveAiOverlayShapeClassNames", () => {
  const shapeUpdate = (proposalId: string, shapeId: string): AiEditPreviewState => ({
    ...preview([]),
    proposalIds: [proposalId],
    draft: {
      summary: "図形",
      plan: [],
      warnings: [],
      operations: [],
      mutationOperations: [{ operation: "updateOverlayShape", summary: "移動", shapeId, patch: { x: 10 } }],
    },
  });

  it("marks the live shape of an update as the before state, without any time-based alternation class", () => {
    const groups = [shapeUpdate("proposal-1", "shape-1")];
    const classNames = deriveAiOverlayShapeClassNames({
      previewGroups: groups,
      previewDiff: deriveAiEditPreviewDiff(groups, []),
      applyAnimation: null,
      beforeHiddenShapeIds: new Set(),
    });

    expect(classNames.get("shape-1")).toBe("ai-diff-modified-shape ai-diff-before-shape");
  });

  it("hides only the before states the user chose to hide", () => {
    const groups = [shapeUpdate("proposal-1", "shape-1"), shapeUpdate("proposal-2", "shape-2")];
    const classNames = deriveAiOverlayShapeClassNames({
      previewGroups: groups,
      previewDiff: deriveAiEditPreviewDiff(groups, []),
      applyAnimation: null,
      beforeHiddenShapeIds: new Set(["shape-2"]),
    });

    expect(classNames.get("shape-1")).not.toContain("ai-diff-before-hidden");
    expect(classNames.get("shape-2")).toBe("ai-diff-modified-shape ai-diff-before-shape ai-diff-before-hidden");
  });
});

describe("resolveAiEditGhostShapes", () => {
  const blockRects = new Map<string, MeasuredBlock>([
    ["left", { id: "left", left: 100, top: 500, width: 400, height: 40 }],
  ]);

  function geo(id: string, x: number, y: number, anchor?: OverlayShape["anchor"]): OverlayGeoShape {
    return {
      id,
      type: "geo",
      x,
      y,
      rotation: 0,
      ...(anchor ? { anchor } : {}),
      props: {
        w: 80,
        h: 40,
        geo: "rectangle",
        fill: "none",
        color: "#111111",
        fillColor: "#ffffff",
        labelColor: "#111111",
        dash: "solid",
        size: "m",
      },
    };
  }

  function textGhost(id: string, anchor: OverlayShape["anchor"]): OverlayTextShape {
    return {
      id,
      type: "text",
      x: 0,
      y: 0,
      rotation: 0,
      ...(anchor ? { anchor } : {}),
      props: {
        w: 40,
        h: 16,
        blocks: [],
        color: "#111111",
        size: "m",
      },
    };
  }

  it("resolves a ghost anchored to an existing shape against that shape's resolved position", () => {
    const existing = geo("parent", 0, 0, { type: "block", blockId: "left", dx: 20, dy: 60 });
    const ghost = textGhost("child", { type: "shape", shapeId: "parent", dx: 5, dy: 7 });

    const [resolved] = resolveAiEditGhostShapes([ghost], [existing], blockRects, {});

    // parent は blockLeft(100)+20 / blockTop(500)+60 に解決され、その上に子の delta が乗る。
    expect({ x: resolved.x, y: resolved.y }).toEqual({ x: 125, y: 567 });
  });

  it("resolves block-anchored ghosts through the same invariant as the applied document", () => {
    const ghost = geo("ghost", 0, 0, { type: "block", blockId: "left", dx: 40, dy: 24 });

    const [resolved] = resolveAiEditGhostShapes([ghost], [], blockRects, {});

    expect({ x: resolved.x, y: resolved.y }).toEqual({ x: 140, y: 524 });
  });

  it("drops ghosts that the applied renderer would not draw (hidden shapes)", () => {
    const hidden = { ...geo("hidden", 0, 0), hidden: true } as OverlayShape;
    const visible = geo("visible", 0, 0);

    expect(resolveAiEditGhostShapes([hidden, visible], [], blockRects, {}).map((shape) => shape.id))
      .toEqual(["visible"]);
  });
});
