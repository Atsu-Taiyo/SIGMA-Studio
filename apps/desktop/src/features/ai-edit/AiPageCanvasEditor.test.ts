import { describe, expect, it } from "vitest";

import type { AiEditPreviewState } from "./model/preview";
import type { AiProposalAnchorCard, AiProposalContentHunk } from "./model/proposal-content";

import {
  AI_PROPOSAL_RESULT_ONLY_COUNTERS,
  buildAiHiddenTargetEditorExtensions,
  collectPageEditorBlockIds,
  collectResultOnlyCollapsedBlockIds,
  composeAiPageEditorExtensions,
  countResultOnlyNotLaidOut,
  deriveAiOverlayShapeClassNames,
  deriveAiResultOnlyShapeIds,
  estimateFloatingDecisionBarHeight,
  placeFloatingDecisionBars,
  selectAiFloatingDecisionPreviews,
  getAiProposalCardKey,
  getAiProposalCardMeasureRevision,
  getAiProposalConversationKey,
  getOverlayInsertionAnchorBlockId,
  resolveAiEditGhostShapes,
} from "./AiPageCanvasEditor";
import { deriveAiEditPreviewDiff } from "./model/preview";
import { DEFAULT_AI_PROPOSAL_DISPLAY_STATE, type AiProposalDisplayState } from "./model/proposal-display-state";
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
  const card = (text: string, proposalIds = ["proposal-1"], mergedWithHumanEdits = false): AiProposalAnchorCard => ({
    preview: roomPreview(proposalIds),
    content: { hunks: [hunk(text)], shapes: [] },
    mergedWithHumanEdits,
    resultLayout: { collapsedBlockIds: [], complete: true },
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
    // 「あなたの編集と合わせた内容です」の一言はバーの下の行を足す。
    expect(getAiProposalCardMeasureRevision(card("提案の本文", ["proposal-1"], true), "uniform", DEFAULT_AI_PROPOSAL_DISPLAY_STATE))
      .not.toBe(base);
    // 破棄理由のポップオーバーは紙面の外 (body) に出るので、カードの高さは変わらない。
    expect(getAiProposalCardMeasureRevision(card("提案の本文"), "uniform", {
      ...DEFAULT_AI_PROPOSAL_DISPLAY_STATE,
      dismissReasonOpen: true,
    })).toBe(base);
  });

  it("re-measures when the card shows only the result (marks, notes and labels go away), and when that result cannot be laid out", () => {
    const resultOnly = { ...DEFAULT_AI_PROPOSAL_DISPLAY_STATE, afterOnly: true };
    const base = getAiProposalCardMeasureRevision(card("提案の本文"), "uniform", DEFAULT_AI_PROPOSAL_DISPLAY_STATE);
    const shown = getAiProposalCardMeasureRevision(card("提案の本文"), "uniform", resultOnly);
    expect(shown).not.toBe(base);
    // 組めない内容には適用後だけの間、バーの下に一言が付く。
    const notLaidOut = { ...card("提案の本文"), resultLayout: { collapsedBlockIds: [], complete: false } };
    expect(getAiProposalCardMeasureRevision(notLaidOut, "uniform", resultOnly)).not.toBe(shown);
  });

  describe("the result only", () => {
    const resultCard = (proposalId: string, collapsedBlockIds: string[], complete = true): AiProposalAnchorCard => ({
      ...card("提案の本文", [proposalId]),
      resultLayout: { collapsedBlockIds, complete },
    });

    it("folds the before blocks of the cards that show only the result, and of no other card", () => {
      const cards = new Map([
        ["left", [resultCard("proposal-1", ["left"]), resultCard("proposal-2", ["left-2"])]],
        ["right", [resultCard("proposal-3", ["right"])]],
      ]);
      const states = new Map<string, AiProposalDisplayState>([
        ["proposal-1", { ...DEFAULT_AI_PROPOSAL_DISPLAY_STATE, afterOnly: true }],
        // 内容を隠したカード (適用後だけは解除されている) は畳まない。
        ["proposal-3", { ...DEFAULT_AI_PROPOSAL_DISPLAY_STATE, contentHidden: true }],
      ]);

      const collapsed = collectResultOnlyCollapsedBlockIds(cards, (_targetId, entry) => (
        states.get(entry.preview.proposalIds[0]) ?? DEFAULT_AI_PROPOSAL_DISPLAY_STATE
      ));

      expect(collapsed).toEqual(["left"]);
    });

    it("counts the cards whose result could not be laid out when the result only is chosen (0 normally)", () => {
      const counted: string[] = [];
      countResultOnlyNotLaidOut([resultCard("proposal-1", ["left"])], (name) => counted.push(name));
      expect(counted).toEqual([]);

      countResultOnlyNotLaidOut([resultCard("proposal-1", [], false), resultCard("proposal-1", ["left"]), resultCard("proposal-1", [], false)], (name) => counted.push(name));
      expect(counted).toEqual([AI_PROPOSAL_RESULT_ONLY_COUNTERS.notLaidOut, AI_PROPOSAL_RESULT_ONLY_COUNTERS.notLaidOut]);
    });
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

  it("draws the red removal only on deleted shapes the merge does not keep (the human edited the kept one)", () => {
    const deletion: AiEditPreviewState = {
      ...preview([]),
      draft: {
        summary: "図形",
        plan: [],
        warnings: [],
        operations: [],
        mutationOperations: [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["shape-kept", "shape-gone"] }],
      },
    };
    const classNames = deriveAiOverlayShapeClassNames({
      previewGroups: [deletion],
      previewDiff: deriveAiEditPreviewDiff([deletion], []),
      applyAnimation: null,
      beforeHiddenShapeIds: new Set(),
      mergeKeptShapeIds: new Set(["shape-kept"]),
    });

    expect(classNames.get("shape-gone")).toBe("ai-diff-removed-shape");
    expect(classNames.has("shape-kept")).toBe(false);
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

describe("floating decision bars (proposals without a page card)", () => {
  const withOps = (
    proposalId: string,
    operations: AiEditPreviewState["draft"]["operations"],
    mutationOperations: NonNullable<AiEditPreviewState["draft"]["mutationOperations"]> = [],
  ): AiEditPreviewState => ({
    ...preview(operations),
    proposalIds: [proposalId],
    draft: { summary: "提案", plan: [], warnings: [], operations, mutationOperations },
  });
  const shapeMove = { operation: "updateOverlayShape" as const, summary: "移動", shapeId: "shape-1", patch: { x: 10 } };
  const layout = { operation: "updatePageLayout", summary: "余白", patch: { marginsMm: { top: 20 } } } as never;
  const replaceLeft = { operation: "replace" as const, summary: "置換", targetId: "left", replacementBlock: { id: "left", type: "paragraph", children: [] } as never };

  it("gives a floating bar to every proposal that has no card in the page flow, whatever it changes", () => {
    const shapeOnly = withOps("p-shape", [], [shapeMove]);
    const mixedWithoutCard = withOps("p-mixed", [], [shapeMove, layout]);
    const layoutOnly = withOps("p-layout", [], [layout]);
    const bodyWithCard = withOps("p-body", [replaceLeft]);
    const mixedWithCard = withOps("p-mixed-card", [replaceLeft], [shapeMove]);

    expect(selectAiFloatingDecisionPreviews(
      [shapeOnly, mixedWithoutCard, layoutOnly, bodyWithCard, mixedWithCard],
      new Set([bodyWithCard, mixedWithCard]),
      new Set(),
    )).toEqual([shapeOnly, mixedWithoutCard, layoutOnly]);
  });

  it("leaves out the proposal whose decision the ⌘K panel shows, and gives it back when the panel stops", () => {
    const shown = withOps("p-shown", [], [shapeMove]);
    const other = withOps("p-other", [], [shapeMove]);

    expect(selectAiFloatingDecisionPreviews([shown, other], new Set(), new Set(["p-shown"]))).toEqual([other]);
    expect(selectAiFloatingDecisionPreviews([shown, other], new Set(), new Set())).toEqual([shown, other]);
  });

  const frame = { pageWidthPx: 800, pageHeightPx: 1100, pageStridePx: 1124, desiredWidthPx: 320, gapPx: 8, marginPx: 12 };
  const page = { left: 0, right: 800, width: 800 };
  const rectOf = (placement: ReturnType<typeof placeFloatingDecisionBars>[number], height: number) => ({
    left: placement.left - placement.width / 2,
    right: placement.left + placement.width / 2,
    top: placement.placement === "above" ? placement.top - height : placement.top,
    bottom: placement.placement === "above" ? placement.top : placement.top + height,
  });
  const overlaps = (a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>) => (
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  );

  it("puts the bar above the shapes when there is room on the page, else below", () => {
    const [above, below] = placeFloatingDecisionBars([
      { key: "a", bounds: { x: 300, y: 400, w: 100, h: 50 }, horizontalBounds: page, heightPx: 80 },
      { key: "b", bounds: { x: 300, y: 20, w: 100, h: 50 }, horizontalBounds: page, heightPx: 80 },
    ], frame);

    expect(above).toMatchObject({ key: "a", placement: "above", left: 350, top: 392 });
    expect(below).toMatchObject({ key: "b", placement: "below", top: 78 });
  });

  it("stacks bars for the same shapes by their real heights so none covers another", () => {
    const requests = [
      { key: "a", bounds: { x: 300, y: 400, w: 100, h: 50 }, horizontalBounds: page, heightPx: 140 },
      { key: "b", bounds: { x: 300, y: 400, w: 100, h: 50 }, horizontalBounds: page, heightPx: 60 },
      { key: "c", bounds: { x: 320, y: 404, w: 100, h: 50 }, horizontalBounds: page, heightPx: 90 },
    ];
    const placements = placeFloatingDecisionBars(requests, frame);
    const rects = placements.map((placement, index) => rectOf(placement, requests[index].heightPx));

    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        expect(overlaps(rects[i], rects[j]), `${i} vs ${j}`).toBe(false);
      }
    }
  });

  // 選んだ図形の上に出る選択の操作 (ポップオーバーと回転ハンドルの帯)。
  const selectionChrome = { x: 245, y: 320, w: 210, h: 80 };
  const rectOfBounds = (bounds: { x: number; y: number; w: number; h: number }) => ({
    left: bounds.x, right: bounds.x + bounds.w, top: bounds.y, bottom: bounds.y + bounds.h,
  });

  it("puts the bar below the shapes when the selection's controls take the space above", () => {
    const [placement] = placeFloatingDecisionBars([
      { key: "a", bounds: { x: 300, y: 400, w: 100, h: 50 }, horizontalBounds: page, heightPx: 80 },
    ], frame, [selectionChrome]);

    expect(placement).toMatchObject({ key: "a", placement: "below", left: 350, top: 458 });
    expect(overlaps(rectOf(placement, 80), rectOfBounds(selectionChrome))).toBe(false);
  });

  it("keeps the bar above when the selection's controls are elsewhere", () => {
    const [placement] = placeFloatingDecisionBars([
      { key: "a", bounds: { x: 300, y: 400, w: 100, h: 50 }, horizontalBounds: page, heightPx: 80 },
    ], frame, [{ x: 600, y: 320, w: 150, h: 80 }]);

    expect(placement).toMatchObject({ placement: "above", top: 392 });
  });

  it("moves bars past the selection's controls and each other when both sides are taken", () => {
    const requests = [
      { key: "a", bounds: { x: 300, y: 400, w: 100, h: 50 }, horizontalBounds: page, heightPx: 80 },
      { key: "b", bounds: { x: 300, y: 400, w: 100, h: 50 }, horizontalBounds: page, heightPx: 60 },
    ];
    const below = { x: 200, y: 450, w: 300, h: 40 };
    const placements = placeFloatingDecisionBars(requests, frame, [selectionChrome, below]);
    const rects = placements.map((placement, index) => rectOf(placement, requests[index].heightPx));

    for (const [index, rect] of rects.entries()) {
      expect(overlaps(rect, rectOfBounds(selectionChrome)), `${index} vs controls`).toBe(false);
      expect(overlaps(rect, rectOfBounds(below)), `${index} vs below`).toBe(false);
    }
    expect(overlaps(rects[0], rects[1])).toBe(false);
  });

  it("keeps the bar on the page when a low shape near the page top has the selected shape's controls on both sides", () => {
    // 見出しのような背の低い図形の上は 1 ページ目の上端。すぐ下の図形 (y 140〜200) を選ぶと、その操作
    // (ポップオーバー・回転ハンドルの帯と選択枠) が上下の両方にかかる。
    const controls = { x: 245, y: 60, w: 210, h: 140 };
    const [placement] = placeFloatingDecisionBars([
      { key: "heading", bounds: { x: 300, y: 100, w: 100, h: 20 }, horizontalBounds: page, heightPx: 80 },
    ], frame, [controls]);
    const rect = rectOf(placement, 80);

    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(frame.pageHeightPx);
    expect(overlaps(rect, rectOfBounds(controls))).toBe(false);
  });

  it("keeps the bar on the page near the page bottom instead of running into the gap or the next page", () => {
    const shape = { x: 300, y: 1000, w: 100, h: 50 };
    const placements = placeFloatingDecisionBars([
      { key: "bottom", bounds: shape, horizontalBounds: page, heightPx: 80 },
    ], frame, [{ x: 245, y: 920, w: 210, h: 80 }]);
    const tall = placeFloatingDecisionBars([
      { key: "tall", bounds: { x: 300, y: 20, w: 100, h: 1060 }, horizontalBounds: page, heightPx: 80 },
    ], frame);

    for (const placement of [...placements, ...tall]) {
      const rect = rectOf(placement, 80);
      expect(rect.top, placement.key).toBeGreaterThanOrEqual(0);
      expect(rect.bottom, placement.key).toBeLessThanOrEqual(frame.pageHeightPx);
    }
    expect(overlaps(rectOf(placements[0], 80), rectOfBounds({ x: 245, y: 920, w: 210, h: 80 }))).toBe(false);
  });

  it("places a proposal with nothing to point at near the top right of the first page", () => {
    const [placement] = placeFloatingDecisionBars([
      { key: "layout", bounds: null, horizontalBounds: page, heightPx: 60 },
    ], frame);

    expect(placement).toMatchObject({ placement: "below", left: 800 - 12 - 160, top: 12 });
  });

  it("estimates a taller bar for every extra line under it", () => {
    const bare = estimateFloatingDecisionBarHeight({ summaryLineCount: 0, hasSessionLabel: false, hasApplyError: false });
    const withSummary = estimateFloatingDecisionBarHeight({ summaryLineCount: 3, hasSessionLabel: true, hasApplyError: false });
    const withError = estimateFloatingDecisionBarHeight({ summaryLineCount: 3, hasSessionLabel: true, hasApplyError: true });

    expect(bare).toBeGreaterThanOrEqual(46);
    expect(withSummary).toBeGreaterThan(bare + 3 * 14);
    expect(withError).toBeGreaterThan(withSummary);
  });
});

describe("buildAiHiddenTargetEditorExtensions", () => {
  it("makes a hidden before shape neither selectable nor editable", () => {
    const extensions = buildAiHiddenTargetEditorExtensions(new Set(["shape-1"]));

    expect([...extensions!.overlayEditPolicy!.unselectableShapeIds!]).toEqual(["shape-1"]);
    expect([...extensions!.overlayEditPolicy!.lockedShapeIds]).toEqual(["shape-1"]);
    expect(extensions!.textFlowEditPolicy).toBeUndefined();
  });

  it("keeps the caret and typing out of a before block folded away for the result only", () => {
    const extensions = buildAiHiddenTargetEditorExtensions(new Set(), new Set(["block-1"]));

    expect(extensions!.overlayEditPolicy).toBeUndefined();
    const [guard] = extensions!.textFlowEditPolicy!.guards;
    expect(guard).toMatchObject({ blockId: "block-1", highlight: false });
    expect(guard.blockedMessage).toBe("適用後だけを表示している間は、隠している変更前を編集できません。「変更箇所を表示」に戻すと編集できます。");
    expect(extensions!.textFlowEditPolicy!.lockAll).toBeUndefined();
  });

  it("preserves only the shapes hidden for the result only from derived rewrites (a re-anchor on save)", () => {
    // バーで隠した変更前・AI の実行中・合成できない提案のロックは派生の書き換えを止めない (従来どおり)。
    // 止めるのは「適用後だけ」で隠した図形だけ: 人の編集では変えられず、混ざると変更口がコミットごと断る。
    const composed = composeAiPageEditorExtensions(
      { overlayEditPolicy: { lockedShapeIds: new Set(["run_shape"]) } },
      buildAiHiddenTargetEditorExtensions(new Set(["bar_hidden", "result_hidden"]), new Set(), new Set(["result_hidden"])),
      undefined,
    );

    expect([...composed!.overlayEditPolicy!.lockedShapeIds].sort()).toEqual(["bar_hidden", "result_hidden", "run_shape"]);
    expect([...composed!.overlayEditPolicy!.preservedShapeIds ?? []]).toEqual(["result_hidden"]);
    expect(buildAiHiddenTargetEditorExtensions(new Set(["bar_hidden"]))!.overlayEditPolicy!.preservedShapeIds).toBeUndefined();
  });

  it("adds nothing while nothing is hidden", () => {
    expect(buildAiHiddenTargetEditorExtensions(new Set())).toBeUndefined();
    expect(buildAiHiddenTargetEditorExtensions(new Set(), new Set())).toBeUndefined();
  });
});

describe("deriveAiResultOnlyShapeIds (shapes of a proposal shown as its result only)", () => {
  const withMutations = (mutationOperations: NonNullable<AiEditPreviewState["draft"]["mutationOperations"]>): AiEditPreviewState => ({
    ...preview([]),
    draft: { summary: "図形", plan: [], warnings: [], operations: [], mutationOperations },
  });

  it("hides the before state of an update and draws its after state without marks", () => {
    const update = withMutations([{ operation: "updateOverlayShape", summary: "移動", shapeId: "shape-1", patch: { x: 10 } }]);
    expect(deriveAiResultOnlyShapeIds([update], new Set())).toEqual({ hiddenShapeIds: ["shape-1"], ghostShapeIds: ["shape-1"] });
  });

  it("hides a shape the proposal deletes, unless the merge keeps it (the human edited it)", () => {
    const deletion = withMutations([{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["shape-gone", "shape-kept"] }]);
    expect(deriveAiResultOnlyShapeIds([deletion], new Set(["shape-kept"]))).toEqual({ hiddenShapeIds: ["shape-gone"], ghostShapeIds: [] });
  });

  it("draws an inserted shape without marks and hides nothing for it", () => {
    const insertion = preview([{
      operation: "insertOverlayShape",
      summary: "図形を挿入",
      targetId: "left",
      overlayShape: { id: "shape-new", type: "geo", x: 0, y: 0, props: { w: 80, h: 40, geo: "rectangle", fill: "none", color: "#111111", fillColor: "#ffffff", labelColor: "#111111", dash: "solid", size: "m" } },
      assets: {},
    }]);
    expect(deriveAiResultOnlyShapeIds([insertion], new Set())).toEqual({ hiddenShapeIds: [], ghostShapeIds: ["shape-new"] });
  });

  it("keeps a shape hidden for the result only hidden while the approval plays the removal", () => {
    const deletion = withMutations([{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["shape-gone", "shape-other"] }]);
    const classNames = deriveAiOverlayShapeClassNames({
      previewGroups: [deletion],
      previewDiff: deriveAiEditPreviewDiff([deletion], []),
      applyAnimation: { removingBlockIds: [], removingShapeIds: ["shape-gone", "shape-other"], addedBlockIds: [], addedShapeIds: [] },
      beforeHiddenShapeIds: new Set(["shape-gone"]),
      resultOnlyHiddenShapeIds: new Set(["shape-gone"]),
    });
    // 適用後だけで隠した図形は消える演出のために出し直さない (隠した変更前が一瞬見える)。
    expect(classNames.get("shape-gone")).toBe("ai-diff-removed-shape ai-diff-before-shape ai-diff-before-hidden");
    expect(classNames.get("shape-other")).toBe("ai-apply-removing-shape");
  });

  it("hides a deleted shape through the same class as a hidden before shape", () => {
    const deletion = withMutations([{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["shape-gone"] }]);
    const classNames = deriveAiOverlayShapeClassNames({
      previewGroups: [deletion],
      previewDiff: deriveAiEditPreviewDiff([deletion], []),
      applyAnimation: null,
      beforeHiddenShapeIds: new Set(["shape-gone"]),
    });
    expect(classNames.get("shape-gone")).toBe("ai-diff-removed-shape ai-diff-before-shape ai-diff-before-hidden");
  });
});

describe("collectPageEditorBlockIds (the blocks the change decoration can fold)", () => {
  it("lists the top-level nodes of every editing surface the page lays out, and nothing nested in them", () => {
    const paragraph = (id: string) => ({ id, type: "paragraph", children: [{ type: "text", text: id }] });
    const content = [
      paragraph("top"),
      { id: "box", type: "boxBlock", styleId: "itembox", blocks: [paragraph("box_child")] },
      { id: "list", type: "list", listType: "bullet", items: [{ id: "item", type: "listItem", children: [] }] },
      {
        id: "problem", type: "problem", tags: [], lead: [], hints: [], answer: { type: "math", expected: "" },
        prompt: [paragraph("prompt"), { id: "area_columns", type: "layoutSection", layout: { columnCount: 2 }, children: [paragraph("area_col")] }],
        solution: [paragraph("solution")],
      },
      { id: "columns", type: "layoutSection", layout: { columnCount: 2 }, children: [paragraph("col_a"), paragraph("col_b")] },
    ] as unknown as Parameters<typeof collectPageEditorBlockIds>[0];

    const ids = collectPageEditorBlockIds(content);

    // 空の導入文のエリアは、打てるように置く仮の段落 (`problem_lead_empty`) が編集面の最上位に並ぶ。
    expect([...ids].sort()).toEqual(["area_col", "box", "col_a", "col_b", "list", "problem_lead_empty", "prompt", "solution", "top"]);
  });
});

describe("composeAiPageEditorExtensions", () => {
  it("keeps a live run's guard (with its stop action) on a block that is also folded away", () => {
    const runGuard = {
      blockId: "block-1",
      guardId: "run-1",
      isPrimaryActionTarget: true,
      blockedMessage: "AI編集中です。",
      presentation: { highlightedBlockClassName: "a", readOnlyBlockClassName: "b", characterClassName: "c", atomClassName: "d" },
      highlight: true,
    };
    const composed = composeAiPageEditorExtensions(
      { textFlowEditPolicy: { guards: [runGuard] } },
      buildAiHiddenTargetEditorExtensions(new Set(), new Set(["block-1", "block-2"])),
      undefined,
    );

    const guards = new Map(composed!.textFlowEditPolicy!.guards.map((guard) => [guard.blockId, guard]));
    expect(guards.get("block-1")).toBe(runGuard);
    expect(guards.get("block-2")?.guardId).toBe("ai-result-only-block-2");
  });

  it("guards a folded block whole even where a live run reserves only a fragment of it (as the commit point does)", () => {
    const partialRun = {
      blockId: "block-1",
      guardId: "run-1",
      isPrimaryActionTarget: true,
      blockedMessage: "AI編集中です。",
      presentation: { highlightedBlockClassName: "a", readOnlyBlockClassName: "b", characterClassName: "c", atomClassName: "d" },
      highlight: true,
      contentReservations: [{ baselineText: "本文", ranges: [{ from: 0, to: 1 }], inlineMathIds: [] }],
    };
    const composed = composeAiPageEditorExtensions(
      { textFlowEditPolicy: { guards: [partialRun] } },
      buildAiHiddenTargetEditorExtensions(new Set(), new Set(["block-1"])),
      undefined,
    );

    const [guard] = composed!.textFlowEditPolicy!.guards;
    expect(guard).toMatchObject({ blockId: "block-1", guardId: "run-1" });
    expect(guard.contentReservations).toBeUndefined();
  });
});
