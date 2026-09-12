import { Fragment } from "react";
import type { ColumnRule } from "@/features/document";

/** Lines sit over the grid without changing any editor's positioning container. */
export function ColumnRuleLines({ rule, dividers }: {
  rule?: ColumnRule;
  dividers: readonly { index: number; left: string }[];
}) {
  if (!rule || rule.style === "none") return null;
  return <Fragment>{dividers.map(divider => <span key={divider.index}
    className="column-rule-separator" aria-hidden="true" style={{ left: divider.left }} />)}</Fragment>;
}
