import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { aiRunSessionStore, type AiRunAnchor, type AiRunSession } from "@/lib/ai/ai-run-session-store";

import type { MeasuredBlock } from "./overlay-canvas/anchor";
import {
  AiRunAnchorLayer,
  aiRunStatusLabel,
  clampAiRunCardPosition,
  getAiRunAnchorBadgeStyle,
  getAiRunAnchorCardPlacement,
  resolveAiRunAnchorPoint,
  resolveAiRunAnchorRegions,
  shouldRenderAiRunAnchorBadge,
  selectVisibleAiRunSessions,
} from "./ai-run-anchor-layer";

function anchor(
  primaryBlockId: string | null,
  overrides: Partial<AiRunAnchor> = {},
): AiRunAnchor {
  return {
    primaryBlockId,
    blockIds: primaryBlockId ? [primaryBlockId] : [],
    shapeIds: [],
    ...overrides,
  };
}

function createSession(overrides: Partial<AiRunSession> = {}): AiRunSession {
  return {
    roomId: "room-1",
    runId: "run-1",
    provider: "chatgpt",
    status: "running",
    events: [],
    streamText: "",
    planSteps: [],
    error: null,
    startedAt: 0,
    endedAt: null,
    anchor: anchor("block-1", { documentId: "doc-1" }),
    queuedMessages: [],
    ...overrides,
  };
}

describe("resolveAiRunAnchorPoint", () => {
  const blockRects = new Map<string, MeasuredBlock>([
    ["block-1", { id: "block-1", top: 120, left: 40, width: 500, height: 60 }],
  ]);

  it("resolves against the measured block when the anchor's block is present", () => {
    const point = resolveAiRunAnchorPoint(anchor("block-1"), blockRects, null);
    expect(point).toEqual({ left: 40, top: 120, source: "block", blockWidth: 500, blockHeight: 60 });
  });

  it("falls back to the captured canvas point when the block has disappeared", () => {
    const point = resolveAiRunAnchorPoint(anchor("deleted-block"), blockRects, { left: 10, top: 20 });
    expect(point).toEqual({ left: 10, top: 20, source: "canvas" });
  });

  it("falls back to the captured canvas point when there is no blockId", () => {
    const point = resolveAiRunAnchorPoint(anchor(null), blockRects, { left: 5, top: 6 });
    expect(point).toEqual({ left: 5, top: 6, source: "canvas" });
  });

  it("prefers the captured canvas point for overlay-originated runs", () => {
    const point = resolveAiRunAnchorPoint(
      anchor("block-1", { preferredTarget: "canvas" }),
      blockRects,
      { left: 72, top: 96 },
    );
    expect(point).toEqual({ left: 72, top: 96, source: "canvas" });
  });

  it("falls back to the top of page 1 when neither a block nor a canvas point resolves", () => {
    const point = resolveAiRunAnchorPoint(anchor(null), blockRects, null);
    expect(point).toEqual({ left: 0, top: 0, source: "page" });
  });

  it("treats a missing anchor the same as one with no blockId", () => {
    const point = resolveAiRunAnchorPoint(null, blockRects, { left: 1, top: 2 });
    expect(point).toEqual({ left: 1, top: 2, source: "canvas" });
  });
});

describe("getAiRunAnchorBadgeStyle", () => {
  it("centers block-anchored widgets in the measured target region", () => {
    expect(getAiRunAnchorBadgeStyle({
      left: 40,
      top: 120,
      source: "block",
      blockWidth: 500,
      blockHeight: 60,
    })).toEqual({
      top: "150px",
      left: "290px",
      right: "auto",
      transform: "translate(-50%, -50%)",
    });
  });

  it("positions canvas-anchored widgets at the captured selection point", () => {
    expect(getAiRunAnchorBadgeStyle({ left: 72, top: 96, source: "canvas" })).toEqual({
      top: "98px",
      left: "72px",
      right: "auto",
    });
  });
});

