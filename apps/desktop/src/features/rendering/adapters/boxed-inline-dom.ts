import { isSafeCssDeclarationValue } from "@/features/document/css-safety";
import {
  normalizeBoxedInlineStyle,
  type BoxedInlineRunSegment,
  type BoxedInlineStyleSource,
} from "@/features/rendering/core";

/**
 * The one class name an inline boxed run is drawn with.
 *
 * The Tiptap mark used to emit `.boxed-text-mark` and the static renderer `.print-boxed-text`, which
 * meant every stylesheet rule had to be written twice and any rule that gained a state only on one
 * of them changed the drawing the moment a text shape took focus. Both projections now take the
 * name from here, so `document-surface.css` has a single selector to style.
 */
export const BOXED_TEXT_CLASS_NAME = "boxed-text";

/** Added alongside {@link BOXED_TEXT_CLASS_NAME} when the boxed content is inline math. */
export const BOXED_INLINE_MATH_CLASS_NAME = "boxed-inline-math";

export interface BoxedInlineDomSpec {
  attrs: Record<string, string>;
  className: string;
  style?: Record<string, string>;
}

/**
 * The DOM an inline boxed run is drawn as: class, data attributes and custom properties.
 *
 * Single source for both projections — the Tiptap `boxed` mark's `renderHTML` and the static
 * renderer's boxed element. The runtime measurement channel is deliberately not part of it; see
 * {@link boxedRunDomAttrs}.
 */
export function boxedInlineDomSpec(
  source: BoxedInlineStyleSource,
  options: { math?: boolean } = {},
): BoxedInlineDomSpec {
  const { paddingY, tone, variant } = normalizeBoxedInlineStyle(source);
  const attrs: Record<string, string> = { "data-sigma-doc-boxed-text": "true" };
  if (paddingY !== undefined) {
    attrs["data-sigma-doc-boxed-padding-y"] = String(paddingY);
  }
  // `frame` is the default look, so omit it to keep the DOM clean.
  if (variant && variant !== "frame") {
    attrs["data-sigma-doc-boxed-variant"] = variant;
  }
  if (tone) {
    attrs["data-sigma-doc-boxed-tone"] = tone;
  }
  if (options.math) {
    attrs["data-sigma-doc-boxed-math"] = "true";
  }
  return {
    attrs,
    className: options.math
      ? `${BOXED_TEXT_CLASS_NAME} ${BOXED_INLINE_MATH_CLASS_NAME}`
      : BOXED_TEXT_CLASS_NAME,
    style: boxedTextPaddingVars(paddingY),
  };
}

/**
 * The measurement channel a boxed run's segments carry so the alignment pass can find them again.
 *
 * Only the static projection emits these: the editing surface gets the equivalent from a
 * ProseMirror decoration, which is a view concern the schema cannot express. That asymmetry is the
 * one documented gap in `inline-dom-parity.test.tsx`.
 */
export function boxedRunDomAttrs(boxedRun: BoxedInlineRunSegment | undefined): Record<string, string> {
  if (!boxedRun) {
    return {};
  }
  const attrs: Record<string, string> = {
    "data-boxed-run-height-target": "true",
    "data-boxed-run-id": boxedRun.runId,
    "data-boxed-run-segment-id": boxedRun.segmentId,
    "data-boxed-run-segment-index": String(boxedRun.segmentIndex),
    "data-boxed-run-segment-count": String(boxedRun.segmentCount),
    "data-boxed-run-style-key": boxedRun.styleKey,
  };
  if (boxedRun.connectLeft) {
    attrs["data-boxed-run-connect-left"] = "true";
  }
  if (boxedRun.connectRight) {
    attrs["data-boxed-run-connect-right"] = "true";
  }
  return attrs;
}

