/**
 * The single decision of "what may a user-drawn problem frame be".
 *
 * A custom frame is one SVG that the renderer cuts into nine pieces (`border-image`). The SVG is
 * only ever drawn as an image, where browsers run no script and load no external file, but the
 * markup is also saved in the document, shown to people, and sent to AI — so it is normalized once,
 * here, and anything that could do more than paint is dropped or rejected.
 *
 * A **leaf module with no imports** (like `css-safety.ts`), so the document schema, the renderer
 * and the settings dialog can all reach it without a dependency cycle.
 */

export const CUSTOM_FRAME_STYLE_ID = "custom";

export const MAX_CUSTOM_FRAME_SVG_LENGTH = 80_000;
export const CUSTOM_FRAME_BORDER_RANGE = { min: 4, max: 48 } as const;
export const CUSTOM_FRAME_PADDING_RANGE = { min: 4, max: 48 } as const;
export const DEFAULT_CUSTOM_FRAME_BORDER_PX = 16;
export const DEFAULT_CUSTOM_FRAME_PADDING_PX = 12;

/**
 * The canvas an AI is asked to draw on. The app cuts it into corners of `slice` units, so the
 * request tells the model exactly where the corners end.
 */
export const AI_FRAME_DRAWING = { width: 160, height: 100, slice: 24 } as const;

export type CustomFrameRejection =
  | "empty"
  | "notSvg"
  | "tooLarge"
  | "noViewBox"
  | "unsafe";

export type NormalizedFrameSvg =
  | { ok: true; svg: string; width: number; height: number }
  | { ok: false; reason: CustomFrameRejection };

