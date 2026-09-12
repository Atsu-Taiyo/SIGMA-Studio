import { describe, expect, it } from "vitest";

import {
  capAiEditTurnReferences,
  collectAiEditInsertionCandidates,
  createOverlaySelectionAiEditReference,
  createTextSelectionAiEditReference,
  formatAiEditReferenceForPrompt,
  formatAiEditReferencesForPrompt,
  formatReferenceSnippet,
  getAiEditReferenceKey,
  getReferenceDisplayLabel,
  isImplicitAiEditReferenceSuppressed,
  MAX_AI_EDIT_REFERENCES,
  resolveAiEditTextRangeBlockIds,
  resolveAiEditTextRangeBlockSpans,
  type AiEditBlockReference,
  type AiEditInlineMathReference,
  type AiEditReference,
  type AiEditTextSelectionReference,
} from "@/lib/ai/ai-edit-reference";
import type { SigmaDocument } from "@/types/sigma-doc";

const multiBlockDocument = {
  version: "2.0",
  docId: "doc-multi-selection",
  metadata: { title: "複数選択" },
  content: [
    { id: "p_1", type: "paragraph", children: [{ type: "text", text: "一" }] },
    { id: "p_2", type: "paragraph", children: [{ type: "text", text: "二" }] },
    { id: "p_3", type: "paragraph", children: [{ type: "text", text: "三" }] },
  ],
  outputProfiles: {},
} as SigmaDocument;

describe("formatReferenceSnippet", () => {
  it("shows the first and last three characters joined by ellipsis", () => {
    expect(formatReferenceSnippet("二次関数の最大値を求めよ")).toBe("二次関...求めよ");
  });

  it("returns short text unchanged", () => {
    expect(formatReferenceSnippet("abc")).toBe("abc");
  });

  it("collapses whitespace before slicing", () => {
    expect(formatReferenceSnippet("  あいう   えおか  ")).toBe("あいう...えおか");
  });
});

function makeTextSelectionReference(overrides: Partial<AiEditTextSelectionReference> = {}): AiEditTextSelectionReference {
  return {
    kind: "textSelection",
    targetId: "p_1",
    targetType: "paragraph",
    excerpt: "二次関数の最大値を求めよ",
    selectedText: "二次関数の最大値を求めよ",
    mathTex: [],
    ...overrides,
  };
}

function makeBlockReference(overrides: Partial<AiEditBlockReference> = {}): AiEditBlockReference {
  return {
    kind: "block",
    targetId: "p_2",
    targetType: "paragraph",
    excerpt: "対象段落の抜粋",
    ...overrides,
  };
}

describe("formatAiEditReferencesForPrompt", () => {
  it("falls back to the whole-selected-block wording for zero references", () => {
    expect(formatAiEditReferencesForPrompt([])).toBe("参照対象: 選択中ブロック全体");
  });

  it("formats a single reference identically to the single-reference formatter", () => {
    const reference = makeTextSelectionReference();
    expect(formatAiEditReferencesForPrompt([reference])).toBe(formatAiEditReferenceForPrompt(reference));
  });

  it("joins multiple references with 参照 i/N headings", () => {
    const first = makeTextSelectionReference();
    const second = makeBlockReference();
    const formatted = formatAiEditReferencesForPrompt([first, second]);

    expect(formatted).toContain("参照 1/2:");
    expect(formatted).toContain("参照 2/2:");
    expect(formatted).toContain("選択テキスト: 二次関数の最大値を求めよ");
    expect(formatted).toContain("抜粋: 対象段落の抜粋");
    expect(formatted.indexOf("参照 1/2:")).toBeLessThan(formatted.indexOf("参照 2/2:"));
  });

  it("includes exact offsets and every selected block id", () => {
    const formatted = formatAiEditReferenceForPrompt(makeTextSelectionReference({
      selectedBlockIds: ["p_1", "p_2"],
      textRange: {
        type: "textRange",
        start: { blockId: "p_1", offset: 1 },
        end: { blockId: "p_3", offset: 0 },
        quote: "一\n二",
      },
    }));

    expect(formatted).toContain("選択範囲: p_1@1 → p_3@0");
    expect(formatted).toContain("選択対象ブロックID: p_1, p_2");
  });
});

