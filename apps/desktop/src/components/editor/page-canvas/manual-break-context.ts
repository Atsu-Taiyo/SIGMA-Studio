import type { SigmaDocument } from "@/features/document";
import { findContainingBoxBlock, findContainingLayoutSection } from "@/lib/document-tree";

import { getLayoutSectionColumnCount } from "./render-units";

/** Independent local columns do not accept manual breaks, inside or outside boxes. */
export function canUseManualBreakAtBlock(document: SigmaDocument, blockId: string): boolean {
  if (findContainingBoxBlock(document, blockId)) return false;
  const section = findContainingLayoutSection(document, blockId);
  return !section || getLayoutSectionColumnCount(section) <= 1;
}

export function canInsertManualBreakAtBlock(document: SigmaDocument, blockId: string): boolean {
  return canUseManualBreakAtBlock(document, blockId);
}