describe("resolveAiRunAnchorRegions", () => {
  it("centers one region across consecutive selected blocks", () => {
    const regions = resolveAiRunAnchorRegions(
      anchor("p1", { blockIds: ["p1", "p2"] }),
      new Map<string, MeasuredBlock>([
        ["p1", { id: "p1", left: 40, top: 100, width: 280, height: 24 }],
        ["p2", { id: "p2", left: 40, top: 132, width: 280, height: 24 }],
      ]),
    );

    expect(regions).toEqual([{
      left: 40,
      top: 100,
      source: "block",
      blockWidth: 280,
      blockHeight: 56,
      blockIds: ["p1", "p2"],
    }]);
  });

  it("creates one region for each selection island separated by an unselected block", () => {
    const regions = resolveAiRunAnchorRegions(
      anchor("p1", { blockIds: ["p1", "p3"] }),
      new Map<string, MeasuredBlock>([
        ["p1", { id: "p1", left: 40, top: 100, width: 280, height: 24 }],
        ["p2", { id: "p2", left: 40, top: 132, width: 280, height: 24 }],
        ["p3", { id: "p3", left: 40, top: 164, width: 280, height: 24 }],
      ]),
    );

    expect(regions.map((region) => region.blockIds)).toEqual([["p1"], ["p3"]]);
  });

  it("splits consecutive selected blocks when columns make them visually disconnected", () => {
    const regions = resolveAiRunAnchorRegions(
      anchor("left", { blockIds: ["left", "right"] }),
      new Map<string, MeasuredBlock>([
        ["left", { id: "left", left: 40, top: 100, width: 260, height: 48 }],
        ["right", { id: "right", left: 340, top: 100, width: 260, height: 48 }],
      ]),
    );

    expect(regions.map((region) => ({ left: region.left, blockIds: region.blockIds }))).toEqual([
      { left: 40, blockIds: ["left"] },
      { left: 340, blockIds: ["right"] },
    ]);
  });

  it("uses line boxes to split one flowing block across columns", () => {
    const regions = resolveAiRunAnchorRegions(
      anchor("split"),
      new Map<string, MeasuredBlock>([["split", {
        id: "split",
        left: 40,
        top: 100,
        width: 560,
        height: 48,
        lines: [
          { index: 0, left: 40, top: 100, width: 260, height: 20 },
          { index: 1, left: 40, top: 124, width: 240, height: 20 },
          { index: 2, left: 340, top: 100, width: 260, height: 20 },
          { index: 3, left: 340, top: 124, width: 220, height: 20 },
        ],
      }]]),
    );

    expect(regions).toHaveLength(2);
    expect(regions.map((region) => region.left)).toEqual([40, 340]);
  });
});

describe("shouldRenderAiRunAnchorBadge", () => {
  const session = {
    roomId: "room-1",
    runId: "run-1",
    provider: "chatgpt" as const,
    status: "running" as const,
    events: [],
    streamText: "",
    planSteps: [],
    error: null,
    startedAt: 0,
    endedAt: null,
    queuedMessages: [],
  };

  it("keeps the nearby badge for body runs", () => {
    expect(shouldRenderAiRunAnchorBadge({ ...session, anchor: anchor("p1") })).toBe(true);
  });

  it("removes the nearby badge for shape runs", () => {
    expect(shouldRenderAiRunAnchorBadge({ ...session, anchor: anchor("p1", { blockIds: [], shapeIds: ["shape-1"] }) })).toBe(false);
  });
});