describe("createOverlaySelectionAiEditReference", () => {
  const selectedShape = {
    id: "shape_whiteboard_1",
    type: "geo" as const,
    x: 120,
    y: 80,
    anchor: { type: "page" as const },
    props: {
      w: 160,
      h: 90,
      geo: "rectangle" as const,
      fill: "none" as const,
      color: "#111111",
      fillColor: "#ffffff",
      labelColor: "#111111",
      dash: "solid" as const,
      size: "m" as const,
    },
  };

  it("targets the selected shape when a whiteboard has no body block", () => {
    const whiteboardDocument = {
      version: "2.0",
      docId: "doc-whiteboard",
      metadata: { title: "ホワイトボード" },
      content: [],
      pageLayout: {
        preset: "whiteboard",
        orientation: "portrait",
        pageSize: { widthMm: 210, heightMm: 297 },
        marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
        flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
      },
      outputProfiles: {
        student: {},
        teacher: {},
        answerBook: {},
      },
    } as SigmaDocument;

    const reference = createOverlaySelectionAiEditReference({
      document: whiteboardDocument,
      targetId: null,
      selectedShapeIds: [selectedShape.id],
      shapes: [selectedShape],
      assets: {},
    });

    expect(reference).toMatchObject({
      kind: "block",
      targetId: selectedShape.id,
      targetType: "overlayShape:geo",
      excerpt: "図形1件",
      overlaySelection: {
        selectedShapeIds: [selectedShape.id],
        shapes: [selectedShape],
      },
    });
    expect(formatAiEditReferenceForPrompt(reference)).toContain("参照対象: overlayShape");
    expect(formatAiEditReferenceForPrompt(reference)).toContain(`対象図形ID: ${selectedShape.id}`);
  });

  it("keeps the nearby body block as the placement target on a paginated document", () => {
    expect(createOverlaySelectionAiEditReference({
      document: multiBlockDocument,
      targetId: "p_2",
      selectedShapeIds: [selectedShape.id],
      shapes: [selectedShape],
      assets: {},
    })).toMatchObject({
      kind: "block",
      targetId: "p_2",
      targetType: "paragraph",
      excerpt: "二",
      overlaySelection: {
        selectedShapeIds: [selectedShape.id],
      },
    });
  });
});

describe("resolveAiEditTextRangeBlockIds", () => {
  it("resolves a multi-block selection and excludes an end block at offset 0", () => {
    expect(resolveAiEditTextRangeBlockIds(multiBlockDocument, {
      type: "textRange",
      start: { blockId: "p_1", offset: 0 },
      end: { blockId: "p_3", offset: 0 },
      quote: "一\n二",
    })).toEqual(["p_1", "p_2"]);
  });

  it("normalizes a reverse selection to document order", () => {
    expect(resolveAiEditTextRangeBlockIds(multiBlockDocument, {
      type: "textRange",
      start: { blockId: "p_3", offset: 0 },
      end: { blockId: "p_1", offset: 0 },
      quote: "一\n二",
    })).toEqual(["p_1", "p_2"]);
  });

  it("persists the resolved block ids when creating a text-selection reference", () => {
    const reference = createTextSelectionAiEditReference({
      document: multiBlockDocument,
      targetId: "p_1",
      selectedText: "一\n二",
      textRange: {
        type: "textRange",
        start: { blockId: "p_1", offset: 0 },
        end: { blockId: "p_3", offset: 0 },
        quote: "一\n二",
      },
    });

    expect(reference?.selectedBlockIds).toEqual(["p_1", "p_2"]);
  });

  it("keeps exact boundary offsets when resolving shimmer spans", () => {
    const document = {
      ...multiBlockDocument,
      content: [
        { id: "p_1", type: "paragraph", children: [{ type: "text", text: "abc" }] },
        { id: "p_2", type: "paragraph", children: [{ type: "text", text: "def" }] },
      ],
    } as SigmaDocument;

    expect(resolveAiEditTextRangeBlockSpans(document, {
      type: "textRange",
      start: { blockId: "p_1", offset: 1 },
      end: { blockId: "p_2", offset: 2 },
      quote: "bc\nde",
    })).toEqual([
      { blockId: "p_1", from: 1, to: 3 },
      { blockId: "p_2", from: 0, to: 2 },
    ]);
  });
});

