import type { LineHeight } from "../model/rich-text";

export const MIN_LINE_HEIGHT = 0.8;
export const MAX_LINE_HEIGHT = 3;
export const LINE_HEIGHT_STEP = 0.05;
export const LINE_HEIGHT_PRESETS = ["1", "1.15", "1.35", "1.5", "1.75", "2"] as const satisfies readonly LineHeight[];

const LINE_HEIGHT_PATTERN = /^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/;

export function normalizeLineHeight(value: unknown): LineHeight | undefined {
  const text = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!LINE_HEIGHT_PATTERN.test(text)) {
    return undefined;
  }

  const number = Number(text);
  if (!Number.isFinite(number) || number < MIN_LINE_HEIGHT || number > MAX_LINE_HEIGHT) {
    return undefined;
  }

  return formatLineHeightValue(number);
}

export function formatLineHeightLabel(value: LineHeight): string {
  return `${value}行`;
}

export function formatLineHeightValue(value: number): LineHeight {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

export function stepLineHeight(current: LineHeight, direction: "increase" | "decrease"): LineHeight {
  const currentNum = Number(current);
  const nextNum = direction === "increase"
    ? currentNum + LINE_HEIGHT_STEP
    : currentNum - LINE_HEIGHT_STEP;
  const clamped = Math.max(MIN_LINE_HEIGHT, Math.min(MAX_LINE_HEIGHT, nextNum));
  return formatLineHeightValue(clamped);
}
