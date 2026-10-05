import { describe, expect, it } from "vitest";

import type { InlineNode, ListItemNode, ListNode, ParagraphNode, SigmaBlock, SigmaDocument } from "@/features/document";
import type { AiEditSessionDraft, SigmaDocMutationOp } from "@/lib/ai/sigma-doc-edit-schema";
import { mergeProposalDraftsIntoDocument } from "@/lib/ai/proposal-batch-replay";
import { computeProposalMergeBasis } from "@/lib/ai/proposal-merge-basis";
import { replayProposalDraftMerging } from "@/lib/ai/proposal-replay";
import { deleteBlocksFromDocument, findBlock, updateBlockInDocument } from "@/lib/document-tree";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import type { DesktopMcpEditProposalSummary } from "@/types/desktop";

import { groupMcpProposalsForPreview, type AiEditPreviewState } from "./preview";
import { buildPendingProposalContent, groupPendingProposalContentByAnchor } from "./proposal-content";
import { AI_PROPOSAL_PREVIEW_COUNTERS, resolveProposalMergePreview, retainProposalMergePreviewFallbacks } from "./proposal-merge-preview";

function text(value: string): InlineNode {
  return { type: "text", text: value };
}

function paragraph(id: string, value: string): ParagraphNode {
  return { type: "paragraph", id, children: [text(value)] };
}

function problem(id: string, prompt: string): SigmaBlock {
  return {
    id,
    type: "problem",
    tags: [],
    lead: [],
    prompt: [paragraph(`${id}_prompt`, prompt)],
    hints: [],
    solution: [],
    answer: { type: "math", expected: "" },
  } as SigmaBlock;
}

function documentOf(blocks: SigmaBlock[]): SigmaDocument {
  return parseSigmaDocument({
    version: "2.0",
    docId: "doc_merge_preview",
    metadata: { title: "合成プレビュー" },
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    content: blocks,
  });
}

/** 打鍵と同じく、触っていないブロックの同一性を保ったまま 1 段落の文字を変える。 */
function typeInto(document: SigmaDocument, id: string, value: string): SigmaDocument {
  return updateBlockInDocument(document, id, (block) => ({ ...(block as ParagraphNode), children: [text(value)] }));
}

function paragraphText(block: unknown): string {
  const children = (block as { children?: InlineNode[] } | null)?.children ?? [];
  return children.map((node) => (node.type === "text" ? node.text : "")).join("");
}

function replaceDraft(id: string, value: string): AiEditSessionDraft {
  return {
    summary: "書き換え",
    plan: [],
    operations: [{ operation: "replace", summary: "書き換え", targetId: id, replacementBlock: paragraph(id, value) }],
    warnings: [],
  };
}

function summaryOf(
  draft: AiEditSessionDraft,
  overrides: Partial<DesktopMcpEditProposalSummary> = {},
): DesktopMcpEditProposalSummary {
  return {
    proposalId: "proposal_1",
    fileId: "file_1",
    baseRevision: 1,
    baseDocId: "doc_merge_preview",
    title: "合成プレビュー",
    summary: draft.summary,
    plan: [],
    warnings: [],
    changedIds: [],
    provider: "claude",
    draft,
    status: "pending",
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    roomId: "room_1",
    ...overrides,
  };
}

function previewFor(summary: DesktopMcpEditProposalSummary, currentRevision = 1): AiEditPreviewState {
  const { groups } = groupMcpProposalsForPreview([summary], summary.fileId, currentRevision);
  expect(groups).toHaveLength(1);
  return groups[0]!;
}

const BASE_TEXT = "The cat sat on the mat.";
const AI_TEXT = "The dog sat on the mat.";
const HUMAN_TEXT = "The cat sat on the red mat.";
const MERGED_TEXT = "The dog sat on the red mat.";