describe("getAiEditReferenceKey", () => {
  it("returns the same key for two equivalent references (dedupe)", () => {
    expect(getAiEditReferenceKey(makeTextSelectionReference())).toBe(getAiEditReferenceKey(makeTextSelectionReference()));
  });

  it("distinguishes references by kind, target, and selection detail", () => {
    const base = makeTextSelectionReference();
    const otherTarget = makeTextSelectionReference({ targetId: "p_9" });
    const otherSelection = makeTextSelectionReference({ selectedText: "別の選択テキスト" });
    const blockOnSameTarget = makeBlockReference({ targetId: base.targetId });
    const inlineMath: AiEditInlineMathReference = {
      kind: "inlineMath",
      targetId: base.targetId,
      targetType: "paragraph",
      excerpt: "x^2",
      mathInlineId: "math_1",
      tex: "x^2",
    };

    const keys = [base, otherTarget, otherSelection, blockOnSameTarget, inlineMath].map(getAiEditReferenceKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("distinguishes textSelection references by textRange offsets", () => {
    const rangeA = makeTextSelectionReference({
      textRange: {
        type: "textRange",
        start: { blockId: "p_1", offset: 0 },
        end: { blockId: "p_1", offset: 4 },
        quote: "二次関数",
      },
    });
    const rangeB = makeTextSelectionReference({
      textRange: {
        type: "textRange",
        start: { blockId: "p_1", offset: 6 },
        end: { blockId: "p_1", offset: 10 },
        quote: "二次関数",
      },
    });
    expect(getAiEditReferenceKey(rangeA)).not.toBe(getAiEditReferenceKey(rangeB));
  });
});

describe("getReferenceDisplayLabel", () => {
  it("uses the selected text snippet instead of a block-type label", () => {
    const reference: AiEditTextSelectionReference = {
      kind: "textSelection",
      targetId: "p_1",
      targetType: "paragraph",
      excerpt: "二次関数の最大値を求めよ",
      selectedText: "二次関数の最大値を求めよ",
      mathTex: [],
    };
    expect(getReferenceDisplayLabel(reference)).toBe("二次関...求めよ");
  });

  it("uses the block excerpt snippet for block references", () => {
    const reference: AiEditBlockReference = {
      kind: "block",
      targetId: "p_1",
      targetType: "paragraph",
      excerpt: "この段落には長い説明文が入っています",
    };
    expect(getReferenceDisplayLabel(reference)).toBe("この段...います");
  });
});

describe("isImplicitAiEditReferenceSuppressed", () => {
  it("does not suppress when there is no implicit reference", () => {
    expect(isImplicitAiEditReferenceSuppressed(null, [makeBlockReference()])).toBe(false);
  });

  it("does not suppress a block implicit reference when nothing is pinned", () => {
    expect(isImplicitAiEditReferenceSuppressed(makeBlockReference(), [])).toBe(false);
  });

  it("suppresses a block implicit reference on the same target as a pin", () => {
    const pinned = makeBlockReference({ targetId: "p_1" });
    const implicit = makeBlockReference({ targetId: "p_1" });
    expect(isImplicitAiEditReferenceSuppressed(implicit, [pinned])).toBe(true);
  });

  it("suppresses ANY block implicit reference once something is pinned, even a different target", () => {
    const pinned = makeBlockReference({ targetId: "p_9" });
    const implicit = makeBlockReference({ targetId: "p_1" });
    expect(isImplicitAiEditReferenceSuppressed(implicit, [pinned])).toBe(true);
  });

  // Regression: a live text selection inside an already-pinned block used to be
  // dropped from turnReferences entirely (the pinned block's targetId matched,
  // so the old targetId-based suppression rule fired for every kind, not just
  // "block"). It must survive as a distinct, separate context.
  it("does NOT suppress a live textSelection implicit reference inside a pinned block", () => {
    const pinnedBlock = makeBlockReference({ targetId: "p_1" });
    const liveSelectionInSameBlock = makeTextSelectionReference({ targetId: "p_1", selectedText: "部分選択" });
    expect(isImplicitAiEditReferenceSuppressed(liveSelectionInSameBlock, [pinnedBlock])).toBe(false);
  });

  it("does NOT suppress a live inlineMath implicit reference inside a pinned block", () => {
    const pinnedBlock = makeBlockReference({ targetId: "p_1" });
    const inlineMath: AiEditInlineMathReference = {
      kind: "inlineMath",
      targetId: "p_1",
      targetType: "paragraph",
      excerpt: "x^2",
      mathInlineId: "math_1",
      tex: "x^2",
    };
    expect(isImplicitAiEditReferenceSuppressed(inlineMath, [pinnedBlock])).toBe(false);
  });

  it("suppresses a textSelection implicit reference that exactly duplicates a pin (same key)", () => {
    const pinned = makeTextSelectionReference({ targetId: "p_1", selectedText: "同じ選択" });
    const implicit = makeTextSelectionReference({ targetId: "p_1", selectedText: "同じ選択" });
    expect(isImplicitAiEditReferenceSuppressed(implicit, [pinned])).toBe(true);
  });

  it("does not suppress when overlay shapes are selected, even on the same target as a pin", () => {
    const pinned = makeBlockReference({ targetId: "p_1" });
    const implicitWithOverlay = makeBlockReference({
      targetId: "p_1",
      overlaySelection: { selectedShapeIds: ["shape_1"], shapes: [], assets: {} },
    });
    expect(isImplicitAiEditReferenceSuppressed(implicitWithOverlay, [pinned])).toBe(false);
  });

  it("suppresses an overlay implicit reference only when the same shape snapshot is pinned", () => {
    const pinned = makeBlockReference({
      targetId: "p_1",
      overlaySelection: { selectedShapeIds: ["shape_1"], shapes: [], assets: {} },
    });
    const sameOverlay = makeBlockReference({
      targetId: "p_1",
      overlaySelection: { selectedShapeIds: ["shape_1"], shapes: [], assets: {} },
    });
    const differentOverlay = makeBlockReference({
      targetId: "p_1",
      overlaySelection: { selectedShapeIds: ["shape_2"], shapes: [], assets: {} },
    });

    expect(isImplicitAiEditReferenceSuppressed(sameOverlay, [pinned])).toBe(true);
    expect(isImplicitAiEditReferenceSuppressed(differentOverlay, [pinned])).toBe(false);
  });

  it("suppresses the same overlay snapshot even when its fallback target block differs", () => {
    const pinned = makeBlockReference({
      targetId: "p_1",
      overlaySelection: { selectedShapeIds: ["shape_2", "shape_1"], shapes: [], assets: {} },
    });
    const implicit = makeBlockReference({
      targetId: "p_9",
      overlaySelection: { selectedShapeIds: ["shape_1", "shape_2"], shapes: [], assets: {} },
    });

    expect(isImplicitAiEditReferenceSuppressed(implicit, [pinned])).toBe(true);
  });
});

describe("capAiEditTurnReferences", () => {
  it("leaves a references array under the cap untouched", () => {
    const references = [makeBlockReference(), makeTextSelectionReference()];
    expect(capAiEditTurnReferences(references)).toEqual(references);
  });

  it("clamps to MAX_AI_EDIT_REFERENCES, keeping earlier (pinned-priority) entries first", () => {
    const references: AiEditReference[] = Array.from({ length: MAX_AI_EDIT_REFERENCES + 1 }, (_, index) =>
      makeBlockReference({ targetId: `p_${index}` }));
    const capped = capAiEditTurnReferences(references);
    expect(capped).toHaveLength(MAX_AI_EDIT_REFERENCES);
    expect(capped.map((reference) => reference.targetId)).toEqual(
      references.slice(0, MAX_AI_EDIT_REFERENCES).map((reference) => reference.targetId),
    );
  });
});

describe("formatAiEditReferenceForPrompt", () => {
  it("identifies the selected-shape thumbnail as a derived preview and keeps ids/anchors authoritative", () => {
    const prompt = formatAiEditReferenceForPrompt({
      kind: "block",
      targetId: "p_1",
      targetType: "paragraph",
      excerpt: "図形の挿入先",
      overlaySelection: {
        selectedShapeIds: ["shape_1"],
        shapes: [{
          id: "shape_1",
          type: "geo",
          x: 10,
          y: 20,
          props: {
            w: 80,
            h: 60,
            geo: "rectangle",
            fill: "none",
            color: "#111111",
            fillColor: "#ffffff",
            labelColor: "#111111",
            dash: "solid",
            size: "m",
          },
        }],
        assets: {},
      },
    });

    expect(prompt).toContain("選択図形プレビュー-*.png");
    expect(prompt).toContain("画像として重複挿入せず");
    expect(prompt).toContain("selectedShapeIds");
    expect(prompt).toContain("対象ブロックID/anchorを正本");
    expect(prompt).toContain('"shape_1"');
  });
});

describe("collectAiEditInsertionCandidates", () => {
  it("exposes an estimated page rect so the AI can supply absolute insert coordinates", () => {
    const candidates = collectAiEditInsertionCandidates(multiBlockDocument);
    const first = candidates.find((candidate) => candidate.id === multiBlockDocument.content[0].id);

    expect(first?.rect).toMatchObject({
      pageIndex: 0,
      estimated: true,
    });
    expect(first?.rect?.left).toBeGreaterThan(0);
    expect(first?.rect?.top).toBeGreaterThan(0);
    expect(first?.rect?.width).toBeGreaterThan(0);
    expect(first?.rect?.height).toBeGreaterThan(0);
  });

  // 図形挿入の実アンカーは問題エリアの子ブロック側なので、rect が無いと
  // AI は絶対座標を決められない (絶対座標APIなのに基準が無い状態になる)。
  it("exposes an estimated rect for problem area candidates too", () => {
    const document = {
      ...multiBlockDocument,
      content: [{
        id: "prob_1",
        type: "problem",
        tags: [],
        lead: [],
        prompt: [{ id: "prob_1_prompt", type: "paragraph", children: [{ type: "text", text: "問題文" }] }],
        answer: { type: "math", expected: "x=1" },
        solution: [],
        hints: [],
      }],
    } as unknown as SigmaDocument;

    const promptCandidate = collectAiEditInsertionCandidates(document)
      .find((candidate) => candidate.id === "prob_1_prompt");

    expect(promptCandidate?.scope).toBe("problemArea");
    expect(promptCandidate?.rect).toMatchObject({ pageIndex: 0, estimated: true });
    expect(promptCandidate?.rect?.top).toBeGreaterThan(0);
  });
});
