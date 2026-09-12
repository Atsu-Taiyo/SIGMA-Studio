import { type AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import type { ParagraphNode, SigmaDocument } from "@/features/document";

export const SOLE_BLOCK_ID = "problem_complex_square_product_range";

export function deleteBlockDraft(blockId: string = SOLE_BLOCK_ID): AiEditSessionDraft {
  return {
    summary: "対象ブロックを削除しました。",
    plan: ["対象ブロックを削除しました。"],
    operations: [],
    warnings: [],
    mutationOperations: [
      {
        operation: "deleteBlocks",
        summary: "対象ブロックを削除しました。",
        blockIds: [blockId],
      },
    ],
  };
}

export function wrapBlocksInColumnsDraft(blockIds: string[]): AiEditSessionDraft {
  return {
    summary: "選択範囲を2段組みにしました。",
    plan: [],
    operations: [],
    warnings: [],
    mutationOperations: [{
      operation: "wrapBlocksInColumns",
      summary: "選択範囲を2段組みにしました。",
      blockIds,
      columnCount: 2,
      columnGapMm: 8,
    }],
  };
}

export function paragraphDocument(ids: string[]): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_column_range_test",
    metadata: { title: "Column range test" },
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    content: ids.map((id) => ({
      type: "paragraph" as const,
      id,
      children: [{ type: "text" as const, text: id }],
    })),
  };
}

export const P_YOTTE_ID = "p_yotte";

export const P_SOURCE_NOTE_ID = "p_source_note";

export function replaceParagraphDraft(blockId: string, text: string): AiEditSessionDraft {
  return {
    summary: `${blockId}を書き換えました。`,
    plan: [`${blockId}を書き換えました。`],
    operations: [{
      operation: "replace",
      summary: `${blockId}を書き換えました。`,
      targetId: blockId,
      replacementBlock: { type: "paragraph", id: blockId, children: [{ type: "text", text }] } satisfies ParagraphNode,
    }],
    warnings: [],
  };
}
