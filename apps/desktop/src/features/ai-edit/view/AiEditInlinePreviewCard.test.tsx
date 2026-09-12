import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AiEditInlinePreviewCard,
  AiEditOverlayApprovalWidget,
  getAiEditOverlayApprovalTitle,
  groupAiEditPreviewEntries,
  resolveDismissReason,
  type AiEditInlinePreviewEntry,
} from "./AiEditInlinePreviewCard";
import type { AiEditPreviewState } from "../model/preview";
import type { AiEditDraft, SigmaDocMutationOp } from "@/lib/ai/sigma-doc-edit-schema";
import type { OverlayShape, SigmaDocument } from "@/features/document";

function replaceEntry(targetId: string, index: number, count: number): Extract<AiEditInlinePreviewEntry, { kind: "operation" }> {
  const draft: AiEditDraft = {
    operation: "replace",
    summary: "本文を書き換え",
    targetId,
    replacementBlock: {
      id: targetId,
      type: "paragraph",
      children: [{ type: "text", text: "書き換え後のテキスト" }],
    },
  };
  return {
    kind: "operation",
    draft,
    operationIndex: index,
    operationCount: count,
    sessionSummary: "本文を書き換えます",
  };
}

function rectangleShape(id: string): OverlayShape {
  return {
    id,
    type: "geo",
    x: 0,
    y: 0,
    props: {
      w: 80,
      h: 40,
      geo: "rectangle",
      fill: "solid",
      color: "#111111",
      fillColor: "#ffffff",
      labelColor: "#111111",
      dash: "solid",
      size: "m",
    },
  };
}

function shapeOnlyEntry(targetId: string): Extract<AiEditInlinePreviewEntry, { kind: "operation" }> {
  const draft: AiEditDraft = {
    operation: "insertOverlayShape",
    summary: "長方形を挿入",
    targetId,
    overlayShape: rectangleShape("shape_1"),
    assets: {},
  };
  return {
    kind: "operation",
    draft,
    operationIndex: 0,
    operationCount: 1,
    sessionSummary: "図形を挿入します",
  };
}

function mutationEntry(op: SigmaDocMutationOp, index = 0): AiEditInlinePreviewEntry {
  return { kind: "mutation", op, operationIndex: index, operationCount: 1, sessionSummary: op.summary };
}

function documentWithShapes(shapes: OverlayShape[]): SigmaDocument {
  return {
    content: [],
    pageLayout: {
      overlay: {
        overlaySnapshot: { version: 1, shapes, assets: {} },
      },
    },
  } as unknown as SigmaDocument;
}

