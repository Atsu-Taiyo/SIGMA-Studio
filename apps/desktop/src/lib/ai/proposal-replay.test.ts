import { describe, expect, it } from "vitest";

import type {
  BoxBlockNode,
  InlineNode,
  ListNode,
  OverlayShape,
  ParagraphNode,
  ProblemNode,
  SigmaBlock,
  SigmaDocument,
} from "@/features/document";
import { ensurePageLayout, normalizeOverlaySnapshot } from "@/features/document";
import { findBlock, updateBlockInDocument, deleteBlocksFromDocument } from "@/lib/document-tree";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import type { AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";

import {
  computeProposalMergeBasis,
  createEmptyProposalMergeReport,
  isProposalMergeQuiet,
} from "./proposal-merge-basis";
import {
  assertAppliedProposalHasRealChanges,
  replayProposalDraft,
  replayProposalDraftMerging,
} from "./proposal-replay";

function text(value: string): InlineNode {
  return { type: "text", text: value };
}

function paragraph(id: string, value: string | InlineNode[]): ParagraphNode {
  return { type: "paragraph", id, children: typeof value === "string" ? [text(value)] : value };
}

function documentOf(blocks: SigmaBlock[]): SigmaDocument {
  return parseSigmaDocument({
    version: "2.0",
    docId: "doc_merge_replay",
    metadata: { title: "Merge replay" },
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    content: blocks,
  });
}

function paragraphText(document: SigmaDocument, id: string): string {
  const block = findBlock(document, id);
  if (!block || !("children" in block) || !Array.isArray(block.children)) {
    throw new Error(`no paragraph ${id}`);
  }
  return (block.children as InlineNode[])
    .map((node) => (node.type === "text" ? node.text : node.type === "mathInline" ? `$${node.tex}$` : ""))
    .join("");
}

function withParagraph(document: SigmaDocument, id: string, value: string | InlineNode[]): SigmaDocument {
  return parseSigmaDocument(updateBlockInDocument(document, id, (block) => ({
    ...(block as ParagraphNode),
    children: typeof value === "string" ? [text(value)] : value,
  })));
}

function replaceDraft(replacement: SigmaBlock | ParagraphNode, summary = "書き換えました。"): AiEditSessionDraft {
  return {
    summary,
    plan: [summary],
    operations: [{ operation: "replace", summary, targetId: replacement.id, replacementBlock: replacement }],
    warnings: [],
  };
}

function withoutUpdatedAt(document: SigmaDocument): unknown {
  return JSON.parse(JSON.stringify(document, (key, value) => (key === "updatedAt" ? undefined : value)));
}

describe("computeProposalMergeBasis", () => {
  it("snapshots only the outermost blocks a draft overwrites, from the base document", () => {
    const base = documentOf([
      paragraph("p_1", "one"),
      { type: "boxBlock", id: "box", styleId: "plain", blocks: [paragraph("inner", "inner")] } satisfies BoxBlockNode,
      paragraph("p_untouched", "untouched"),
    ]);
    const draft: AiEditSessionDraft = {
      summary: "編集",
      plan: ["編集"],
      operations: [
        { operation: "replace", summary: "a", targetId: "p_1", replacementBlock: paragraph("p_1", "ONE") },
        { operation: "replace", summary: "b", targetId: "box", replacementBlock: { ...(findBlock(base, "box") as BoxBlockNode), blocks: [paragraph("inner", "INNER")] } },
        { operation: "replace", summary: "c", targetId: "inner", replacementBlock: paragraph("inner", "INNER2") },
      ],
      warnings: [],
    };

    const basis = computeProposalMergeBasis(draft, base);

    expect(basis.version).toBe(1);
    expect(Object.keys(basis.entities).sort()).toEqual(["box", "p_1"]);
    expect(basis.entities.p_1).toEqual({ kind: "block", value: paragraph("p_1", "one") });
    expect(basis.entities.box?.value).toMatchObject({ id: "box", blocks: [{ id: "inner", children: [{ text: "inner" }] }] });
  });

  it("keeps the first-touched snapshot of an entity and only adds newly touched ones", () => {
    const firstBase = documentOf([paragraph("p_1", "one"), paragraph("p_2", "two")]);
    const first = computeProposalMergeBasis(replaceDraft(paragraph("p_1", "ONE")), firstBase);
    const laterBase = withParagraph(withParagraph(firstBase, "p_1", "one (human)"), "p_2", "two (human)");
    const combined: AiEditSessionDraft = {
      ...replaceDraft(paragraph("p_1", "ONE")),
      operations: [
        ...replaceDraft(paragraph("p_1", "ONE")).operations,
        ...replaceDraft(paragraph("p_2", "TWO")).operations,
      ],
    };

    const next = computeProposalMergeBasis(combined, laterBase, first);

    expect(next.entities.p_1?.value).toEqual(paragraph("p_1", "one"));
    expect(next.entities.p_2?.value).toEqual(paragraph("p_2", "two (human)"));
  });

  it("substitutes earlier snapshots inside a newly touched ancestor", () => {
    const base = documentOf([{ type: "boxBlock", id: "box", styleId: "plain", blocks: [paragraph("inner", "inner")] }]);
    const first = computeProposalMergeBasis(replaceDraft(paragraph("inner", "INNER")), base);
    const laterBase = withParagraph(base, "inner", "inner (human)");
    const draft: AiEditSessionDraft = {
      ...replaceDraft(paragraph("inner", "INNER")),
      operations: [
        ...replaceDraft(paragraph("inner", "INNER")).operations,
        ...replaceDraft({ type: "boxBlock", id: "box", styleId: "plain", title: [text("AI title")], blocks: [paragraph("inner", "inner (human)")] }).operations,
      ],
    };

    const next = computeProposalMergeBasis(draft, laterBase, first);

    expect(Object.keys(next.entities)).toEqual(["box"]);
    expect(next.entities.box?.value).toMatchObject({ blocks: [{ id: "inner", children: [{ text: "inner" }] }] });
  });

  it("keeps the first snapshot of a shape and an anchor already in the previous basis", () => {
    const base = withShapes(ensurePageLayout(documentOf([paragraph("a", "a"), paragraph("b", "b")])), [geoShape("shape_1", 10, 10)]);
    const draft: AiEditSessionDraft = {
      summary: "編集",
      plan: ["編集"],
      operations: [{ operation: "insertAfter", summary: "i", targetId: "b", insertedBlock: paragraph("new", "new") }],
      mutationOperations: [{ operation: "updateOverlayShape", summary: "u", shapeId: "shape_1", patch: { x: 50 } }],
      warnings: [],
    };
    const first = computeProposalMergeBasis(draft, base);
    const later = withShapes(documentOf([paragraph("z", "z"), paragraph("a", "a"), paragraph("b", "b")]), [{ ...geoShape("shape_1", 10, 10), x: 70 }]);

    const next = computeProposalMergeBasis(draft, later, first);

    expect(next.entities.shape_1).toEqual(first.entities.shape_1);
    expect(next.anchors).toEqual({ b: { container: null, precedingIds: ["a"] } });
  });

  it("skips blocks the draft creates and records shapes, deletions and insert anchors", () => {
    const base = ensurePageLayout(documentOf([paragraph("a", "a"), paragraph("b", "b"), paragraph("c", "c")]));
    const shape = geoShape("shape_1", 10, 10);
    const withShape = withShapes(base, [shape]);
    const draft: AiEditSessionDraft = {
      summary: "編集",
      plan: ["編集"],
      operations: [
        { operation: "insertAfter", summary: "i", targetId: "c", insertedBlock: paragraph("new", "new") },
        { operation: "replace", summary: "r", targetId: "new", replacementBlock: paragraph("new", "NEW") },
      ],
      mutationOperations: [
        { operation: "deleteBlocks", summary: "d", blockIds: ["b"] },
        { operation: "updateOverlayShape", summary: "u", shapeId: "shape_1", patch: { x: 50 } },
      ],
      warnings: [],
    };

    const basis = computeProposalMergeBasis(draft, withShape);

    expect(Object.keys(basis.entities).sort()).toEqual(["b", "shape_1"]);
    expect(basis.entities.shape_1).toEqual({ kind: "shape", value: shape });
    expect(basis.anchors).toEqual({ c: { container: null, precedingIds: ["b", "a"] } });
  });
});

describe("replayProposalDraftMerging", () => {
  it("keeps a human edit to another block and reports nothing to count", () => {
    const base = documentOf([paragraph("p_1", "one"), paragraph("p_2", "two")]);
    const draft = replaceDraft(paragraph("p_1", "ONE by AI"));
    const basis = computeProposalMergeBasis(draft, base);
    const current = withParagraph(base, "p_2", "two by human");

    const result = replayProposalDraftMerging(current, draft, basis);

    expect(paragraphText(result.nextDocument, "p_1")).toBe("ONE by AI");
    expect(paragraphText(result.nextDocument, "p_2")).toBe("two by human");
    expect(isProposalMergeQuiet(result.report)).toBe(true);
    expect(result.report).toEqual(createEmptyProposalMergeReport());
  });

  it("produces exactly the legacy replay when nobody else edited the touched blocks", () => {
    const base = documentOf([paragraph("p_1", "one"), paragraph("p_2", "two")]);
    const draft = replaceDraft(paragraph("p_1", "ONE"));
    const basis = computeProposalMergeBasis(draft, base);

    const merged = replayProposalDraftMerging(base, draft, basis);

    expect(withoutUpdatedAt(merged.nextDocument)).toEqual(withoutUpdatedAt(replayProposalDraft(base, draft).nextDocument));
    expect(merged.draft).toEqual(replayProposalDraft(base, draft).draft);
  });

  it("keeps both edits made at different positions of the same paragraph", () => {
    const base = documentOf([paragraph("p_1", "The cat sat on the mat.")]);
    const draft = replaceDraft(paragraph("p_1", "The dog sat on the mat."));
    const basis = computeProposalMergeBasis(draft, base);
    const current = withParagraph(base, "p_1", "The cat sat on the red mat.");

    const result = replayProposalDraftMerging(current, draft, basis);

    expect(paragraphText(result.nextDocument, "p_1")).toBe("The dog sat on the red mat.");
    expect(result.report.humanEditedUnits).toEqual(["p_1"]);
    expect(result.report.overlaps).toEqual([]);
    expect(isProposalMergeQuiet(result.report)).toBe(false);
  });

  it("keeps both insertions into the same place, the human's first", () => {
    const base = documentOf([paragraph("p_1", "AB")]);
    const draft = replaceDraft(paragraph("p_1", "A[ai]B"));
    const basis = computeProposalMergeBasis(draft, base);
    const current = withParagraph(base, "p_1", "A(human)B");

    const result = replayProposalDraftMerging(current, draft, basis);

    expect(paragraphText(result.nextDocument, "p_1")).toBe("A(human)[ai]B");
    expect(result.report.overlaps).toEqual(["#p_1.children"]);
  });

  it("keeps a human text edit and an AI formula edit in a paragraph with math", () => {
    const base = documentOf([paragraph("p_math", [
      text("値は "),
      { type: "mathInline", id: "m_1", tex: "\\frac{1}{2}", display: "inline" },
      text(" です。"),
    ])]);
    const draft = replaceDraft(paragraph("p_math", [
      text("値は "),
      { type: "mathInline", id: "m_ai", tex: "\\frac{1}{3}", display: "inline" },
      text(" です。"),
    ]));
    const basis = computeProposalMergeBasis(draft, base);
    const current = withParagraph(base, "p_math", [
      text("答えの値は "),
      { type: "mathInline", id: "m_1", tex: "\\frac{1}{2}", display: "inline" },
      text(" です。"),
    ]);

    const result = replayProposalDraftMerging(current, draft, basis);

    expect(paragraphText(result.nextDocument, "p_math")).toBe("答えの値は $\\frac{1}{3}$ です。");
  });

  it.each([
    ["box", (child: ParagraphNode, other: ParagraphNode): SigmaBlock => ({ type: "boxBlock", id: "outer", styleId: "plain", blocks: [child, other] })],
    ["problem", (child: ParagraphNode, other: ParagraphNode): SigmaBlock => ({ type: "problem", id: "outer", tags: [], lead: [], prompt: [child], solution: [other], hints: [] } satisfies ProblemNode)],
    ["list", (child: ParagraphNode, other: ParagraphNode): SigmaBlock => ({
      type: "list",
      id: "outer",
      listType: "bullet",
      items: [
        { type: "listItem", id: child.id, children: child.children },
        { type: "listItem", id: other.id, children: other.children },
      ],
    } satisfies ListNode)],
  ])("merges edits of different children inside a %s", (_label, build) => {
    const base = documentOf([build(paragraph("child_a", "alpha"), paragraph("child_b", "beta"))]);
    const draft = replaceDraft(build(paragraph("child_a", "ALPHA by AI"), paragraph("child_b", "beta")));
    const basis = computeProposalMergeBasis(draft, base);
    const current = parseSigmaDocument(updateBlockInDocument(base, "child_b", (block) => ({
      ...block,
      children: [text("beta by human")],
    } as typeof block)));

    const result = replayProposalDraftMerging(current, draft, basis);

    expect(paragraphText(result.nextDocument, "child_a")).toBe("ALPHA by AI");
    expect(paragraphText(result.nextDocument, "child_b")).toBe("beta by human");
  });

  it("merges a later turn's replacement of the same block against the first base", () => {
    const base = documentOf([paragraph("p_1", "one two")]);
    const draft: AiEditSessionDraft = {
      summary: "2ターン",
      plan: ["2ターン"],
      operations: [
        ...replaceDraft(paragraph("p_1", "ONE two")).operations,
        ...replaceDraft(paragraph("p_1", "ONE TWO")).operations,
      ],
      warnings: [],
    };
    const basis = computeProposalMergeBasis(draft, base);
    const current = withParagraph(base, "p_1", "one two three");

    const result = replayProposalDraftMerging(current, draft, basis);

    expect(paragraphText(result.nextDocument, "p_1")).toBe("ONE TWO three");
  });

  it("fails instead of reviving a block the human deleted", () => {
    const base = documentOf([paragraph("p_1", "one"), paragraph("p_2", "two")]);
    const draft = replaceDraft(paragraph("p_1", "ONE"));
    const basis = computeProposalMergeBasis(draft, base);
    const current = parseSigmaDocument(deleteBlocksFromDocument(base, ["p_1"]));

    expect(() => replayProposalDraftMerging(current, draft, basis)).toThrow();
  });

  it("keeps a block the AI deleted when the human edited it", () => {
    const base = documentOf([paragraph("p_1", "one"), paragraph("p_2", "two")]);
    const draft: AiEditSessionDraft = {
      summary: "削除",
      plan: ["削除"],
      operations: [],
      mutationOperations: [{ operation: "deleteBlocks", summary: "削除", blockIds: ["p_1", "p_2"] }],
      warnings: [],
    };
    const basis = computeProposalMergeBasis(draft, base);
    const current = withParagraph(base, "p_1", "one by human");

    const result = replayProposalDraftMerging(current, draft, basis);

    expect(result.nextDocument.content.map((block) => block.id)).toEqual(["p_1"]);
    expect(paragraphText(result.nextDocument, "p_1")).toBe("one by human");
    expect(result.report.editBeatsDelete).toEqual(["#p_1"]);
  });

  it("leaves the document as it is when the human edited every block the AI deleted", () => {
    const base = documentOf([paragraph("p_1", "one"), paragraph("p_2", "two")]);
    const draft: AiEditSessionDraft = {
      summary: "削除",
      plan: ["削除"],
      operations: [],
      mutationOperations: [{ operation: "deleteBlocks", summary: "削除", blockIds: ["p_1"] }],
      warnings: [],
    };
    const basis = computeProposalMergeBasis(draft, base);
    const current = withParagraph(base, "p_1", "one by human");

    const result = replayProposalDraftMerging(current, draft, basis);

    expect(withoutUpdatedAt(result.nextDocument)).toEqual(withoutUpdatedAt(current));
    expect(result.report.editBeatsDelete).toEqual(["#p_1"]);
  });

  it("adopts the AI side of a unit whose merge repeats an id, and counts it", () => {
    const problem = (prompt: ParagraphNode[], solution: ParagraphNode[]): ProblemNode => ({
      type: "problem", id: "problem", tags: [], lead: [], prompt, solution, hints: [],
    });
    const base = documentOf([problem([paragraph("x", "x"), paragraph("y", "y")], [paragraph("s", "s")])]);
    // The AI moves x from the prompt into the solution; the human edits x where it was.
    const draft = replaceDraft(problem([paragraph("y", "y")], [paragraph("s", "s"), paragraph("x", "x")]));
    const basis = computeProposalMergeBasis(draft, base);
    const current = withParagraph(base, "x", "x by human");

    const result = replayProposalDraftMerging(current, draft, basis);

    expect(result.report.invalidAfterMerge).toBe(1);
    expect(result.report.duplicateIds).toEqual(["x"]);
    expect(findBlock(result.nextDocument, "problem")).toMatchObject({
      prompt: [{ id: "y" }],
      solution: [{ id: "s" }, { id: "x", children: [{ text: "x" }] }],
    });
  });

  it("fails when even the AI side would repeat an id elsewhere in the document", () => {
    const base = documentOf([
      { type: "boxBlock", id: "box", styleId: "plain", blocks: [paragraph("c", "c"), paragraph("d", "d")] },
      paragraph("tail", "tail"),
    ]);
    const draft = replaceDraft({ type: "boxBlock", id: "box", styleId: "plain", blocks: [paragraph("c", "c by AI"), paragraph("d", "d")] });
    const basis = computeProposalMergeBasis(draft, base);
    // The human moved c out of the box.
    const current = documentOf([
      { type: "boxBlock", id: "box", styleId: "plain", blocks: [paragraph("d", "d")] },
      paragraph("tail", "tail"),
      paragraph("c", "c"),
    ]);

    expect(() => replayProposalDraftMerging(current, draft, basis)).toThrow();
  });

  it("merges a shape the human moved with the AI's style change", () => {
    const base = withShapes(ensurePageLayout(documentOf([paragraph("p_1", "one")])), [geoShape("shape_1", 10, 10)]);
    const draft: AiEditSessionDraft = {
      summary: "色",
      plan: ["色"],
      operations: [],
      mutationOperations: [{ operation: "updateOverlayShape", summary: "色", shapeId: "shape_1", patch: { props: { color: "red" } } }],
      warnings: [],
    };
    const basis = computeProposalMergeBasis(draft, base);
    const current = withShapes(base, [{ ...geoShape("shape_1", 10, 10), x: 200 }]);

    const result = replayProposalDraftMerging(current, draft, basis);
    const shape = normalizeOverlaySnapshot(result.nextDocument.pageLayout?.overlay?.overlaySnapshot).shapes[0];

    expect(shape).toMatchObject({ id: "shape_1", x: 200, props: { color: "red" } });
    expect(result.report.humanEditedUnits).toEqual(["shape_1"]);
  });

  it("re-anchors an insertion whose anchor the human deleted after the preceding block", () => {
    const base = documentOf([paragraph("a", "a"), paragraph("b", "b"), paragraph("c", "c")]);
    const draft: AiEditSessionDraft = {
      summary: "挿入",
      plan: ["挿入"],
      operations: [{ operation: "insertAfter", summary: "挿入", targetId: "b", insertedBlock: paragraph("new", "new") }],
      warnings: [],
    };
    const basis = computeProposalMergeBasis(draft, base);
    const current = parseSigmaDocument(deleteBlocksFromDocument(base, ["b"]));

    const result = replayProposalDraftMerging(current, draft, basis);

    expect(result.nextDocument.content.map((block) => block.id)).toEqual(["a", "new", "c"]);
    expect(result.report.anchorRelocated).toBe(1);
  });

  it("still fails an insertion whose anchor and every preceding block are gone", () => {
    const base = documentOf([paragraph("a", "a"), paragraph("b", "b")]);
    const draft: AiEditSessionDraft = {
      summary: "挿入",
      plan: ["挿入"],
      operations: [{ operation: "insertAfter", summary: "挿入", targetId: "a", insertedBlock: paragraph("new", "new") }],
      warnings: [],
    };
    const basis = computeProposalMergeBasis(draft, base);
    const current = parseSigmaDocument(deleteBlocksFromDocument(base, ["a"]));

    expect(() => replayProposalDraftMerging(current, draft, basis)).toThrow();
  });

  it("renames a colliding image asset of an inserted shape", () => {
    const base = ensurePageLayout(documentOf([paragraph("p_1", "one")]));
    const draft: AiEditSessionDraft = {
      summary: "画像",
      plan: ["画像"],
      operations: [{
        operation: "insertOverlayShape",
        summary: "画像",
        targetId: "p_1",
        overlayShape: { id: "shape_image", type: "image", x: 10, y: 10, props: { assetId: "asset_shared", w: 120, h: 80 } },
        assets: { asset_shared: imageAsset("asset_shared", "NEW") },
      }],
      warnings: [],
    };
    const basis = computeProposalMergeBasis(draft, base);
    const current = withAssets(base, { asset_shared: imageAsset("asset_shared", "OLD") });

    const result = replayProposalDraftMerging(current, draft, basis);
    const snapshot = normalizeOverlaySnapshot(result.nextDocument.pageLayout?.overlay?.overlaySnapshot);

    expect(snapshot.assets.asset_shared?.props.src).toBe("sigma-doc-storage://asset-old");
    expect(snapshot.assets["asset_shared-2"]?.props.src).toBe("sigma-doc-storage://asset-new");
    expect(snapshot.shapes.find((shape) => shape.id === "shape_image")).toMatchObject({ props: { assetId: "asset_shared-2" } });
    expect(result.report.reidentified).toBe(1);
  });

  it("keeps a shape the AI deletes when the human edited it", () => {
    const base = withShapes(ensurePageLayout(documentOf([paragraph("p_1", "one")])), [geoShape("shape_1", 10, 10), geoShape("shape_2", 50, 50)]);
    const draft: AiEditSessionDraft = {
      summary: "削除",
      plan: ["削除"],
      operations: [],
      mutationOperations: [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["shape_1", "shape_2"] }],
      warnings: [],
    };
    const basis = computeProposalMergeBasis(draft, base);
    const current = withShapes(base, [{ ...geoShape("shape_1", 10, 10), x: 99 }, geoShape("shape_2", 50, 50)]);

    const result = replayProposalDraftMerging(current, draft, basis);

    expect(normalizeOverlaySnapshot(result.nextDocument.pageLayout?.overlay?.overlaySnapshot).shapes.map((shape) => shape.id))
      .toEqual(["shape_1"]);
    expect(result.report.editBeatsDelete).toEqual(["#shape_1"]);
  });

  it("drops a nested replacement whose target the merged block no longer holds, keeping the recorded order valid", () => {
    const box = (blocks: ParagraphNode[]): BoxBlockNode => ({ type: "boxBlock", id: "box", styleId: "plain", blocks });
    const base = documentOf([box([paragraph("a", "a"), paragraph("b", "b")]), paragraph("tail", "tail")]);
    const draft: AiEditSessionDraft = {
      summary: "編集",
      plan: ["編集"],
      operations: [
        { operation: "replace", summary: "a", targetId: "box", replacementBlock: { ...box([paragraph("a", "a by AI"), paragraph("b", "b")]), title: [text("AI")] } },
        { operation: "replace", summary: "b", targetId: "b", replacementBlock: paragraph("b", "b") },
      ],
      mutationOperations: [{ operation: "deleteBlocks", summary: "d", blockIds: ["tail"] }],
      operationOrder: [
        { kind: "operation", index: 0 },
        { kind: "operation", index: 1 },
        { kind: "mutation", index: 0 },
      ],
      warnings: [],
    };
    const basis = computeProposalMergeBasis(draft, base);
    // The human removed b from the box; the AI's replacement of b changed nothing.
    const current = documentOf([box([paragraph("a", "a")]), paragraph("tail", "tail")]);

    const result = replayProposalDraftMerging(current, draft, basis);

    expect(findBlock(result.nextDocument, "box")).toMatchObject({ title: [{ text: "AI" }], blocks: [{ id: "a", children: [{ text: "a by AI" }] }] });
    expect(findBlock(result.nextDocument, "b")).toBeNull();
    expect(findBlock(result.nextDocument, "tail")).toBeNull();
  });

  it("points a later update of the inserted image at its renamed asset", () => {
    const base = ensurePageLayout(documentOf([paragraph("p_1", "one")]));
    const draft: AiEditSessionDraft = {
      summary: "画像",
      plan: ["画像"],
      operations: [{
        operation: "insertOverlayShape",
        summary: "画像",
        targetId: "p_1",
        overlayShape: { id: "shape_image", type: "image", x: 10, y: 10, props: { assetId: "asset_shared", w: 120, h: 80 } },
        assets: { asset_shared: imageAsset("asset_shared", "NEW") },
      }],
      mutationOperations: [{
        operation: "updateOverlayShape",
        summary: "差し替え",
        shapeId: "shape_image",
        patch: { props: { assetId: "asset_shared", w: 60 } },
        assets: { asset_shared: imageAsset("asset_shared", "NEWER") },
      }],
      warnings: [],
    };
    const basis = computeProposalMergeBasis(draft, base);
    const current = withAssets(base, { asset_shared: imageAsset("asset_shared", "OLD") });

    const result = replayProposalDraftMerging(current, draft, basis);
    const snapshot = normalizeOverlaySnapshot(result.nextDocument.pageLayout?.overlay?.overlaySnapshot);

    expect(snapshot.assets.asset_shared?.props.src).toBe("sigma-doc-storage://asset-old");
    expect(snapshot.assets["asset_shared-2"]?.props.src).toBe("sigma-doc-storage://asset-newer");
    expect(snapshot.shapes.find((shape) => shape.id === "shape_image")).toMatchObject({ props: { assetId: "asset_shared-2", w: 60 } });
  });

  it("never changes the persisted draft or the current document", () => {
    const base = documentOf([paragraph("p_1", "The cat sat.")]);
    const draft = replaceDraft(paragraph("p_1", "The dog sat."));
    const basis = computeProposalMergeBasis(draft, base);
    const current = withParagraph(base, "p_1", "The cat sat down.");
    const snapshots = structuredClone({ draft, basis, current });

    replayProposalDraftMerging(current, draft, basis);

    expect({ draft, basis, current }).toEqual(snapshots);
  });
});

