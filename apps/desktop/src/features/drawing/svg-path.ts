import type { OverlayPoint } from "@/features/document";

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

export function svgNumbers(value: string): number[] {
  if (value.replace(NUMBER, "").replace(/[\s,]/g, "")) throw new Error("Invalid SVG numbers");
  const numbers = (value.match(NUMBER) ?? []).map(Number);
  if (!numbers.every(Number.isFinite)) throw new Error("Invalid SVG numbers");
  return numbers;
}

export interface SvgSubpath {
  /** A curve holds exactly `[start, control, end]`: the quadratic Bézier the `curve` line draws from three points. */
  points: OverlayPoint[];
  closed: boolean;
  curve: boolean;
}

/**
 * Straight subpaths, and a subpath that is a single quadratic Bézier.
 * Arcs, cubics, chained or mixed curves and compound fills stay as SVG, rather than losing geometry.
 */
export function parseSvgSubpaths(d: string): SvgSubpath[] | null {
  if (/[^\s,0-9.eE+\-MmLlHhVvZzQq]/.test(d)) return null;
  const pattern = /[MmLlHhVvZzQq]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
  if (d.replace(pattern, "").replace(/[\s,]/g, "")) return null;
  const tokens = d.match(pattern) ?? [];
  const paths: SvgSubpath[] = [];
  let x = 0, y = 0, command = "", index = 0;
  let current: SvgSubpath | undefined;
  while (index < tokens.length) {
    if (/^[a-z]$/i.test(tokens[index])) command = tokens[index++];
    const upper = command.toUpperCase(), relative = command !== upper;
    if (upper === "Z") {
      if (!current || current.curve) return null;
      current.closed = true;
      ({ x, y } = current.points[0]);
      current = undefined;
      command = "";
      continue;
    }
    const count = upper === "M" || upper === "L" ? 2 : upper === "H" || upper === "V" ? 1 : upper === "Q" ? 4 : 0;
    if (!count || index + count > tokens.length || tokens.slice(index, index + count).some((v) => /^[a-z]$/i.test(v))) return null;
    const n = tokens.slice(index, index + count).map(Number);
    index += count;
    if (!n.every(Number.isFinite)) return null;
    if (upper === "Q") {
      // A second curve, or a curve after a line, is not one quadratic Bézier.
      if (!current || current.curve || current.points.length !== 1) return null;
      const offsetX = relative ? x : 0, offsetY = relative ? y : 0;
      current.points.push({ x: n[0] + offsetX, y: n[1] + offsetY }, { x: n[2] + offsetX, y: n[3] + offsetY });
      current.curve = true;
      ({ x, y } = current.points[2]);
      continue;
    }
    if (upper === "H") x = n[0] + (relative ? x : 0);
    else if (upper === "V") y = n[0] + (relative ? y : 0);
    else { x = n[0] + (relative ? x : 0); y = n[1] + (relative ? y : 0); }
    if (upper === "M") {
      current = { points: [{ x, y }], closed: false, curve: false };
      paths.push(current);
      command = relative ? "l" : "L";
    } else if (current && !current.curve) current.points.push({ x, y });
    else return null;
  }
  return paths.length ? paths : null;
}
