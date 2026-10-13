import type { OverlayBounds } from "@/features/document";
import type { SvgFragmentNode } from "@/lib/svg-image-source";

/** Measure only the converter's validated static tree; never insert raw SVG/HTML strings. */
export function measureSvgFragment(root: SvgFragmentNode): OverlayBounds | null {
  const container = document.createElement("div");
  Object.assign(container.style, { position: "fixed", left: "-10000px", top: "0", opacity: "0", pointerEvents: "none" });
  const create = (node: SvgFragmentNode): SVGElement => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", node.tag);
    for (const [key, value] of Object.entries(node.attrs)) element.setAttribute(key, value);
    for (const child of node.children) element.append(typeof child === "string" ? document.createTextNode(child) : create(child));
    return element;
  };
  try {
    const svg = create(root) as SVGSVGElement;
    svg.style.display = "block";
    svg.style.width = `${root.attrs.width}px`;
    svg.style.height = `${root.attrs.height}px`;
    container.append(svg);
    document.body.append(container);
    const bbox = svg.getBBox(), matrix = svg.getScreenCTM(), frame = container.getBoundingClientRect();
    if (!matrix || (bbox.width <= 0 && bbox.height <= 0)) return null;
    const points = [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x, bbox.y + bbox.height], [bbox.x + bbox.width, bbox.y + bbox.height]]
      .map(([x, y]) => ({ x: matrix.a * x + matrix.c * y + matrix.e - frame.left, y: matrix.b * x + matrix.d * y + matrix.f - frame.top }));
    const x = Math.min(...points.map((p) => p.x)), y = Math.min(...points.map((p) => p.y));
    // getBBox excludes stroke by default. Leave room for thick outlines and antialiasing.
    let strokePadding = 2;
    const markers = Array.from(svg.querySelectorAll("marker"));
    for (const element of Array.from(svg.querySelectorAll("path, rect, circle, ellipse, line, polyline, polygon, text"))) {
      const style = getComputedStyle(element), transform = (element as SVGGraphicsElement).getScreenCTM();
      if (!transform) continue;
      const scale = Math.max(Math.hypot(transform.a, transform.b), Math.hypot(transform.c, transform.d));
      const strokeWidth = Number.parseFloat(style.strokeWidth || "1");
      strokePadding = Math.max(strokePadding, strokeWidth * scale * Math.max(1, Number.parseFloat(style.strokeMiterlimit || "4")));
      for (const value of [style.markerStart, style.markerMid, style.markerEnd]) {
        const id = /#([^'"\s)]+)['"]?\)/.exec(value)?.[1];
        if (!id) continue;
        const marker = markers.find((candidate) => candidate.id === id);
        if (!marker) return null;
        const width = Number(marker.getAttribute("markerWidth") ?? 3), height = Number(marker.getAttribute("markerHeight") ?? 3);
        const viewBox = (marker.getAttribute("viewBox") ?? `0 0 ${width} ${height}`).trim().split(/[\s,]+/).map(Number);
        const rx = Number(marker.getAttribute("refX") ?? 0), ry = Number(marker.getAttribute("refY") ?? 0);
        if (![width, height, rx, ry, ...viewBox].every(Number.isFinite) || viewBox.length !== 4 || viewBox[2] <= 0 || viewBox[3] <= 0) return null;
        const units = marker.getAttribute("markerUnits") === "userSpaceOnUse" ? 1 : strokeWidth;
        // A marker's viewport clips its contents. This covers all orientations and ref offsets.
        const extent = width + height + Math.abs(rx - viewBox[0]) * width / viewBox[2] + Math.abs(ry - viewBox[1]) * height / viewBox[3];
        strokePadding = Math.max(strokePadding, extent * units * scale * 2);
      }
    }
    if (!Number.isFinite(strokePadding)) return null;
    return { x: x - strokePadding, y: y - strokePadding,
      w: Math.max(...points.map((p) => p.x)) - x + strokePadding * 2,
      h: Math.max(...points.map((p) => p.y)) - y + strokePadding * 2 };
  } catch { return null; }
  finally { container.remove(); }
}
