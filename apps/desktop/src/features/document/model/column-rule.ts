/** A printed separator shared by every gap in its page flow or local section. */
export interface ColumnRule {
  style: "none" | "solid" | "dashed" | "dotted" | "double";
  widthPx: number;
  color: string;
}

export const DEFAULT_COLUMN_RULE: Readonly<ColumnRule> = { style: "none", widthPx: 1, color: "#111111" };

export function normalizeColumnRule(value: unknown): ColumnRule | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rule = value as Partial<ColumnRule>;
  const style = rule.style;
  if (style !== "none" && style !== "solid" && style !== "dashed" && style !== "dotted" && style !== "double") return undefined;
  return {
    style,
    widthPx: typeof rule.widthPx === "number" && Number.isFinite(rule.widthPx)
      ? Math.min(8, Math.max(style === "double" ? 3 : 0.5, rule.widthPx))
      : style === "double" ? 3 : DEFAULT_COLUMN_RULE.widthPx,
    color: typeof rule.color === "string" && /^#[0-9a-f]{6}$/i.test(rule.color) ? rule.color : DEFAULT_COLUMN_RULE.color,
  };
}
