import type { InlineNode } from "@/features/document";

export interface TextBlockFontRun {
  fontSizePt?: number;
  hasContent: boolean;
}

export interface TextBlockTypography {
  minimumFontSizePt: number;
  hasInheritedFontSize: boolean;
}

/**
 * A block's invisible baseline must not be taller than its smallest text run. Actual line boxes
 * still come from browser layout: larger runs, wrapping, and inline math determine each line's
 * height. Unspecified sizes keep the block style's original font, independently of this baseline.
 * These are render values, never paragraph attributes in SigmaDoc.
 */
export function resolveTextBlockTypography(runs: Iterable<TextBlockFontRun>): TextBlockTypography | undefined {
  let minimumFontSizePt = Infinity;
  let hasInheritedFontSize = false;
  for (const run of runs) {
    if (!run.hasContent) continue;
    if (run.fontSizePt !== undefined && Number.isFinite(run.fontSizePt) && run.fontSizePt > 0) {
      minimumFontSizePt = Math.min(minimumFontSizePt, run.fontSizePt);
    } else {
      hasInheritedFontSize = true;
    }
  }
  return Number.isFinite(minimumFontSizePt) ? { minimumFontSizePt, hasInheritedFontSize } : undefined;
}

export function textBlockFontRuns(children: readonly InlineNode[]): TextBlockFontRun[] {
  return children.map((child) => ({
    fontSizePt: child.fontSize,
    hasContent: child.type === "mathInline" || child.text.replace(/[\r\n]/g, "").length > 0,
  }));
}
