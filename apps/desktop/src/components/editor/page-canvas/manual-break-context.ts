import type { SigmaDocument } from "@/features/document";
import { isManualBreakAllowedAtBlock } from "@/features/text-editing";

/**
 * 手動改ページ (改段) は本文の流れのどこにでも置ける (引用・箱・問題・1段組の段組みの中も)。
 * 独立した複数段の段組みの中だけは、段の所属を `columnStartIds` が決めるので置けない。
 */
export function canUseManualBreakAtBlock(document: SigmaDocument, blockId: string): boolean {
  return isManualBreakAllowedAtBlock(document.content, blockId);
}

export function canInsertManualBreakAtBlock(document: SigmaDocument, blockId: string): boolean {
  return canUseManualBreakAtBlock(document, blockId);
}
