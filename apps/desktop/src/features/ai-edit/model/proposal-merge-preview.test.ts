import { describe, expect, it } from "vitest";

import type { InlineNode, ParagraphNode, SigmaBlock, SigmaDocument } from "@/features/document";
import type { AiEditSessionDraft, SigmaDocMutationOp } from "@/lib/ai/sigma-doc-edit-schema";
import { computeProposalMergeBasis } from "@/lib/ai/proposal-merge-basis";
import { replayProposalDraftMerging } from "@/lib/ai/proposal-replay";
import { findBlock, updateBlockInDocument } from "@/lib/document-tree";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import type { DesktopMcpEditProposalSummary } from "@/types/desktop";

import { groupMcpProposalsForPreview, type AiEditPreviewState } from "./preview";
import { buildPendingProposalContent, groupPendingProposalContentByAnchor } from "./proposal-content";
import { resolveProposalMergePreview } from "./proposal-merge-preview";

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

  it("does not replay a proposal that changes no body block (shapes only)", () => {
    const base = documentOf([paragraph("p_1", BASE_TEXT)]);
    const draft: AiEditSessionDraft = {
      summary: "図形を消す",
      plan: [],
      operations: [],
      mutationOperations: [{ operation: "deleteOverlayShapes", summary: "消す", shapeIds: ["shape_1"] } as SigmaDocMutationOp],
      warnings: [],
    };
    const preview = previewFor(summaryOf(draft, { mergeBasis: { version: 1, entities: {} } }));

    expect(resolveProposalMergePreview(base, preview)).toEqual({ afterDocument: null, humanEditedUnits: [] });
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
