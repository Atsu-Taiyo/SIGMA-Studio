import { describe, expect, it } from "vitest";

import type { OverlayGraphShape, ParagraphNode, SigmaDocument } from "@/features/document";
import type { ProposalMergeBasis } from "@/lib/ai/proposal-merge-basis";
import type { AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";

import { findAiLockedTargetsTouched } from "./locked-target-diff";
import {
  aiLockedTargetsForOrigin,
  describeAiLockedTargets,
  EMPTY_AI_LOCKED_TARGETS,
  isAiLockedBlock,
  isAiLockedShapeSelection,
  mergeAiLockedTargets,
  withAiResultOnlyTargets,
} from "./locked-targets";
import {
  aiActiveRunBlockedMessage,
  aiPendingProposalBlockedMessage,
  aiResultOnlyBlockedMessage,
} from "../adapters/tiptap/edit-lock-adapter";
import { derivePendingAiProposalLockTargets, type AiEditPreviewState } from "../model/preview";

function paragraph(id: string, text: string): ParagraphNode {
  return { id, type: "paragraph", children: [{ type: "text", text }] };
}

function makeDocument(content: ParagraphNode[]): SigmaDocument {
  return { content } as unknown as SigmaDocument;
}

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

describe("pending proposals and the commit choke point", () => {
  // 保留中の提案は三者マージで人の編集に追従できるので、その対象への変更は拒否しない。
  // 拒否するのは実行中の run が握る範囲と、合成できない対象 (旧レコード・整列・段組み設定) だけ。
  const before = makeDocument([paragraph("p1", "元の本文"), paragraph("p2", "別の段落")]);
  const humanEdit = makeDocument([paragraph("p1", "元の本文に人が追記"), paragraph("p2", "別の段落")]);
  const replaceP1: AiEditSessionDraft = {
    summary: "書き換え",
    plan: [],
    operations: [{ operation: "replace", summary: "書き換え", targetId: "p1", replacementBlock: paragraph("p1", "AIの本文") }],
    warnings: [],
  };
  const preview = (mergeBasis?: ProposalMergeBasis): AiEditPreviewState => ({
    targetId: "p1",
    draft: replaceP1,
    createdAt: 0,
    proposalIds: ["proposal_1"],
    baseRevision: 1,
    providers: [],
    ...(mergeBasis ? { mergeSources: [{ proposalId: "proposal_1", createdAt: "2026-10-05T00:00:00.000Z", draft: replaceP1, mergeBasis }] } : {}),
  });
  const basis: ProposalMergeBasis = { version: 1, entities: { p1: { kind: "block", value: paragraph("p1", "元の本文") } } };

  it("lets the human edit what a merge-capable proposal overwrites", () => {
    const targets = mergeAiLockedTargets([], [], derivePendingAiProposalLockTargets([preview(basis)]));

    expect(findAiLockedTargetsTouched(before, humanEdit, targets)).toEqual({ blockIds: [], shapeIds: [] });
  });

  it("still refuses an edit inside a live run's anchor, pointing at the stop button", () => {
    const targets = mergeAiLockedTargets(["p1"], [], derivePendingAiProposalLockTargets([preview(basis)]));
    const touched = findAiLockedTargetsTouched(before, humanEdit, targets);

    expect(touched.blockIds).toEqual(["p1"]);
    expect(describeAiLockedTargets(targets, touched)).toBe(aiActiveRunBlockedMessage());
  });

  it("still refuses an edit to a legacy proposal's target, with the pending-proposal wording", () => {
    const targets = mergeAiLockedTargets([], [], derivePendingAiProposalLockTargets([preview()]));
    const touched = findAiLockedTargetsTouched(before, humanEdit, targets);

    expect(touched.blockIds).toEqual(["p1"]);
    expect(describeAiLockedTargets(targets, touched)).toBe(aiPendingProposalBlockedMessage());
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

describe("blocks folded away while a proposal shows only its result", () => {
  const before = makeDocument([paragraph("folded", "変更前"), paragraph("next", "次の段落")]);

  it("refuses at the commit choke point (and for undo) any change to a folded block, with the result-only wording", () => {
    const targets = withAiResultOnlyTargets(EMPTY_AI_LOCKED_TARGETS, { blockIds: new Set(["folded"]), shapeIds: new Set() });
    // 次の段落の先頭で Backspace: 次の段落が畳んだ変更前へ結合される。
    const joined = makeDocument([paragraph("folded", "変更前次の段落")]);
    // 検索の置換: 畳んだ変更前の文字が見えないまま書き換わる。
    const replaced = makeDocument([paragraph("folded", "変更後"), paragraph("next", "次の段落")]);

    for (const after of [joined, replaced]) {
      const touched = findAiLockedTargetsTouched(before, after, targets);
      expect(touched.blockIds).toEqual(["folded"]);
      expect(describeAiLockedTargets(targets, touched)).toBe(aiResultOnlyBlockedMessage());
    }
    expect(findAiLockedTargetsTouched(before, makeDocument([paragraph("folded", "変更前"), paragraph("next", "直した")]), targets).blockIds)
      .toEqual([]);
  });

  it("guards a folded block as a whole, even where a live run reserved only a fragment of it", () => {
    const base = mergeAiLockedTargets(["folded"], [], { blockIds: [], shapeIds: [] }, [], new Map([["folded", [{ baselineText: "変更前", ranges: [{ from: 0, to: 1 }], inlineMathIds: [] }]]]));
    const targets = withAiResultOnlyTargets(base, { blockIds: new Set(["folded"]), shapeIds: new Set() });

    expect(targets.contentReservations?.has("folded")).toBe(false);
    expect(isAiLockedBlock(targets, "folded")).toBe(true);
    // 止められる実行が握っていれば、その案内を優先する。
    expect(describeAiLockedTargets(targets, { blockIds: ["folded"], shapeIds: [] })).toBe(aiActiveRunBlockedMessage());
  });

  it("changes nothing while nothing is folded", () => {
    expect(withAiResultOnlyTargets(EMPTY_AI_LOCKED_TARGETS, { blockIds: new Set(), shapeIds: new Set() })).toBe(EMPTY_AI_LOCKED_TARGETS);
  });
});

describe("who a result-only fold stops: only human edits", () => {
  const before = makeDocument([paragraph("folded", "変更前"), paragraph("next", "次の段落")]);
  const changed = makeDocument([paragraph("folded", "AIの変更後"), paragraph("next", "次の段落")]);
  const folded = withAiResultOnlyTargets(EMPTY_AI_LOCKED_TARGETS, { blockIds: new Set(["folded"]), shapeIds: new Set() });

  it("refuses a human edit of a folded block but lets an AI approval and a version restore through", () => {
    expect(findAiLockedTargetsTouched(before, changed, aiLockedTargetsForOrigin(folded, "human-edit")).blockIds).toEqual(["folded"]);
    // WebMCP の承認・版の復元は、表示の切り替えで止めない。
    for (const origin of ["ai-approval", "history-restore"] as const) {
      expect(findAiLockedTargetsTouched(before, changed, aiLockedTargetsForOrigin(folded, origin)).blockIds).toEqual([]);
    }
  });

  it("keeps every other AI hold for any origin (a live run still refuses an approval touching its anchor)", () => {
    const run = withAiResultOnlyTargets(
      mergeAiLockedTargets(["folded"], [], { blockIds: [], shapeIds: [] }),
      { blockIds: new Set(["folded"]), shapeIds: new Set() },
    );
    expect(findAiLockedTargetsTouched(before, changed, aiLockedTargetsForOrigin(run, "ai-approval")).blockIds).toEqual(["folded"]);
  });

  it("guards hidden shapes the same way as folded blocks", () => {
    const shape = (x: number) => ({ id: "hidden_shape", type: "geo", x, y: 0, props: {} });
    const withShape = (x: number) => ({ content: [], pageLayout: { overlay: { overlaySnapshot: { version: 1, shapes: [shape(x)], assets: {} } } } }) as unknown as SigmaDocument;
    const hidden = withAiResultOnlyTargets(EMPTY_AI_LOCKED_TARGETS, { blockIds: new Set(), shapeIds: new Set(["hidden_shape"]) });

    const touched = findAiLockedTargetsTouched(withShape(10), withShape(90), aiLockedTargetsForOrigin(hidden, "human-edit"));

    expect(touched.shapeIds).toEqual(["hidden_shape"]);
    expect(describeAiLockedTargets(hidden, touched)).toBe(aiResultOnlyBlockedMessage());
    expect(findAiLockedTargetsTouched(withShape(10), withShape(90), aiLockedTargetsForOrigin(hidden, "ai-approval")).shapeIds).toEqual([]);
  });

  it("does not refuse a save that carries only the position a hidden shape's anchor resolves to", () => {
    // 畳んだ変更前の分だけ本文が詰まると、紙面は隠した図形の y を固定先から解き直し、次の保存 (無関係な
    // 図形の移動) に載せる。固定で決まる座標は人の編集ではないので比べない。固定・大きさ・中身・削除は比べる。
    type Anchor = Record<string, unknown>;
    const hiddenShape = (anchor: Anchor | undefined, x: number, y: number, w = 120) => ({
      id: "hidden_shape", type: "geo", x, y, ...(anchor ? { anchor } : {}), props: { w, h: 60 },
    });
    const other = (x: number) => ({ id: "other_shape", type: "geo", x, y: 0, props: { w: 40, h: 40 } });
    const saved = (shape: ReturnType<typeof hiddenShape> | null, otherX = 0) => ({
      content: [{ id: "below", type: "paragraph", children: [{ type: "text", text: "固定先" }] }],
      pageLayout: { overlay: { overlaySnapshot: { version: 1, shapes: [...(shape ? [shape] : []), other(otherX)], assets: {} } } },
    }) as unknown as SigmaDocument;
    const hidden = aiLockedTargetsForOrigin(
      withAiResultOnlyTargets(EMPTY_AI_LOCKED_TARGETS, { blockIds: new Set(), shapeIds: new Set(["hidden_shape"]) }),
      "human-edit",
    );
    const touched = (anchor: Anchor | undefined, next: ReturnType<typeof hiddenShape> | null) => (
      findAiLockedTargetsTouched(saved(hiddenShape(anchor, 84, 130)), saved(next, 40), hidden).shapeIds
    );
    const onBlock = { type: "block", blockId: "below", dx: 60, dy: 10 };
    const onBlockNoDx = { type: "block", blockId: "below", dy: 10 };
    const onShape = { type: "shape", shapeId: "other_shape", dx: 4, dy: 4 };

    // 固定先から解き直した座標だけが違う。
    expect(touched(onBlock, hiddenShape(onBlock, 96, 100))).toEqual([]);
    expect(touched(onBlockNoDx, hiddenShape(onBlockNoDx, 84, 100))).toEqual([]);
    expect(touched(onShape, hiddenShape(onShape, 44, 4))).toEqual([]);
    // 人の編集で変わるものは断る: 固定・dx の無い固定での x (図形自身の位置)・大きさ・削除・固定の無い図形の位置。
    expect(touched(onBlock, hiddenShape({ ...onBlock, dy: 30 }, 84, 150))).toEqual(["hidden_shape"]);
    expect(touched(onBlockNoDx, hiddenShape(onBlockNoDx, 120, 130))).toEqual(["hidden_shape"]);
    expect(touched(onBlock, hiddenShape(onBlock, 84, 130, 200))).toEqual(["hidden_shape"]);
    expect(touched(onBlock, null)).toEqual(["hidden_shape"]);
    expect(touched(undefined, hiddenShape(undefined, 84, 100))).toEqual(["hidden_shape"]);
    // 人が固定先を別の (在る) ブロックへ変えるのは断る。
    expect(touched(onBlock, hiddenShape({ ...onBlock, blockId: "other_block" }, 84, 130))).toEqual(["hidden_shape"]);
  });

  it("does not refuse the anchor a save picks again for a hidden shape whose block the human deleted", () => {
    // 提案が更新する図形 S (適用後だけで隠れている) の固定先を人が消した後、無関係な図形 T を動かして保存する。
    // 保存時の付け替えは S の固定を位置から選び直す: 消えた固定先からの選び直しは導出なので比べない。
    type Anchor = Record<string, unknown>;
    const shape = (anchor: Anchor, x: number, y: number) => ({ id: "hidden_shape", type: "geo", x, y, anchor, props: { w: 120, h: 60 } });
    const other = (x: number) => ({ id: "other_shape", type: "geo", x, y: 0, props: { w: 40, h: 40 } });
    const saved = (hidden: ReturnType<typeof shape> | null, otherX: number) => ({
      content: [
        { id: "kept", type: "paragraph", children: [{ type: "text", text: "残った段落" }] },
        { id: "also_kept", type: "paragraph", children: [{ type: "text", text: "もう一つ" }] },
      ],
      pageLayout: { overlay: { overlaySnapshot: { version: 1, shapes: [...(hidden ? [hidden] : []), other(otherX)], assets: {} } } },
    }) as unknown as SigmaDocument;
    const hidden = aiLockedTargetsForOrigin(
      withAiResultOnlyTargets(EMPTY_AI_LOCKED_TARGETS, { blockIds: new Set(), shapeIds: new Set(["hidden_shape"]) }),
      "human-edit",
    );
    const onDeleted = { type: "block", blockId: "deleted_block", dx: 60, dy: 24 };
    const before = saved(shape(onDeleted, 84, 130), 0);

    const repicked = { type: "block", blockId: "kept", dx: 60, dy: 40, line: { index: 0, dy: 38 } };
    expect(findAiLockedTargetsTouched(before, saved(shape(repicked, 84, 130), 40), hidden).shapeIds).toEqual([]);
    // 消えた固定先でも、大きさ・中身・削除は人の編集として断る。
    expect(findAiLockedTargetsTouched(before, saved({ ...shape(repicked, 84, 130), props: { w: 200, h: 60 } }, 40), hidden).shapeIds)
      .toEqual(["hidden_shape"]);
    expect(findAiLockedTargetsTouched(before, saved(null, 40), hidden).shapeIds).toEqual(["hidden_shape"]);
  });

  it("treats a restore it cannot look at in advance (a shared session's undo) as touching what is hidden", () => {
    expect(findAiLockedTargetsTouched(before, undefined, folded)).toEqual({ blockIds: ["folded"], shapeIds: [] });
    expect(findAiLockedTargetsTouched(before, undefined, EMPTY_AI_LOCKED_TARGETS)).toEqual({ blockIds: [], shapeIds: [] });
  });
});
