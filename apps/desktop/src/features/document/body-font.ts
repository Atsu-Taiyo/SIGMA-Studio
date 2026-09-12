/**
 * The font body text is drawn with when nothing overrides it.
 *
 * The body face comes first and the symbol face second. The order does not change a single
 * glyph — the two faces are complementary, and 28 sampled characters (Latin, kana, kanji,
 * enclosed numbers, ㈱ ℃ ∀ ∈ ≦ √ ─ ■ 𝑥 …) render pixel-identical either way — but it does
 * change which face is *primary*, and the primary face alone decides two things Chromium reads
 * from font metrics rather than from CSS:
 *
 * - the text caret's height. `Noto Sans Symbols` reports ascent + descent = 2.06em where every
 *   other bundled face reports 1.5em, so with it first the caret was drawn 33px tall on 16px
 *   text — taller than the 28.5px line box itself. `line-height` has no say in this.
 * - the strut's baseline. Moving it costs 1px (21px → 20px from the line top at 12pt/1.78) and
 *   leaves the line box height untouched, so pagination is unchanged and the editor and the
 *   print/PDF path move together (both read this same constant).
 *
 * Lives here rather than in the toolbar's constants because every surface needs it, including
 * `overlay-canvas`, which is not allowed to import `editor-shell/constants`
 * (`overlay-canvas/shape-renderer-architecture.test.ts`). `editor-shell/constants.ts` re-exports it
 * as `DEFAULT_FONT_FAMILY_VALUE` so the toolbar keeps its own vocabulary.
 *
 * Must stay identical to `--editor-body-font-family` in `globals.css`: the toolbar claims to show
 * the font a position is actually drawn with, and that claim is only true while the two agree.
 * Every named face before the generic fallback is bundled with the desktop renderer so pagination
 * never depends on the host OS's `system-ui` / Japanese fallback metrics. The bundled symbol and
 * math faces cover complementary enclosed-number, numeral and mathematical glyphs around the body face.
 * `body-font.test.ts` pins both contracts together.
 */
export const DEFAULT_BODY_FONT_FAMILY =
  '"M PLUS 1p", "Noto Sans Symbols", "STIX Two Math", sans-serif';

/** Bundled serif face exposed by the cross-platform "Noto Serif JP" option. */
export const DEFAULT_SERIF_BODY_FONT_FAMILY =
  '"Noto Serif JP", "Noto Sans Symbols", "STIX Two Math", serif';

/**
 * Older SigmaDoc files stored "標準明朝" as an OS fallback stack. That meant the same run was
 * Yu Mincho on macOS and MS PMincho on Windows, so its line breaks could change before PDF export.
 * Keep accepting the persisted value, but resolve it to the bundled face at every render boundary.
 */
export const LEGACY_STANDARD_SERIF_FONT_FAMILY =
  'ui-serif, "Yu Mincho", YuMincho, "Hiragino Mincho ProN", "BIZ UDPMincho", "MS PMincho", serif';

const LEGACY_SYSTEM_BODY_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif';

/**
 * The same bundled faces with the symbol face still in front. Files written before the reorder
 * stored these strings on their runs; resolving them keeps one caret height across a document
 * instead of a tall caret in the older paragraphs.
 */
const LEGACY_SYMBOLS_FIRST_BODY_FONT_FAMILY =
  '"Noto Sans Symbols", "M PLUS 1p", "STIX Two Math", sans-serif';

const LEGACY_SYMBOLS_FIRST_SERIF_FONT_FAMILY =
  '"Noto Sans Symbols", "Noto Serif JP", "STIX Two Math", serif';

export function resolveDocumentFontFamily(fontFamily: string | null | undefined): string | undefined {
  const value = fontFamily?.trim();
  if (!value) {
    return undefined;
  }
  const key = fontFamilyKey(value);
  if (key === fontFamilyKey(LEGACY_STANDARD_SERIF_FONT_FAMILY)) {
    return DEFAULT_SERIF_BODY_FONT_FAMILY;
  }
  if (key === fontFamilyKey(LEGACY_SYSTEM_BODY_FONT_FAMILY)) {
    return DEFAULT_BODY_FONT_FAMILY;
  }
  if (key === fontFamilyKey(LEGACY_SYMBOLS_FIRST_BODY_FONT_FAMILY)) {
    return DEFAULT_BODY_FONT_FAMILY;
  }
  if (key === fontFamilyKey(LEGACY_SYMBOLS_FIRST_SERIF_FONT_FAMILY)) {
    return DEFAULT_SERIF_BODY_FONT_FAMILY;
  }
  return value;
}

function fontFamilyKey(value: string): string {
  return value
    .replace(/["']/g, "")
    .split(",")
    .map((part) => part.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"))
    .join(",");
}
