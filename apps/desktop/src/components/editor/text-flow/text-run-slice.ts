import type { Slice } from "@tiptap/pm/model";

import { createId } from "@/lib/id";
import type { TiptapNode } from "@/lib/tiptap-adapter";
import type { TextFlowBlock } from "@/features/text-editing";

import { tiptapToTextFlow } from "./tiptap-document-adapter";

/**
 * 1 エディタ内の PM slice を SigmaDoc 本文ブロックへ戻す。
 *
 * チャンクを跨ぐコピー / 削除は、各エディタの部分範囲をこれでブロック化し、文書順に連結する。
 * PM スキーマは pagination (改ページ / keepTogether / keepWithNext) を持たないので、
 * 選択の外に残るブロックのヒントを保つ経路は通常の onUpdate と同じく `previousBlocks`
 * から id で引き継ぐ。
 */
export function sliceToTextFlowBlocks(
  slice: Slice,
  previousBlocks: TextFlowBlock[] = [],
): TextFlowBlock[] {
  const blockNodes: TiptapNode[] = [];
  const inlineNodes: TiptapNode[] = [];

  slice.content.forEach((node) => {
    const json = node.toJSON() as TiptapNode;
    if (node.isBlock) {
      blockNodes.push(json);
      return;
    }
    inlineNodes.push(json);
  });

  if (blockNodes.length > 0) {
    // A slice intentionally omits blocks outside its range. Carry fields for matching ids,
    // but do not synthesize owners that belong outside the slice.
    return tiptapToTextFlow(
      { type: "doc", content: blockNodes },
      previousBlocks,
      { retainDeletedManualBreakOwners: false },
    );
  }

  if (inlineNodes.length === 0) {
    return [];
  }

  return tiptapToTextFlow({
    type: "doc",
    content: [{
      type: "paragraph",
      attrs: {
        sigmaDocId: createId("p"),
        sigmaDocType: "paragraph",
      },
      content: inlineNodes,
    }],
  });
}

export function emptyTextFlowParagraph(): TextFlowBlock {
  return {
    type: "paragraph",
    id: createId("p"),
    children: [],
  };
}

/**
 * literal paste (Cmd+Shift+V) のプレーンテキストを段落列へ。単一エディタの
 * `view.pasteText` (PM の parseText) と同じ規則で、連続改行は 1 つの段落境界に畳む。
 */
export function plainTextToTextFlowParagraphs(text: string): TextFlowBlock[] {
  return text.split(/(?:\r\n?|\n)+/).map((line) => ({
    type: "paragraph",
    id: createId("p"),
    children: line ? [{ type: "text", text: line }] : [],
  }));
}
