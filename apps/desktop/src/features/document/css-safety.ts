/**
 * The single decision of "which CSS scalar values may a document carry".
 *
 * Document strings (shape colors, inline `color` / `backgroundColor` / `fontFamily`, table cell
 * styles) are written into `style` attributes by several serializers — the SVG export builds them
 * by hand-concatenating strings, `renderToStaticMarkup` does not escape `;` inside style object
 * values, and the print/PDF path re-serializes the same model again. A value like
 * `red;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#fff;z-index:2147483647`
 * therefore turns one color into a full-screen overlay in every string-serializing output.
 *
 * This module is the shared authority for both sides of that problem: the document normalization
 * boundary (`overlay-snapshot.ts`) uses it to decide what gets stored, and the serializers use
 * `isSafeCssDeclarationValue` as a value-level backstop for the paths that never pass through
 * normalization (body inline nodes are plain `z.string()` in the schema, and composite values like
 * `1px solid <color>` cannot be checked by swapping a color out).
 *
 * It lives in `features/document` (the lowest layer) as a **leaf module with zero imports** so
 * every consumer can reach it, including `packages/viewer`, whose `viewer-safety.ts` deep-imports
 * it (`@/features/document/css-safety`) rather than keeping a second copy of these rules — a
 * hand-copied duplicate is exactly how the viewer's stylesheet mirror silently rotted before.
 * Importing the `@/features/document` barrel from the viewer would instead pull the whole document
 * feature into the published bundle (`package-boundary.test.ts`).
 */

/**
 * Every predicate takes `unknown` and narrows. A `value: string` signature would be a lie at three
 * of the call sites: the structural type guards do not check the type of every CSS field
 * (`isGraph2DSpec` never looks at `axes.axisColor`), React stringifies a non-string style value
 * with `"" + value`, and a `typeof` check written at each caller is the kind of guard that gets
 * forgotten at the fourth one — where `.trim()` on a non-string would throw during render.
 */

/** The color substituted for a rejected required color prop. Matches the app's own default. */
export const SAFE_FALLBACK_COLOR = "black";

const MAX_CSS_SCALAR_LENGTH = 512;
const MAX_FONT_FAMILY_LENGTH = 200;

const CSS_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
/** `\` starts a CSS escape (`\3b` is `;`); `;{}<>` end the declaration, rule, or element. */
const CSS_ESCAPE_OR_DELIMITER = /[\\;{}<>]/u;
/** Everything that fetches, evaluates, or swallows the declarations written after it. */
const CSS_UNSAFE_TOKEN = /(?:url\s*\(|(?:-webkit-)?image-set\s*\(|element\s*\(|@import\b|expression\s*\(|javascript\s*:|vbscript\s*:|data\s*:|\/\*)/iu;
const SAFE_COLOR_FUNCTION = /^(?:rgb|rgba|hsl|hsla)\(\s*[-+.\d%\s,/]+\)$/iu;
const SAFE_COLOR_HEX = /^#[\da-f]{3,8}$/iu;
const SAFE_COLOR_KEYWORD = /^[a-z]+$/iu;
const SAFE_FONT_FAMILY = /^[\p{L}\p{N}\s,"'_.-]+$/u;

/**
 * A scalar that cannot escape the declaration it is written into: no control characters, no CSS
 * escape sequence, no delimiter that would end the declaration/rule/element, and no token that
 * fetches or evaluates (`url(`, `@import`, `expression(`, `javascript:`, `data:`, `/*`).
 */
export function isSafeCssScalar(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length > 0
    && trimmed.length <= MAX_CSS_SCALAR_LENGTH
    && !CSS_CONTROL_CHARACTER.test(value)
    && !CSS_ESCAPE_OR_DELIMITER.test(value)
    && !CSS_UNSAFE_TOKEN.test(value);
}

/** A safe scalar that is additionally shaped like a color: `#rgb[a]`, a keyword, or `rgb()/hsl()`. */
export function isSafeCssColor(value: unknown): value is string {
  if (!isSafeCssScalar(value)) {
    return false;
  }
  const trimmed = value.trim();
  return SAFE_COLOR_HEX.test(trimmed)
    || SAFE_COLOR_KEYWORD.test(trimmed)
    || SAFE_COLOR_FUNCTION.test(trimmed);
}

/** A safe scalar that is additionally shaped like a font family list. */
export function isSafeCssFontFamily(value: unknown): value is string {
  if (!isSafeCssScalar(value)) {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length <= MAX_FONT_FAMILY_LENGTH && SAFE_FONT_FAMILY.test(trimmed);
}

/**
 * Serializer backstop applied per declaration **value**, not per color: composite values such as
 * `1px solid <color>` (`getTableRenderedLineStyleModel`) embed a document color inside a larger
 * string, so only a whole-value check covers them.
 *
 * Looser than {@link isSafeCssColor} in shape — the renderers legitimately emit `calc(1.78em + 6px)`
 * for boxed-run line heights and `1px solid #1f2937` for table borders, so function and composite
 * values are accepted. `calc(` is not in {@link CSS_UNSAFE_TOKEN}, so keeping that guard costs the
 * renderers nothing while still refusing `url(` (an external fetch from a document string) and
 * `/*` (an unterminated comment swallows every declaration written after it).
 */
export function isSafeCssDeclarationValue(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  return value.trim().length > 0
    && value.length <= MAX_CSS_SCALAR_LENGTH
    && !CSS_CONTROL_CHARACTER.test(value)
    && !CSS_ESCAPE_OR_DELIMITER.test(value)
    && !CSS_UNSAFE_TOKEN.test(value);
}