function documentWithProblem(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_problem_preview",
    metadata: { title: "問題プレビュー" },
    content: [{
      id: "problem_1",
      type: "problem",
      tags: [],
      lead: [],
      prompt: [{ id: "prompt_1", type: "paragraph", children: [{ type: "text", text: "元の問題文" }] }],
      hints: [],
      solution: [{ id: "solution_1", type: "paragraph", children: [{ type: "text", text: "元の解答" }] }],
      answer: { type: "math", expected: "" },
      numbering: { value: 7 },
    }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
}

function listEntry(): Extract<AiEditInlinePreviewEntry, { kind: "operation" }> {
  const draft: AiEditDraft = {
    operation: "replace",
    summary: "リストに書き換え",
    targetId: "list_1",
    replacementBlock: {
      id: "list_1",
      type: "list",
      listType: "ordered",
      markerStyle: "paren",
      items: [
        {
          type: "listItem",
          id: "li_1",
          children: [{ type: "text", text: "いち", fontFamily: '"Yu Mincho", serif', fontSize: 18 }],
        },
        { type: "listItem", id: "li_2", children: [{ type: "text", text: "に" }] },
      ],
    },
  };
  return { kind: "operation", draft, operationIndex: 0, operationCount: 1, sessionSummary: "リストにします" };
}

describe("AiEditInlinePreviewCard", () => {
  it("renders a section number with the same prefix as heading previews", () => {
    const entry: Extract<AiEditInlinePreviewEntry, { kind: "operation" }> = {
      kind: "operation",
      draft: {
        operation: "replace",
        summary: "章を更新",
        targetId: "section-1",
        replacementBlock: { type: "section", id: "section-1", title: "序章" },
      },
      operationIndex: 0,
      operationCount: 1,
      sessionSummary: "章を更新します",
      headingNumber: "第1章",
      headingNumbers: new Map([["section-1", "第1章"]]),
    };
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard entries={[entry]} providers={["claude"]} applying={false} />,
    );

    expect(html).toContain('<span class="heading-number-prefix">第1章 </span>序章');
  });

  it("draws list markers with the same typography the applied document will use", () => {
    // 提案プレビューと適用結果でマーカーが食い違うと「提案 ≠ 適用」に戻る。
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard entries={[listEntry()]} providers={["claude"]} applying={false} />,
    );

    expect(html).toContain("--sigma-doc-list-marker-font-family:&quot;Yu Mincho&quot;, serif");
    expect(html).toContain("--sigma-doc-list-marker-font-size:18pt");
    expect(html).toContain('class="print-list"');
    // 無印の項目は既定のまま (隣の項目の書体が漏れない)。
    expect(html.match(/data-list-marker-typography/g)).toHaveLength(1);
  });

  it("renders the proposed content without a heavy header or change-count chrome", () => {
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard
        entries={[replaceEntry("p1", 0, 2), replaceEntry("p1", 1, 2)]}
        providers={["claude"]}
        applying={false}
      />,
    );

    // The proposed text content is present...
    expect(html).toContain("書き換え後のテキスト");
    expect(html).toContain("ai-inline-preview-scroll");
    // Provider identity chrome is omitted so the proposed content gets the full width.
    expect(html).not.toContain("ai-proposal-provider-identity");
    expect(html).not.toContain(">Claude<");
    expect(html).toContain('aria-label="閉じる"');
    expect(html).not.toContain("件の変更");
    // Per-operation index badges ("1/2") are gone too.
    expect(html).not.toContain("ai-inline-preview-operation-title");
  });

  it("uses the sidebar's 提案された変更 heading so both surfaces read the same", () => {
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard
        entries={[replaceEntry("p1", 0, 1)]}
        providers={["claude"]}
        applying={false}
      />,
    );

    expect(html).toContain("ai-inline-preview-diff-heading");
    expect(html.match(/提案された変更/g)).toHaveLength(1);
  });

  it("orders the card like the sidebar proposal: heading → diff → 参照元 → actions", () => {
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard
        entries={[replaceEntry("p1", 0, 1)]}
        providers={["claude"]}
        applying={false}
        sourceReferences={[{ type: "document", fileId: "file_1", title: "参照した教材" }]}
        onOpenConversation={() => {}}
        onApply={async () => ({ ok: true })}
        onDismiss={() => {}}
      />,
    );

    const headingIndex = html.indexOf("ai-inline-preview-diff-heading");
    const scrollIndex = html.indexOf("ai-inline-preview-scroll");
    const chipsIndex = html.indexOf("ai-source-ref-row");
    const actionsIndex = html.indexOf("ai-inline-preview-actions");

    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(headingIndex).toBeLessThan(scrollIndex);
    expect(scrollIndex).toBeLessThan(chipsIndex);
    expect(chipsIndex).toBeLessThan(actionsIndex);
  });

  it("keeps the provider/title information available to assistive tech via aria-label", () => {
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard
        entries={[replaceEntry("p1", 0, 1)]}
        providers={["claude", "chatgpt"]}
        applying={false}
      />,
    );

    expect(html).toContain('aria-label="AIの編集案: AI編集案"');
  });

  it("does not repeat session or provider labels inside the body diff widget", () => {
    const withLabel = renderToStaticMarkup(
      <AiEditInlinePreviewCard
        entries={[replaceEntry("p1", 0, 1)]}
        providers={["claude"]}
        applying={false}
        sessionLabel="数式の見直し"
      />,
    );
    expect(withLabel).not.toContain("数式の見直し");

    const withoutLabel = renderToStaticMarkup(
      <AiEditInlinePreviewCard entries={[replaceEntry("p1", 0, 1)]} providers={["claude"]} applying={false} />,
    );
    expect(withoutLabel).not.toContain(">Claude<");
  });

  it("renders discard and apply actions", () => {
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard
        entries={[replaceEntry("p1", 0, 1)]}
        providers={["antigravity"]}
        applying={false}
      />,
    );

    expect(html).toContain("ai-inline-preview-action discard");
    expect(html).toContain("ai-inline-preview-action apply");
    expect(html).toContain("破棄");
    expect(html).toContain("適用");
  });

  it("renders a 続けて修正 action without embedding a follow-up composer", () => {
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard
        entries={[replaceEntry("p1", 0, 1)]}
        providers={[]}
        applying={false}
        onOpenConversation={() => {}}
      />,
    );

    // The conversation is opened in a separate body portal, never mounted
    // inside the proposal card itself.
    expect(html).not.toContain("ai-proposal-composer-slot");
    expect(html).not.toContain("ai-run-card-composer");
    expect(html).toContain('aria-label="続けて修正"');
    // Reading order: discard, continue, apply.
    expect(html.indexOf('aria-label="破棄"')).toBeLessThan(html.indexOf('aria-label="続けて修正"'));
    expect(html.indexOf('aria-label="続けて修正"')).toBeLessThan(html.indexOf('aria-label="適用"'));
  });

  it("omits the 続けて修正 action when the proposal has no conversation opener", () => {
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard entries={[replaceEntry("p1", 0, 1)]} providers={[]} applying={false} />,
    );

    expect(html).not.toContain("続けて修正");
  });

  it("does not add a generic change-summary line above the real body diff", () => {
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard
        entries={[replaceEntry("p1", 0, 1)]}
        providers={["claude"]}
        applying={false}
      />,
    );

    expect(html).toContain("書き換え後のテキスト");
    expect(html).not.toContain("ai-inline-preview-summary");
    expect(html).not.toContain("本文を更新");
  });

  it("disables both actions and shows a shimmer while applying", () => {
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard
        entries={[replaceEntry("p1", 0, 1)]}
        providers={["antigravity"]}
        applying
        onApply={async () => ({ ok: true })}
        onDismiss={() => {}}
      />,
    );

    expect(html).toContain("ui-shimmer-text");
    expect(html).toContain("適用中…");
    const disabledButtonCount = (html.match(/disabled=""/g) ?? []).length;
    expect(disabledButtonCount).toBe(2);
  });

  it("never renders insertOverlayShape entries inside a body-flow card", () => {
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard
        entries={[shapeOnlyEntry("p1")]}
        providers={[]}
        applying={false}
      />,
    );

    expect(html).toBe("");
  });

  it("renders overlay-only decisions as a compact canvas widget without a duplicate shape preview", () => {
    const preview = previewState([shapeOnlyEntry("p1").draft], { sessionLabel: "グラフ作成" });
    const html = renderToStaticMarkup(
      <AiEditOverlayApprovalWidget
        preview={preview}
        applying={false}
        placement="above"
        style={{ left: 120, top: 80 }}
        onApply={async () => ({ ok: true })}
        onDismiss={() => {}}
      />,
    );

    expect(html).toContain("ai-overlay-approval-widget");
    expect(html).toContain('data-placement="above"');
    expect(html).toContain("グラフ作成");
    expect(html).not.toContain("ai-proposal-provider-identity");
    expect(html).not.toContain(">ChatGPT<");
    expect(html).toContain("AI図形の挿入案");
    expect(html).toContain("ai-inline-preview-action discard");
    expect(html).toContain("ai-inline-preview-action apply");
    expect(html).not.toContain("ai-edit-shape-preview-viewport");
    expect(html).not.toContain("data-proposal-ids");
    // The canvas widget stays a compact toolbar: the sidebar's diff heading
    // belongs to the body-flow card, not here.
    expect(html).not.toContain("ai-inline-preview-diff-heading");
  });

  it("renders up to 3 change-summary lines plus a ほかN件 remainder, and the 続けて修正 action", () => {
    const preview = previewState([shapeOnlyEntry("p1").draft]);
    const html = renderToStaticMarkup(
      <AiEditOverlayApprovalWidget
        preview={preview}
        applying={false}
        placement="above"
        style={{ left: 120, top: 80 }}
        changeSummaryLines={["矩形を追加", "円を追加", "三角形を追加", "表を追加"]}
        onOpenConversation={() => {}}
        onApply={async () => ({ ok: true })}
        onDismiss={() => {}}
      />,
    );

    expect(html).toContain("ai-overlay-approval-summary-list");
    expect(html).toContain("矩形を追加");
    expect(html).toContain("円を追加");
    expect(html).toContain("三角形を追加");
    expect(html).not.toContain("表を追加");
    expect(html).toContain("ほか1件");
    // The follow-up card is portaled elsewhere rather than embedded here.
    expect(html).not.toContain("ai-proposal-composer-slot");
    expect(html).not.toContain("ai-run-card-composer");
    expect(html).toContain('aria-label="続けて修正"');
  });

  it("labels graph insertion proposals as graph proposals", () => {
    const graphDraft = {
      ...shapeOnlyEntry("p1").draft,
      overlayShape: { ...rectangleShape("graph_1"), type: "graph2dShape" },
    } as unknown as AiEditDraft;

    expect(getAiEditOverlayApprovalTitle(previewState([graphDraft]))).toBe("AIグラフの挿入案");
  });

  it("labels a paired table deletion and insertion as one replacement proposal", () => {
    const preview = previewState([{
      operation: "insertTableShape",
      summary: "新表を挿入",
      targetId: "p1",
      tableShape: {
        id: "generated_table",
        type: "tableShape",
        x: 0,
        y: 56,
        props: { w: 460, h: 132, table: {} },
      } as never,
    }]);
    preview.draft.mutationOperations = [{
      operation: "deleteOverlayShapes",
      summary: "旧表を削除",
      shapeIds: ["old_table"],
    }];
    preview.shapeReplacements = [{ removedShapeId: "old_table", addedShapeId: "generated_table" }];

    expect(getAiEditOverlayApprovalTitle(preview)).toBe("AI表の置き換え案");
  });

  it("shows only the proposed '+' content for a replace — never a '−' repeat of the current content", () => {
    // The body already marks the to-be-replaced text with a pale-red background;
    // repeating the old content inside the card showed the same information twice.
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard
        entries={[replaceEntry("p1", 0, 1)]}
        providers={["claude"]}
        applying={false}
      />,
    );

    expect(html).toContain("ai-inline-preview-diff-added");
    expect(html).not.toContain("ai-inline-preview-diff-removed");
  });

  it("renders a problem-area proposal with the problem/solution layout rail", () => {
    const entry = replaceEntry("solution_1", 0, 1);
    entry.problemArea = "solution";
    entry.problemNumber = 1;
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard entries={[entry]} providers={["chatgpt"]} applying={false} />,
    );

    expect(html).toContain('data-problem-area="solution"');
    expect(html).toContain("ai-inline-preview-problem-area-label");
    expect(html).toContain(">解答<");
    expect(html).toContain("書き換え後のテキスト");
  });

  it("renders a framed whole-problem proposal with the applied number and print-area structure", () => {
    const entry: AiEditInlinePreviewEntry = {
      kind: "operation",
      draft: {
        operation: "replace",
        summary: "問題を書き換え",
        targetId: "problem_1",
        replacementBlock: {
          id: "problem_1",
          type: "problem",
          tags: [],
          lead: [],
          prompt: [{ id: "next_prompt", type: "paragraph", children: [{ type: "text", text: "新しい問題文" }] }],
          hints: [],
          solution: [{ id: "next_solution", type: "paragraph", children: [{ type: "text", text: "新しい解答" }] }],
          answer: { type: "math", expected: "" },
          frame: { enabled: true },
        },
      },
      operationIndex: 0,
      operationCount: 1,
      sessionSummary: "問題を書き換えます",
      problemNumber: 4,
    };
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard entries={[entry]} providers={["chatgpt"]} applying={false} />,
    );

    expect(html).toContain("ai-inline-preview-paper");
    expect(html).toContain("print-problem-area with-frame");
    expect(html).toContain('class="print-problem-number"');
    expect(html).toContain('class="print-problem-number" style="font-size:12pt">4</span>');
    expect(html).toContain('data-problem-area="prompt"');
    expect(html).toContain('data-problem-area="solution"');
    expect(html).not.toContain("ai-inline-preview-problem-area-label");
    expect(html).toContain("新しい問題文");
    expect(html).toContain("新しい解答");
  });

  it("renders a box proposal through the shared print renderer", () => {
    const entry: AiEditInlinePreviewEntry = {
      kind: "operation",
      draft: {
        operation: "replace",
        summary: "囲みを追加",
        targetId: "box_1",
        replacementBlock: {
          id: "box_1",
          type: "boxBlock",
          styleId: "itembox",
          title: [{ type: "text", text: "要点" }],
          blocks: [{ id: "box_body", type: "paragraph", children: [{ type: "text", text: "囲みの本文" }] }],
        },
      },
      operationIndex: 0,
      operationCount: 1,
      sessionSummary: "囲みを追加します",
    };

    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard entries={[entry]} providers={["chatgpt"]} applying={false} />,
    );

    expect(html).toContain("print-box-block");
    expect(html).toContain('class="print-box-title"');
    expect(html).toContain('class="print-paragraph"');
  });

  it("never renders an overlay update mutation inside a body-flow card", () => {
    const entry: AiEditInlinePreviewEntry = {
      kind: "mutation",
      op: { operation: "updateOverlayShape", summary: "図形を右へ移動", shapeId: "shape_1", patch: { x: 120 } },
      operationIndex: 0,
      operationCount: 1,
      sessionSummary: "図形を更新します",
      afterShapes: [rectangleShape("shape_1")],
      assets: {},
    };
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard entries={[entry]} providers={["claude"]} applying={false} />,
    );

    expect(html).toBe("");
  });

  it("renders a compact summary row for a mutation-only entry (e.g. deleteBlocks)", () => {
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard
        entries={[mutationEntry({ operation: "deleteBlocks", summary: "3件のブロックを削除", blockIds: ["b1", "b2", "b3"] })]}
        providers={["claude"]}
        applying={false}
      />,
    );

    expect(html).toContain("3件のブロックを削除");
    expect(html).not.toContain("ai-edit-shape-preview-viewport");
  });

  it("falls back to a generic label for an unrecognized mutation op instead of crashing", () => {
    const unknownOp = { operation: "unknownFutureOp" } as unknown as SigmaDocMutationOp;
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard entries={[mutationEntry(unknownOp)]} providers={[]} applying={false} />,
    );

    expect(html).toContain("編集案");
  });

  it("returns null when there are no entries", () => {
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard entries={[]} providers={["claude"]} applying={false} />,
    );

    expect(html).toBe("");
  });
});

