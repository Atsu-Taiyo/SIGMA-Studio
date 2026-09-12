/**
 * Draws a laid-out DOM subtree onto a canvas.
 *
 * Needed by the one surface that has no DOM to put on top of its pixels: the exported video.
 * Everywhere else — the live 3D window, the static shape, print and the SVG export — the TeX
 * labels ride along as real elements, so their glyphs come from the browser's own typesetting.
 * A video frame is pixels only, and rasterizing the elements the browser already laid out is the
 * only way to keep the fractions, roots and superscripts a plain-text fallback would flatten.
 *
 * The walk is deliberately small: text runs, background fills and border rules. That is exactly
 * what KaTeX emits for a label (glyph spans plus the fraction/overline rules), and anything it
 * cannot draw — an inline `<svg>`, a CSS gradient — is skipped rather than approximated.
 */

/** Elements whose box is drawn but whose content must not be: MathML is a screen-reader mirror. */
const SKIPPED_CLASS_NAMES = new Set(["katex-mathml"]);

export interface DomRasterResult {
  canvas: HTMLCanvasElement;
  /** CSS pixels, i.e. the size the element occupies on screen. */
  width: number;
  height: number;
}

/**
 * @param scale Device pixels per CSS pixel. The canvas is drawn at this density so a label stays
 *   sharp when the video is encoded above the on-screen size.
 */
export function rasterizeElement(element: HTMLElement, scale: number): DomRasterResult | null {
  const origin = element.getBoundingClientRect();
  const width = Math.ceil(origin.width);
  const height = Math.ceil(origin.height);
  if (!(width > 0) || !(height > 0)) return null;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.scale(scale, scale);
  context.translate(-origin.left, -origin.top);
  context.textBaseline = "alphabetic";

  try {
    paintNode(context, element);
  } catch {
    // A label that cannot be rasterized is dropped by the caller; it never fails the export.
    return null;
  }
  return { canvas, width, height };
}

function paintNode(context: CanvasRenderingContext2D, node: Node): void {
  if (node instanceof Text) {
    paintText(context, node);
    return;
  }
  if (!(node instanceof HTMLElement)) return;
  if ([...node.classList].some((name) => SKIPPED_CLASS_NAMES.has(name))) return;

  const style = getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden") return;
  const opacity = Number(style.opacity);
  const alpha = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
  if (alpha === 0) return;

  const previousAlpha = context.globalAlpha;
  context.globalAlpha = previousAlpha * alpha;
  paintBox(context, node, style);
  for (const child of node.childNodes) paintNode(context, child);
  context.globalAlpha = previousAlpha;
}

/** Background fill plus each border edge — how KaTeX draws fraction bars and overlines. */
function paintBox(
  context: CanvasRenderingContext2D,
  element: HTMLElement,
  style: CSSStyleDeclaration,
): void {
  const box = element.getBoundingClientRect();
  if (!(box.width > 0) || !(box.height > 0)) return;

  if (isPaintedColor(style.backgroundColor)) {
    context.fillStyle = style.backgroundColor;
    fillRoundedRect(context, box, readCornerRadius(style));
  }

  const edges = [
    { width: style.borderTopWidth, color: style.borderTopColor, x: box.left, y: box.top, w: box.width, h: 0 },
    { width: style.borderBottomWidth, color: style.borderBottomColor, x: box.left, y: box.bottom, w: box.width, h: 0 },
    { width: style.borderLeftWidth, color: style.borderLeftColor, x: box.left, y: box.top, w: 0, h: box.height },
    { width: style.borderRightWidth, color: style.borderRightColor, x: box.right, y: box.top, w: 0, h: box.height },
  ];
  for (const edge of edges) {
    const thickness = Number.parseFloat(edge.width);
    if (!(thickness > 0) || !isPaintedColor(edge.color)) continue;
    context.fillStyle = edge.color;
    // Borders grow inwards from the box edge, so the bottom/right ones start one width back.
    context.fillRect(
      edge.w === 0 && edge.x === box.right ? edge.x - thickness : edge.x,
      edge.h === 0 && edge.y === box.bottom ? edge.y - thickness : edge.y,
      edge.w === 0 ? thickness : edge.w,
      edge.h === 0 ? thickness : edge.h,
    );
  }
}

function paintText(context: CanvasRenderingContext2D, node: Text): void {
  const text = node.data;
  if (!text.trim()) return;
  const parent = node.parentElement;
  if (!parent) return;
  const style = getComputedStyle(parent);
  if (style.visibility === "hidden" || !isPaintedColor(style.color)) return;

  const range = document.createRange();
  range.selectNodeContents(node);
  const rects = [...range.getClientRects()];
  range.detach();
  if (rects.length === 0) return;

  context.font = [
    style.fontStyle,
    style.fontVariant === "normal" ? "" : style.fontVariant,
    style.fontWeight,
    `${style.fontSize}/1`,
    style.fontFamily,
  ].filter(Boolean).join(" ");
  context.fillStyle = style.color;
  const metrics = context.measureText(text);
  const ascent = Number.isFinite(metrics.fontBoundingBoxAscent)
    ? metrics.fontBoundingBoxAscent
    : Number.parseFloat(style.fontSize) * 0.8;

  // A wrapped run yields one rect per line; labels are `white-space: nowrap`, so in practice this
  // is a single rect and the whole string is drawn once at its measured left edge.
  if (rects.length === 1) {
    context.fillText(text, rects[0].left, rects[0].top + ascent);
    return;
  }
  let consumed = 0;
  for (const rect of rects) {
    const remaining = text.slice(consumed);
    const fitted = fitToWidth(context, remaining, rect.width);
    context.fillText(fitted, rect.left, rect.top + ascent);
    consumed += fitted.length;
  }
}

/** Longest prefix of `text` that still measures at most `width`; never returns the empty string. */
function fitToWidth(context: CanvasRenderingContext2D, text: string, width: number): string {
  for (let length = text.length; length > 1; length -= 1) {
    if (context.measureText(text.slice(0, length)).width <= width + 0.5) return text.slice(0, length);
  }
  return text;
}

function fillRoundedRect(context: CanvasRenderingContext2D, box: DOMRect, radius: number): void {
  if (radius <= 0 || typeof context.roundRect !== "function") {
    context.fillRect(box.left, box.top, box.width, box.height);
    return;
  }
  context.beginPath();
  context.roundRect(box.left, box.top, box.width, box.height, Math.min(radius, box.width / 2, box.height / 2));
  context.fill();
}

function readCornerRadius(style: CSSStyleDeclaration): number {
  const radius = Number.parseFloat(style.borderTopLeftRadius);
  return Number.isFinite(radius) ? radius : 0;
}

/** `transparent` and any fully transparent `rgba()` paint nothing; drawing them costs a fill. */
function isPaintedColor(color: string): boolean {
  if (!color || color === "transparent") return false;
  const match = /^rgba?\(([^)]*)\)$/.exec(color.trim());
  if (!match) return true;
  const parts = match[1].split(/[,/]/).map((part) => Number.parseFloat(part));
  return parts.length < 4 || !(parts[3] === 0);
}
