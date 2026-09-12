import {
  createBlockAiEditReference,
  createInlineMathAiEditReference,
  createTextSelectionAiEditReference,
  type AiEditReference,
} from "@/lib/ai/ai-edit-reference";
import type {
  SigmaCommentAnchor,
  SigmaDocument,
} from "@/features/document";

/**
 * コメントのanchorからAI実行用の対象ブロックIDと参照コンテキストを導出する。
 * overlay系anchorはブロックに紐づかないためselectedId/referenceともnull。
 */
export function buildCommentAiReference(
  document: SigmaDocument,
  anchor: SigmaCommentAnchor,
): { selectedId: string | null; reference: AiEditReference | null } {
  if (anchor.type === "textRange") {
    const targetId = anchor.start.blockId;
    return {
      selectedId: targetId,
      reference: createTextSelectionAiEditReference({
        document,
        targetId,
        selectedText: anchor.quote,
        mathTex: anchor.mathTex ?? [],
        textRange: anchor,
      }),
    };
  }
  if (anchor.type === "inlineMath") {
    return {
      selectedId: anchor.blockId,
      reference: createInlineMathAiEditReference({
        document,
        targetId: anchor.blockId,
        mathInlineId: anchor.mathInlineId,
        tex: anchor.tex ?? "",
      }),
    };
  }
  if (anchor.type === "block") {
    return {
      selectedId: anchor.blockId,
      reference: createBlockAiEditReference(document, anchor.blockId),
    };
  }
  return { selectedId: null, reference: null };
}
