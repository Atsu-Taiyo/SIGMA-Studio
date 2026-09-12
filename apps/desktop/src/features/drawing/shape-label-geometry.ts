import type {
  OverlayArrowShape,
  OverlayBounds,
  OverlayLineShape,
  OverlayPoint,
  OverlayShape,
} from "@/features/document";
import { overlayLabelFontSize } from "@/features/rendering/core";

import { getLineMidpoint } from "./line-geometry";
import { estimateTextWidthEm, TEXT_ASCENT_EM, TEXT_DESCENT_EM } from "./svg-label-metrics";

/**
 * Where a line's or arrow's `props.label` is drawn, in page coordinates.
 *
 * The single definition: the editor canvas (`shape-renderer.tsx`), the SVG export
 * (`overlay-svg.ts`) and the visible box (`shape-visual-bounds.ts`) all read it, so the caption
 * cannot end up outside the rectangle that is supposed to contain it. It used to be written out
 * three times, and the export and the canvas had already drifted apart for arrows.
 *
 * Only line and arrow: a `geo` caption is drawn in the middle of a box it is already inside.
 */
export interface OverlayShapeLabelPlacement {
  /** The middle of the caption's baseline, in page coordinates. */
  readonly anchor: OverlayPoint;
  readonly text: string;
  readonly fontSizePx: number;
}

type OverlayLabelledShape = OverlayLineShape | OverlayArrowShape;

/** The caption is lifted clear of the stroke by this much, as the renderers do. */
const LABEL_BASELINE_OFFSET = 8;

export function getShapeLabelPlacement(shape: OverlayShape): OverlayShapeLabelPlacement | null {
  const labelled = asLabelledShape(shape);
  // The same truthiness check the renderers draw with: an empty caption is no caption.
  const text = labelled?.props.label;
  if (!labelled || !text) {
    return null;
  }

  // The anchor stays on the *stored* segment: an arrow head shortens the ink, and a caption that
  // slid whenever a head was picked would look like the shape had moved.
  const local = labelled.type === "arrow"
    ? {
      x: (labelled.props.start.x + labelled.props.end.x) / 2,
      y: (labelled.props.start.y + labelled.props.end.y) / 2,
    }
    : getLineMidpoint(labelled.props.points);
  if (!local) {
    return null;
  }

  return {
    anchor: {
      x: labelled.x + local.x,
      y: labelled.y + local.y - LABEL_BASELINE_OFFSET,
    },
    text,
    fontSizePx: overlayLabelFontSize(labelled.props.size),
  };
}

/**
 * The box the caption's glyphs occupy.
 *
 * The `<text>` is drawn with `text-anchor: middle` and no `dominant-baseline`, so the anchor is
 * the middle of the baseline: the box hangs an ascent above it and a descent below. Widths come
 * from `svg-label-metrics.ts`, the DOM-free estimator this caption owns: it reads Latin glyphs as
 * a flat 0.58em — wider than they really are, so no safety factor is added on top.
 */
export function getShapeLabelBounds(shape: OverlayShape): OverlayBounds | null {
  const placement = getShapeLabelPlacement(shape);
  if (!placement) {
    return null;
  }

  const { anchor, fontSizePx } = placement;
  // SVG collapses whitespace, so a caption with a newline in it is drawn on one line. Splitting it
  // into two would over-estimate the height and under-estimate the width.
  const oneLine = placement.text.replace(/\s+/g, " ");
  const w = Math.ceil(estimateTextWidthEm(oneLine) * fontSizePx);

  return {
    x: anchor.x - w / 2,
    y: anchor.y - fontSizePx * TEXT_ASCENT_EM,
    w,
    h: fontSizePx * (TEXT_ASCENT_EM + TEXT_DESCENT_EM),
  };
}

/** The two shape types that caption a segment rather than a box they already fill. */
function asLabelledShape(shape: OverlayShape): OverlayLabelledShape | null {
  return shape.type === "line" || shape.type === "arrow" ? shape : null;
}
