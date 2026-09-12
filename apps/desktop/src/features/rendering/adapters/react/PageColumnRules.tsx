import type { CSSProperties } from "react";
import type { PageMetrics } from "@/features/document";
import { createColumnRuleStyle } from "../column-rule-style";

/** Output content shared by the editor's PageCanvas and static Viewer. */
export function PageColumnRules({ metrics }: { metrics: PageMetrics }) {
  const rule = metrics.flow.columnRule;
  if (!rule || rule.style === "none" || metrics.flow.columnCount <= 1) return null;
  return <div className="page-column-rules" aria-hidden="true" style={{
    ...createColumnRuleStyle(rule), position: "absolute", inset: 0, pointerEvents: "none",
  } as CSSProperties}>
    {Array.from({ length: metrics.flow.columnCount - 1 }, (_, index) => (
      <span key={index} style={{
        position: "absolute",
        top: metrics.margins.topPx,
        bottom: metrics.margins.bottomPx,
        left: metrics.margins.leftPx + (index + 1) * metrics.flow.columnWidthPx + (index + 0.5) * metrics.flow.columnGapPx,
        transform: "translateX(-50%)",
        borderLeft: "var(--column-rule-width) var(--column-rule-style) var(--column-rule-color)",
      }} />
    ))}
  </div>;
}
