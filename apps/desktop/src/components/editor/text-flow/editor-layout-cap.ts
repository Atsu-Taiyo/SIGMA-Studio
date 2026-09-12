import type { InlineNode } from "@/features/document";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import {
  capInlineNodesForEditorLayout as capInlineNodesForEditorLayoutModel,
  getInlineNodesEditorLength,
  MAX_TEXT_FLOW_EDITOR_LAYOUT_CHARS,
} from "@/features/text-editing";

export {
  MAX_TEXT_FLOW_EDITOR_LAYOUT_CHARS,
  getInlineNodesEditorLength,
  isOversizedLeafTextFlowBlock,
} from "@/features/text-editing";

export function oversizedEditorLayoutPlaceholder(charCount: number): string {
  return createCurrentLocaleTranslator("editor")("body.oversizedParagraph", {
    count: charCount.toLocaleString(),
  });
}

export function capInlineNodesForEditorLayout(
  children: readonly InlineNode[],
): { children: readonly InlineNode[]; originalLength: number; capped: boolean } {
  const originalLength = getInlineNodesEditorLength(children);
  if (originalLength <= MAX_TEXT_FLOW_EDITOR_LAYOUT_CHARS) {
    return { children, originalLength, capped: false };
  }
  return capInlineNodesForEditorLayoutModel(children, oversizedEditorLayoutPlaceholder(originalLength));
}
