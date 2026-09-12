import type { GraphFillPattern } from "./model/graph";

export const DEFAULT_GRAPH_FILL_COLOR = "#9ca3af";
export const DEFAULT_GRAPH_FILL_OPACITY = 0.28;
export const DEFAULT_GRAPH_FILL_PATTERN: GraphFillPattern = "solid";

/**
 * 塗り方の選択肢。**文言は持たない** — `features/document` は最下層で、
 * 表示のための文字列を抱えない (表示名は `shape.graphFill.<value>`)。
 */
export const GRAPH_FILL_PATTERN_OPTIONS = [
  { value: "solid" },
  { value: "diagonal" },
  { value: "diagonalBack" },
  { value: "cross" },
  { value: "horizontal" },
  { value: "vertical" },
  { value: "dots" },
] as const satisfies readonly { value: GraphFillPattern }[];

export function isGraphFillPattern(value: unknown): value is GraphFillPattern {
  return GRAPH_FILL_PATTERN_OPTIONS.some((option) => option.value === value);
}

export function normalizeGraphFillPattern(pattern: GraphFillPattern | undefined): GraphFillPattern {
  return isGraphFillPattern(pattern) ? pattern : DEFAULT_GRAPH_FILL_PATTERN;
}

export function normalizeGraphFillOpacity(opacity: number | undefined): number {
  if (typeof opacity !== "number" || !Number.isFinite(opacity)) {
    return DEFAULT_GRAPH_FILL_OPACITY;
  }

  return Math.min(1, Math.max(0, opacity));
}
