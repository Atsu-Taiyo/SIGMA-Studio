const MATH_DELIMITED = /^\$([\s\S]*)\$$/u;
/** U+2212 MINUS SIGN and the dashes; NFKC leaves these alone but a spreadsheet paste is full of them. */
const LEADING_MINUS = /^[\u2010-\u2015\u2212]/u;
/** Any whitespace left after trimming separates two tokens, so the cell is not one number. */
const INTERNAL_WHITESPACE = /\s/u;
/** Commas drop out only in a well-formed thousands grouping; `1,2` stays ambiguous and is refused. */
const GROUPED_THOUSANDS = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u;
const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

/**
 * Parses one cell's text as a number.
 *
 * NFKC folds the full-width digits and punctuation a Japanese keyboard produces; a bare `$…$` (how
 * inline math serializes) is unwrapped so a number typed as a formula still counts. Anything else —
 * an em dash, prose, a hex literal — is `null`.
 *
 * Separators are removed narrowly, on purpose. Stripping every space and comma would read the two
 * tokens `1 2` as `12` and the European decimal `1,2` as `12` — a *wrong* plotted value, which is
 * far worse than the gap an unparseable cell leaves. So internal whitespace disqualifies the cell
 * outright, and commas are dropped only where they group digits in threes.
 *
 * It lives beside the grid expansion rather than with the chart derivation because the formula
 * engine reads cells through it too: one table, one answer to "is this cell a number".
 */
export function parseChartNumber(text: string): number | null {
  const normalized = text.normalize("NFKC").trim();
  const unwrapped = MATH_DELIMITED.exec(normalized)?.[1]?.trim() ?? normalized;
  const signed = unwrapped.replace(LEADING_MINUS, "-");
  if (INTERNAL_WHITESPACE.test(signed)) {
    return null;
  }
  const compact = GROUPED_THOUSANDS.test(signed) ? signed.replace(/,/gu, "") : signed;
  if (!DECIMAL_NUMBER.test(compact)) {
    return null;
  }
  const value = Number(compact);
  return Number.isFinite(value) ? value : null;
}
