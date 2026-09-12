"use client";

import { useEffect, useRef, useState } from "react";

import { CALLOUT_TEXT_PADDING, getTextShapeRenderedLineHeightPx } from "@/features/drawing";
import { getEffectiveZoom } from "@/features/rendering/adapters";

import type { OverlayShape } from "./types";

/**
 * Attributes whose change can move the rendered height without adding or removing a node.
 *
 * The boxed-run alignment pass writes its measured values back as attributes and custom
 * properties, so a run that grows a frame changes the height with the same DOM in place.
 */
export const OVERLAY_TEXT_HEIGHT_ATTRIBUTES = [
  "class",
  "style",
  "data-boxed-run-aligned",
  "data-sigma-doc-boxed-padding-y",
  "data-sigma-doc-boxed-variant",
  "data-sigma-doc-boxed-tone",
  "data-sigma-doc-boxed-math",
] as const;

/** Report a new height only once it differs by a whole pixel. */
const HEIGHT_EPSILON_PX = 1;

export interface OverlayTextMeasureOptions {
  /** The shape is turned, so only rotation-immune layout metrics can be read. */
  rotated?: boolean;
  /**
   * A layout input that must permit the current height to be reported again when it changes.
   * Width is the important case: the resize interaction can overwrite a height reported during
   * an earlier drag frame even when the final width wraps to the same number of lines.
   */
  remeasureKey?: string | number;
}

/**
 * The height a shape's text occupies, in the shape's own (unzoomed) pixels.
 *
 * `.page-stack` scales its subtree — with CSS `zoom` in previews and a `transform` on the page
 * canvas — which scales `getBoundingClientRect()` but leaves `scrollHeight` in local px. Mixing the
 * two is how a shape edited at 150% used to save a 1.5x-inflated height, so every rect-derived
 * number is divided back by the ratio the element itself reports before the two are combined.
 *
 * The only layout read in this file, and named so `shape-renderer-architecture.test.ts` can allow
 * it by name rather than by loosening the rule.
 */
export function measureOverlayTextContentHeight(
  element: HTMLElement,
  // Neither destructured nor defaulted to `{}`: `shape-renderer-architecture.test.ts` finds a
  // function's body by matching from the first `{` after its declaration, so either form would
  // make the allow-list entry for this function cover the options object instead of the body.
  options?: OverlayTextMeasureOptions,
): number {
  if (options?.rotated) {
    // Rotation turns every rect into an axis-aligned bounding box and loses the original corners,
    // so the overflow scan below cannot be un-rotated. Layout metrics are local and unrotated,
    // which makes them the only stable reading on this branch.
    return Math.ceil(Math.max(element.scrollHeight, element.offsetHeight));
  }
  const rect = element.getBoundingClientRect();
  const zoom = getEffectiveZoom(element);
  const descendantBottoms = Array.from(element.querySelectorAll<HTMLElement>("*"))
    .map((child) => child.getBoundingClientRect())
    .filter((childRect) => childRect.width > 0 || childRect.height > 0)
    .map((childRect) => childRect.bottom);
  const maxBottom = Math.max(rect.bottom, ...descendantBottoms);
  return Math.ceil(Math.max(
    element.scrollHeight,
    rect.height / zoom,
    (maxBottom - rect.top) / zoom,
  ));
}

/**
 * The `props.h` a measured content height means for this shape.
 *
 * A callout's text is drawn inside `getCalloutTextRect`, which has already taken the padding off
 * every side, so its content height has to have it put back before it can be compared with the
 * stored box height. A text shape's box *is* its content box.
 */
export function overlayTextBoxHeightForContent(
  shape: Extract<OverlayShape, { type: "text" | "callout" }>,
  contentHeight: number,
): number {
  const lineHeight = getTextShapeRenderedLineHeightPx(shape);
  const height = Math.max(lineHeight, contentHeight);
  return shape.type === "callout" ? height + CALLOUT_TEXT_PADDING * 2 : height;
}

/**
 * Watches one element and reports the height its content needs.
 *
 * Returns a callback ref, so the caller does not have to own an element ref just to be measured.
 * `undefined` turns the whole thing off. Interactive surfaces use the callback to write the
 * derived cache back; read-only surfaces may instead keep the reported height as local view state.
 *
 * The reported value is deliberately *not* fed back in: the callback and the last value it sent
 * live in refs, so writing the height back cannot re-arm this effect. The height the caller then
 * applies lands on the wrapper's `min-height`, one level above the element measured here, so
 * growing the box cannot grow the reading that produced it.
 */
export function useOverlayTextContentHeight(
  onMeasuredHeight: ((contentHeight: number) => void) | undefined,
  // Neither destructured nor defaulted, for the same reason as above.
  options?: OverlayTextMeasureOptions,
): (element: HTMLElement | null) => void {
  const rotated = options?.rotated ?? false;
  const remeasureKey = options?.remeasureKey;
  // A state-backed callback ref: the element has to be a dependency of the effect below (a new
  // element needs new observers), and only state makes the mount visible to React.
  const [element, setElement] = useState<HTMLElement | null>(null);
  const callbackRef = useRef(onMeasuredHeight);
  const lastReportedRef = useRef<number | null>(null);

  useEffect(() => {
    callbackRef.current = onMeasuredHeight;
  }, [onMeasuredHeight]);

  useEffect(() => {
    if (!element || !callbackRef.current) {
      return;
    }

    // A new layout input needs one fresh report even when the numeric height matches the previous
    // one. This closes the race between a drag frame's height write-back and the resize patch that
    // follows it with the original cached height.
    lastReportedRef.current = null;

    const report = () => {
      const callback = callbackRef.current;
      if (!callback) {
        return;
      }
      const contentHeight = measureOverlayTextContentHeight(element, { rotated });
      const last = lastReportedRef.current;
      if (last !== null && Math.abs(last - contentHeight) < HEIGHT_EPSILON_PX) {
        return;
      }
      lastReportedRef.current = contentHeight;
      callback(contentHeight);
    };

    let frameId: number | null = null;
    const schedule = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        report();
      });
    };

    report();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    const mutationObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    resizeObserver?.observe(element);
    mutationObserver?.observe(element, {
      attributes: true,
      attributeFilter: [...OVERLAY_TEXT_HEIGHT_ATTRIBUTES],
      childList: true,
      subtree: true,
    });

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
    // The callback and the last reported height are read through refs on purpose (see the note
    // above): neither may re-arm this effect, or writing the height back would restart the watch.
  }, [element, remeasureKey, rotated]);

  return setElement;
}
