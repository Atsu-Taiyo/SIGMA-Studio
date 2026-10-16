export type TextAlign = "left" | "center" | "right" | "justify";

/** Unitless CSS line-height multiplier, normalized by `normalizeLineHeight`. */
export type LineHeight = string;

export type InlineNode = TextInlineNode | MathInlineNode;

export interface TextInlineNode {
  type: "text";
  text: string;
  /** Stable recipient identity for a collaborator mention in a comment. */
  mentionUserId?: string;
  marks?: TextMark[];
  underlineStyle?: UnderlineStyle;
  color?: string;
  backgroundColor?: string;
  fontFamily?: string;
  fontSize?: number;
  boxedPaddingY?: number;
  boxedVariant?: BoxedVariant;
  boxedTone?: BoxedTone;
  /** {@link BoxedRoundness}. */
  boxedRoundness?: BoxedRoundness;
}

/** Native underline appearance; absent preserves the existing solid underline. */
export type UnderlineStyle = "solid" | "wavy" | "dotted" | "double";

export type TextMark = "bold" | "italic" | "underline" | "boxed";

/**
 * Visual style of a boxed run, modeled after common TeX box commands:
 * `frame` (\fbox), `thick`, `double`, `oval` (\ovalbox), `shade` (\tcolorbox / \itembox),
 * and `compact` (a tight frame for imported source text).
 * Absent means `frame`, so existing boxed runs keep their thin-border look.
 */
export type BoxedVariant = "frame" | "thick" | "double" | "oval" | "shade" | "compact";

/** Fill colour preset for `shade` boxes. Absent means `gray`. */
export type BoxedTone = "gray" | "blue" | "green" | "red" | "yellow";

/**
 * How round an `oval` box's corners are, as a percentage (0–100) of the full rounding the variant
 * draws by default. Absent means 100, so existing rounded boxes keep their look. Other variants
 * have square corners and ignore it. Older readers drop the unknown field and draw the default.
 */
export type BoxedRoundness = number;

export interface MathInlineNode {
  type: "mathInline";
  id: string;
  tex: string;
  display: "inline";
  marks?: Array<Extract<TextMark, "underline" | "boxed">>;
  underlineStyle?: UnderlineStyle;
  color?: string;
  backgroundColor?: string;
  fontFamily?: string;
  fontSize?: number;
  boxedPaddingY?: number;
  boxedVariant?: BoxedVariant;
  boxedTone?: BoxedTone;
  /** {@link BoxedRoundness}. */
  boxedRoundness?: BoxedRoundness;
  semanticRole?: "expression" | "equation" | "variable";
  altText?: string;
}

/** Plain-text projection used by search, labels, and editor-only summaries. */
export function inlineNodesToPlainText(children: readonly InlineNode[]): string {
  return children
    .map((child) => child.type === "text" ? child.text : `$${child.tex}$`)
    .join("");
}