describe("resolveProposalMergePreview", () => {
  it("previews the merged content: the human's edit and the AI's change, as the approval would save it", () => {
    const base = documentOf([paragraph("p_1", BASE_TEXT), paragraph("p_2", "残す")]);
    const draft = replaceDraft("p_1", AI_TEXT);
    const mergeBasis = computeProposalMergeBasis(draft, base);
    const current = typeInto(base, "p_1", HUMAN_TEXT);
    const preview = previewFor(summaryOf(draft, { mergeBasis }));

    const merged = resolveProposalMergePreview(current, preview);
    const content = buildPendingProposalContent(current, merged.afterDocument, preview);

    const approved = replayProposalDraftMerging(current, draft, mergeBasis).nextDocument;
    expect(paragraphText(content.hunks[0]?.added[0])).toBe(MERGED_TEXT);
    expect(content.hunks[0]?.added[0]).toEqual(findBlock(approved, "p_1"));
    expect(paragraphText(content.hunks[0]?.removed[0])).toBe(HUMAN_TEXT);
    expect(merged.humanEditedUnits).toEqual(["p_1"]);
  });

  it("is what the page cards show too", () => {
    const base = documentOf([paragraph("p_1", BASE_TEXT)]);
    const draft = replaceDraft("p_1", AI_TEXT);
    const mergeBasis = computeProposalMergeBasis(draft, base);
    const current = typeInto(base, "p_1", HUMAN_TEXT);
    const preview = previewFor(summaryOf(draft, { mergeBasis }));

    const cards = groupPendingProposalContentByAnchor([preview], current);

    const card = cards.get("p_1")?.[0];
    expect(paragraphText(card?.content.hunks[0]?.added[0])).toBe(MERGED_TEXT);
    expect(card?.mergedWithHumanEdits).toBe(true);
  });

  it("keeps the plain replay for a legacy record without a merge basis", () => {
    const base = documentOf([paragraph("p_1", BASE_TEXT)]);
    const draft = replaceDraft("p_1", AI_TEXT);
    const current = typeInto(base, "p_1", HUMAN_TEXT);
    const preview = previewFor(summaryOf(draft));

    const merged = resolveProposalMergePreview(current, preview);

    expect(preview.mergeSources).toBeUndefined();
    expect(paragraphText(findBlock(merged.afterDocument!, "p_1"))).toBe(AI_TEXT);
    expect(merged.humanEditedUnits).toEqual([]);
  });

  it("reports no merge when nobody edited what the proposal overwrites", () => {
    const base = documentOf([paragraph("p_1", BASE_TEXT), paragraph("p_2", "別の段落")]);
    const draft = replaceDraft("p_1", AI_TEXT);
    const mergeBasis = computeProposalMergeBasis(draft, base);
    const current = typeInto(base, "p_2", "人が書き足した段落");
    const preview = previewFor(summaryOf(draft, { mergeBasis }));

    const merged = resolveProposalMergePreview(current, preview);

    expect(paragraphText(findBlock(merged.afterDocument!, "p_1"))).toBe(AI_TEXT);
    expect(paragraphText(findBlock(merged.afterDocument!, "p_2"))).toBe("人が書き足した段落");
    expect(merged.humanEditedUnits).toEqual([]);
  });

  it("replays a shapes-only proposal only when it has a base: whether the merge keeps a shape the human edited", () => {
    const shape = {
      id: "shape_1",
      type: "geo",
      x: 40,
      y: 40,
      props: { w: 80, h: 40, geo: "rectangle", fill: "none", color: "#111111", fillColor: "#ffffff", labelColor: "#111111", dash: "solid", size: "m" },
    };
    const withShape = (x: number): SigmaDocument => ({
      ...documentOf([paragraph("p_1", BASE_TEXT)]),
      pageLayout: { overlay: { overlaySnapshot: { version: 1, shapes: [{ ...shape, x }], assets: {} } } },
    } as unknown as SigmaDocument);
    const base = withShape(40);
    const draft: AiEditSessionDraft = {
      summary: "図形を消す",
      plan: [],
      operations: [],
      mutationOperations: [{ operation: "deleteOverlayShapes", summary: "消す", shapeIds: ["shape_1"] } as SigmaDocMutationOp],
      warnings: [],
    };
    const counted: string[] = [];
    const count = (name: string) => counted.push(name);

    // base を持たない図形だけの提案は、本文の内容も合成も使わないので replay しない。
    expect(resolveProposalMergePreview(base, previewFor(summaryOf(draft)), { count })).toEqual({ afterDocument: null, humanEditedUnits: [] });

    const preview = previewFor(summaryOf(draft, { mergeBasis: computeProposalMergeBasis(draft, base) }));
    expect(resolveProposalMergePreview(base, preview, { count }).afterDocument?.pageLayout?.overlay?.overlaySnapshot?.shapes).toEqual([]);
    // 人が消される図形を動かした: 承認は人の図形を残す (編集は削除に勝つ)。
    const moved = resolveProposalMergePreview(withShape(90), preview, { count });
    expect(moved.afterDocument?.pageLayout?.overlay?.overlaySnapshot?.shapes).toEqual([{ ...shape, x: 90 }]);
    expect(moved.humanEditedUnits).toEqual(["shape_1"]);
    expect(counted).toEqual([]);
  });

  it("previews nothing (instead of throwing) when neither the merge nor the plain replay can apply", () => {
    const base = documentOf([paragraph("p_1", BASE_TEXT), paragraph("p_2", "残す")]);
    const draft = replaceDraft("p_1", AI_TEXT);
    const mergeBasis = computeProposalMergeBasis(draft, base);
    const current = documentOf([paragraph("p_2", "残す")]);
    const preview = previewFor(summaryOf(draft, { mergeBasis }));

    expect(resolveProposalMergePreview(current, preview)).toEqual({ afterDocument: null, humanEditedUnits: [] });
  });

  it("does not show a block the AI deletes as removed when the human's edit keeps it", () => {
    const base = documentOf([paragraph("p_1", "前"), paragraph("p_2", "消される段落"), paragraph("p_3", "後")]);
    const draft: AiEditSessionDraft = {
      summary: "削除",
      plan: [],
      operations: [],
      mutationOperations: [{ operation: "deleteBlocks", summary: "段落を削除", blockIds: ["p_2"] } as SigmaDocMutationOp],
      warnings: [],
    };
    const mergeBasis = computeProposalMergeBasis(draft, base);
    const current = typeInto(base, "p_2", "人が直した段落");
    const preview = previewFor(summaryOf(draft, { mergeBasis }));

    const merged = resolveProposalMergePreview(current, preview);
    const content = buildPendingProposalContent(current, merged.afterDocument, preview);

    expect(paragraphText(findBlock(merged.afterDocument!, "p_2"))).toBe("人が直した段落");
    expect(content.hunks.flatMap((hunk) => hunk.removed)).toEqual([]);
    expect(merged.humanEditedUnits).toEqual(["p_2"]);
  });

  describe("cache: recomputes only when what the proposal touches changes", () => {
    function setup() {
      const base = documentOf([problem("q_1", "問1"), paragraph("p_1", BASE_TEXT), paragraph("p_2", "別の段落")]);
      const draft = replaceDraft("p_1", AI_TEXT);
      const mergeBasis = computeProposalMergeBasis(draft, base);
      const preview = previewFor(summaryOf(draft, { mergeBasis }));
      return { base, preview };
    }

    it("returns the same result for the same document", () => {
      const { base, preview } = setup();
      expect(resolveProposalMergePreview(base, preview)).toBe(resolveProposalMergePreview(base, preview));
    });

    it("does not replay again when the human types in a block the proposal does not touch", () => {
      const { base, preview } = setup();
      const before = resolveProposalMergePreview(base, preview);
      const typed = typeInto(base, "p_2", "別の段落に打鍵");

      const after = resolveProposalMergePreview(typed, preview);

      expect(after.afterDocument).toBe(before.afterDocument);
    });

    it("replays again when the human edits a block the proposal overwrites", () => {
      const { base, preview } = setup();
      const before = resolveProposalMergePreview(base, preview);
      const typed = typeInto(base, "p_1", HUMAN_TEXT);

      const after = resolveProposalMergePreview(typed, preview);

      expect(after.afterDocument).not.toBe(before.afterDocument);
      expect(paragraphText(findBlock(after.afterDocument!, "p_1"))).toBe(MERGED_TEXT);
    });

    it("replays again when the numbering of the document changes", () => {
      const { base, preview } = setup();
      const before = resolveProposalMergePreview(base, preview);
      const withProblem: SigmaDocument = { ...base, content: [problem("q_0", "新しい問"), ...base.content] };

      const after = resolveProposalMergePreview(withProblem, preview);

      expect(after.afterDocument).not.toBe(before.afterDocument);
      expect(findBlock(after.afterDocument!, "q_0")).not.toBeNull();
    });
  });
});

