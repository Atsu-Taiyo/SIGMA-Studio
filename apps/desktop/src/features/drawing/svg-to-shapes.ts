import type { OverlayArrowhead, OverlayDash, OverlayPoint, OverlayShape, OverlayTextSize } from "@/features/document";
import { overlayStrokeWidth } from "@/features/rendering/core";
import { svgMarkerArrowhead, type SvgMarkerDefinition, type SvgMarkerLookup } from "./svg-markers";
import { parseSvgSubpaths, svgNumbers } from "./svg-path";

export { svgNumbers };
/**
 * The editor draws a geo shape's outline this far inside its box (`GeoSvgBody`, `getGeoPolygonPoints`),
 * so a box that is to show an SVG outline's centre line has to be this much larger on every side.
 */
const GEO_OUTLINE_INSET = 1;
export type SvgMatrix = readonly [number, number, number, number, number, number];
/** Every line size the editor offers, thinnest first. A stroke becomes the nearest one. */
export const SVG_LINE_SIZES: readonly OverlayTextSize[] = ["xs", "s", "m", "l", "xl"];
export const SVG_IDENTITY: SvgMatrix = [1, 0, 0, 1, 0, 0];

export function multiplySvgMatrices(a: SvgMatrix, b: SvgMatrix): SvgMatrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

export function parseSvgTransform(value = ""): SvgMatrix {
  let matrix = SVG_IDENTITY;
  const parts = [...value.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)];
  if (value.replace(/([a-zA-Z]+)\s*\(([^)]*)\)/g, "").replace(/[\s,]/g, "")) throw new Error("Invalid transform");
  for (const [, name, values] of parts) {
    const n = svgNumbers(values);
    let next: SvgMatrix;
    if (name === "matrix" && n.length === 6) next = n as unknown as SvgMatrix;
    else if (name === "translate" && (n.length === 1 || n.length === 2)) next = [1, 0, 0, 1, n[0], n[1] ?? 0];
    else if (name === "scale" && (n.length === 1 || n.length === 2)) next = [n[0], 0, 0, n[1] ?? n[0], 0, 0];
    else if (name === "rotate" && (n.length === 1 || n.length === 3)) {
      const angle = n[0] * Math.PI / 180;
      const c = Math.cos(angle), s = Math.sin(angle), x = n[1] ?? 0, y = n[2] ?? 0;
      next = [c, s, -s, c, x - c * x + s * y, y - s * x - c * y];
    } else if ((name === "skewX" || name === "skewY") && n.length === 1) {
      const tangent = Math.tan(n[0] * Math.PI / 180);
      next = name === "skewX" ? [1, 0, tangent, 1, 0, 0] : [1, tangent, 0, 1, 0, 0];
    } else throw new Error("Unsupported transform");
    matrix = multiplySvgMatrices(matrix, next);
  }
  if (!matrix.every(Number.isFinite)) throw new Error("Invalid transform");
  return matrix;
}

function point(matrix: SvgMatrix, x: number, y: number): OverlayPoint {
  return { x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] };
}

function length(value: string | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  const numbers = svgNumbers(value.replace(/px$/, ""));
  if (numbers.length !== 1) throw new Error("Unsupported length");
  return numbers[0];
}

