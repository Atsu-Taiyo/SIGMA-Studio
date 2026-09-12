import type { ColumnRule } from "@/features/document";

/** Shared read-only geometry for React, ProseMirror and output column grids.
 * Column membership and normalized widths are projected from SigmaDoc by the caller.
 */
export function createIndependentColumnLayout(widths: readonly number[], gap: string) {
  const total = widths.reduce((sum, width) => sum + width, 0);
  let precedingWidth = 0;
  return {
    gridTemplateColumns: widths.map(width => `minmax(0, ${width}fr)`).join(" "),
    columnGap: gap,
    dividers: widths.slice(0, -1).map((width, index) => {
      precedingWidth += width;
      const fraction = precedingWidth / total;
      return {
        index,
        left: `calc(${fraction * 100}% + ${index + 0.5 - fraction * (widths.length - 1)} * ${gap})`,
      };
    }),
  };
}

/** Read-only separator appearance shared by every output adapter. */
export function getColumnRulePresentation(rule?: ColumnRule) {
  return {
    style: rule?.style ?? "none",
    widthPx: rule?.style === "double" ? Math.max(3, rule.widthPx) : rule?.widthPx ?? 1,
    color: rule?.color ?? "#111111",
  };
}
