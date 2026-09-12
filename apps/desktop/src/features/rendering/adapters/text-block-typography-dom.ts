import type { InlineNode } from "@/features/document";
import { resolveTextBlockTypography, textBlockFontRuns, type TextBlockTypography } from "@/features/rendering/core";

export const TEXT_BLOCK_FONT_SIZE_VARIABLE = "--sigma-doc-text-line-font-size";
export const INHERITED_TEXT_FONT_ATTRIBUTE = "data-sigma-doc-inherited-font";

export function textBlockTypographyVars(typography: TextBlockTypography | undefined): Record<string, string> | undefined {
  if (!typography) return undefined;
  const size = `${typography.minimumFontSizePt}pt`;
  return {
    [TEXT_BLOCK_FONT_SIZE_VARIABLE]: typography.hasInheritedFontSize
      ? `min(var(--sigma-doc-text-base-font-size, var(--editor-font-size, 12pt)), ${size})`
      : size,
  };
}

export function inlineNodesTextBlockTypographyVars(children: readonly InlineNode[]): Record<string, string> | undefined {
  return textBlockTypographyVars(resolveTextBlockTypography(textBlockFontRuns(children)));
}