describe("resolveProposalMergePreview follows the approval's batch rules", () => {
  it("skips only the proposal that cannot be replayed and still merges the others, as the approval does", () => {
    const base = documentOf([paragraph("p_a", BASE_TEXT), paragraph("p_b", "Bee text."), paragraph("p_c", "残す")]);
    const draftA = replaceDraft("p_a", AI_TEXT);
    const draftB = replaceDraft("p_b", "Bee text changed by AI.");
    const proposalA = summaryOf(draftA, { proposalId: "proposal_a", mergeBasis: computeProposalMergeBasis(draftA, base) });
    const proposalB = summaryOf(draftB, {
      proposalId: "proposal_b",
      createdAt: "2026-10-05T00:00:01.000Z",
      updatedAt: "2026-10-05T00:00:01.000Z",
      mergeBasis: computeProposalMergeBasis(draftB, base),
    });
    // 人が A の対象を直し、B の対象を消した (B は承認なら競合として保留に残る)。
    const current = deleteBlocksFromDocument(typeInto(base, "p_a", HUMAN_TEXT), ["p_b"]);
    const { groups } = groupMcpProposalsForPreview([proposalA, proposalB], "file_1", 1);
    expect(groups).toHaveLength(1);
    const preview = groups[0]!;

    const merged = resolveProposalMergePreview(current, preview);

    const approval = mergeProposalDraftsIntoDocument(current, [proposalA, proposalB]);
    expect(approval.failed.map((failure) => failure.proposalId)).toEqual(["proposal_b"]);
    expect(merged.afterDocument?.content).toEqual(approval.document.content);
    expect(paragraphText(findBlock(merged.afterDocument!, "p_a"))).toBe(MERGED_TEXT);
    expect(merged.humanEditedUnits).toEqual(["p_a"]);
    expect(groupPendingProposalContentByAnchor([preview], current).get("p_a")?.[0]?.mergedWithHumanEdits).toBe(true);
  });

  it("puts the merge notice only on the card whose unit the human edited", () => {
    const base = documentOf([paragraph("p_1", BASE_TEXT), paragraph("p_2", "間"), paragraph("p_5", BASE_TEXT)]);
    const draft: AiEditSessionDraft = {
      summary: "2 か所を書き換え",
      plan: [],
      operations: [
        { operation: "replace", summary: "1", targetId: "p_1", replacementBlock: paragraph("p_1", AI_TEXT) },
        { operation: "replace", summary: "5", targetId: "p_5", replacementBlock: paragraph("p_5", AI_TEXT) },
      ],
      warnings: [],
    };
    const preview = previewFor(summaryOf(draft, { mergeBasis: computeProposalMergeBasis(draft, base) }));
    const current = typeInto(base, "p_1", HUMAN_TEXT);

    const cards = groupPendingProposalContentByAnchor([preview], current);

    expect(cards.get("p_1")?.[0]?.mergedWithHumanEdits).toBe(true);
    expect(cards.get("p_5")?.[0]?.mergedWithHumanEdits).toBe(false);
  });
});

