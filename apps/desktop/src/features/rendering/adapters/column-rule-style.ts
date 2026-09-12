import type { ColumnRule } from "@/features/document";
import { getColumnRulePresentation } from "../core";

export function createColumnRuleStyle(rule?: ColumnRule) {
  const presentation = getColumnRulePresentation(rule);
  return {
    "--column-rule-style": presentation.style,
    "--column-rule-width": `${presentation.widthPx}px`,
    "--column-rule-color": presentation.color,
  };
}
