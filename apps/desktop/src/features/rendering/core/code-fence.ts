/**
 * Drops leftover markdown code fences from a code block's full text.
 *
 * Input / paste can leave an outer ``` / ~~~ pair, or just a leading opening
 * fence (` ```asdasda `). Inner fences stay untouched. Used by print/PDF so the
 * paper view does not show markdown chrome that the live editor already consumed.
 */
const WRAPPING_FENCE = /^(```|~~~)[^\n]*\n([\s\S]*)\n\1[ \t]*$/;
const OPENING_FENCE = /^(```|~~~)([^\n]*)(?:\n([\s\S]*))?$/;

export function stripWrappingMarkdownCodeFence(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  const trimmed = normalized.trim();
  const wrapped = WRAPPING_FENCE.exec(trimmed);
  if (wrapped) {
    return wrapped[2];
  }
  if (!trimmed.includes("\n")) {
    return text;
  }
  const opened = OPENING_FENCE.exec(trimmed);
  if (!opened) {
    return text;
  }
  const info = opened[2].replace(/^[ \t]/, "");
  const rest = opened[3];
  if (rest === undefined) {
    return info;
  }
  if (info === "") {
    return rest;
  }
  return `${info}\n${rest}`;
}
