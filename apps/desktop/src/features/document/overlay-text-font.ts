import type { OverlayShape, OverlayTextSize } from "./overlay-model";
import { overlayTextSizeToPx } from "./overlay-rich-text-format";

/**
 * Single source of truth for "how big does an overlay text shape render". Three copies of this
 * math used to exist — `features/drawing/text-shape-font.ts` (private size table + private unit
 * helpers), `overlay-group-normalization.ts` (open-coded pt→px conversion and scale clamp inside
 * `getTextShapeContentFallbackHeight`), and `lib/font-size-units.ts` (unit helpers) — which let the
 * *stored* geometry of auto-sized text shapes drift away from what the renderers draw.
 *
 * It lives in `features/document` (the lowest layer) as a leaf module so every consumer can reach
 * it: `features/drawing` may only import `@/features/document*` and `@/features/rendering/core`
 * (`features/drawing/architecture.test.ts`), while `features/document` may not import
 * `features/rendering` at all (`features/document/architecture.test.ts`) — so neither
 * `rendering/core` nor `@/lib` can host it. `features/drawing/text-shape-font.ts` re-exports the
 * whole module as the drawing feature's single runtime edge into this feature, and
 * `lib/font-size-units.ts` re-exports the unit helpers.
 *
 * The size table itself stays in `overlay-rich-text-format.ts` (`overlayTextSizeToPx`) — its
 * inverse (`fontSizeToOverlaySize`) lives next to it, and this module imports it rather than
 * holding a second copy.
 *
 * Outgoing imports must stay relative — anything else would make the drawing feature's runtime
 * graph pull in more of this feature than the font math, and `features/drawing`'s own boundary test
 * cannot see it because it only greps drawing files. `features/document/architecture.test.ts` pins
 * that rule for this module.
 */

export const CSS_PX_PER_PT = 96 / 72;
export const TEXT_SHAPE_LINE_HEIGHT = 1;

export function pxToPt(px: number): number {
  return roundFontSize(px / CSS_PX_PER_PT);
}

export function ptToPx(pt: number): number {
  return pt * CSS_PX_PER_PT;
}

export function roundFontSize(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Px font size for the `size` enum alone. This is the enum-only API — it takes no point size, so it
 * stays on plain px arithmetic instead of detouring through `pt`, and there is nothing to gain from
 * changing that: callers that have a whole shape — and therefore a possible `props.fontSize` in
 * points — must use `getTextShapeRenderedFontSizePx`, which is the one path that reads it.
 */
export function getTextShapeFontSizePx(size: OverlayTextSize): number {
  return overlayTextSizeToPx(size);
}

/**
 * Font size a shape's stored props resolve to, in points. `props.fontSize` (points) wins over the
 * legacy `props.size` enum whenever it describes a glyph that can actually be drawn; the enum is
 * still a live input (`create-shape.ts` writes `size:"m"` for new shapes and the toolbar reads it
 * back through `fontSizeToOverlaySize`).
 */
export function getTextShapeFontSizePt(
  shape: Extract<OverlayShape, { type: "text" | "callout" }>,
): number {
  const baseFontSize = (
    typeof shape.props.fontSize === "number" &&
    Number.isFinite(shape.props.fontSize) &&
    shape.props.fontSize > 0
  )
    ? shape.props.fontSize
    : pxToPt(overlayTextSizeToPx(shape.props.size));
  return baseFontSize;
}

export function getTextShapeRenderedFontSizePx(
  shape: Extract<OverlayShape, { type: "text" | "callout" }>,
): number {
  return ptToPx(getTextShapeFontSizePt(shape));
}

/**
 * Height of one rendered line box. Both the drawing feature's text box estimator and this
 * feature's `getShapeBounds` (group bounds) go through this function, so the *stored* geometry of
 * a text shape cannot drift from what the renderers draw.
 */
export function getTextShapeRenderedLineHeightPx(
  shape: Extract<OverlayShape, { type: "text" | "callout" }>,
): number {
  return Math.ceil(
    getTextShapeRenderedFontSizePx(shape) * TEXT_SHAPE_LINE_HEIGHT,
  );
}

/** Line box for the `size` enum alone — the px counterpart of `getTextShapeFontSizePx`. */
export function getTextShapeLineHeightPx(size: OverlayTextSize): number {
  return Math.ceil(getTextShapeFontSizePx(size) * TEXT_SHAPE_LINE_HEIGHT);
}