describe("AiRunAnchorLayer", () => {
  it("renders the run badge without a separate block-highlight element", () => {
    aiRunSessionStore.startRun("room-highlight-test", {
      runId: "run-highlight-test",
      provider: "chatgpt",
      anchor: anchor("block-1", { documentId: "doc-1" }),
      startedAt: 1,
    });
    try {
      const markup = renderToStaticMarkup(createElement(AiRunAnchorLayer, {
        documentIdentityKey: "doc-1",
        document: {
          version: "2.0",
          docId: "doc-1",
          metadata: { title: "test" },
          content: [{ id: "block-1", type: "paragraph", children: [{ type: "text", text: "本文" }] }],
          outputProfiles: { student: {}, teacher: {}, answerBook: {} },
        },
        blockRects: new Map<string, MeasuredBlock>([
          ["block-1", { id: "block-1", top: 20, left: 40, width: 500, height: 24 }],
        ]),
        blockIdsWithProposalCards: new Set<string>(),
        canvasElement: null,
        onFocusSession: () => {},
      }));

      expect(markup).toContain("ai-run-anchor-badge");
      expect(markup).not.toContain("ai-run-anchor-block-highlight");
    } finally {
      aiRunSessionStore.resetSession("room-highlight-test");
    }
  });

  it("renders a badge for every disconnected body region in one run", () => {
    aiRunSessionStore.startRun("room-islands-test", {
      runId: "run-islands-test",
      provider: "chatgpt",
      anchor: anchor("block-1", {
        blockIds: ["block-1", "block-3"],
        documentId: "doc-1",
      }),
      startedAt: 1,
    });
    try {
      const markup = renderToStaticMarkup(createElement(AiRunAnchorLayer, {
        documentIdentityKey: "doc-1",
        document: {
          version: "2.0",
          docId: "doc-1",
          metadata: { title: "test" },
          content: [
            { id: "block-1", type: "paragraph", children: [{ type: "text", text: "対象1" }] },
            { id: "block-2", type: "paragraph", children: [{ type: "text", text: "対象外" }] },
            { id: "block-3", type: "paragraph", children: [{ type: "text", text: "対象2" }] },
          ],
          outputProfiles: { student: {}, teacher: {}, answerBook: {} },
        },
        blockRects: new Map<string, MeasuredBlock>([
          ["block-1", { id: "block-1", top: 20, left: 40, width: 500, height: 24 }],
          ["block-2", { id: "block-2", top: 52, left: 40, width: 500, height: 24 }],
          ["block-3", { id: "block-3", top: 84, left: 40, width: 500, height: 24 }],
        ]),
        blockIdsWithProposalCards: new Set<string>(),
        canvasElement: null,
        onFocusSession: () => {},
      }));

      expect(markup.match(/class="ai-run-anchor-badge"/g)).toHaveLength(2);
      expect(markup).toContain('data-anchor-block-id="block-1"');
      expect(markup).toContain('data-anchor-block-id="block-3"');
    } finally {
      aiRunSessionStore.resetSession("room-islands-test");
    }
  });
});

