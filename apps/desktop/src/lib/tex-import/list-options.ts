import type { ListNode } from "@/features/document";
import { readBraceGroup } from "./scanner";

type Numbering = Pick<ListNode, "start" | "markerStyle">;

export function readNumericItemLabel(label: string | undefined): Numbering | null {
  const text = label?.trim();
  const paren = text?.match(/^\(([1-9]\d*)\)$/);
  const decimal = text?.match(/^([1-9]\d*)\.$/);
  const number = Number(paren?.[1] ?? decimal?.[1]);
  return Number.isSafeInteger(number) && number > 0
    ? { start: number, markerStyle: paren ? "paren" : "decimal" }
    : null;
}

/** Read enumitem keys without splitting commas or closing brackets inside brace groups. */
export function readListOptions(option: string | undefined): Numbering {
  if (!option) return {};
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < option.length; index += 1) {
    if (option[index] === "{") {
      const group = readBraceGroup(option, index);
      if (group) index = group.endIndex - 1;
    } else if (option[index] === ",") {
      parts.push(option.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(option.slice(start));
  const result: Numbering = {};
  for (const part of parts) {
    const match = part.trim().match(/^(label|start)\s*=\s*([\s\S]*)$/);
    if (!match) continue;
    const raw = match[2].trim();
    const group = readBraceGroup(raw, 0);
    const value = group?.endIndex === raw.length ? group.value.trim() : raw;
    if (match[1] === "start" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) result.start = Number(value);
    if (match[1] === "label" && /^\(\\arabic\*\)$/.test(value)) result.markerStyle = "paren";
    if (match[1] === "label" && /^\\arabic\*\.$/.test(value)) result.markerStyle = "decimal";
  }
  return result;
}