describe("resolveProposalMergePreview counts its fallbacks (MISS R3)", () => {
  // 数え済みの退避は提案の id ごとに覚えるので、テストごとに別の提案にする。
  function conflicting(proposalId: string) {
    const base = documentOf([paragraph("p_1", BASE_TEXT), paragraph("p_2", "残す")]);
    const draft = replaceDraft("p_1", AI_TEXT);
    const preview = previewFor(summaryOf(draft, { proposalId, mergeBasis: computeProposalMergeBasis(draft, base) }));
    return { preview, current: deleteBlocksFromDocument(base, ["p_1"]) };
  }

  it("counts a preview that could not use the merging replay and one that shows nothing", () => {
    const { preview, current } = conflicting("proposal_counts_both");
    const counted: string[] = [];

    resolveProposalMergePreview(current, preview, { count: (name) => counted.push(name) });

    expect(counted).toEqual([AI_PROPOSAL_PREVIEW_COUNTERS.fallback, AI_PROPOSAL_PREVIEW_COUNTERS.noPreview]);
  });

  it("counts a proposal entering the fallback state once, not again while it stays there", () => {
    const { preview, current } = conflicting("proposal_enters_once");
    const counted: string[] = [];
    const count = (name: string) => counted.push(name);

    resolveProposalMergePreview(current, preview, { count });
    // The human keeps editing what the proposal reads (here: the problem numbering) while its target is gone.
    resolveProposalMergePreview({ ...current, content: [problem("q_0", "新しい問"), ...current.content] }, preview, { count });
    expect(counted).toEqual([AI_PROPOSAL_PREVIEW_COUNTERS.fallback, AI_PROPOSAL_PREVIEW_COUNTERS.noPreview]);

    // The target comes back (undo), then is deleted again: that is a new fallback.
    const restored = documentOf([paragraph("p_1", BASE_TEXT), paragraph("p_2", "残す")]);
    resolveProposalMergePreview(restored, preview, { count });
    resolveProposalMergePreview(deleteBlocksFromDocument(restored, ["p_1"]), preview, { count });
    expect(counted).toEqual([
      AI_PROPOSAL_PREVIEW_COUNTERS.fallback, AI_PROPOSAL_PREVIEW_COUNTERS.noPreview,
      AI_PROPOSAL_PREVIEW_COUNTERS.fallback, AI_PROPOSAL_PREVIEW_COUNTERS.noPreview,
    ]);
  });

  it("does not count the same fallback again when the proposal list is fetched again (new preview objects)", () => {
    const base = documentOf([paragraph("p_1", BASE_TEXT), paragraph("p_2", "残す")]);
    const draft = replaceDraft("p_1", AI_TEXT);
    const summary = summaryOf(draft, { proposalId: "proposal_refetched", mergeBasis: computeProposalMergeBasis(draft, base) });
    const current = deleteBlocksFromDocument(base, ["p_1"]);
    const counted: string[] = [];
    const count = (name: string) => counted.push(name);

    resolveProposalMergePreview(current, previewFor(summary), { count });
    // 自動保存のあとなどで一覧を取り直すと、同じ提案のプレビューが新しいオブジェクトで届く。
    resolveProposalMergePreview(current, previewFor(summary), { count });

    expect(counted).toEqual([AI_PROPOSAL_PREVIEW_COUNTERS.fallback, AI_PROPOSAL_PREVIEW_COUNTERS.noPreview]);
  });

  it("still counts a fallback first observed while counting was off (approval in progress, removal animation)", () => {
    const base = documentOf([paragraph("p_1", BASE_TEXT), paragraph("p_2", "残す")]);
    const draft = replaceDraft("p_1", AI_TEXT);
    const preview = previewFor(summaryOf(draft, { proposalId: "proposal_observed_quietly", mergeBasis: computeProposalMergeBasis(draft, base) }));
    const current = deleteBlocksFromDocument(base, ["p_1"]);
    const counted: string[] = [];
    const count = (name: string) => counted.push(name);

    resolveProposalMergePreview(current, preview, { countFallbacks: false, count });
    expect(counted).toEqual([]);
    resolveProposalMergePreview(current, preview, { count });
    resolveProposalMergePreview(current, preview, { count });

    expect(counted).toEqual([AI_PROPOSAL_PREVIEW_COUNTERS.fallback, AI_PROPOSAL_PREVIEW_COUNTERS.noPreview]);
  });

  it("counts the fallback again after a recovery that was only observed while counting was off", () => {
    const { preview, current } = conflicting("proposal_recovered_quietly");
    const restored = documentOf([paragraph("p_1", BASE_TEXT), paragraph("p_2", "残す")]);
    const counted: string[] = [];
    const count = (name: string) => counted.push(name);

    resolveProposalMergePreview(current, preview, { count });
    resolveProposalMergePreview(restored, preview, { countFallbacks: false, count });
    resolveProposalMergePreview(deleteBlocksFromDocument(restored, ["p_1"]), preview, { count });

    expect(counted).toEqual([
      AI_PROPOSAL_PREVIEW_COUNTERS.fallback, AI_PROPOSAL_PREVIEW_COUNTERS.noPreview,
      AI_PROPOSAL_PREVIEW_COUNTERS.fallback, AI_PROPOSAL_PREVIEW_COUNTERS.noPreview,
    ]);
  });

  it("forgets what it counted for proposals that are no longer pending", () => {
    const { preview, current } = conflicting("proposal_resolved");
    const counted: string[] = [];
    const count = (name: string) => counted.push(name);

    resolveProposalMergePreview(current, preview, { count });
    retainProposalMergePreviewFallbacks([]);
    resolveProposalMergePreview(current, previewFor(summaryOf(replaceDraft("p_1", AI_TEXT), {
      proposalId: "proposal_resolved",
      mergeBasis: preview.mergeSources![0]!.mergeBasis,
    })), { count });

    expect(counted).toHaveLength(4);
  });

  it("counts nothing for a proposal that merges or applies normally", () => {
    const base = documentOf([paragraph("p_1", BASE_TEXT), paragraph("p_2", "別の段落")]);
    const draft = replaceDraft("p_1", AI_TEXT);
    const preview = previewFor(summaryOf(draft, { mergeBasis: computeProposalMergeBasis(draft, base) }));
    const counted: string[] = [];

    resolveProposalMergePreview(typeInto(base, "p_1", HUMAN_TEXT), preview, { count: (name) => counted.push(name) });

    expect(counted).toEqual([]);
  });

  it("does not count while an approval is replacing the document (the old proposals are drawn over the result)", () => {
    const { preview, current } = conflicting("proposal_while_applying");
    const counted: string[] = [];

    resolveProposalMergePreview(current, preview, { countFallbacks: false, count: (name) => counted.push(name) });

    expect(counted).toEqual([]);
  });
});

