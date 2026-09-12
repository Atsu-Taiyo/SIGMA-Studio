import { getOverlayTextBlocksLineCount } from "@/features/rendering/core";

import type {
  OverlayCalloutShape,
  OverlayShape,
} from "@/features/document";

import {
  CALLOUT_TEXT_PADDING,
  getTextShapeRenderedLineHeightPx,
  MIN_TEXT_SHAPE_WIDTH,
} from "./text-shape-font";

export interface OverlayTextBoxSize {
  w: number;
  h: number;
}

/**
 * Effective (render-time) box for a text shape.
 *
 * Width is the user's stored width, clamped to the minimum — nothing derives it, because the user
 * chose it and wrapping happens at exactly that width. Height is the stored derived cache, floored
 * by the number of lines the content occupies with no wrapping at all: the cache can be missing on
 * a freshly generated shape or stale after an edit that has not been measured yet, and a box that
 * is shorter than its own line breaks would clip visibly. Never mutates the shape.
 */
export function getTextShapeEffectiveSize(
  shape: Extract<OverlayShape, { type: "text" }>,
): OverlayTextBoxSize {
  const w = Math.max(MIN_TEXT_SHAPE_WIDTH, shape.props.w);
  const storedH = Number.isFinite(shape.props.h) ? shape.props.h : 0;
  return { w, h: Math.max(storedH, getTextShapeContentFallbackHeight(shape)) };
}

/**
 * Effective (render-time) body-rect size for a callout: width is the stored `props.w` (the mouth
 * geometry is expressed against that rect, and growing it would let a wider box "help" wrapping,
 * which would then need less height, which would then let the box narrow again — an unstable
 * two-axis fixed point). Height never shrinks below the stored `props.h`, and never below the
 * lines the content occupies from its own breaks. Never mutates `shape`.
 */
export function getCalloutBodySize(
  shape: OverlayCalloutShape,
): OverlayTextBoxSize {
  const wEff = Math.max(1, shape.props.w);
  const lineHeight = getTextShapeRenderedLineHeightPx(shape);
  const contentFloor = Math.max(1, getOverlayTextBlocksLineCount(shape.props.blocks)) * lineHeight;
  return {
    w: wEff,
    h: Math.max(shape.props.h, contentFloor + 2 * CALLOUT_TEXT_PADDING),
  };
}

/**
 * The callout's inner text rect, in coordinates local to its (effective) body rect — i.e. after
 * applying `CALLOUT_TEXT_PADDING` on all sides of `getCalloutBodySize(shape)`. Renderers place
 * the rich-text content here instead of re-deriving it from the stored `props.w`/`props.h`.
 */
export function getCalloutTextRect(
  shape: OverlayCalloutShape,
): { x: number; y: number; w: number; h: number } {
  const body = getCalloutBodySize(shape);
  return {
    x: CALLOUT_TEXT_PADDING,
    y: CALLOUT_TEXT_PADDING,
    w: Math.max(1, body.w - 2 * CALLOUT_TEXT_PADDING),
    h: Math.max(1, body.h - 2 * CALLOUT_TEXT_PADDING),
  };
}

/**
 * Height a text shape needs from its explicit line breaks alone (hard breaks and `\n` in
 * plain text runs), ignoring width-driven wrapping. Used as one lower bound inside
 * `getTextShapeEffectiveSize`; kept separate because a few callers (e.g. resize) want this
 * cheaper estimate without triggering a full content measurement.
 */
export function getTextShapeContentFallbackHeight(
  shape: Extract<OverlayShape, { type: "text" }>,
): number {
  const lineHeight = getTextShapeRenderedLineHeightPx(shape);
  return Math.max(
    lineHeight,
    getOverlayTextBlocksLineCount(shape.props.blocks) * lineHeight,
  );
}
