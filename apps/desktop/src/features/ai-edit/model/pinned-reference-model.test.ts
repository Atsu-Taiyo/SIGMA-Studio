import { describe, expect, it } from "vitest";

import { getAiEditReferenceKey, type AiEditReference } from "@/lib/ai/ai-edit-reference";
import type { AiEditShapeOnlyPreview } from "@/lib/ai/ai-edit-shape-preview";
import type { SigmaDocument } from "@/types/sigma-doc";

import { setValidationLocale } from "@/lib/ai/validation-locale";

import {
  addAiPinnedReferencePreview,
  planAiPinnedReferenceAddition,
  reconcileAiPinnedReferenceTextRanges,
  textRangeBlockSignature,
  removeAiPinnedReferenceByKey,
  removeAiPinnedReferencePreview,
} from "./pinned-reference-model";

function blockReference(targetId: string): AiEditReference {
  return {
    kind: "block",
    targetId,
    targetType: "paragraph",
    excerpt: targetId,
  };
}

function textSelectionReference(): AiEditReference {
  return {
    kind: "textSelection",
    targetId: "paragraph-1",
    targetType: "paragraph",
    excerpt: "固定した本文",
    selectedText: "固定した本文",
    mathTex: ["x+1"],
    selectedBlockIds: ["paragraph-1"],
    textRange: {
      type: "textRange",
      start: { blockId: "paragraph-1", offset: 0 },
      end: { blockId: "paragraph-1", offset: 6 },
      quote: "固定した本文",
      mathTex: ["x+1"],
    },
  };
}

function documentWithParagraphText(text: string): SigmaDocument {
  return {
    version: "2.0",
    docId: "pinned-reference-test",
    metadata: { title: "pin参照" },
    content: [{
      id: "paragraph-1",
      type: "paragraph",
      children: [{ type: "text", text }],
    }],
    outputProfiles: {},
  } as SigmaDocument;
}

describe("planAiPinnedReferenceAddition", () => {
  it("appends new references in request order", () => {
    const first = blockReference("paragraph-1");
    const second = blockReference("paragraph-2");

    const firstResult = planAiPinnedReferenceAddition([], first);
    const secondResult = planAiPinnedReferenceAddition(firstResult.references, second);

    expect(firstResult.outcome).toBe("added");
    expect(secondResult.outcome).toBe("added");
    expect(secondResult.references).toEqual([first, second]);
  });

  it("checks duplicate before limit and preserves the current array for both rejections", () => {
    const first = blockReference("paragraph-1");
    const second = blockReference("paragraph-2");
    const fullReferences = [first, second];

    const duplicate = planAiPinnedReferenceAddition(fullReferences, first, 2);
    const limited = planAiPinnedReferenceAddition(
      fullReferences,
      blockReference("paragraph-3"),
      2,
    );

    expect(duplicate.outcome).toBe("duplicate");
    expect(duplicate.references).toBe(fullReferences);
    expect(limited.outcome).toBe("limit");
    expect(limited.references).toBe(fullReferences);
  });
});

describe("pinned reference previews", () => {
  it("keeps the first preview instead of replacing it", () => {
    const firstPreview: AiEditShapeOnlyPreview = { svg: "<svg>first</svg>", width: 100, height: 80 };
    const laterPreview: AiEditShapeOnlyPreview = { svg: "<svg>later</svg>", width: 200, height: 160 };
    const firstMap = addAiPinnedReferencePreview(new Map(), "shape-reference", firstPreview);
    const duplicateMap = addAiPinnedReferencePreview(firstMap, "shape-reference", laterPreview);

    expect(duplicateMap).toBe(firstMap);
    expect(duplicateMap.get("shape-reference")).toBe(firstPreview);
  });

  it("removes only the requested reference and preview", () => {
    const first = blockReference("paragraph-1");
    const second = blockReference("paragraph-2");
    const firstKey = getAiEditReferenceKey(first);
    const secondKey = getAiEditReferenceKey(second);
    const firstPreview: AiEditShapeOnlyPreview = { svg: "<svg>first</svg>", width: 100, height: 80 };
    const secondPreview: AiEditShapeOnlyPreview = { svg: "<svg>second</svg>", width: 100, height: 80 };
    const previews = new Map([
      [firstKey, firstPreview],
      [secondKey, secondPreview],
    ]);

    expect(removeAiPinnedReferenceByKey([first, second], firstKey)).toEqual([second]);
    expect(removeAiPinnedReferencePreview(previews, firstKey)).toEqual(new Map([
      [secondKey, secondPreview],
    ]));
    expect(removeAiPinnedReferencePreview(previews, "missing")).toBe(previews);
  });
});