describe("resolveProposalMergePreview cache and the structure around the units", () => {
  const item = (id: string, text: string): ListItemNode => ({ type: "listItem", id, children: [{ type: "text", text }] });

  it("replays again when an item is added before the replaced list item (its number changes)", () => {
    const list: ListNode = { id: "list_1", type: "list", listType: "ordered", items: [item("li_a", "一"), item("li_b", "二"), item("li_c", "三")] };
    const base = documentOf([list as SigmaBlock]);
    const draft: AiEditSessionDraft = {
      summary: "項目を直す",
      plan: [],
      operations: [{ operation: "replace", summary: "直す", targetId: "li_b", replacementBlock: item("li_b", "二を直した") }],
      warnings: [],
    };
    const preview = previewFor(summaryOf(draft, { mergeBasis: computeProposalMergeBasis(draft, base) }));
    resolveProposalMergePreview(base, preview);
    const withItem = updateBlockInDocument(base, "list_1", (block) => {
      const current = block as ListNode;
      return { ...current, items: [current.items[0]!, item("li_x", "足した"), ...current.items.slice(1)] };
    });

    const content = buildPendingProposalContent(withItem, resolveProposalMergePreview(withItem, preview).afterDocument, preview);

    expect(content.hunks[0]?.removed[0]).toMatchObject({ type: "list", start: 3 });
    expect(content.hunks[0]?.added[0]).toMatchObject({ type: "list", start: 3 });
  });

  it("replays again when a block an insertion would move after (the anchor is gone) changes", () => {
    const base = documentOf([paragraph("p_0", "最初"), paragraph("p_1", "前"), paragraph("p_anchor", "目印"), paragraph("p_3", "後")]);
    const draft: AiEditSessionDraft = {
      summary: "挿入",
      plan: [],
      operations: [{ operation: "insertAfter", summary: "足す", targetId: "p_anchor", insertedBlock: paragraph("p_new", "AI が足した段落") }],
      warnings: [],
    };
    const preview = previewFor(summaryOf(draft, { mergeBasis: computeProposalMergeBasis(draft, base) }));
    const withoutAnchor = deleteBlocksFromDocument(base, ["p_anchor"]);
    const first = resolveProposalMergePreview(withoutAnchor, preview);
    expect(first.afterDocument?.content.map((block) => block.id)).toEqual(["p_0", "p_1", "p_new", "p_3"]);

    const withoutPreceding = deleteBlocksFromDocument(withoutAnchor, ["p_1"]);
    const second = resolveProposalMergePreview(withoutPreceding, preview);

    expect(second.afterDocument?.content.map((block) => block.id)).toEqual(["p_0", "p_new", "p_3"]);
  });

  it("still keeps the result while the human types in a block the proposal does not touch", () => {
    const list: ListNode = { id: "list_1", type: "list", listType: "ordered", items: [item("li_a", "一"), item("li_b", "二")] };
    const base = documentOf([paragraph("p_0", "本文"), list as SigmaBlock]);
    const draft: AiEditSessionDraft = {
      summary: "項目を直す",
      plan: [],
      operations: [{ operation: "replace", summary: "直す", targetId: "li_b", replacementBlock: item("li_b", "二を直した") }],
      warnings: [],
    };
    const preview = previewFor(summaryOf(draft, { mergeBasis: computeProposalMergeBasis(draft, base) }));
    const before = resolveProposalMergePreview(base, preview);

    expect(resolveProposalMergePreview(typeInto(base, "p_0", "本文に打鍵"), preview).afterDocument).toBe(before.afterDocument);
  });
});