describe("getAiRunAnchorCardPlacement", () => {
  const viewport = { width: 800, height: 600 };
  const cardSize = { width: 320, height: 300 };

  it("opens below the badge when there is room", () => {
    const placement = getAiRunAnchorCardPlacement(
      { left: 460, right: 486, top: 120, bottom: 146, width: 26, height: 26 },
      cardSize,
      viewport,
      undefined,
      { topBoundary: 80 },
    );
    expect(placement.side).toBe("bottom");
    expect(placement.top).toBe(154);
    expect(placement.left).toBe(166);
    expect(placement.maxHeight).toBe(300);
  });

  it("flips above the badge when the bottom edge would clip", () => {
    const placement = getAiRunAnchorCardPlacement(
      { left: 460, right: 486, top: 552, bottom: 578, width: 26, height: 26 },
      cardSize,
      viewport,
      undefined,
      { topBoundary: 80 },
    );
    expect(placement.side).toBe("top");
    expect(placement.top).toBe(244);
    expect(placement.left).toBe(166);
  });

  it("shifts horizontally into the viewport", () => {
    const placement = getAiRunAnchorCardPlacement(
      { left: 6, right: 32, top: 160, bottom: 186, width: 26, height: 26 },
      cardSize,
      viewport,
      undefined,
      { topBoundary: 80 },
    );
    expect(placement.left).toBe(8);
    expect(placement.transformOrigin).toBe("16px top");
  });

  it("keeps the card below the menubar boundary", () => {
    const placement = getAiRunAnchorCardPlacement(
      { left: 460, right: 486, top: 86, bottom: 112, width: 26, height: 26 },
      { width: 320, height: 520 },
      viewport,
      undefined,
      { topBoundary: 124 },
    );
    expect(placement.top).toBeGreaterThanOrEqual(124);
    expect(placement.maxHeight).toBeLessThanOrEqual(600 - 124 - 8);
  });

  it("keeps the standard card width when the target column is narrower", () => {
    const placement = getAiRunAnchorCardPlacement(
      { left: 366, right: 392, top: 160, bottom: 186, width: 26, height: 26 },
      cardSize,
      viewport,
      undefined,
      { horizontalBounds: { left: 80, right: 360 } },
    );

    expect(placement.left).toBe(80);
    expect(placement.width).toBe(320);
    expect(placement.left + placement.width).toBe(400);
  });

  it("uses the same card width with and without column bounds", () => {
    const anchor = { left: 366, right: 392, top: 160, bottom: 186, width: 26, height: 26 };
    const singleColumn = getAiRunAnchorCardPlacement(anchor, cardSize, viewport);
    const twoColumn = getAiRunAnchorCardPlacement(
      anchor,
      cardSize,
      viewport,
      undefined,
      { horizontalBounds: { left: 80, right: 280 } },
    );

    expect(singleColumn.width).toBe(320);
    expect(twoColumn.width).toBe(singleColumn.width);
  });

  it("places the card below a containing problem area when it fits", () => {
    const placement = getAiRunAnchorCardPlacement(
      { left: 460, right: 486, top: 180, bottom: 206, width: 26, height: 26 },
      { width: 320, height: 200 },
      viewport,
      { top: 100, bottom: 320, left: 80, right: 720 },
      { topBoundary: 80 },
    );

    expect(placement.side).toBe("bottom");
    expect(placement.top).toBe(328);
    expect(placement.maxHeight).toBe(200);
  });

  it("places the card above a containing problem area when only that side fits", () => {
    const placement = getAiRunAnchorCardPlacement(
      { left: 460, right: 486, top: 500, bottom: 526, width: 26, height: 26 },
      { width: 320, height: 200 },
      viewport,
      { top: 280, bottom: 580, left: 80, right: 720 },
      { topBoundary: 80 },
    );

    expect(placement.side).toBe("top");
    expect(placement.top).toBe(80);
    expect(placement.maxHeight).toBe(192);
  });

  it("uses standard placement when the card does not fit outside the problem area", () => {
    const anchorRect = { left: 460, right: 486, top: 250, bottom: 276, width: 26, height: 26 };
    const standardPlacement = getAiRunAnchorCardPlacement(
      anchorRect,
      cardSize,
      viewport,
      undefined,
      { topBoundary: 80 },
    );
    const placement = getAiRunAnchorCardPlacement(
      anchorRect,
      cardSize,
      viewport,
      { top: 100, bottom: 500, left: 80, right: 720 },
      { topBoundary: 80 },
    );

    expect(placement).toEqual(standardPlacement);
  });
});

describe("clampAiRunCardPosition", () => {
  it("keeps a dragged compact chat inside the viewport and below the menubar", () => {
    expect(clampAiRunCardPosition(
      { left: 760, top: 20 },
      { width: 320, height: 300 },
      { width: 800, height: 600 },
      { topBoundary: 72 },
    )).toEqual({ left: 472, top: 72 });
  });

  it("clamps a card dragged past the bottom-left corner", () => {
    expect(clampAiRunCardPosition(
      { left: -100, top: 580 },
      { width: 320, height: 300 },
      { width: 800, height: 600 },
      { topBoundary: 72 },
    )).toEqual({ left: 8, top: 292 });
  });
});

describe("aiRunStatusLabel", () => {
  it("labels a completed session", () => {
    expect(aiRunStatusLabel(createSession({ status: "completed" }))).toBe("完了");
  });

  it("always shows the fixed failure label in the pill, regardless of error text", () => {
    expect(aiRunStatusLabel(createSession({ status: "failed", error: "接続エラー" }))).toBe("失敗しました");
  });

  it("falls back to a generic failure label when there is no error text", () => {
    expect(aiRunStatusLabel(createSession({ status: "failed", error: null }))).toBe("失敗しました");
  });

  it("summarizes the latest activity while running", () => {
    const session = createSession({
      status: "running",
      events: [{ kind: "phase", phase: "reading", message: "reading", timestamp: 1 }],
    });
    expect(aiRunStatusLabel(session)).toBe("教材を読み取っています…");
  });
});