/** Inline text styling (`styledText` mark / `style` decoration) as CSS declarations. */
export function inlineTextStyleDeclarations(style: {
  backgroundColor?: string;
  color?: string;
  fontFamily?: string;
  fontSizePt?: number;
}): Record<string, string> | undefined {
  // Empty strings and a zero font size are dropped: React omits such declarations entirely, and
  // an emitted `color:` / `font-size:0pt` would be both meaningless and a parity break.
  const declarations: Record<string, string> = {};
  if (style.color) {
    declarations.color = style.color;
  }
  if (style.backgroundColor) {
    declarations["background-color"] = style.backgroundColor;
  }
  if (style.fontFamily) {
    declarations["font-family"] = style.fontFamily;
    // MathLive's nested `.ML__text` otherwise inherits its math wrapper's fallback stack rather
    // than this styled run. A custom property survives that nesting and keeps `\\text{...}` on
    // the same bundled body face in the editor, preview, SVG and PDF.
    declarations["--sigma-math-text-font-family"] = style.fontFamily;
  }
  if (style.fontSizePt) {
    declarations["font-size"] = `${style.fontSizePt}pt`;
  }
  return Object.keys(declarations).length > 0 ? declarations : undefined;
}

/** CSS declarations as the `style` attribute string ProseMirror's `renderHTML` has to return. */
export function cssTextFromDeclarations(declarations: Record<string, string> | undefined): string | undefined {
  if (!declarations) {
    return undefined;
  }
  // ProseMirror inserts this string as the `style` attribute verbatim. Body inline nodes never
  // pass through the overlay normalization boundary (their colors stay `z.string()` in the
  // schema), so this is where a document-supplied value is stopped from adding declarations.
  const cssText = Object.entries(declarations)
    .filter(([, value]) => isSafeCssDeclarationValue(value))
    .map(([property, value]) => `${property}: ${value}`)
    .join("; ");
  return cssText.length > 0 ? cssText : undefined;
}

/** Browser/CSS projection of the format-neutral boxed-inline run model. */
export function boxedTextPaddingVars(paddingY: unknown): Record<`--${string}`, string> | undefined {
  const normalized = normalizeBoxedInlineStyle({ paddingY }).paddingY;
  return normalized !== undefined
    ? {
        "--boxed-text-padding-y": `${normalized}px`,
        "--boxed-text-line-height": `calc(1.78em + ${normalized * 2 + 2}px)`,
      }
    : undefined;
}


/**
 * Cumulative CSS `zoom` applied to an element (product of every ancestor's `zoom`).
 * Browser rects are zoom-scaled; callers divide measurements by this value before
 * feeding them back into CSS dimensions inside the same zoomed container.
 */
/**
 * How much larger the element is painted than it is laid out.
 *
 * Measured rects are in painted pixels; the boxed-run maths needs the element's own
 * coordinate space, so it divides by this. Both ways of scaling a subtree count: the
 * page canvas paints through a `transform` (so zoom cannot change layout — see
 * docs/pdf-parity-architecture.md), while previews such as the material thumbnail still
 * use the `zoom` property. Reading only one of them reported 1 while the rects were
 * scaled, inflating every measured height by the zoom factor.
 */
export function getEffectiveZoom(element: Element | null): number {
  if (typeof window === "undefined") {
    return 1;
  }
  let zoom = 1;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    const value = Number.parseFloat(style.zoom);
    if (Number.isFinite(value) && value > 0) {
      zoom *= value;
    }
    zoom *= readTransformScaleX(style.transform);
  }
  return zoom > 0 ? zoom : 1;
}

/** The horizontal scale of a computed `transform`; 1 when there is none or it is not a scale. */
function readTransformScaleX(transform: string | undefined): number {
  if (!transform || transform === "none") {
    return 1;
  }
  // `matrix(a, b, c, d, e, f)` and `matrix3d(a, …)` both start with the x scale.
  const match = /^matrix(?:3d)?\(\s*([-\d.eE+]+)/.exec(transform);
  const scaleX = match ? Number.parseFloat(match[1]) : Number.NaN;
  return Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1;
}