describe("assertAppliedProposalHasRealChanges with a merge basis", () => {
  it("accepts a change the human already made, judged against the base", () => {
    const base = documentOf([paragraph("p_1", "one")]);
    const draft = replaceDraft(paragraph("p_1", "ONE"));
    const basis = computeProposalMergeBasis(draft, base);
    const current = withParagraph(base, "p_1", "ONE");
    const result = replayProposalDraftMerging(current, draft, basis);

    expect(() => assertAppliedProposalHasRealChanges(current, result.nextDocument, draft, basis)).not.toThrow();
    expect(() => assertAppliedProposalHasRealChanges(current, result.nextDocument, draft)).toThrow();
  });

  it("rejects a draft that leaves every target as it was in the base", () => {
    const base = documentOf([paragraph("p_1", "one")]);
    const draft = replaceDraft(paragraph("p_1", "one"));
    const basis = computeProposalMergeBasis(draft, base);
    const current = withParagraph(base, "p_1", "one by human");

    expect(() => assertAppliedProposalHasRealChanges(current, current, draft, basis)).toThrow();
  });
});

function geoShape(id: string, x: number, y: number): OverlayShape {
  return {
    id,
    type: "geo",
    x,
    y,
    props: { w: 80, h: 30, geo: "rectangle", fill: "none", color: "black", labelColor: "black", dash: "solid", size: "m" },
  } as OverlayShape;
}

function withShapes(document: SigmaDocument, shapes: OverlayShape[]): SigmaDocument {
  const layout = ensurePageLayout(document).pageLayout!;
  const snapshot = normalizeOverlaySnapshot(layout.overlay?.overlaySnapshot);
  return parseSigmaDocument({
    ...document,
    pageLayout: { ...layout, overlay: { ...layout.overlay, overlaySnapshot: { ...snapshot, shapes } } },
  });
}

function withAssets(document: SigmaDocument, assets: Record<string, ReturnType<typeof imageAsset>>): SigmaDocument {
  const layout = ensurePageLayout(document).pageLayout!;
  const snapshot = normalizeOverlaySnapshot(layout.overlay?.overlaySnapshot);
  return parseSigmaDocument({
    ...document,
    pageLayout: { ...layout, overlay: { ...layout.overlay, overlaySnapshot: { ...snapshot, assets } } },
  });
}

function imageAsset(id: string, marker: string) {
  return {
    id,
    type: "image" as const,
    props: {
      w: 120,
      h: 80,
      name: `${marker}.png`,
      isAnimated: false as const,
      mimeType: "image/png",
      src: `sigma-doc-storage://asset-${marker.toLowerCase()}`,
      fileSize: 3,
    },
  };
}
