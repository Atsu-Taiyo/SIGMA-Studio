import { describe, expect, it } from "vitest";
import { ensurePageLayout } from "@/lib/page-layout";
import { type AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import type { OverlayTableShape } from "@/features/document";
import type { ParagraphNode, ProblemNode, SigmaDocument } from "@/features/document";
import { mergeProposalDraftsIntoDocument, replayProposalDraft } from "./replay";
import {
  deleteBlockDraft,
  wrapBlocksInColumnsDraft,
  paragraphDocument,
} from "../../tests/fixtures/proposal-document";

describe("replayProposalDraft input ownership", () => {
  it("returns a normalized draft without changing the persisted proposal or current document", () => {
    const document = paragraphDocument(["first", "new-between-anchors", "last"]);
    const draft = wrapBlocksInColumnsDraft(["first", "last"]);
    const originalDocument = structuredClone(document);
    const originalDraft = structuredClone(draft);

    const result = replayProposalDraft(document, draft);

    expect(result.draft.mutationOperations?.[0]).toMatchObject({
      operation: "wrapBlocksInColumns",
      blockIds: ["first", "new-between-anchors", "last"],
    });
    expect(result.nextDocument.content[0]).toMatchObject({
      type: "layoutSection",
      children: [{ id: "first" }, { id: "new-between-anchors" }, { id: "last" }],
    });
    expect(document).toEqual(originalDocument);
    expect(draft).toEqual(originalDraft);
  });

  it("leaves inputs intact when a persisted range cannot be replayed", () => {
    const document = paragraphDocument(["first"]);
    const draft = wrapBlocksInColumnsDraft(["first", "deleted-anchor"]);
    const originalDocument = structuredClone(document);
    const originalDraft = structuredClone(draft);

    expect(() => replayProposalDraft(document, draft)).toThrow();
    expect(document).toEqual(originalDocument);
    expect(draft).toEqual(originalDraft);
  });
});

describe("mergeProposalDraftsIntoDocument", () => {
  const twoParagraphDocument: SigmaDocument = {
    version: "2.0",
    docId: "doc_merge_test",
    metadata: { title: "Merge test" },
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    content: [
      { type: "paragraph", id: "para_1", children: [{ type: "text", text: "one" }] } satisfies ParagraphNode,
      { type: "paragraph", id: "para_2", children: [{ type: "text", text: "two" }] } satisfies ParagraphNode,
    ],
  };

  function tableShape(
    id: string,
    blockId: string,
    text: string,
    placement: { x: number; y: number; dx: number; dy: number },
  ): OverlayTableShape {
    const columnId = `${id}_column`;
    const rowId = `${id}_row`;
    return {
      id,
      type: "tableShape",
      x: placement.x,
      y: placement.y,
      rotation: 0,
      anchor: { type: "block", blockId, dx: placement.dx, dy: placement.dy },
      props: {
        w: 420,
        h: 135,
        table: {
          version: 1,
          kind: "plain",
          columns: [{ id: columnId, width: { mode: "fr", value: 1 } }],
          rows: [{ id: rowId, height: { mode: "auto", min: 32 } }],
          cells: [{
            id: `${id}_cell`,
            rowId,
            columnId,
            content: [{
              type: "paragraph",
              id: `${id}_paragraph`,
              children: [{ type: "text", text }],
            }],
          }],
          grid: {
            borderColor: "#111827",
            borderWidth: 1,
            borderStyle: "solid",
            showOuterBorder: true,
            showInnerBorders: true,
          },
          defaultCellStyle: {
            align: "center",
            verticalAlign: "middle",
            paddingX: 8,
            paddingY: 6,
            color: "#111827",
            fontSize: 10.5,
            fontWeight: "normal",
          },
        },
      },
    };
  }

  function withOverlayShape(shape: OverlayTableShape): SigmaDocument {
    const document = ensurePageLayout(twoParagraphDocument);
    return {
      ...document,
      pageLayout: {
        ...document.pageLayout!,
        overlay: {
          ...(document.pageLayout?.overlay ?? {}),
          overlaySnapshot: { version: 1, shapes: [shape], assets: {} },
        },
      },
    };
  }

  function fractionProblemDocument(tex: string, solutionText: string): SigmaDocument {
    return {
      version: "2.0",
      docId: "doc_fraction_problem_merge_test",
      metadata: { title: "Fraction problem merge test" },
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
      content: [{
        type: "problem",
        id: "problem_fraction",
        tags: [],
        lead: [],
        prompt: [{
          type: "paragraph",
          id: "p_fraction",
          children: [{ type: "mathInline", id: "m_fraction", tex, display: "inline" }],
        }],
        answer: { type: "math", expected: "1/2" },
        solution: [{ type: "paragraph", id: "p_solution", children: [{ type: "text", text: solutionText }] }],
        hints: [],
      }],
    };
  }

  it("applies every proposal's draft in order when all targets exist", () => {
    const result = mergeProposalDraftsIntoDocument(twoParagraphDocument, [
      { proposalId: "p1", draft: deleteBlockDraft("para_1") },
      { proposalId: "p2", draft: deleteBlockDraft("para_2") },
    ]);

    expect(result.appliedIds).toEqual(["p1", "p2"]);
    expect(result.failed).toEqual([]);
    expect(result.document.content).toHaveLength(0);
  });

  it("preserves a child update_rich_content edit when a parent update_problem_content is approved in the same batch", () => {
    const originalTex = String.raw`\tfrac{1}{2}`;
    const replacementTex = String.raw`\dfrac{1}{2}`;
    const baseDocument = fractionProblemDocument(originalTex, "元の解説");
    const replacementParagraph: ParagraphNode = {
      type: "paragraph",
      id: "p_fraction",
      children: [{ type: "mathInline", id: "m_fraction", tex: replacementTex, display: "inline" }],
    };
    const replacementProblem = {
      ...(baseDocument.content[0] as ProblemNode),
      solution: [{ type: "paragraph" as const, id: "p_solution", children: [{ type: "text" as const, text: "更新後の解説" }] }],
    };

    const result = mergeProposalDraftsIntoDocument(baseDocument, [
      {
        proposalId: "rich_content",
        source: { toolName: "update_rich_content", toolArgs: {} },
        draft: {
          summary: "分数表示を更新",
          plan: [],
          warnings: [],
          operations: [{
            operation: "replace",
            summary: "段落本文を更新",
            targetId: "p_fraction",
            replacementBlock: replacementParagraph,
          }],
        },
      },
      {
        proposalId: "problem_content",
        source: { toolName: "update_problem_content", toolArgs: {} },
        draft: {
          summary: "解説を更新",
          plan: [],
          warnings: [],
          operations: [{
            operation: "replace",
            summary: "問題内容を更新",
            targetId: "problem_fraction",
            replacementBlock: replacementProblem,
          }],
        },
      },
    ]);

    expect(result.appliedIds).toEqual(["rich_content", "problem_content"]);
    expect(result.failed).toEqual([]);
    const problem = result.document.content[0];
    expect(problem).toMatchObject({
      type: "problem",
      prompt: [{ children: [{ type: "mathInline", tex: replacementTex }] }],
      solution: [{ children: [{ type: "text", text: "更新後の解説" }] }],
    });
    expect(JSON.stringify(result.document)).not.toContain(originalTex);
  });

  it("re-resolves a partial-column range and includes blocks inserted between its anchors", () => {
    const currentDocument = paragraphDocument([
      "outside_before",
      "range_start",
      "inserted_after_proposal",
      "range_end",
      "outside_after",
    ]);
    const result = mergeProposalDraftsIntoDocument(currentDocument, [{
      proposalId: "columns",
      draft: wrapBlocksInColumnsDraft(["range_start", "range_end"]),
    }]);

    expect(result.appliedIds).toEqual(["columns"]);
    expect(result.failed).toEqual([]);
    expect(result.document.content.map((block) => block.id)).toEqual([
      "outside_before",
      expect.stringMatching(/^layout_section_/),
      "outside_after",
    ]);
    expect(result.document.content[1]).toMatchObject({
      type: "layoutSection",
      children: [
        { id: "range_start" },
        { id: "inserted_after_proposal" },
        { id: "range_end" },
      ],
    });
  });

  it("reports a structural error when a partial-column range anchor no longer exists", () => {
    const currentDocument = paragraphDocument(["range_start", "outside_after"]);
    const result = mergeProposalDraftsIntoDocument(currentDocument, [{
      proposalId: "columns",
      draft: wrapBlocksInColumnsDraft(["range_start", "range_end"]),
    }]);

    expect(result.appliedIds).toEqual([]);
    expect(result.failed).toEqual([{
      proposalId: "columns",
      error: expect.stringContaining("2段組み範囲を現在の教材で特定できません"),
    }]);
  });

  it("skips a proposal whose target was already removed by an earlier proposal in the same batch, continuing with the rest", () => {
    // This mirrors the real silent-skip bug: two pending proposals both target para_1 (e.g. one
    // deletes it and a stale duplicate also targets it); the first application removes it so the
    // second's draft can no longer find its target. Previously this was caught and swallowed with
    // no trace; now it must be reported back via `failed`.
    const result = mergeProposalDraftsIntoDocument(twoParagraphDocument, [
      { proposalId: "p1", draft: deleteBlockDraft("para_1") },
      { proposalId: "p2_stale_duplicate", draft: deleteBlockDraft("para_1") },
      { proposalId: "p3", draft: deleteBlockDraft("para_2") },
    ]);

    expect(result.appliedIds).toEqual(["p1", "p3"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].proposalId).toBe("p2_stale_duplicate");
    expect(result.failed[0].error).toContain("見つかりません");
    expect(result.document.content).toHaveLength(0);
  });

  it("leaves the document unchanged and reports every proposal as failed when none can apply", () => {
    const result = mergeProposalDraftsIntoDocument(twoParagraphDocument, [
      { proposalId: "p1", draft: deleteBlockDraft("does_not_exist") },
    ]);

    expect(result.appliedIds).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toEqual({
      proposalId: "p1",
      error: expect.stringContaining("見つかりません"),
    });
    expect(result.document).toBe(twoParagraphDocument);
  });

  it("atomically replaces a deleted shape with a same-run insertion while preserving its identity and placement", () => {
    const existing = tableShape("variation_table", "para_2", "old", {
      x: 217,
      y: 503,
      dx: 151,
      dy: 212,
    });
    const replacement = tableShape("ai_table_generated", "para_2", "new", {
      x: 0,
      y: 56,
      dx: 0,
      dy: 56,
    });
    replacement.props.w = 460;
    replacement.props.h = 132;

    const result = mergeProposalDraftsIntoDocument(withOverlayShape(existing), [
      {
        proposalId: "update",
        draft: {
          summary: "表サイズを更新",
          plan: [],
          operations: [],
          warnings: [],
          mutationOperations: [{
            operation: "updateOverlayShape",
            summary: "表サイズを更新",
            shapeId: existing.id,
            patch: { props: { w: 460, h: 132 } },
          }],
        },
      },
      {
        proposalId: "delete",
        draft: {
          summary: "旧表を削除",
          plan: [],
          operations: [],
          warnings: [],
          mutationOperations: [{
            operation: "deleteOverlayShapes",
            summary: "旧表を削除",
            shapeIds: [existing.id],
          }],
        },
      },
      {
        proposalId: "insert",
        source: { toolName: "draft_insert_table", toolArgs: { id: existing.id } },
        draft: {
          summary: "新表を挿入",
          plan: [],
          operations: [{
            operation: "insertTableShape",
            summary: "新表を挿入",
            targetId: "para_2",
            tableShape: replacement,
          }],
          warnings: [],
        },
      },
    ]);

    expect(result.appliedIds).toEqual(["update", "delete", "insert"]);
    expect(result.failed).toEqual([]);
    const shapes = result.document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatchObject({
      id: existing.id,
      type: "tableShape",
      x: existing.x,
      y: existing.y,
      anchor: existing.anchor,
      props: { w: 460, h: 132 },
    });
  });

  it("rolls back the delete when the paired insertion cannot be applied", () => {
    const existing = tableShape("variation_table", "para_2", "old", {
      x: 217,
      y: 503,
      dx: 151,
      dy: 212,
    });
    const replacement = tableShape("ai_table_generated", "para_2", "new", {
      x: 0,
      y: 56,
      dx: 0,
      dy: 56,
    });
    const baseDocument = withOverlayShape(existing);
    const result = mergeProposalDraftsIntoDocument(baseDocument, [
      {
        proposalId: "delete",
        draft: {
          summary: "旧表を削除",
          plan: [],
          operations: [],
          warnings: [],
          mutationOperations: [{
            operation: "deleteOverlayShapes",
            summary: "旧表を削除",
            shapeIds: [existing.id],
          }],
        },
      },
      {
        proposalId: "insert_invalid",
        source: { toolName: "draft_insert_table", toolArgs: { id: existing.id } },
        draft: {
          summary: "新表を挿入",
          plan: [],
          operations: [{
            operation: "insertTableShape",
            summary: "新表を挿入",
            targetId: "missing_target",
            tableShape: replacement,
          }],
          warnings: [],
        },
      },
    ]);

    expect(result.appliedIds).toEqual([]);
    expect(result.failed).toEqual([{ proposalId: "insert_invalid", error: expect.stringContaining("見つかりません") }]);
    expect(result.document).toBe(baseDocument);
    expect(result.document.pageLayout?.overlay?.overlaySnapshot?.shapes).toEqual([existing]);
  });
});

describe("replayProposalDraft legacy overlay anchor support", () => {
  function problemDocument(problem: ProblemNode): SigmaDocument {
    return {
      version: "2.0",
      docId: "doc_overlay_anchor_rebase",
      metadata: { title: "Overlay anchor rebase" },
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
      content: [problem],
    };
  }

  function legacyCalloutDraft(): AiEditSessionDraft {
    return {
      summary: "空の解答欄へ吹き出しを追加しました。",
      plan: ["吹き出しを追加しました。"],
      operations: [{
        operation: "replace",
        summary: "図形の挿入先として問題の解答に空行を追加しました。",
        targetId: "problem_1",
        replacementBlock: {
          type: "problem",
          id: "problem_1",
          tags: [],
          lead: [],
          prompt: [{ type: "paragraph", id: "prompt_1", children: [{ type: "text", text: "古い問題文" }] }],
          solution: [{ type: "paragraph", id: "answer_anchor", children: [] }],
          hints: [],
        },
      }, {
        operation: "insertOverlayShape",
        summary: "吹き出しを追加しました。",
        targetId: "answer_anchor",
        overlayShape: {
          id: "callout_1",
          type: "callout",
          x: 20,
          y: 80,
          rotation: 0,
          anchor: { type: "block", blockId: "answer_anchor", dx: 20, dy: 80, reserveSpace: true },
          props: {
            w: 320,
            h: 68,
            radius: 18,
            tail: {
              baseStart: { x: 44, y: 68 },
              baseEnd: { x: 84, y: 68 },
              tip: { x: 64, y: 96 },
            },
            blocks: [{ type: "paragraph", id: "local_sigma_doc_proposal_store_test_55", children: [] }],
            color: "#111111",
            size: "m",
            dash: "solid",
            strokeWidth: "m",
          },
        },
        assets: {},
      }],
      warnings: [],
    };
  }

  it("preserves current body content and retargets the overlay when the area is no longer empty", () => {
    const currentProblem: ProblemNode = {
      type: "problem",
      id: "problem_1",
      tags: [],
      lead: [],
      prompt: [{ type: "paragraph", id: "prompt_1", children: [{ type: "text", text: "人間が直した問題文" }] }],
      solution: [{ type: "paragraph", id: "answer_human", children: [{ type: "text", text: "人間の解答" }] }],
      hints: [],
    };

    const replay = replayProposalDraft(problemDocument(currentProblem), legacyCalloutDraft());
    const problem = replay.nextDocument.content[0];
    expect(problem).toEqual(currentProblem);
    expect(replay.nextDocument.pageLayout?.overlay?.overlaySnapshot?.shapes[0]).toMatchObject({
      id: "callout_1",
      anchor: { type: "block", blockId: "answer_human" },
    });
  });

  it("adds only the synthetic anchor while preserving other current problem fields", () => {
    const currentProblem: ProblemNode = {
      type: "problem",
      id: "problem_1",
      tags: ["current-tag"],
      lead: [],
      prompt: [{ type: "paragraph", id: "prompt_1", children: [{ type: "text", text: "人間が直した問題文" }] }],
      solution: [],
      hints: [],
    };

    const replay = replayProposalDraft(problemDocument(currentProblem), legacyCalloutDraft());
    const problem = replay.nextDocument.content[0];
    expect(problem).toMatchObject({
      tags: ["current-tag"],
      prompt: currentProblem.prompt,
      solution: [{ id: "answer_anchor", type: "paragraph", children: [] }],
    });
  });
});