describe("selectVisibleAiRunSessions", () => {
  const baseOptions = {
    documentId: "doc-1",
    now: 1000,
    blockIdsWithProposalCards: new Set<string>(),
  };

  it("shows active and terminal sessions for the current document", () => {
    const sessions = new Map([
      ["room-1", createSession({ status: "running" })],
      ["room-2", createSession({ status: "completed", anchor: anchor("block-2", { documentId: "doc-1" }) })],
    ]);
    const visible = selectVisibleAiRunSessions(sessions, baseOptions);
    expect(visible.map((entry) => entry.roomId).sort()).toEqual(["room-1", "room-2"]);
  });

  it("hides an idle session", () => {
    const sessions = new Map([["room-1", createSession({ status: "idle" })]]);
    expect(selectVisibleAiRunSessions(sessions, baseOptions)).toHaveLength(0);
  });

  it("hides a session anchored to a different open document", () => {
    const sessions = new Map([
      ["room-1", createSession({ anchor: anchor("block-1", { documentId: "doc-other" }) })],
    ]);
    expect(selectVisibleAiRunSessions(sessions, baseOptions)).toHaveLength(0);
  });

  it("keeps a session with no recorded documentId", () => {
    const sessions = new Map([["room-1", createSession({ anchor: anchor("block-1") })]]);
    expect(selectVisibleAiRunSessions(sessions, baseOptions)).toHaveLength(1);
  });

  it("keeps a completed session visible while its target block still shows a proposal card, past the grace window", () => {
    const sessions = new Map([["room-1", createSession({ status: "completed", endedAt: 1000 })]]);
    const visible = selectVisibleAiRunSessions(sessions, {
      ...baseOptions,
      // Well past `endedAt + AI_RUN_ANCHOR_TERMINAL_DISPLAY_MS`: without a card
      // this would have hidden, but the pending proposal keeps the icon alive.
      now: 1000 + 60_000,
      blockIdsWithProposalCards: new Set(["block-1"]),
    });
    expect(visible).toHaveLength(1);
    expect(visible[0].hasPendingProposal).toBe(true);
  });

  it("keeps an overlay-only proposal room visible without a body preview target", () => {
    const sessions = new Map([["room-1", createSession({
      status: "completed",
      endedAt: 1000,
      anchor: anchor("overlay-anchor", { blockIds: [], documentId: "doc-1", shapeIds: ["shape-1"] }),
    })]]);
    const visible = selectVisibleAiRunSessions(sessions, {
      ...baseOptions,
      now: 1000 + 60_000,
      roomIdsWithProposalCards: new Set(["room-1"]),
    });

    expect(visible).toHaveLength(1);
    expect(visible[0].hasPendingProposal).toBe(true);
  });

  it("marks an active session with a proposal-carrying block as pending too", () => {
    const sessions = new Map([["room-1", createSession({ status: "running" })]]);
    const visible = selectVisibleAiRunSessions(sessions, {
      ...baseOptions,
      blockIdsWithProposalCards: new Set(["block-1"]),
    });
    expect(visible).toHaveLength(1);
    expect(visible[0].hasPendingProposal).toBe(true);
  });

  it("hides a completed session with no pending proposal once its grace window has elapsed", () => {
    const sessions = new Map([["room-1", createSession({ status: "completed", endedAt: 1000 })]]);
    const stillVisible = selectVisibleAiRunSessions(sessions, { ...baseOptions, now: 1000 + 1000 });
    expect(stillVisible).toHaveLength(1);
    expect(stillVisible[0].hasPendingProposal).toBe(false);

    const hidden = selectVisibleAiRunSessions(sessions, { ...baseOptions, now: 1000 + 5000 });
    expect(hidden).toHaveLength(0);
  });
});
