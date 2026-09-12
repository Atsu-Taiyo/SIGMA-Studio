/**
 * DOM-free text metrics: how wide a run of plain characters is, and how tall a line of them is.
 *
 * Named for the consumer that will outlive the others. A line's or arrow's `props.label` is drawn
 * straight into the SVG as a one-line `<text>` — it never wraps, never holds a formula, and is
 * measured where there is no DOM at all (the SVG export, the visible-bounds box the canvas
 * hit-tests with), so it will always need an estimate. Overlay *text shapes* went the other way in
 * this series: they are laid out by the body renderer and their height comes from the measured
 * DOM, and the shared DOM-free estimator they used to be measured by is gone — so these numbers
 * are the caption's alone now.
 *
 * The widths are a deliberate over-estimate: Latin glyphs are read as a flat 0.58em, wider than
 * they really are. A caption box that is too wide only wastes space, while one that is too narrow
 * lets the glyphs escape the rectangle that is supposed to contain them.
 */

/**
 * Plain text's vertical box, split into ascent and descent.
 *
 * The split is what an SVG `<text>` needs — its `y` is the baseline, so the glyphs hang an ascent
 * above it and a descent below — but the two numbers are the plain-text line box itself, so
 * anything that puts one line in a box floors it with them: a line holding a formula is
 * `max(ascents) + max(descents)`, never shorter than plain text on that line.
 *
 * Their sum MUST stay 1 (`TEXT_SHAPE_LINE_HEIGHT`): `line-height: 1` on `.overlay-text-shape` in
 * globals.css assumes exactly this, so the floor is also what makes a one-line box exactly one
 * line tall.
 */
export const TEXT_ASCENT_EM = 0.8;
export const TEXT_DESCENT_EM = 0.2;

/** Width of one line of plain text, in em of the font it is drawn at. */
export function estimateTextWidthEm(text: string): number {
  let em = 0;
  for (const char of text) {
    em += estimateOverlayTextCharUnits(char);
  }
  return em;
}

export function estimateOverlayTextCharUnits(char: string): number {
  if (/\s/u.test(char)) {
    return 0.35;
  }

  const codePoint = char.codePointAt(0) ?? 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef)
  ) {
    return 1;
  }

  if (/[+\-*/=<>()[\]{}^_,.;:|]/u.test(char)) {
    return 0.45;
  }

  return 0.58;
}
