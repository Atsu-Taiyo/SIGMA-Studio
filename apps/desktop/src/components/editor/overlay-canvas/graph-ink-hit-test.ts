import type { OverlayPoint } from "@/features/document";

/** UI adapter: query the same SVG paths that are visible, without resampling graph expressions. */
export function hitTestRenderedGraphInk(host: Element, client: OverlayPoint, tolerance = 3): boolean {
  const samples = [new DOMPoint(client.x, client.y)];
  for (let i = 0; i < 8 && tolerance > 0; i += 1) {
    const a = i * Math.PI / 4;
    samples.push(new DOMPoint(client.x + tolerance * Math.cos(a), client.y + tolerance * Math.sin(a)));
  }
  for (const element of host.querySelectorAll("path, line, polyline, polygon, circle, ellipse, rect, text")) {
    if (element.closest("defs, clipPath, mask, marker, pattern")) continue;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility !== "visible") continue;
    let hidden = false;
    for (let parent: Element | null = element; parent && parent !== host; parent = parent.parentElement) {
      const s = getComputedStyle(parent);
      if (s.display === "none" || Number(s.opacity) === 0) { hidden = true; break; }
    }
    if (hidden) continue;
    if (element instanceof SVGTextElement) {
      const r = element.getBoundingClientRect();
      if (client.x >= r.left && client.x <= r.right && client.y >= r.top && client.y <= r.bottom) return true;
      continue;
    }
    if (!(element instanceof SVGGeometryElement)) continue;
    const matrix = element.getScreenCTM();
    if (!matrix || matrix.a * matrix.d === matrix.b * matrix.c) continue;
    const inverse = matrix.inverse();
    const filled = style.fill !== "none" && style.fill !== "rgba(0, 0, 0, 0)" && Number(style.fillOpacity) > 0;
    const stroked = style.stroke !== "none" && style.stroke !== "rgba(0, 0, 0, 0)" && Number(style.strokeOpacity) > 0 && parseFloat(style.strokeWidth) > 0;
    for (const sample of samples) {
      const local = sample.matrixTransform(inverse);
      if ((filled && element.isPointInFill(local)) || (stroked && element.isPointInStroke(local))) return true;
    }
  }
  return false;
}

/** If a graph is not mounted, retain geometric selection rather than making it unreachable. */
export function hasRenderedGraphInk(root: Element | null, shapeId: string, client: OverlayPoint): boolean {
  const host = root?.querySelector(`[data-overlay-shape-id="${CSS.escape(shapeId)}"]`);
  return !host || hitTestRenderedGraphInk(host, client);
}