/** Framework-neutral conversion of one resolved SVG primitive to the existing drawing model. */
export function svgPrimitiveToShapes(
  tag: string,
  attrs: Readonly<Record<string, string>>,
  matrix: SvgMatrix,
  createId: () => string,
  markers?: SvgMarkerLookup,
  /** The sizes a stroke may become (the nearest wins). The AI's conversion leaves out `xs`, which older versions cannot read. */
  lineSizes: readonly OverlayTextSize[] = SVG_LINE_SIZES,
): OverlayShape[] | null {
  try {
    if (["clip-path", "mask", "filter", "vector-effect", "paint-order"].some((key) => attrs[key] && attrs[key] !== "none")) return null;
    // Markers become the line's own arrow heads, and only where a head can reproduce them.
    const markerKeys = (["marker-start", "marker-mid", "marker-end"] as const).filter((key) => attrs[key] && attrs[key] !== "none");
    if (markerKeys.length && (!markers || !["line", "polyline", "path"].includes(tag) || markerKeys.includes("marker-mid"))) return null;
    const fill = attrs.fill ?? "black", stroke = attrs.stroke ?? "none";
    if (/url\(/.test(fill + stroke)) return null;
    const scaleX = Math.hypot(matrix[0], matrix[1]), scaleY = Math.hypot(matrix[2], matrix[3]);
    const width = length(attrs["stroke-width"], 1) * Math.sqrt(scaleX * scaleY);
    const sizes = lineSizes.length > 0 ? lineSizes : SVG_LINE_SIZES;
    const size = sizes.reduce((best, candidate) => Math.abs(overlayStrokeWidth(candidate) - width) < Math.abs(overlayStrokeWidth(best) - width) ? candidate : best);
    const dashValues = attrs["stroke-dasharray"] && attrs["stroke-dasharray"] !== "none" ? svgNumbers(attrs["stroke-dasharray"]) : [];
    if (dashValues.some((n) => n < 0)) return null;
    const dash: OverlayDash = dashValues.some((n) => n > 0) ? dashValues[0] <= Math.max(1, length(attrs["stroke-width"], 1)) ? "dotted" : "dashed" : "solid";
    const props = {
      fill: fill === "none" ? "none" as const : "solid" as const,
      fillColor: fill === "currentColor" ? attrs.color ?? "black" : fill,
      fillOpacity: length(attrs["fill-opacity"], 1),
      color: stroke === "none" ? "black" : stroke === "currentColor" ? attrs.color ?? "black" : stroke,
      strokeOpacity: stroke === "none" || width <= 0 ? 0 : length(attrs["stroke-opacity"], 1),
      labelColor: "black", dash, size,
    };
    if ([props.fillOpacity, props.strokeOpacity].some((n) => n < 0 || n > 1)) return null;
    const base = () => ({ id: createId(), x: 0, y: 0, rotation: 0 });
    const markerAt: Partial<Record<"start" | "end", SvgMarkerDefinition>> = {};
    if (markerKeys.length) {
      const similar = Math.abs(matrix[0] * matrix[2] + matrix[1] * matrix[3]) < 1e-7 * scaleX * scaleY && Math.abs(scaleX - scaleY) <= 1e-7 * scaleX;
      if (stroke === "none" || width <= 0 || !similar) return null;
      for (const key of markerKeys) {
        const id = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)$/.exec(attrs[key])?.[1];
        const marker = id ? markers?.(id) : undefined;
        if (!marker) return null;
        markerAt[key === "marker-start" ? "start" : "end"] = marker;
      }
    }
    const line = (points: OverlayPoint[], closed: boolean, kind: "polyline" | "curve" = "polyline"): OverlayShape | null => {
      const mapped = points.map((p) => point(matrix, p.x, p.y));
      if (markerKeys.length && closed) return null;
      const heads: Partial<Record<"start" | "end", OverlayArrowhead>> = {};
      // A head's tip is where the marker's ink ends, which is past the vertex the marker is anchored on.
      for (const endpoint of ["start", "end"] as const) {
        const marker = markerAt[endpoint];
        if (!marker) continue;
        const at = endpoint === "start" ? 0 : mapped.length - 1, from = endpoint === "start" ? 1 : mapped.length - 2;
        // Which way the head has to point: out of the line, measured where the marker is drawn (before the transform).
        const outward = { x: points[at].x - points[from].x, y: points[at].y - points[from].y };
        const head = svgMarkerArrowhead(marker, endpoint, { color: props.color, strokeWidth: length(attrs["stroke-width"], 1), pxPerUserUnit: scaleX, size, outward });
        const dx = mapped[at].x - mapped[from].x, dy = mapped[at].y - mapped[from].y, span = Math.hypot(dx, dy);
        if (!head || !(span > 0)) return null;
        mapped[at] = { x: mapped[at].x + dx / span * head.overshoot, y: mapped[at].y + dy / span * head.overshoot };
        heads[endpoint] = head.head;
      }
      const x = Math.min(...mapped.map((p) => p.x)), y = Math.min(...mapped.map((p) => p.y));
      return { ...base(), type: "line", x, y, props: { ...props, kind, closed,
        ...(heads.start ? { arrowheadStart: heads.start } : {}), ...(heads.end ? { arrowheadEnd: heads.end } : {}),
        fill: closed ? props.fill : "none", points: mapped.map((p) => ({ x: p.x - x, y: p.y - y })) } };
    };
    if (tag === "line") {
      const shape = line([{ x: length(attrs.x1), y: length(attrs.y1) }, { x: length(attrs.x2), y: length(attrs.y2) }], false);
      return shape && [shape];
    }
    if (tag === "polyline" || tag === "polygon") {
      const n = svgNumbers(attrs.points ?? "");
      if (n.length < 4 || n.length % 2 || (tag === "polyline" && props.fill === "solid" && n.length > 4)) return null;
      if (tag === "polygon" && n.length === 6 && Math.abs(matrix[0] * matrix[2] + matrix[1] * matrix[3]) < 1e-7 * scaleX * scaleY) {
        const vertices = Array.from({ length: 3 }, (_, i) => ({ x: n[i * 2], y: n[i * 2 + 1] }));
        const left = Math.min(...vertices.map((p) => p.x)), right = Math.max(...vertices.map((p) => p.x));
        const top = Math.min(...vertices.map((p) => p.y)), bottom = Math.max(...vertices.map((p) => p.y));
        const apex = vertices.find((p, i) => vertices.filter((_v, j) => i !== j).every((v) => v.y === (p.y === top ? bottom : top)));
        if (apex && right > left && bottom > top) {
          const box = svgPrimitiveToShapes("rect", { ...attrs, x: String(left), y: String(top), width: String(right - left), height: String(bottom - top) }, matrix, createId, undefined, lineSizes)?.[0];
          if (box?.type === "geo") return [{ ...box, flipY: (matrix[0] * matrix[3] - matrix[1] * matrix[2] < 0) !== (apex.y === bottom),
            props: { ...box.props, geo: "triangle", apexX: (apex.x - left) * scaleX + GEO_OUTLINE_INSET } }];
        }
      }
      if (attrs["fill-rule"] === "evenodd" && props.fill === "solid") return null;
      const shape = line(Array.from({ length: n.length / 2 }, (_, i) => ({ x: n[2 * i], y: n[2 * i + 1] })), tag === "polygon");
      return shape && [shape];
    }
    if (tag === "path") {
      const paths = parseSvgSubpaths(attrs.d ?? "");
      // A marker sits on the first and last vertex of the whole path, which a second subpath would leave in the middle.
      if (!paths || (markerKeys.length && paths.length > 1) ||
        (props.fill === "solid" && (attrs["fill-rule"] === "evenodd" || paths.length > 1 || paths.some((p) => !p.closed && p.points.length > 2)))) return null;
      const shapes = paths.filter((p) => p.points.length >= 2).map((p) => line(p.points, p.closed, p.curve ? "curve" : "polyline"));
      return shapes.every((shape) => shape) ? shapes as OverlayShape[] : null;
    }
    if (!["rect", "circle", "ellipse"].includes(tag)) return null;
    let x = length(attrs.x), y = length(attrs.y), w = length(attrs.width), h = length(attrs.height);
    if (tag !== "rect") {
      const rx = length(tag === "circle" ? attrs.r : attrs.rx), ry = length(tag === "circle" ? attrs.r : attrs.ry);
      x = length(attrs.cx) - rx; y = length(attrs.cy) - ry; w = rx * 2; h = ry * 2;
    }
    if (w <= 0 || h <= 0 || scaleX <= 0 || scaleY <= 0) return null;
    const orthogonal = Math.abs(matrix[0] * matrix[2] + matrix[1] * matrix[3]) < 1e-7 * scaleX * scaleY;
    const radius = Math.max(length(attrs.rx, length(attrs.ry)), length(attrs.ry, length(attrs.rx)));
    if (tag === "rect" && (!orthogonal || (radius && (Math.abs(scaleX - scaleY) > 1e-7 || length(attrs.rx, radius) !== length(attrs.ry, radius))))) {
      if (radius) return null;
      const shape = line([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], true);
      return shape && [shape];
    }
    if (!orthogonal) return null;
    const center = point(matrix, x + w / 2, y + h / 2);
    const boxWidth = w * scaleX + 2 * GEO_OUTLINE_INSET, boxHeight = h * scaleY + 2 * GEO_OUTLINE_INSET;
    return [{ ...base(), type: "geo", x: center.x - boxWidth / 2, y: center.y - boxHeight / 2,
      rotation: Math.atan2(matrix[1], matrix[0]),
      props: { ...props, geo: tag === "rect" ? "rectangle" : "ellipse", w: boxWidth, h: boxHeight,
        ...(tag === "rect" && radius > 0 ? { radius: radius * scaleX } : {}) } }];
  } catch { return null; }
}
