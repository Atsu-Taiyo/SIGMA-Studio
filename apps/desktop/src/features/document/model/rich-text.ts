export type TextAlign = "left" | "center" | "right" | "justify";

/** Unitless CSS line-height multiplier, normalized by `normalizeLineHeight`. */
export type LineHeight = string;

export type InlineNode = TextInlineNode | MathInlineNode;

export interface TextInlineNode {
  type: "text";
  text: string;
  marks?: TextMark[];
  color?: string;
  backgroundColor?: string;
  fontFamily?: string;
  fontSize?: number;
  boxedPaddingY?: number;
  boxedVariant?: BoxedVariant;
  boxedTone?: BoxedTone;
}

export type TextMark = "bold" | "italic" | "underline" | "boxed";

/**
 * Visual style of a boxed run, modeled after common TeX box commands:
 * `frame` (\fbox), `thick`, `double`, `oval` (\ovalbox), and `shade` (\tcolorbox / \itembox).
 * Absent means `frame`, so existing boxed runs keep their thin-border look.
 */
export type BoxedVariant = "frame" | "thick" | "double" | "oval" | "shade";

/** Fill colour preset for `shade` boxes. Absent means `gray`. */
export type BoxedTone = "gray" | "blue" | "green" | "red" | "yellow";

export interface MathInlineNode {
  type: "mathInline";
  id: string;
  tex: string;
  display: "inline";
  marks?: Array<Extract<TextMark, "underline" | "boxed">>;
  color?: string;
  backgroundColor?: string;
  fontFamily?: string;
  fontSize?: number;
  boxedPaddingY?: number;
  boxedVariant?: BoxedVariant;
  boxedTone?: BoxedTone;
  semanticRole?: "expression" | "equation" | "variable";
  altText?: string;
}

/** Plain-text projection used by search, labels, and editor-only summaries. */
export function inlineNodesToPlainText(children: readonly InlineNode[]): string {
  return children
    .map((child) => child.type === "text" ? child.text : `$${child.tex}$`)
    .join("");
}
