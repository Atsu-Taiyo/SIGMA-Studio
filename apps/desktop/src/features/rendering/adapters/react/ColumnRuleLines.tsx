import { Fragment } from "react";
import type { FlowColumnRulePiece } from "@/features/rendering/core";
import type { ColumnRule } from "@/features/document";

/** Lines sit over the grid without changing any editor's positioning container. */
export function ColumnRuleLines({ rule, dividers, pieces }: {
  rule?: ColumnRule;
  pieces?: readonly FlowColumnRulePiece[];
  dividers: readonly { index: number; left: string }[];
}) {
  if (!rule || rule.style === "none") return null;
  return <Fragment>{dividers.flatMap(divider => (pieces ?? [undefined]).map((piece, index) => <span key={`${divider.index}:${index}`}
    className="column-rule-separator" aria-hidden="true" style={piece
      ? { left: `calc(${divider.left} + ${piece.x}px)`, top: piece.y, height: piece.height, bottom: "auto" }
      : { left: divider.left }} />))}</Fragment>;
}