describe("reconcileAiPinnedReferenceTextRanges", () => {
  it("records the initial signature without replacing the reference array", () => {
    const reference = textSelectionReference();
    const references = [reference];
    const result = reconcileAiPinnedReferenceTextRanges(
      references,
      new Map(),
      documentWithParagraphText("固定した本文"),
    );

    expect(result.changed).toBe(false);
    expect(result.references).toBe(references);
    expect(result.signatures.get(getAiEditReferenceKey(reference))).toBeDefined();
  });

  it("invalidates only textRange after its block content changes", () => {
    const reference = textSelectionReference();
    const stableDocument = documentWithParagraphText("固定した本文");
    const initial = reconcileAiPinnedReferenceTextRanges([reference], new Map(), stableDocument);
    const changed = reconcileAiPinnedReferenceTextRanges(
      initial.references,
      initial.signatures,
      documentWithParagraphText("編集された本文"),
    );

    expect(changed.changed).toBe(true);
    expect(changed.references).toEqual([{
      ...reference,
      textRange: undefined,
    }]);
    expect(changed.references[0]).toMatchObject({
      selectedText: "固定した本文",
      mathTex: ["x+1"],
      selectedBlockIds: ["paragraph-1"],
    });
    expect(changed.signatures.has(getAiEditReferenceKey(reference))).toBe(false);
  });

  it("does not invalidate a text range when unrelated document metadata changes", () => {
    const reference = textSelectionReference();
    const stableDocument = documentWithParagraphText("固定した本文");
    const initial = reconcileAiPinnedReferenceTextRanges([reference], new Map(), stableDocument);
    const metadataOnlyChange = {
      ...stableDocument,
      metadata: { ...stableDocument.metadata, title: "別タイトル" },
    };
    const reconciled = reconcileAiPinnedReferenceTextRanges(
      initial.references,
      initial.signatures,
      metadataOnlyChange,
    );

    expect(reconciled.changed).toBe(false);
    expect(reconciled.references).toBe(initial.references);
  });

  it("clears stale signatures when no pinned references remain", () => {
    const result = reconcileAiPinnedReferenceTextRanges(
      [],
      new Map([["stale-reference", "signature"]]),
      documentWithParagraphText("固定した本文"),
    );

    expect(result.changed).toBe(false);
    expect(result.references).toEqual([]);
    expect(result.signatures.size).toBe(0);
  });
});

/**
 * 署名は**内容が変わったか**を見るためのもの。ラベル (「問題文」「解答」…) を
 * 訳文から作ると、本文を 1 文字も触っていないのに **UI 言語を切り替えただけで
 * 署名が変わり、pin した参照が黙って外れる**。
 *
 * これは本 i18n 移行で 4 度目の「翻訳文字列を機械可読な値として使う」欠陥だった。
 */
describe("textRangeBlockSignature", () => {
  function documentWithProblem(): SigmaDocument {
    return {
      version: "2.0",
      docId: "signature-locale-test",
      metadata: { title: "signature" },
      content: [{
        id: "problem-1",
        type: "problem",
        tags: [],
        lead: [{ id: "lead-1", type: "paragraph", children: [{ type: "text", text: "導入" }] }],
        prompt: [{ id: "prompt-1", type: "paragraph", children: [{ type: "text", text: "本文" }] }],
        answer: { type: "math", expected: "x=1" },
        solution: [],
        hints: [],
      }],
      outputProfiles: {},
    } as unknown as SigmaDocument;
  }

  const range = {
    start: { blockId: "problem-1", offset: 0 },
    end: { blockId: "problem-1", offset: 2 },
  } as never;

  it("does not change when only the UI language changes", () => {
    const document = documentWithProblem();
    try {
      setValidationLocale("ja");
      const ja = textRangeBlockSignature(document, range);
      setValidationLocale("en");
      const en = textRangeBlockSignature(document, range);
      expect(en).toBe(ja);
    } finally {
      setValidationLocale(null);
    }
  });

  it("still changes when the body actually changes", () => {
    const before = textRangeBlockSignature(documentWithProblem(), range);
    const edited = documentWithProblem();
    (edited.content[0] as unknown as { prompt: { children: { text: string }[] }[] })
      .prompt[0].children[0].text = "書き換えた";
    expect(textRangeBlockSignature(edited, range)).not.toBe(before);
  });
});