describe("groupMcpProposalsForPreview and merge-capable proposals", () => {
  const draft = replaceDraft("p_1", AI_TEXT);
  const mergeBasis = computeProposalMergeBasis(draft, documentOf([paragraph("p_1", BASE_TEXT)]));

  it("carries each proposal's merge inputs into the preview", () => {
    const preview = previewFor(summaryOf(draft, { mergeBasis, requestedShapeId: undefined }));
    expect(preview.mergeSources).toEqual([{
      proposalId: "proposal_1",
      createdAt: "2026-10-05T00:00:00.000Z",
      draft,
      mergeBasis,
    }]);
  });

  it("does not use the base of a proposal whose stored draft is invalid", () => {
    const { groups } = groupMcpProposalsForPreview([summaryOf(draft, { mergeBasis, invalidReason: "壊れた提案" })], "file_1", 1);
    expect(groups).toEqual([]);
  });

  it("keeps a merge-capable proposal without a request selection in the preview after the revision moved", () => {
    const { groups, stale } = groupMcpProposalsForPreview([summaryOf(draft, { mergeBasis, baseRevision: 1 })], "file_1", 3);
    expect(stale).toEqual([]);
    expect(groups.map((group) => group.proposalIds)).toEqual([["proposal_1"]]);
  });

  it("still sends a legacy proposal without a request selection to the conflict notice after the revision moved", () => {
    const { groups, stale } = groupMcpProposalsForPreview([summaryOf(draft, { baseRevision: 1 })], "file_1", 3);
    expect(groups).toEqual([]);
    expect(stale.map((group) => group.proposalIds)).toEqual([["proposal_1"]]);
  });

  it("sends an unresolvable conflict of a merge-capable proposal to the notice (target gone, replay failed)", () => {
    for (const reason of ["anchor-missing", "replay-failed"] as const) {
      const { groups, stale } = groupMcpProposalsForPreview([summaryOf(draft, {
        mergeBasis,
        conflict: { blockIds: ["p_1"], detectedAtRevision: 2, reason },
      })], "file_1", 2);
      expect(groups).toEqual([]);
      expect(stale).toEqual([expect.objectContaining({ kind: "conflict", conflictReason: reason })]);
    }
  });

  it("sends a proposal with an invalid stored draft to the notice even before a conflict is recorded", () => {
    const { stale } = groupMcpProposalsForPreview([summaryOf(draft, { invalidReason: "壊れた提案" })], "file_1", 1);
    expect(stale).toEqual([expect.objectContaining({
      proposalIds: ["proposal_1"],
      kind: "conflict",
      conflictReason: "replay-failed",
      invalidReason: "壊れた提案",
    })]);
  });
});