const SVG_ELEMENT = /<svg\b[\s\S]*<\/svg\s*>/i;
const SVG_ROOT_OPEN_TAG = /<svg\b[^>]*>/i;
const SCRIPT_OR_EMBED = /<\s*(?:script|foreignObject|iframe|object|embed|audio|video)\b[\s\S]*?(?:<\s*\/\s*(?:script|foreignObject|iframe|object|embed|audio|video)\s*>|$)/gi;
const EVENT_HANDLER = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const HREF_ATTRIBUTE = /\s+(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const INLINE_RASTER = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/i;
const STILL_UNSAFE = /<\s*(?:script|foreignObject)|javascript\s*:|<!ENTITY|<!DOCTYPE[^>]*\[/i;
const EXTERNAL_URL_FUNCTION = /url\(\s*(?:"|')?\s*(?!#)[^)]*\)/gi;

function readAttribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return match ? (match[1] ?? match[2]) : undefined;
}

function parseLength(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*([\d.]+)\s*(?:px|pt)?\s*$/i.exec(value);
  const parsed = match ? Number(match[1]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export interface FrameSvgViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function readSvgViewBox(svg: string): FrameSvgViewBox | undefined {
  const root = SVG_ROOT_OPEN_TAG.exec(svg)?.[0];
  if (!root) return undefined;
  const raw = readAttribute(root, "viewBox");
  if (raw) {
    const parts = raw.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
    }
    return undefined;
  }
  const width = parseLength(readAttribute(root, "width"));
  const height = parseLength(readAttribute(root, "height"));
  return width && height ? { x: 0, y: 0, width, height } : undefined;
}

function formatNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** Replace the size attributes of the root `<svg>` and make sure it declares its namespace. */
function withRootGeometry(svg: string, box: FrameSvgViewBox): string {
  return svg.replace(SVG_ROOT_OPEN_TAG, (tag) => {
    let attributes = tag
      .replace(/^<svg\b/i, "")
      .replace(/\/?>$/, "")
      .replace(/\s(?:width|height|viewBox)\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
    if (!/\sxmlns\s*=/.test(attributes)) {
      attributes += ' xmlns="http://www.w3.org/2000/svg"';
    }
    const geometry = ` width="${formatNumber(box.width)}" height="${formatNumber(box.height)}" viewBox="${formatNumber(box.x)} ${formatNumber(box.y)} ${formatNumber(box.width)} ${formatNumber(box.height)}"`;
    return `<svg${attributes}${geometry}>`;
  });
}

/**
 * Turns whatever the user pasted (an SVG file, an SVG from TikZ, text an AI wrote around an SVG)
 * into the one canonical form: a single `<svg>` element with a namespace, an explicit size and a
 * `viewBox`, without scripts, event handlers or references to anything outside the drawing.
 */
export function normalizeFrameSvg(input: string): NormalizedFrameSvg {
  const text = input.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > MAX_CUSTOM_FRAME_SVG_LENGTH * 2) return { ok: false, reason: "tooLarge" };
  const element = SVG_ELEMENT.exec(text)?.[0];
  if (!element) return { ok: false, reason: "notSvg" };

  const cleaned = element
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(SCRIPT_OR_EMBED, "")
    .replace(EVENT_HANDLER, "")
    .replace(HREF_ATTRIBUTE, (whole, doubleQuoted: string | undefined, singleQuoted: string | undefined) => {
      const target = (doubleQuoted ?? singleQuoted ?? "").trim();
      return target.startsWith("#") || INLINE_RASTER.test(target) ? whole : "";
    })
    .replace(EXTERNAL_URL_FUNCTION, "none")
    .trim();

  if (STILL_UNSAFE.test(cleaned)) return { ok: false, reason: "unsafe" };
  if (cleaned.length > MAX_CUSTOM_FRAME_SVG_LENGTH) return { ok: false, reason: "tooLarge" };
  const box = readSvgViewBox(cleaned);
  if (!box) return { ok: false, reason: "noViewBox" };
  return { ok: true, svg: withRootGeometry(cleaned, box), width: box.width, height: box.height };
}

/** The value `svg` must already have if it came out of `normalizeFrameSvg` (used by the schema). */
export function isCanonicalFrameSvg(svg: string): boolean {
  const result = normalizeFrameSvg(svg);
  return result.ok && result.svg === svg.trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The largest corner that still leaves a middle band to stretch. */
export function getMaxCustomFrameSlice(width: number, height: number): number {
  return Math.max(1, Math.floor(Math.min(width, height) / 2) - 1);
}

export function clampCustomFrameSlice(slice: number, width: number, height: number): number {
  return clamp(Math.round(slice * 10) / 10, 1, getMaxCustomFrameSlice(width, height));
}

export interface CustomFrameGeometry {
  svg: string;
  width: number;
  height: number;
  slice: number;
  borderPx: number;
  paddingPx: number;
}

/** A drawing's corners are usually about a quarter of its shorter side. */
export function createCustomFrameGeometry(
  drawing: { svg: string; width: number; height: number },
  overrides: Partial<Pick<CustomFrameGeometry, "borderPx" | "paddingPx" | "slice">> = {},
): CustomFrameGeometry {
  const slice = clampCustomFrameSlice(
    overrides.slice ?? Math.min(drawing.width, drawing.height) * 0.25,
    drawing.width,
    drawing.height,
  );
  const borderPx = clamp(
    overrides.borderPx ?? DEFAULT_CUSTOM_FRAME_BORDER_PX,
    CUSTOM_FRAME_BORDER_RANGE.min,
    CUSTOM_FRAME_BORDER_RANGE.max,
  );
  const paddingPx = clamp(
    overrides.paddingPx ?? DEFAULT_CUSTOM_FRAME_PADDING_PX,
    CUSTOM_FRAME_PADDING_RANGE.min,
    CUSTOM_FRAME_PADDING_RANGE.max,
  );
  return {
    svg: drawing.svg,
    width: drawing.width,
    height: drawing.height,
    slice,
    borderPx,
    paddingPx,
  };
}

export interface CustomFrameMetrics {
  slice: number;
  borderPx: number;
  paddingPx: number;
}

/**
 * What the renderer may trust about a stored frame. The numbers end up inside `style` attributes
 * that some serializers write without escaping (see `css-safety.ts`), and a document can arrive
 * from anywhere, so anything that is not a finite number in range is replaced here, at the sink,
 * rather than relying on every reader having validated the file first.
 */
export function resolveCustomFrameMetrics(frame: {
  width: number;
  height: number;
  slice: number;
  borderPx: number;
  paddingPx: number;
}): CustomFrameMetrics {
  const finite = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const width = Math.max(1, finite(frame.width, 1));
  const height = Math.max(1, finite(frame.height, 1));
  return {
    slice: clampCustomFrameSlice(finite(frame.slice, Math.min(width, height) * 0.25), width, height),
    borderPx: clamp(finite(frame.borderPx, DEFAULT_CUSTOM_FRAME_BORDER_PX), CUSTOM_FRAME_BORDER_RANGE.min, CUSTOM_FRAME_BORDER_RANGE.max),
    paddingPx: clamp(finite(frame.paddingPx, DEFAULT_CUSTOM_FRAME_PADDING_PX), CUSTOM_FRAME_PADDING_RANGE.min, CUSTOM_FRAME_PADDING_RANGE.max),
  };
}

export interface CustomFrameEdges {
  top: boolean;
  bottom: boolean;
}

/**
 * A frame split across columns or pages is drawn one piece per fragment, and only the outer edges
 * of the whole problem are closed. For a piece that is open at the top or bottom the matching band
 * is cropped away, so the side edges continue straight through the break instead of showing the
 * corner artwork again.
 */
export function cropCustomFrameSvg(
  frame: Pick<CustomFrameGeometry, "svg" | "slice">,
  edges: CustomFrameEdges,
): string {
  if (edges.top && edges.bottom) return frame.svg;
  const box = readSvgViewBox(frame.svg);
  if (!box) return frame.svg;
  const cropTop = edges.top ? 0 : frame.slice;
  const cropBottom = edges.bottom ? 0 : frame.slice;
  return withRootGeometry(frame.svg, {
    x: box.x,
    y: box.y + cropTop,
    width: box.width,
    height: box.height - cropTop - cropBottom,
  });
}
