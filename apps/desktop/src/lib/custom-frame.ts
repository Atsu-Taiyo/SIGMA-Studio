import {
  createCustomFrameGeometry,
  cropCustomFrameSvg,
  normalizeFrameSvg,
  resolveCustomFrameMetrics,
  type CustomFrame,
  type TikzImageSource,
} from "@/features/document";

/**
 * A user-drawn frame (`CustomFrame`) works the same wherever it is used: a problem or a box. This
 * module holds what both share — turning a drawing into a frame, and the CSS custom properties the
 * `custom-frame` stylesheet rules read. Only "which block, and where on it" differs per target.
 */

/** What a drawing is being made for. Conversations with the AI, notices and panels key on it. */
export type CustomFrameTargetKind = "problem" | "box";

export interface CustomFrameTarget {
  kind: CustomFrameTargetKind;
  /** The SigmaDoc id of the problem or the box. */
  id: string;
}

/** A finished drawing, already through `normalizeFrameSvg`. */
export interface CustomFrameDrawing {
  svg: string;
  width: number;
  height: number;
}

const PX_TO_MM = 25.4 / 96;

function formatCssLength(px: number, unit: "px" | "mm"): string {
  const value = unit === "mm" ? px * PX_TO_MM : px;
  return `${Math.round(value * 1000) / 1000}${unit}`;
}

/** `<img src>` for a drawing. Shown as an image, it can never run anything. */
export function customFrameImageSrc(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function cssImage(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * A value `getCustomFrameStyle` produced. `encodeURIComponent` leaves nothing that can end the
 * quoted URL or the declaration (`"`, `;`, `\`, braces, angle brackets and line breaks are all
 * escaped), so a value of exactly this shape is safe in a serialized `style` attribute even though
 * it contains `url(` — which the generic check (`isSafeCssDeclarationValue`) refuses on purpose.
 */
const CUSTOM_FRAME_IMAGE_VALUE = /^url\("data:image\/svg\+xml,[A-Za-z0-9\-_.!~*'()%]*"\)$/;

export function isCustomFrameImageValue(value: string): boolean {
  return CUSTOM_FRAME_IMAGE_VALUE.test(value);
}

/**
 * `"split"`: one image per combination of closed edges, for a surface that draws a frame that
 * continues onto the next column or page as separate pieces (it must not repeat its top or bottom
 * artwork there; see `cropCustomFrameSvg`). `"closed"`: only the whole drawing, for a surface that
 * draws the frame whole and clips it at the break.
 */
export type CustomFrameImages = "split" | "closed";

const styleCache = new WeakMap<CustomFrame, Map<string, Record<string, string>>>();

/**
 * The inline custom properties the `custom-frame` rules in the stylesheets read. `unit` picks the
 * length unit of the surface: the problem editor measures in px and its print in mm — the same
 * drawing has to land on the same physical size in both.
 */
export function getCustomFrameStyle(
  custom: CustomFrame,
  unit: "px" | "mm",
  images: CustomFrameImages = "split",
): Record<string, string> {
  const cacheKey = `${unit}:${images}`;
  const cached = styleCache.get(custom)?.get(cacheKey);
  if (cached) {
    return cached;
  }
  const metrics = resolveCustomFrameMetrics(custom);
  const svg = typeof custom.svg === "string" ? custom.svg : "";
  const crop = (top: boolean, bottom: boolean) =>
    cssImage(cropCustomFrameSvg({ svg, slice: metrics.slice }, { top, bottom }));
  const style: Record<string, string> = {
    "--custom-frame-border": formatCssLength(metrics.borderPx, unit),
    "--custom-frame-padding": formatCssLength(metrics.paddingPx, unit),
    "--custom-frame-slice": String(metrics.slice),
    "--custom-frame-image-closed": crop(true, true),
    ...(images === "split"
      ? {
          "--custom-frame-image-open-bottom": crop(true, false),
          "--custom-frame-image-open-top": crop(false, true),
          "--custom-frame-image-open-both": crop(false, false),
        }
      : {}),
  };
  const perKey = styleCache.get(custom) ?? new Map<string, Record<string, string>>();
  perKey.set(cacheKey, style);
  styleCache.set(custom, perKey);
  return style;
}

/**
 * A finished drawing becomes the frame. The thickness and padding of the frame it replaces
 * survive a new drawing. The corner size carries over only while the drawing keeps the same shape,
 * unless the drawing says which corner size it was made for.
 */
export function applyCustomFrameDrawing(
  previous: CustomFrame | undefined,
  drawing: CustomFrameDrawing,
  options: { slice?: number; tikz?: TikzImageSource } = {},
): CustomFrame {
  const sameShape = previous !== undefined
    && previous.width === drawing.width
    && previous.height === drawing.height;
  const geometry = createCustomFrameGeometry(drawing, {
    borderPx: previous?.borderPx,
    paddingPx: previous?.paddingPx,
    slice: options.slice ?? (sameShape ? previous.slice : undefined),
  });
  return { ...geometry, ...(options.tikz ? { tikz: options.tikz } : {}) };
}

/** The same drawing with another corner size, thickness or padding. The TikZ source stays. */
export function updateCustomFrameGeometry(
  previous: CustomFrame,
  patch: Partial<Pick<CustomFrame, "slice" | "borderPx" | "paddingPx">>,
): CustomFrame {
  const geometry = createCustomFrameGeometry(previous, { ...previous, ...patch });
  const { tikz } = previous;
  return { ...geometry, ...(tikz ? { tikz } : {}) };
}

/**
 * Builds a saveable `CustomFrame` from loosely typed input (an AI tool call, a pasted snippet). The
 * drawing goes through the same normalizer as the settings dialogs, so a frame that arrives this
 * way is stored in the one canonical form the document schema accepts. Returns `undefined` when
 * there is no drawing at all, and throws when there is one that cannot be used — instead of saving
 * something the file would later refuse to open.
 */
export function normalizeCustomFrameInput(input: unknown, path = "custom"): CustomFrame | undefined {
  if (typeof input !== "object" || input === null || typeof (input as { svg?: unknown }).svg !== "string") {
    return undefined;
  }
  const source = input as Record<string, unknown>;
  const drawing = normalizeFrameSvg(source.svg as string);
  if (!drawing.ok) {
    throw new Error(`${path}.svg cannot be used as a frame drawing (${drawing.reason})`);
  }
  const numberOrUndefined = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
  return createCustomFrameGeometry(drawing, {
    slice: numberOrUndefined(source.slice),
    borderPx: numberOrUndefined(source.borderPx),
    paddingPx: numberOrUndefined(source.paddingPx),
  });
}
