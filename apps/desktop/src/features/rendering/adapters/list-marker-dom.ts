import type { InlineNode } from "@/features/document";
import {
  listMarkerRunsFromInlineNodes,
  resolveListMarkerTypography,
  type ListMarkerTypography,
} from "@/features/rendering/core";

/**
 * The one attribute `document-surface.css` styles a typography-carrying `li` on.
 *
 * The custom properties below inherit, so the rule is written against this attribute rather than
 * `li` itself: a nested list's items must fall back to their own first run, not the parent's.
 */
export const LIST_MARKER_TYPOGRAPHY_ATTRIBUTE = "data-list-marker-typography";

const FONT_FAMILY_VARIABLE = "--sigma-doc-list-marker-font-family";
const FONT_SIZE_VARIABLE = "--sigma-doc-list-marker-font-size";
const COLOR_VARIABLE = "--sigma-doc-list-marker-color";
const FONT_WEIGHT_VARIABLE = "--sigma-doc-list-marker-font-weight";
const FONT_STYLE_VARIABLE = "--sigma-doc-list-marker-font-style";

/**
 * A document-supplied value that cannot escape the declaration it is written into.
 *
 * The value comes from the document, and every projection puts it in a `style` attribute — the
 * ProseMirror decoration concatenates it into `cssText`, React writes it into the DOM. A `;` or a
 * `}` would let a document add declarations of its own; `<` `>` and comment markers are rejected
 * for the same reason (an unterminated `/*` swallows the declarations after it). Newlines are out
 * because a decoration's `style` is concatenated as one line.
 *
 * Font family and colour are both document strings, so both go through this.
 */
const UNSAFE_CSS_VALUE_PATTERN = /[;{}<>\n\r]|\/\*|\*\//;

/**
 * Browser/CSS projection of {@link ListMarkerTypography}: the custom properties `::marker` reads.
 *
 * Returning `undefined` means "emit nothing", and the marker keeps inheriting the `li` font, so an
 * untouched document's computed values do not change.
 */
export function listMarkerTypographyVars(
  typography: ListMarkerTypography | undefined,
): Record<`--${string}`, string> | undefined {
  if (!typography) {
    return undefined;
  }

  const vars: Record<`--${string}`, string> = {};
  if (typography.fontFamily && !UNSAFE_CSS_VALUE_PATTERN.test(typography.fontFamily)) {
    vars[FONT_FAMILY_VARIABLE] = typography.fontFamily;
  }
  const { fontSizePt } = typography;
  if (fontSizePt !== undefined && Number.isFinite(fontSizePt) && fontSizePt > 0) {
    // pt, matching `inlineTextStyleDeclarations`: the run's own span is sized in pt, and the
    // marker has to land on the same number.
    vars[FONT_SIZE_VARIABLE] = `${fontSizePt}pt`;
  }
  if (typography.color && !UNSAFE_CSS_VALUE_PATTERN.test(typography.color)) {
    vars[COLOR_VARIABLE] = typography.color;
  }
  // 太字・斜体は「付いていれば書く」だけ。既定値 (normal) をわざわざ書くと、リストの
  // 既定書体が太字の面でマーカーだけ細くなる。
  if (typography.bold) {
    vars[FONT_WEIGHT_VARIABLE] = "bold";
  }
  if (typography.italic) {
    vars[FONT_STYLE_VARIABLE] = "italic";
  }
  return Object.keys(vars).length > 0 ? vars : undefined;
}

export interface ListMarkerTypographyDomSpec {
  attrs: Record<string, string>;
  style: Record<`--${string}`, string>;
}

/**
 * The `li` attribute and custom properties one SigmaDoc list item's content asks for.
 *
 * The attribute and the properties are decided together here so no surface can emit one without
 * the other — the CSS rule needs both, and a surface that emitted only the properties would style
 * nothing while looking correct in the markup.
 */
export function listMarkerTypographyDomSpec(
  children: readonly InlineNode[],
): ListMarkerTypographyDomSpec | undefined {
  const style = listMarkerTypographyVars(
    resolveListMarkerTypography(listMarkerRunsFromInlineNodes(children)),
  );
  return style ? { attrs: { [LIST_MARKER_TYPOGRAPHY_ATTRIBUTE]: "" }, style } : undefined;
}
