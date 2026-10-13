import type { OverlayDash, OverlayPoint, OverlayShape, OverlayTextSize } from "@/features/document";
import { overlayStrokeWidth } from "@/features/rendering/core";

export type SvgMatrix = readonly [number, number, number, number, number, number];
export const SVG_IDENTITY: SvgMatrix = [1, 0, 0, 1, 0, 0];
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

export function svgNumbers(value: string): number[] {
  if (value.replace(NUMBER, "").replace(/[\s,]/g, "")) throw new Error("Invalid SVG numbers");
  const numbers = (value.match(NUMBER) ?? []).map(Number);
  if (!numbers.every(Number.isFinite)) throw new Error("Invalid SVG numbers");
  return numbers;
}

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

/** Straight SVG subpaths. Curves and compound fills stay as SVG, rather than losing geometry. */
function straightPaths(d: string): { points: OverlayPoint[]; closed: boolean }[] | null {
  if (/[^\s,0-9.eE+\-MmLlHhVvZz]/.test(d)) return null;
  const pattern = /[MmLlHhVvZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
  if (d.replace(pattern, "").replace(/[\s,]/g, "")) return null;
  const tokens = d.match(pattern) ?? [];
  const paths: { points: OverlayPoint[]; closed: boolean }[] = [];
  let x = 0, y = 0, command = "", index = 0;
  let current: typeof paths[number] | undefined;
  while (index < tokens.length) {
    if (/^[a-z]$/i.test(tokens[index])) command = tokens[index++];
    const upper = command.toUpperCase(), relative = command !== upper;
    if (upper === "Z") {
      if (!current) return null;
      current.closed = true;
      ({ x, y } = current.points[0]);
      current = undefined;
      command = "";
      continue;
    }
    const count = upper === "M" || upper === "L" ? 2 : upper === "H" || upper === "V" ? 1 : 0;
    if (!count || index + count > tokens.length || tokens.slice(index, index + count).some((v) => /^[a-z]$/i.test(v))) return null;
    const n = tokens.slice(index, index + count).map(Number);
    index += count;
    if (!n.every(Number.isFinite)) return null;
    if (upper === "H") x = n[0] + (relative ? x : 0);
    else if (upper === "V") y = n[0] + (relative ? y : 0);
    else { x = n[0] + (relative ? x : 0); y = n[1] + (relative ? y : 0); }
    if (upper === "M") {
      current = { points: [{ x, y }], closed: false };
      paths.push(current);
      command = relative ? "l" : "L";
    } else if (current) current.points.push({ x, y });
    else return null;
  }
  return paths.length ? paths : null;
}

/** Framework-neutral conversion of one resolved SVG primitive to the existing drawing model. */
export function svgPrimitiveToShapes(
  tag: string,
  attrs: Readonly<Record<string, string>>,
  matrix: SvgMatrix,
  createId: () => string,
): OverlayShape[] | null {
  try {
    if (["clip-path", "mask", "filter", "marker-start", "marker-mid", "marker-end", "vector-effect", "paint-order"]
      .some((key) => attrs[key] && attrs[key] !== "none")) return null;
    const fill = attrs.fill ?? "black", stroke = attrs.stroke ?? "none";
    if (/url\(/.test(fill + stroke)) return null;
    const scaleX = Math.hypot(matrix[0], matrix[1]), scaleY = Math.hypot(matrix[2], matrix[3]);
    const width = length(attrs["stroke-width"], 1) * Math.sqrt(scaleX * scaleY);
    const sizes: OverlayTextSize[] = ["s", "m", "l", "xl"];
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
    const line = (points: OverlayPoint[], closed: boolean): OverlayShape => {
      const mapped = points.map((p) => point(matrix, p.x, p.y));
      const x = Math.min(...mapped.map((p) => p.x)), y = Math.min(...mapped.map((p) => p.y));
      return { ...base(), type: "line", x, y, props: { ...props, kind: "polyline", closed,
        fill: closed ? props.fill : "none", points: mapped.map((p) => ({ x: p.x - x, y: p.y - y })) } };
    };
    if (tag === "line") return [line([{ x: length(attrs.x1), y: length(attrs.y1) }, { x: length(attrs.x2), y: length(attrs.y2) }], false)];
    if (tag === "polyline" || tag === "polygon") {
      const n = svgNumbers(attrs.points ?? "");
      if (n.length < 4 || n.length % 2 || (tag === "polyline" && props.fill === "solid" && n.length > 4)) return null;
      if (tag === "polygon" && n.length === 6 && Math.abs(matrix[0] * matrix[2] + matrix[1] * matrix[3]) < 1e-7 * scaleX * scaleY) {
        const vertices = Array.from({ length: 3 }, (_, i) => ({ x: n[i * 2], y: n[i * 2 + 1] }));
        const left = Math.min(...vertices.map((p) => p.x)), right = Math.max(...vertices.map((p) => p.x));
        const top = Math.min(...vertices.map((p) => p.y)), bottom = Math.max(...vertices.map((p) => p.y));
        const apex = vertices.find((p, i) => vertices.filter((_v, j) => i !== j).every((v) => v.y === (p.y === top ? bottom : top)));
        if (apex && right > left && bottom > top) {
          const box = svgPrimitiveToShapes("rect", { ...attrs, x: String(left), y: String(top), width: String(right - left), height: String(bottom - top) }, matrix, createId)?.[0];
          if (box?.type === "geo") return [{ ...box, flipY: (matrix[0] * matrix[3] - matrix[1] * matrix[2] < 0) !== (apex.y === bottom),
            props: { ...box.props, geo: "triangle", apexX: (apex.x - left) * scaleX } }];
        }
      }
      if (attrs["fill-rule"] === "evenodd" && props.fill === "solid") return null;
      return [line(Array.from({ length: n.length / 2 }, (_, i) => ({ x: n[2 * i], y: n[2 * i + 1] })), tag === "polygon")];
    }
    if (tag === "path") {
      const paths = straightPaths(attrs.d ?? "");
      if (!paths || (props.fill === "solid" && (attrs["fill-rule"] === "evenodd" || paths.length > 1 || paths.some((p) => !p.closed && p.points.length > 2)))) return null;
      return paths.filter((p) => p.points.length >= 2).map((p) => line(p.points, p.closed));
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
      return [line([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], true)];
    }
    if (!orthogonal) return null;
    const center = point(matrix, x + w / 2, y + h / 2);
    return [{ ...base(), type: "geo", x: center.x - w * scaleX / 2, y: center.y - h * scaleY / 2,
      rotation: Math.atan2(matrix[1], matrix[0]),
      props: { ...props, geo: tag === "rect" ? "rectangle" : "ellipse", w: w * scaleX, h: h * scaleY,
        ...(tag === "rect" && radius > 0 ? { radius: radius * scaleX } : {}) } }];
  } catch { return null; }
}
