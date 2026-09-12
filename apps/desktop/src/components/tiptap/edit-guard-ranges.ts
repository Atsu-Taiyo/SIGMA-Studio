import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

import { rebaseProtectedTextRanges, type TextContentReservation } from "@/features/text-editing";

export interface EditGuardSpan { from: number; to: number }

/** Project canonical plain-text offsets into this editing view, including atomic math. */
export function resolveEditGuardSpans(
  node: ProseMirrorNode,
  contentFrom: number,
  reservations: readonly TextContentReservation[],
): EditGuardSpan[] | null {
  let text = "";
  const units: EditGuardSpan[] = [];
  const math = new Map<string, EditGuardSpan>();
  node.descendants((child, offset) => {
    const from = contentFrom + offset;
    if (child.isText) {
      const value = child.text ?? "";
      text += value;
      for (let i = 0; i < value.length; i++) units.push({ from: from + i, to: from + i + 1 });
    } else if (child.type.name === "hardBreak") {
      text += "\n";
      units.push({ from, to: from + child.nodeSize });
    } else if (child.type.name === "mathInline") {
      const span = { from, to: from + child.nodeSize };
      const value = `$${child.attrs.tex ?? ""}$`;
      text += value;
      for (let i = 0; i < value.length; i++) units.push(span);
      if (typeof child.attrs.id === "string") math.set(child.attrs.id, span);
    }
  });
  const result: EditGuardSpan[] = [];
  for (const reservation of reservations) {
    const ranges = rebaseProtectedTextRanges(reservation.baselineText, text, reservation.ranges);
    if (!ranges) return null;
    for (const range of ranges) {
      result.push({ from: units[range.from].from, to: units[range.to - 1].to });
    }
    for (const id of reservation.inlineMathIds) {
      const span = math.get(id);
      if (span) result.push(span);
    }
  }
  const merged: EditGuardSpan[] = [];
  for (const span of result.sort((a, b) => a.from - b.from || a.to - b.to)) {
    const last = merged[merged.length - 1];
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  return merged;
}

/** Step maps disambiguate repeated text: typing inside `aaa` cannot masquerade as an append. */
export function transactionTouchesEditGuardSpans(
  transaction: Transaction,
  spans: readonly EditGuardSpan[],
): boolean {
  for (const original of spans) {
    let { from, to } = original;
    for (const step of transaction.steps) {
      const map = step.getMap();
      let touched = false;
      map.forEach((start, end) => {
        if (start === end ? start > from && start < to : start < to && end > from) touched = true;
      });
      if (touched) return true;
      from = map.map(from, 1);
      to = map.map(to, -1);
    }
    // Mark-only transactions have empty step maps. Compare the actual protected content too.
    if (from >= to || !transaction.before.slice(original.from, original.to).content
      .eq(transaction.doc.slice(from, to).content)) return true;
  }
  return false;
}