function previewState(operations: AiEditDraft[], overrides: Partial<AiEditPreviewState> = {}): AiEditPreviewState {
  return {
    targetId: operations[0]?.targetId ?? "",
    draft: { summary: "挿入します", plan: [], operations, warnings: [] },
    createdAt: 0,
    proposalIds: ["proposal_1"],
    baseRevision: 1,
    providers: ["chatgpt"],
    ...overrides,
  };
}

function insertAfter(targetId: string, insertedId: string, text: string): AiEditDraft {
  return {
    operation: "insertAfter",
    summary: text,
    targetId,
    insertedBlock: { id: insertedId, type: "paragraph", children: [{ type: "text", text }] },
  };
}

describe("resolveDismissReason", () => {
  it("trims whitespace around a reason", () => {
    expect(resolveDismissReason("  数式が元の問題と合っていない  ")).toBe("数式が元の問題と合っていない");
  });

  it("treats a blank or whitespace-only reason as no reason (undefined)", () => {
    expect(resolveDismissReason("")).toBeUndefined();
    expect(resolveDismissReason("   ")).toBeUndefined();
  });
});

describe("groupAiEditPreviewEntries", () => {
  it("returns an empty map for no previews", () => {
    expect(groupAiEditPreviewEntries([]).size).toBe(0);
  });

  it("folds a chain of insertAfter ops onto the single real anchor block, in order", () => {
    // op0 targets the real block; op1 targets op0's inserted (not-yet-existing)
    // block; op2 targets op1's. Keyed naively by targetId this scatters into
    // three groups (two with no rendered block); folded, all land on "p_real".
    const grouped = groupAiEditPreviewEntries([previewState([
      insertAfter("p_real", "ins_0", "候補0"),
      insertAfter("ins_0", "ins_1", "候補1"),
      insertAfter("ins_1", "ins_2", "候補2"),
    ])]);

    expect([...grouped.keys()]).toEqual(["p_real"]);
    const cards = grouped.get("p_real")!;
    expect(cards).toHaveLength(1);
    expect(cards[0].entries.map((entry) => entry.operationIndex)).toEqual([0, 1, 2]);
  });

  it("keeps operations targeting distinct real blocks in separate anchors", () => {
    const grouped = groupAiEditPreviewEntries([previewState([
      insertAfter("p_a", "ins_a", "A"),
      insertAfter("p_b", "ins_b", "B"),
    ])]);

    expect(new Set(grouped.keys())).toEqual(new Set(["p_a", "p_b"]));
  });

  it("preserves prompt/solution ownership and the problem number for layout-aware previews", () => {
    const grouped = groupAiEditPreviewEntries([previewState([
      insertAfter("prompt_1", "next_prompt", "新しい問題文"),
      insertAfter("solution_1", "next_solution", "新しい解答"),
    ])], documentWithProblem());

    expect(grouped.get("prompt_1")?.[0].entries[0]).toMatchObject({
      kind: "operation",
      problemArea: "prompt",
      problemNumber: 7,
    });
    expect(grouped.get("solution_1")?.[0].entries[0]).toMatchObject({
      kind: "operation",
      problemArea: "solution",
      problemNumber: 7,
    });
  });

  it("uses the proposed problem numbering setting, including hiding a disabled number", () => {
    const source = documentWithProblem();
    const problem = source.content[0];
    if (problem?.type !== "problem") throw new Error("problem fixture is missing");
    const preview = previewState([{
      operation: "replace",
      summary: "問題番号を非表示",
      targetId: problem.id,
      replacementBlock: { ...problem, numbering: { enabled: false, value: 12 } },
    }]);

    const entry = groupAiEditPreviewEntries([preview], source).get(problem.id)?.[0].entries[0];
    expect(entry).toMatchObject({ kind: "operation" });
    expect(entry && entry.kind === "operation" ? entry.problemNumber : null).toBeUndefined();
    const html = renderToStaticMarkup(
      <AiEditInlinePreviewCard entries={entry ? [entry] : []} providers={["chatgpt"]} applying={false} />,
    );
    expect(html).toContain('data-problem-area="prompt"');
    expect(html).toContain("元の問題文");
    expect(html).not.toContain("print-problem-number");
  });

  it("keeps two different runs proposing edits at the same anchor as two separate cards", () => {
    const runA = previewState([insertAfter("p1", "ins_a", "A案")], { runId: "run-a", proposalIds: ["pa"] });
    const runB = previewState([insertAfter("p1", "ins_b", "B案")], { runId: "run-b", proposalIds: ["pb"] });

    const grouped = groupAiEditPreviewEntries([runA, runB]);

    const cards = grouped.get("p1")!;
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.preview.runId)).toEqual(["run-a", "run-b"]);
    expect(cards[0].entries).toHaveLength(1);
    expect(cards[1].entries).toHaveLength(1);
  });

  it("keeps an overlay update out of body-flow grouping even when the shape has a block anchor", () => {
    const shape = { ...rectangleShape("shape_1"), anchor: { type: "block" as const, blockId: "b_anchor", dy: 0 } };
    const document = documentWithShapes([shape]);
    const preview = previewState([], {
      draft: {
        summary: "図形を更新します",
        plan: [],
        operations: [],
        warnings: [],
        mutationOperations: [{ operation: "updateOverlayShape", summary: "図形を右へ移動", shapeId: "shape_1", patch: { x: 120 } }],
      },
    });

    const grouped = groupAiEditPreviewEntries([preview], document);

    expect(grouped.size).toBe(0);
  });

  it("keeps an unanchored overlay update out of body-flow grouping", () => {
    const document = documentWithShapes([rectangleShape("shape_1")]);
    const preview = previewState([], {
      draft: {
        summary: "図形を更新します",
        plan: [],
        operations: [],
        warnings: [],
        mutationOperations: [{ operation: "updateOverlayShape", summary: "図形を更新", shapeId: "shape_1", patch: { x: 10 } }],
      },
    });

    const grouped = groupAiEditPreviewEntries([preview], document);

    expect(grouped.size).toBe(0);
  });

  it("hides the empty-area anchor support op and new shape while retaining genuine body edits", () => {
    const supportDraft = {
      operation: "replace",
      summary: "図形の挿入先として問題の問題文に空行を追加しました。",
      targetId: "problem_1",
      replacementBlock: { id: "problem_1", type: "problem", prompt: [] },
    } as unknown as AiEditDraft;
    const shapeDraft = { ...shapeOnlyEntry("empty_prompt_anchor").draft, targetId: "empty_prompt_anchor" };
    const preview = previewState([supportDraft, shapeDraft, insertAfter("p_real", "body_insert", "本文の追加")]);

    const grouped = groupAiEditPreviewEntries([preview]);

    expect([...grouped.keys()]).toEqual(["p_real"]);
    expect(grouped.get("p_real")![0].entries).toHaveLength(1);
    expect(grouped.get("p_real")![0].entries[0]).toMatchObject({
      kind: "operation",
      draft: { operation: "insertAfter" },
    });
  });

  it("anchors a mutation op (e.g. deleteBlocks) to its first affected block", () => {
    const preview = previewState([], {
      draft: {
        summary: "削除します",
        plan: [],
        operations: [],
        warnings: [],
        mutationOperations: [{ operation: "deleteBlocks", summary: "2件を削除", blockIds: ["b1", "b2"] }],
      },
    });

    const grouped = groupAiEditPreviewEntries([preview]);
    const cards = grouped.get("b1")!;
    expect(cards).toHaveLength(1);
    expect(cards[0].entries).toHaveLength(1);
    expect(cards[0].entries[0]).toMatchObject({ kind: "mutation" });
  });
});
