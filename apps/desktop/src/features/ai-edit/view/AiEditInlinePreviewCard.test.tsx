import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AiEditInlinePreviewCard,
  AiEditOverlayApprovalWidget,
  getAiEditInlinePreviewTitleId,
  getAiEditOverlayApprovalTitle,
  resolveDismissReason,
} from "./AiEditInlinePreviewCard";
import type { AiEditPreviewState } from "../model/preview";
import {
  groupPendingProposalContentByAnchor,
  type AiProposalContent,
  type AiProposalContentHunk,
} from "../model/proposal-content";
import type { AiEditDraft, SigmaDocMutationOp } from "@/lib/ai/sigma-doc-edit-schema";
import type { OverlayShape, SigmaBlock, SigmaDocument } from "@/features/document";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";

function paragraph(id: string, text: string): SigmaBlock {
  return { id, type: "paragraph", children: [{ type: "text", text }] };
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

function documentOf(content: SigmaBlock[], extra: Record<string, unknown> = {}): SigmaDocument {
  return parseSigmaDocument({
    version: "2.0",
    docId: "doc_card",
    metadata: { title: "提案カード" },
    content,
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    ...extra,
  });
}

function problem(): SigmaBlock {
  return {
    id: "problem_1",
    type: "problem",
    tags: [],
    lead: [],
    prompt: [paragraph("prompt_1", "元の問題文") as never],
    hints: [],
    solution: [paragraph("solution_1", "元の解答") as never],
    answer: { type: "math", expected: "" },
    numbering: { value: 7 },
  } as SigmaBlock;
}

function baseDocument(): SigmaDocument {
  return documentOf([paragraph("p1", "元の本文"), problem(), paragraph("b1", "一"), paragraph("b2", "二")]);
}

function previewState(
  operations: AiEditDraft[],
  overrides: Partial<AiEditPreviewState> = {},
  mutationOperations: SigmaDocMutationOp[] = [],
): AiEditPreviewState {
  return {
    targetId: operations[0]?.targetId ?? "",
    draft: {
      summary: "挿入します",
      plan: [],
      operations,
      warnings: [],
      ...(mutationOperations.length > 0 ? { mutationOperations } : {}),
    },
    createdAt: 0,
    proposalIds: ["proposal_1"],
    baseRevision: 1,
    providers: ["chatgpt"],
    ...overrides,
  };
}

function replace(targetId: string, block: SigmaBlock): AiEditDraft {
  return { operation: "replace", summary: "本文を書き換え", targetId, replacementBlock: block as never };
}

function insertAfter(targetId: string, insertedId: string, text: string): AiEditDraft {
  return { operation: "insertAfter", summary: text, targetId, insertedBlock: paragraph(insertedId, text) as never };
}

/** 紙面と同じ手順で、そのアンカーに置くカードの内容を作る。 */
function cardContent(preview: AiEditPreviewState, anchorId: string, document = baseDocument()): AiProposalContent {
  const card = groupPendingProposalContentByAnchor([preview], document).get(anchorId)?.[0];
  if (!card) {
    throw new Error(`no card at ${anchorId}`);
  }
  return card.content;
}

function replaceContent(): AiProposalContent {
  return cardContent(previewState([replace("p1", paragraph("p1", "書き換え後のテキスト"))]), "p1");
}

function renderCard(content: AiProposalContent, props: Partial<Parameters<typeof AiEditInlinePreviewCard>[0]> = {}): string {
  return renderToStaticMarkup(<AiEditInlinePreviewCard content={content} applying={false} {...props} />);
}

/** 描画結果の文字だけ (変わった単語を塗った span で文が分かれても続けて読める)。 */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function hunk(overrides: Partial<AiProposalContentHunk>): AiProposalContentHunk {
  return {
    anchorBlockId: "p1",
    removed: [],
    added: [],
    notes: [],
    operations: [],
    numbering: {
      removed: { problems: new Map(), headings: new Map() },
      added: { problems: new Map(), headings: new Map() },
    },
    ...overrides,
  };
}

describe("AiEditInlinePreviewCard", () => {
  it("renders a section number with the same prefix as heading previews", () => {
    const content: AiProposalContent = {
      hunks: [hunk({
        anchorBlockId: "section-1",
        added: [{ type: "section", id: "section-1", title: "序章" }],
        operations: ["replace"],
        numbering: {
          removed: { problems: new Map(), headings: new Map() },
          added: { problems: new Map(), headings: new Map([["section-1", "第1章"]]) },
        },
      })],
      shapes: [],
    };

    expect(renderCard(content)).toContain('<span class="heading-number-prefix">第1章 </span>序章');
  });

  it("draws list markers with the same typography the applied document will use", () => {
    // 提案プレビューと適用結果でマーカーが食い違うと「提案 ≠ 適用」に戻る。
    const document = documentOf([{
      id: "list_1",
      type: "list",
      listType: "ordered",
      items: [{ type: "listItem", id: "li_1", children: [{ type: "text", text: "元" }] }],
    } as SigmaBlock]);
    const content = cardContent(previewState([replace("list_1", {
      id: "list_1",
      type: "list",
      listType: "ordered",
      markerStyle: "paren",
      items: [
        { type: "listItem", id: "li_1", children: [{ type: "text", text: "いち", fontFamily: '"Yu Mincho", serif', fontSize: 18 }] },
        { type: "listItem", id: "li_2", children: [{ type: "text", text: "に" }] },
      ],
    } as SigmaBlock)]), "list_1", document);
    const html = renderCard(content);

    expect(html).toContain("--sigma-doc-list-marker-font-family:&quot;Yu Mincho&quot;, serif");
    expect(html).toContain("--sigma-doc-list-marker-font-size:18pt");
    expect(html).toContain('class="print-list"');
    // 無印の項目は既定のまま (隣の項目の書体が漏れない)。
    expect(html.match(/data-list-marker-typography/g)).toHaveLength(1);
  });

  it("renders the proposed content inside the card frame without provider or change-count chrome", () => {
    const html = renderCard(cardContent(previewState([
      insertAfter("p1", "ins_0", "候補0"),
      insertAfter("ins_0", "ins_1", "候補1"),
    ]), "p1"));

    expect(html).toContain("候補0");
    expect(html).toContain("候補1");
    expect(html).toContain("ai-inline-preview-scroll");
    expect(html).toContain('data-ai-proposal-content=""');
    expect(html).toContain('data-surface="page"');
    expect(html).not.toContain("ai-proposal-provider-identity");
    expect(html).not.toContain(">ChatGPT<");
    expect(html).toContain('aria-label="閉じる"');
    expect(html).not.toContain("件の変更");
    expect(html).not.toContain("ai-inline-preview-operation-title");
  });

  it("uses the sidebar's 提案された変更 heading so both surfaces read the same", () => {
    const html = renderCard(replaceContent());

    expect(html).toContain("ai-inline-preview-diff-heading");
    expect(html.match(/提案された変更/g)).toHaveLength(1);
  });

  it("orders the card like the sidebar proposal: heading → diff → 参照元 → actions", () => {
    const html = renderCard(replaceContent(), {
      sourceReferences: [{ type: "document", fileId: "file_1", title: "参照した教材" }],
      onOpenConversation: () => {},
      onApply: async () => ({ ok: true }),
      onDismiss: () => {},
    });

    const headingIndex = html.indexOf("ai-inline-preview-diff-heading");
    const scrollIndex = html.indexOf("ai-inline-preview-scroll");
    const chipsIndex = html.indexOf("ai-source-ref-row");
    const actionsIndex = html.indexOf("ai-inline-preview-actions");

    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(headingIndex).toBeLessThan(scrollIndex);
    expect(scrollIndex).toBeLessThan(chipsIndex);
    expect(chipsIndex).toBeLessThan(actionsIndex);
  });

  it("keeps the title information available to assistive tech via aria-label", () => {
    expect(renderCard(replaceContent())).toContain('aria-label="AIの編集案: AI編集案"');
    expect(renderCard(cardContent(previewState([insertAfter("p1", "ins", "追加")]), "p1")))
      .toContain('aria-label="AIの編集案: AI挿入案"');
  });

  it("renders discard and apply actions", () => {
    const html = renderCard(replaceContent());

    expect(html).toContain("ai-inline-preview-action discard");
    expect(html).toContain("ai-inline-preview-action apply");
    expect(html).toContain("破棄");
    expect(html).toContain("適用");
  });

  it("renders a 続けて修正 action without embedding a follow-up composer", () => {
    const html = renderCard(replaceContent(), { onOpenConversation: () => {} });

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
    expect(renderCard(replaceContent())).not.toContain("続けて修正");
  });

  it("does not add a generic change-summary line above the real body content", () => {
    const html = renderCard(replaceContent());

    expect(html).toContain("書き換え後");
    expect(html).not.toContain("ai-inline-preview-summary");
    expect(html).not.toContain("本文を更新");
  });

  it("disables both actions and shows a shimmer while applying", () => {
    const html = renderCard(replaceContent(), { applying: true, onApply: async () => ({ ok: true }), onDismiss: () => {} });

    expect(html).toContain("ui-shimmer-text");
    expect(html).toContain("適用中…");
    const disabledButtonCount = (html.match(/disabled=""/g) ?? []).length;
    expect(disabledButtonCount).toBe(2);
  });

  it("never renders overlay shapes inside a body-flow card", () => {
    const shapeOnly: AiProposalContent = {
      hunks: [],
      shapes: [{ change: "added", shape: rectangleShape("shape_1"), assets: {} }],
    };
    const mixed: AiProposalContent = { ...replaceContent(), shapes: shapeOnly.shapes };

    expect(renderCard(shapeOnly)).toBe("");
    expect(renderCard(mixed)).not.toContain("data-ai-proposal-shapes");
    expect(textOf(renderCard(mixed))).toContain("書き換え後のテキスト");
  });

  it("shows only the proposed '+' content for a replace — never a '−' repeat of the current content", () => {
    // The body already marks the to-be-replaced text with a pale-red background;
    // repeating the old content inside the card showed the same information twice.
    const html = renderCard(replaceContent());

    expect(html).toContain('data-change="added"');
    expect(html).not.toContain('data-change="removed"');
    expect(html).not.toContain("元の本文");
  });

  it("renders a problem-area proposal with the problem/solution layout rail", () => {
    const html = renderCard(cardContent(previewState([insertAfter("solution_1", "next_solution", "新しい解答")]), "solution_1"));

    expect(html).toContain('data-problem-area="solution"');
    expect(html).toContain('data-ai-proposal-area-label="">解答<');
    expect(html).toContain("新しい解答");
  });

  it("renders a framed whole-problem proposal with the applied number and print-area structure", () => {
    const html = renderCard(cardContent(previewState([replace("problem_1", {
      id: "problem_1",
      type: "problem",
      tags: [],
      lead: [],
      prompt: [paragraph("next_prompt", "新しい問題文") as never],
      hints: [],
      solution: [paragraph("next_solution", "新しい解答") as never],
      answer: { type: "math", expected: "" },
      numbering: { value: 7 },
      frame: { enabled: true },
    } as SigmaBlock)]), "problem_1"));

    expect(html).toContain("print-problem-area with-frame");
    expect(html).toContain('class="print-problem-number" style="font-size:12pt">7</span>');
    expect(html).toContain('data-problem-area="prompt"');
    expect(html).toContain('data-problem-area="solution"');
    expect(html).not.toContain("data-ai-proposal-area-label");
    // 元の問題との違いの単語だけが塗られるので、文は要素をまたいで続く。
    expect(textOf(html)).toContain("新しい問題文");
    expect(textOf(html)).toContain("新しい解答");
  });

  it("renders a box proposal through the shared print renderer", () => {
    const document = documentOf([{
      id: "box_1",
      type: "boxBlock",
      styleId: "itembox",
      title: [{ type: "text", text: "要点" }],
      blocks: [paragraph("box_body", "囲みの本文") as never],
    } as SigmaBlock]);
    const html = renderCard(cardContent(previewState([replace("box_1", {
      id: "box_1",
      type: "boxBlock",
      styleId: "itembox",
      title: [{ type: "text", text: "要点" }],
      blocks: [paragraph("box_body", "新しい囲みの本文") as never],
    } as SigmaBlock)]), "box_1", document));

    expect(html).toContain("print-box-block");
    expect(html).toContain('class="print-box-title"');
    expect(html).toContain('class="print-paragraph"');
  });

  it("renders a compact summary row for a mutation-only proposal (e.g. deleteBlocks)", () => {
    const content = cardContent(previewState([], {}, [
      { operation: "deleteBlocks", summary: "2件のブロックを削除", blockIds: ["b1", "b2"] },
    ]), "b1");
    const html = renderCard(content);

    expect(html).toContain("2件のブロックを削除");
    expect(html).toContain('aria-label="AIの編集案: AI削除案"');
    expect(html).not.toContain("<svg viewBox");
  });

  it("falls back to a generic label for an unrecognized mutation op instead of crashing", () => {
    const unknownOp = { operation: "unknownFutureOp", blockIds: ["b1"] } as unknown as SigmaDocMutationOp;
    const html = renderCard(cardContent(previewState([], {}, [unknownOp]), "b1"));

    expect(html).toContain("AI編集案");
  });

  it("returns null when there is no body content", () => {
    expect(renderCard({ hunks: [], shapes: [] })).toBe("");
  });

  it("renders overlay-only decisions as a compact canvas widget without a duplicate shape preview", () => {
    const preview = previewState([{
      operation: "insertOverlayShape",
      summary: "長方形を挿入",
      targetId: "p1",
      overlayShape: rectangleShape("shape_1"),
      assets: {},
    }], { sessionLabel: "グラフ作成" });
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
    expect(html).not.toContain("data-ai-proposal-content");
    expect(html).not.toContain("data-proposal-ids");
    // The canvas widget stays a compact toolbar: the sidebar's diff heading
    // belongs to the body-flow card, not here.
    expect(html).not.toContain("ai-inline-preview-diff-heading");
  });

  it("renders up to 3 change-summary lines plus a ほかN件 remainder, and the 続けて修正 action", () => {
    const preview = previewState([{
      operation: "insertOverlayShape",
      summary: "長方形を挿入",
      targetId: "p1",
      overlayShape: rectangleShape("shape_1"),
      assets: {},
    }]);
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
      operation: "insertOverlayShape",
      summary: "グラフを挿入",
      targetId: "p1",
      overlayShape: { ...rectangleShape("graph_1"), type: "graph2dShape" },
      assets: {},
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
});

describe("getAiEditInlinePreviewTitleId", () => {
  it("names the card by the kinds of operation its blocks came from", () => {
    const of = (...operations: AiProposalContentHunk["operations"]) => ({ hunks: [hunk({ operations })], shapes: [] });

    expect(getAiEditInlinePreviewTitleId(of("insertAfter", "insertAfter"))).toBe("insert");
    expect(getAiEditInlinePreviewTitleId(of("replace"))).toBe("edit");
    expect(getAiEditInlinePreviewTitleId(of("insertAfter", "replace"))).toBe("edit");
    expect(getAiEditInlinePreviewTitleId(of("deleteBlocks"))).toBe("delete");
    expect(getAiEditInlinePreviewTitleId(of("moveBlocks", "moveBlocks"))).toBe("move");
    expect(getAiEditInlinePreviewTitleId(of("deleteBlocks", "moveBlocks"))).toBe("edit");
    expect(getAiEditInlinePreviewTitleId(of("wrapBlocksInColumns"))).toBe("edit");
    expect(getAiEditInlinePreviewTitleId({ hunks: [], shapes: [] })).toBe("edit");
  });
});

describe("resolveDismissReason", () => {
  it("trims whitespace around a reason", () => {
    expect(resolveDismissReason("  数式が元の問題と合っていない  ")).toBe("数式が元の問題と合っていない");
  });

  it("treats a blank or whitespace-only reason as no reason (undefined)", () => {
    expect(resolveDismissReason("")).toBeUndefined();
    expect(resolveDismissReason("   ")).toBeUndefined();
  });
});

describe("groupPendingProposalContentByAnchor (page cards)", () => {
  it("returns an empty map for no previews", () => {
    expect(groupPendingProposalContentByAnchor([], baseDocument()).size).toBe(0);
  });

  it("keeps operations targeting distinct real blocks in separate anchors", () => {
    const grouped = groupPendingProposalContentByAnchor([previewState([
      insertAfter("p1", "ins_a", "A"),
      insertAfter("b2", "ins_b", "B"),
    ])], baseDocument());

    expect(new Set(grouped.keys())).toEqual(new Set(["p1", "b2"]));
  });

  it("preserves prompt/solution ownership and the problem number for layout-aware previews", () => {
    const grouped = groupPendingProposalContentByAnchor([previewState([
      insertAfter("prompt_1", "next_prompt", "新しい問題文"),
      insertAfter("solution_1", "next_solution", "新しい解答"),
    ])], baseDocument());

    expect(grouped.get("prompt_1")?.[0].content.hunks[0]?.problemArea).toEqual({ problemId: "problem_1", area: "prompt" });
    expect(grouped.get("solution_1")?.[0].content.hunks[0]?.problemArea).toEqual({ problemId: "problem_1", area: "solution" });
    expect(grouped.get("prompt_1")?.[0].content.hunks[0]?.numbering.added.problems.get("problem_1")).toBe(7);
  });

  it("anchors a mutation op (e.g. deleteBlocks) to its first affected block", () => {
    const grouped = groupPendingProposalContentByAnchor([previewState([], {}, [
      { operation: "deleteBlocks", summary: "2件を削除", blockIds: ["b1", "b2"] },
    ])], baseDocument());

    expect([...grouped.keys()]).toEqual(["b1"]);
    expect(grouped.get("b1")?.[0].content.hunks[0]?.removed.map((block) => block.id)).toEqual(["b1", "b2"]);
  });

  it("keeps an overlay update out of body-flow grouping even when the shape has a block anchor", () => {
    const shape = { ...rectangleShape("shape_1"), anchor: { type: "block" as const, blockId: "p1", dy: 0 } };
    const document = {
      ...baseDocument(),
      pageLayout: { overlay: { overlaySnapshot: { version: 1, shapes: [shape], assets: {} } } },
    } as unknown as SigmaDocument;
    const preview = previewState([], {}, [
      { operation: "updateOverlayShape", summary: "図形を右へ移動", shapeId: "shape_1", patch: { x: 120 } },
    ]);

    expect(groupPendingProposalContentByAnchor([preview], document).size).toBe(0);
  });
});
