import type { Graph3DObject, Graph3DSpec } from "@/features/document";
import { getGraph3DIntersectionGeometry, type Graph3DPoint2 } from "@/features/drawing";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const tShape = createCurrentLocaleTranslator("shape");

export interface Graph3DSectionSvgResult {
  svg: string;
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * A flat common part, seen straight on, as a standalone SVG.
 *
 * A common part that has come out flat is a plane figure, and a plane figure belongs in the body
 * text at full size rather than as a corner of a 3D window the reader has to rotate. Only the flat
 * case is drawable this way: a shared volume, a line and a point have no true shape on paper, so
 * this returns null for them and the caller keeps its button disabled.
 */
export function createGraph3DIntersectionSvg(
  spec: Graph3DSpec,
  regionId: string,
  options: { width?: number; height?: number; padding?: number } = {},
): Graph3DSectionSvgResult | null {
  const region = spec.regions.find((candidate) => candidate.id === regionId);
  if (!region || region.kind !== "objectIntersection") return null;
  const members = region.objectIds
    .map((objectId) => spec.objects.find((object) => object.id === objectId))
    .filter((object): object is Graph3DObject => object !== undefined);
  if (members.length < 2) return null;
  // Built from the members rather than read off the scene: an author can want the plane figure in
  // the body without also showing the common part inside the 3D window.
  const variables = Object.fromEntries(spec.parameters.map((parameter) => [parameter.name, parameter.value]));
  let geometry;
  try {
    geometry = getGraph3DIntersectionGeometry(members, variables, {
      ...(region.resolution === undefined ? {} : { resolution: region.resolution }),
    });
  } catch {
    return null;
  }
  if (geometry.kind !== "section") return null;
  const loops = geometry.section.loops;
  const points = loops.flatMap((loop) => loop.points2D);
  if (points.length === 0) return null;

  const bounds = pointBounds(points);
  const spanX = Math.max(1e-6, bounds.maxX - bounds.minX);
  const spanY = Math.max(1e-6, bounds.maxY - bounds.minY);
  const padding = Math.max(0, options.padding ?? 18);
  // The picture keeps the figure's own proportions: a square section must not arrive as a
  // rectangle just because the default frame is one.
  const width = Math.max(80, Math.round(options.width ?? 360));
  const height = Math.max(
    60,
    Math.round(options.height ?? ((width - padding * 2) * (spanY / spanX) + padding * 2)),
  );
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const mapPoint = (point: Graph3DPoint2) => ({
    x: width / 2 + (point.x - (bounds.minX + bounds.maxX) / 2) * scale,
    // SVG's y grows downwards; the plane basis' y grows upwards.
    y: height / 2 - (point.y - (bounds.minY + bounds.maxY) / 2) * scale,
  });

  const fill = region.fill;
  const lineColor = escapeXml(region.edgeColor ?? (fill.mode === "none" ? "#111827" : fill.color));
  const fillOpacity = fill.mode === "none" ? 0 : clampOpacity(fill.opacity ?? 0.3);
  const patternId = "intersection-hatch";
  const fillValue = fill.mode === "pattern"
    ? `url(#${patternId})`
    : fill.mode === "solid"
      ? escapeXml(fill.color)
      : "none";
  const pattern = fill.mode === "pattern"
    ? `<pattern id="${patternId}" patternUnits="userSpaceOnUse" width="8" height="8"><rect width="8" height="8" fill="#ffffff"/><path d="M-1 9L9-1" stroke="${escapeXml(fill.color)}" stroke-width="1.2"/></pattern>`
    : "";
  // One path with `evenodd`, so a section with a hole in it reads as a ring, not as two shapes.
  const path = loops.map((loop) => `${loop.points2D.map((point, index) => {
    const mapped = mapPoint(point);
    return `${index === 0 ? "M" : "L"}${formatNumber(mapped.x)} ${formatNumber(mapped.y)}`;
  }).join(" ")} Z`).join(" ");
  const area = fillValue === "none"
    ? ""
    : `<path d="${path}" fill="${fillValue}" fill-opacity="${fillOpacity}" fill-rule="evenodd" clip-rule="evenodd"/>`;
  const contour = region.showEdges === false
    ? ""
    : `<path d="${path}" fill="none" fill-rule="evenodd" clip-rule="evenodd" stroke="${lineColor}" stroke-width="1.5" stroke-linejoin="round"/>`;
  const label = escapeXml(region.label || tShape("graph3d.intersectionFallback"));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}"><rect width="100%" height="100%" fill="#ffffff"/><defs>${pattern}</defs>${area}${contour}</svg>`;
  return {
    svg,
    dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    width,
    height,
  };
}

function pointBounds(points: Graph3DPoint2[]) {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function clampOpacity(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.3));
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
