import {
  getGraph3DAxisColors,
  resolveGraph3DDimensionEndStyle,
  type Graph3DAxisEndStyle,
  type Graph3DExpressionRange,
  type Graph3DFillStyle,
  type Graph3DObject,
  type Graph3DSpec,
  type Graph3DViewSettings,
} from "@/features/document";
import {
  buildGraph3DSceneGeometry,
  createGraph3DRenderSpec,
  graph3DBoundedSolidResolution,
  graph3DPrimitiveRingSamples,
  type Graph3DMeshGeometry,
  type Graph3DPoint3,
  type Graph3DRenderQuality,
  type Graph3DSceneGeometry,
} from "@/features/drawing";
import {
  createGraph3DProjector,
  getArrowheadMarkerSpec,
  graph3DAxisDashPattern,
  graph3DAxisEndScale,
  graph3DAxisEndShaftTrim,
  graph3DDimensionDashPattern,
  graph3DDimensionHeadLength,
  graph3DDimensionRadius,
  graph3DLambertShade,
  GRAPH3D_AXIS_ARROW_LENGTH_RATIO,
  GRAPH3D_AXIS_LENGTH,
  GRAPH3D_DEFAULT_BACKGROUND_COLOR,
  GRAPH3D_DEFAULT_DIMENSION_COLOR,
  GRAPH3D_DEFAULT_INTERSECTION_OPACITY,
  GRAPH3D_DEFAULT_OBJECT_COLOR,
  GRAPH3D_DEFAULT_OBJECT_OPACITY,
  GRAPH3D_DEFAULT_WIREFRAME_COLOR,
  GRAPH3D_GRID,
  GRAPH3D_INTERSECTION_POINT_RADIUS,
  type ArrowheadMarkerSpec,
  type Graph3DProjectedPoint,
  type Graph3DProjector,
} from "@/features/rendering/core";

/**
 * A 3D figure drawn without a WebGL context.
 *
 * The 3D window renders through three.js, so a spec reaching the page from a plain node process —
 * an MCP proposal, a headless export — had nothing but a "3D" placeholder to show. This projects
 * the same evaluated mesh the live scene uses through the same camera arithmetic
 * (`createGraph3DProjector`) and paints it back to front, which is close enough to the WebGL frame
 * to read as the same figure.
 *
 * **No text is ever emitted.** TeX labels stay a live DOM/SVG layer in every view
 * (`graph3d-preview.ts`, `overlay-svg.ts`'s `graph3DLabelsToSvg`); baking them here would draw
 * every label twice on the printed page — and keeping the output free of `<text>` is also what
 * makes rasterizing it font-independent, so a server with no fonts installed still gets the figure.
 *
 * Deliberately not reproduced from the WebGL scene: the stencil-composited cut sections (cuts are
 * never built — `graph3d-scene.ts`) and shadows (unimplemented on the three side too).
 */
export interface Graph3DSceneSvgResult {
  /**
   * `null` when the figure was over the triangle budget and no picture was produced. The caller
   * decides what to do with that — inserting the figure must not fail just because a preview
   * could not be drawn.
   */
  svg: string | null;
  width: number;
  height: number;
  truncated: boolean;
}

export interface Graph3DSceneSvgOptions {
  width: number;
  height: number;
  /** Omitted means `balanced`, the density the live view drops to while a figure is dragged. */
  quality?: Graph3DRenderQuality;
}

/**
 * The most drawn pieces — faces, wireframe edges, contours, dots — worth serializing for one
 * picture.
 *
 * The depth sort itself is O(n log n) and cheap, but every piece is also an element in the output:
 * past this the SVG string alone runs to tens of megabytes, which the rasterizer and the 2MB asset
 * budget both refuse long before the drawing would have helped anyone. Counting the wireframe and
 * the contours rather than the faces alone matters because a wireframed mesh emits four pieces per
 * triangle, not one.
 */
export const MAX_GRAPH3D_SVG_PRIMITIVES = 60_000;

/**
 * Sampling ceiling for a headless drawing, tighter than the live view's.
 *
 * A marched solid is cubic in its resolution: the model may author 256, and the same call may
 * carry dozens of objects. The live view can afford that because it is drawn once per frame on a
 * GPU; here it is one synchronous pass inside a request, and a still at 48 is already finer than
 * a 360px-wide figure can show.
 */
export const MAX_GRAPH3D_HEADLESS_RESOLUTION = 48;

/** The same ceiling for the plot counts of a parametric surface, curve or solid of revolution. */
export const MAX_GRAPH3D_HEADLESS_SAMPLES = 48;

/**
 * The most grid points worth *sampling* for one picture, across the whole figure.
 *
 * Separate from the primitive budget below, and checked before anything is built: that one bounds
 * how big the output is, this one bounds what it costs to get there. A marched solid is cubic in
 * its resolution, so capping each object still leaves dozens of them multiplying together — and
 * unlike the output, the sampling cost is already spent by the time the result can be measured.
 * Every default density is far under this, so an ordinary figure never meets it: the value is
 * measured, not guessed — a marched solid samples roughly 400 cells per millisecond here, so this
 * is about a second of sampling for the very worst figure the input schema can express.
 */
export const MAX_GRAPH3D_HEADLESS_SAMPLE_CELLS = 400_000;

/** The samplers' own fallbacks, used only to estimate the cost of an unstated density. */
const DEFAULT_ESTIMATED_RESOLUTION = 22;
const DEFAULT_ESTIMATED_SAMPLES = 36;
const BOX_PRIMITIVE_TRIANGLES = 12;

/** Screen radius of a bare vertex, in px. */
const POINT_RADIUS_PX = 2;
const LINE_WIDTH_PX = 1;
const SECTION_CONTOUR_WIDTH_PX = 1.5;
/** Grid lines and axes are cut into pieces this long, in scene units, before being sorted. */
const SEGMENT_PIECE_SCENE_LENGTH = 0.5;
const MAX_SEGMENT_PIECES = 32;
const HATCH_PATTERN_ID_PREFIX = "graph3d-scene-hatch";

interface Drawable {
  /** Distance from the camera; the picture is painted from the largest down. */
  depth: number;
  svg: string;
}

interface Point2 {
  x: number;
  y: number;
}

export function createGraph3DSceneSvg(
  spec: Graph3DSpec,
  options: Graph3DSceneSvgOptions,
): Graph3DSceneSvgResult | null {
  const width = Math.round(options.width);
  const height = Math.round(options.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  // The ceiling is put on the authored density first and the quality factor applied to what is
  // left: capping afterwards would let an authored 128 arrive as a proportional 83 and march a
  // single solid past the whole picture's triangle budget on its own.
  const renderSpec = createGraph3DRenderSpec(
    clampGraph3DHeadlessResolution(spec),
    options.quality ?? "balanced",
  );
  if (estimateGraph3DSampleCells(renderSpec) > MAX_GRAPH3D_HEADLESS_SAMPLE_CELLS) {
    return { svg: null, width, height, truncated: true };
  }

  let scene: Graph3DSceneGeometry;
  try {
    scene = buildGraph3DSceneGeometry(renderSpec);
  } catch {
    return null;
  }

  if (countScenePrimitives(scene) > MAX_GRAPH3D_SVG_PRIMITIVES) {
    return { svg: null, width, height, truncated: true };
  }

  const view = renderSpec.view;
  const projector = createGraph3DProjector(renderSpec.camera, width, height);
  const pixelsPerUnit = estimatePixelsPerUnit(projector, renderSpec.camera.target);
  const items: Drawable[] = [
    ...(view.showGrid ? gridDrawables(projector) : []),
    ...(view.showAxes ? axisDrawables(projector, view, renderSpec.camera.position, pixelsPerUnit) : []),
    ...scene.objects.flatMap((item) => objectDrawables(projector, item)),
    ...scene.intersections.flatMap((item, index) => intersectionDrawables(projector, item, index, pixelsPerUnit)),
    ...scene.annotations.flatMap((item) => (
      item.kind === "dimension"
        ? dimensionDrawables(projector, item, renderSpec.camera.position, pixelsPerUnit)
        : []
    )),
  ];
  // Painter's algorithm: the far side is drawn first and covered by what is in front of it.
  items.sort((left, right) => right.depth - left.depth);

  const defs = hatchPatternDefs(scene);
  const background = `<rect width="100%" height="100%" fill="${safeCssColor(view.backgroundColor, GRAPH3D_DEFAULT_BACKGROUND_COLOR)}"/>`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    defs,
    background,
    ...items.map((item) => item.svg),
    "</svg>",
  ].join("");

  return { svg, width, height, truncated: false };
}

/**
 * The same figure with every scalar field capped for a headless pass.
 *
 * `createGraph3DRenderSpec` scales the authored counts by a factor; this puts a ceiling under
 * whatever that produced, so one absurd authored resolution cannot survive as a proportional
 * fraction of itself.
 */
export function clampGraph3DHeadlessResolution(spec: Graph3DSpec): Graph3DSpec {
  const capRange = (range: Graph3DExpressionRange): Graph3DExpressionRange => (
    (range.samples ?? 0) > MAX_GRAPH3D_HEADLESS_SAMPLES
      ? { ...range, samples: MAX_GRAPH3D_HEADLESS_SAMPLES }
      : range
  );
  const capResolution = <T extends { resolution?: number }>(object: T): T => (
    (object.resolution ?? 0) > MAX_GRAPH3D_HEADLESS_RESOLUTION
      ? { ...object, resolution: MAX_GRAPH3D_HEADLESS_RESOLUTION }
      : object
  );
  // Every density the model can author, not only the marched ones: a parametric surface or a
  // solid of revolution at 256×256 costs as much as a marched solid does.
  const capObject = (object: Graph3DObject): Graph3DObject => {
    switch (object.kind) {
      case "implicitSurface":
      case "boundedSolid":
      case "primitive":
        return capResolution(object);
      case "parametricSurface":
        return { ...object, u: capRange(object.u), v: capRange(object.v) };
      case "parametricCurve":
        return { ...object, range: capRange(object.range) };
      case "solidOfRevolution":
        return {
          ...object,
          axisRange: capRange(object.axisRange),
          ...(object.angleRange ? { angleRange: capRange(object.angleRange) } : {}),
        };
      default:
        return object;
    }
  };
  return {
    ...spec,
    objects: spec.objects.map(capObject),
    regions: spec.regions.map((region) => (
      region.kind === "objectIntersection" ? capResolution(region) : region
    )),
  };
}

/**
 * Roughly how many grid points the figure will evaluate, in the units each sampler works in.
 *
 * An upper bound, not a measurement: the point is to refuse an unreasonable figure before paying
 * for it, and every unstated density falls back to the sampler's own modest default so an
 * ordinary spec is never rejected by a pessimistic guess.
 */
function estimateGraph3DSampleCells(spec: Graph3DSpec): number {
  const samplesOf = (range: Graph3DExpressionRange | undefined) => range?.samples ?? DEFAULT_ESTIMATED_SAMPLES;
  const objects = spec.objects.reduce((total, object) => {
    switch (object.kind) {
      case "implicitSurface":
        return total + (object.resolution ?? DEFAULT_ESTIMATED_RESOLUTION) ** 3;
      case "boundedSolid":
        return total + graph3DBoundedSolidResolution(object) ** 3;
      case "parametricSurface":
        return total + samplesOf(object.u) * samplesOf(object.v);
      case "parametricCurve":
        return total + samplesOf(object.range);
      case "solidOfRevolution":
        return total + samplesOf(object.axisRange) * samplesOf(object.angleRange);
      case "primitive":
        // A box is 12 triangles whatever the resolution says; a curved one derives its ring from
        // its own radius when nothing was authored, so an ordinary solid is charged what it costs.
        return object.primitive === "box"
          ? total + BOX_PRIMITIVE_TRIANGLES
          : total + graph3DPrimitiveRingSamples(1, object.resolution) ** 2;
      case "polyhedron":
        return total + object.vertices.length + object.faces.length;
      default:
        return total + 1;
    }
  }, 0);
  const regions = spec.regions.reduce((total, region) => (
    region.kind === "objectIntersection"
      ? total + (region.resolution ?? DEFAULT_ESTIMATED_RESOLUTION) ** 3
      : total
  ), 0);
  return objects + regions;
}

/** How many elements the drawing would emit, counted the same way the emitters below do. */
function countScenePrimitives(scene: Graph3DSceneGeometry): number {
  const objects = scene.objects.reduce((total, item) => {
    const { triangles, lineSegments, positions } = item.geometry;
    if (triangles.length === 0) {
      return total + (lineSegments.length > 0 ? lineSegments.length : positions.length);
    }
    const wireframe = item.object.style?.wireframe
      ? (lineSegments.length > 0 ? lineSegments.length : triangles.length * 3)
      : 0;
    return total + triangles.length + wireframe;
  }, 0);
  const intersections = scene.intersections.reduce((total, item) => {
    const geometry = item.geometry;
    if (geometry.kind === "solid") {
      return total + geometry.geometry.triangles.length + (geometry.seams?.length ?? 0);
    }
    if (geometry.kind === "surface") {
      return total + geometry.geometry.triangles.length + geometry.contour.length;
    }
    if (geometry.kind === "curve") return total + geometry.segments.length;
    if (geometry.kind === "points") return total + geometry.points.length;
    if (geometry.kind === "section") return total + 1;
    return total;
  }, 0);
  return objects + intersections;
}

// --- objects -------------------------------------------------------------------------------

function objectDrawables(
  projector: Graph3DProjector,
  item: Graph3DSceneGeometry["objects"][number],
): Drawable[] {
  const style = item.object.style;
  const color = safeCssColor(style?.color, GRAPH3D_DEFAULT_OBJECT_COLOR);
  const opacity = clampUnit(style?.opacity, GRAPH3D_DEFAULT_OBJECT_OPACITY);
  const geometry = item.geometry;

  if (geometry.triangles.length > 0) {
    const faces = shadedFaceDrawables(projector, geometry, color, opacity);
    if (!style?.wireframe) return faces;
    const wireColor = safeCssColor(
      style.wireframeColor ?? style.color,
      GRAPH3D_DEFAULT_WIREFRAME_COLOR,
    );
    const wireOpacity = opacity < 0.8 ? Math.min(1, Math.max(0.2, opacity + 0.2)) : 1;
    return [...faces, ...meshLineDrawables(projector, geometry, wireColor, wireOpacity)];
  }

  if (geometry.lineSegments.length > 0) {
    return meshLineDrawables(projector, geometry, color, opacity);
  }
  return geometry.positions.flatMap((point) => {
    const projected = projector.project(point);
    return projected
      ? [{ depth: projected.depth, svg: circleSvg(projected, POINT_RADIUS_PX, color, opacity) }]
      : [];
  });
}

function shadedFaceDrawables(
  projector: Graph3DProjector,
  geometry: Graph3DMeshGeometry,
  color: string,
  opacity: number,
): Drawable[] {
  // A colour we cannot take apart (a CSS name) is drawn flat rather than replaced: losing the
  // shading keeps the figure readable, whereas substituting a hex fallback would silently repaint
  // an authored red surface in the default slate.
  const rgb = parseCssColor(color);
  return geometry.triangles.flatMap((triangle) => {
    const corners = triangle.map((index) => geometry.positions[index]);
    const projected = projectPolygon(projector, corners);
    if (!projected) return [];
    // No normals are stored, so each face computes its own; the winding is not guaranteed, which
    // is why the shade uses |n·L| and lights both facings identically (a one-sided rule leaves
    // random black patches across an otherwise smooth surface).
    const normal = cross3(subtract3(corners[1], corners[0]), subtract3(corners[2], corners[0]));
    if (!(Math.hypot(normal.x, normal.y, normal.z) > 1e-9)) return [];
    const shade = graph3DLambertShade(normal);
    return [{
      depth: projected.depth,
      svg: `<path d="${polygonPath(projected.points)}" fill="${rgb ? shadeColor(rgb, shade) : color}" fill-opacity="${formatNumber(opacity)}"/>`,
    }];
  });
}

function meshLineDrawables(
  projector: Graph3DProjector,
  geometry: Graph3DMeshGeometry,
  color: string,
  opacity: number,
): Drawable[] {
  const source = geometry.lineSegments.length > 0
    ? geometry.lineSegments.map(([from, to]) => [geometry.positions[from], geometry.positions[to]] as const)
    : geometry.triangles.flatMap((triangle) => ([
      [geometry.positions[triangle[0]], geometry.positions[triangle[1]]],
      [geometry.positions[triangle[1]], geometry.positions[triangle[2]]],
      [geometry.positions[triangle[2]], geometry.positions[triangle[0]]],
    ] as const));
  return source.flatMap(([from, to]) => segmentDrawable(projector, from, to, color, opacity, LINE_WIDTH_PX));
}

// --- shared common parts -------------------------------------------------------------------

function intersectionDrawables(
  projector: Graph3DProjector,
  item: Graph3DSceneGeometry["intersections"][number],
  index: number,
  pixelsPerUnit: number,
): Drawable[] {
  const fill = item.region.fill;
  if (fill.mode === "none") return [];
  const fillColor = safeCssColor(fill.color, GRAPH3D_DEFAULT_OBJECT_COLOR);
  const opacity = clampUnit(fill.opacity, GRAPH3D_DEFAULT_INTERSECTION_OPACITY);
  const edgeColor = safeCssColor(item.region.edgeColor ?? fill.color, GRAPH3D_DEFAULT_OBJECT_COLOR);
  const showEdges = item.region.showEdges !== false;
  const geometry = item.geometry;

  if (geometry.kind === "solid") {
    const body = shadedFaceDrawables(projector, geometry.geometry, fillColor, opacity);
    if (!showEdges) return body;
    // Where the shared body changes which member it is following, the seams are the answer; a
    // marched surface has no clean creases to derive edges from.
    const edges = geometry.seams
      ? geometry.seams.flatMap(([from, to]) => segmentDrawable(projector, from, to, edgeColor, 1, LINE_WIDTH_PX))
      : [];
    return [...body, ...edges];
  }

  if (geometry.kind === "surface") {
    const patch = shadedFaceDrawables(projector, geometry.geometry, fillColor, opacity);
    const contour = showEdges || geometry.geometry.triangles.length === 0
      ? geometry.contour.flatMap(([from, to]) => segmentDrawable(projector, from, to, edgeColor, 1, SECTION_CONTOUR_WIDTH_PX))
      : [];
    return [...patch, ...contour];
  }

  if (geometry.kind === "curve") {
    return geometry.segments.flatMap(([from, to]) => (
      segmentDrawable(projector, from, to, edgeColor, 1, SECTION_CONTOUR_WIDTH_PX)
    ));
  }

  if (geometry.kind === "points") {
    const radius = Math.max(1.5, GRAPH3D_INTERSECTION_POINT_RADIUS * pixelsPerUnit);
    return geometry.points.flatMap((point) => {
      const projected = projector.project(point);
      return projected ? [{ depth: projected.depth, svg: circleSvg(projected, radius, edgeColor, 1) }] : [];
    });
  }

  if (geometry.kind !== "section") return [];
  // One path with `evenodd`, so a section with a hole in it reads as a ring, not as two shapes.
  const loops = geometry.section.loops
    .map((loop) => projectPolygon(projector, loop.points3D))
    .filter((loop): loop is { points: Point2[]; depth: number } => loop !== null);
  if (loops.length === 0) return [];
  const depth = loops.reduce((total, loop) => total + loop.depth, 0) / loops.length;
  const path = loops.map((loop) => polygonPath(loop.points)).join(" ");
  const paint = fill.mode === "pattern" ? `url(#${hatchPatternId(index)})` : fillColor;
  const area = `<path d="${path}" fill="${paint}" fill-opacity="${formatNumber(opacity)}" fill-rule="evenodd" clip-rule="evenodd"/>`;
  const outline = showEdges
    ? `<path d="${path}" fill="none" fill-rule="evenodd" clip-rule="evenodd" stroke="${edgeColor}" stroke-width="${SECTION_CONTOUR_WIDTH_PX}" stroke-linejoin="round"/>`
    : "";
  return [{ depth, svg: `${area}${outline}` }];
}

/**
 * One hatch per patterned common part, keyed by position rather than by region id: the id is
 * model-authored text and must never reach an `id` attribute.
 */
function hatchPatternDefs(scene: Graph3DSceneGeometry): string {
  const patterns = scene.intersections.flatMap((item, index) => {
    const fill = item.region.fill;
    if (fill.mode !== "pattern") return [];
    const color = safeCssColor((fill as Extract<Graph3DFillStyle, { mode: "pattern" }>).color, GRAPH3D_DEFAULT_OBJECT_COLOR);
    return [`<pattern id="${hatchPatternId(index)}" patternUnits="userSpaceOnUse" width="8" height="8">`
      + `<rect width="8" height="8" fill="${GRAPH3D_DEFAULT_BACKGROUND_COLOR}"/>`
      + `<path d="M-1 9L9-1" stroke="${color}" stroke-width="1.2"/></pattern>`];
  });
  return patterns.length > 0 ? `<defs>${patterns.join("")}</defs>` : "";
}

function hatchPatternId(index: number): string {
  return `${HATCH_PATTERN_ID_PREFIX}-${index}`;
}

// --- grid, axes, dimensions ------------------------------------------------------------------

function gridDrawables(projector: Graph3DProjector): Drawable[] {
  const half = GRAPH3D_GRID.size / 2;
  const step = GRAPH3D_GRID.size / GRAPH3D_GRID.divisions;
  const drawables: Drawable[] = [];
  for (let index = 0; index <= GRAPH3D_GRID.divisions; index += 1) {
    const offset = -half + index * step;
    const center = Math.abs(offset) < 1e-9;
    const color = center ? GRAPH3D_GRID.centerLineColor : GRAPH3D_GRID.gridColor;
    drawables.push(
      ...segmentDrawable(projector, { x: offset, y: -half, z: 0 }, { x: offset, y: half, z: 0 }, color, 1, LINE_WIDTH_PX, undefined, true),
      ...segmentDrawable(projector, { x: -half, y: offset, z: 0 }, { x: half, y: offset, z: 0 }, color, 1, LINE_WIDTH_PX, undefined, true),
    );
  }
  return drawables;
}

function axisDrawables(
  projector: Graph3DProjector,
  view: Graph3DViewSettings,
  cameraPosition: Graph3DPoint3,
  pixelsPerUnit: number,
): Drawable[] {
  const colors = getGraph3DAxisColors(view);
  const length = GRAPH3D_AXIS_LENGTH;
  const dash = graph3DAxisDashPattern(view.axisLineStyle ?? "solid", length * 2);
  const endStyle: Graph3DAxisEndStyle = view.axisEndStyle ?? "arrow";
  const spec = getArrowheadMarkerSpec(endStyle);
  const headLength = length * GRAPH3D_AXIS_ARROW_LENGTH_RATIO;

  return (["x", "y", "z"] as const).flatMap((axis) => {
    const direction: Graph3DPoint3 = {
      x: axis === "x" ? 1 : 0,
      y: axis === "y" ? 1 : 0,
      z: axis === "z" ? 1 : 0,
    };
    const color = safeCssColor(colors[axis], GRAPH3D_DEFAULT_WIREFRAME_COLOR);
    const head = spec
      ? axisEndDrawables(projector, spec, cameraPosition, scale3(direction, length), direction, headLength, color, pixelsPerUnit)
      : { drawables: [], shaftTrim: 0 };
    const shaft = segmentDrawable(
      projector,
      scale3(direction, -length),
      scale3(direction, length - head.shaftTrim),
      color,
      1,
      LINE_WIDTH_PX,
      dash ? { dashSize: dash.dashSize * pixelsPerUnit, gapSize: dash.gapSize * pixelsPerUnit } : undefined,
      true,
    );
    return [...shaft, ...head.drawables];
  });
}

/**
 * The flat end of an axis or a dimension line, turned to face the camera.
 *
 * Mirrors what `keepFlatAxisEndFacingCamera` does per frame in the live scene: the head's own +x
 * follows the line while its plane is turned toward the viewpoint. With a fixed camera that is one
 * basis, computed once.
 */
function axisEndDrawables(
  projector: Graph3DProjector,
  spec: ArrowheadMarkerSpec,
  cameraPosition: Graph3DPoint3,
  endpoint: Graph3DPoint3,
  direction: Graph3DPoint3,
  headLength: number,
  color: string,
  pixelsPerUnit: number,
): { drawables: Drawable[]; shaftTrim: number } {
  const scale = graph3DAxisEndScale(spec, headLength);
  const shaftTrim = graph3DAxisEndShaftTrim(spec) * scale;
  const towardCamera = subtract3(cameraPosition, endpoint);
  const normal = normalize3(subtract3(towardCamera, scale3(direction, dot3(towardCamera, direction))))
    ?? normalize3(subtract3({ x: 0, y: 0, z: 1 }, scale3(direction, direction.z)))
    ?? { x: 1, y: 0, z: 0 };
  const across = normalize3(cross3(normal, direction));
  if (!across) return { drawables: [], shaftTrim };

  const toWorld = (markerX: number, markerY: number): Graph3DPoint3 => add3(
    endpoint,
    add3(scale3(direction, (markerX - spec.tipX) * scale), scale3(across, (spec.refY - markerY) * scale)),
  );

  if (spec.geometry.kind === "circle") {
    const center = projector.project(toWorld(spec.geometry.cx, spec.geometry.cy));
    if (!center) return { drawables: [], shaftTrim };
    const radius = Math.max(0.5, spec.geometry.r * scale * pixelsPerUnit);
    return {
      shaftTrim,
      drawables: [{ depth: center.depth, svg: circleSvg(center, radius, color, 1) }],
    };
  }

  const outline = spec.geometry;
  const projected = projectPolygon(projector, outline.points.map((point) => toWorld(point.x, point.y)));
  if (!projected) return { drawables: [], shaftTrim };
  const svg = outline.closed && outline.filled
    ? `<path d="${polygonPath(projected.points)}" fill="${color}"/>`
    : `<path d="${openPath(projected.points, outline.closed)}" fill="none" stroke="${color}" stroke-width="${formatNumber(Math.max(0.5, outline.strokeWidth * scale * pixelsPerUnit))}" stroke-linejoin="round" stroke-linecap="round"/>`;
  return { shaftTrim, drawables: [{ depth: projected.depth, svg }] };
}

function dimensionDrawables(
  projector: Graph3DProjector,
  annotation: Extract<Graph3DSceneGeometry["annotations"][number], { kind: "dimension" }>,
  cameraPosition: Graph3DPoint3,
  pixelsPerUnit: number,
): Drawable[] {
  const color = safeCssColor(annotation.color, GRAPH3D_DEFAULT_DIMENSION_COLOR);
  const span = subtract3(annotation.to, annotation.from);
  const total = Math.hypot(span.x, span.y, span.z);
  if (!(total > 1e-6)) return [];
  const direction = scale3(span, 1 / total);
  // The live scene draws a dimension as a cylinder of this radius, so the stroke is derived from
  // the same world measurement instead of using the authored width as a pixel count.
  const radius = graph3DDimensionRadius(annotation.lineWidth);
  const spec = getArrowheadMarkerSpec(resolveGraph3DDimensionEndStyle(annotation.endStyle));
  const headLength = graph3DDimensionHeadLength(radius, total);
  const heads = spec
    ? [
      axisEndDrawables(projector, spec, cameraPosition, annotation.from, negate3(direction), headLength, color, pixelsPerUnit),
      axisEndDrawables(projector, spec, cameraPosition, annotation.to, direction, headLength, color, pixelsPerUnit),
    ]
    : [];
  const trim = heads[0]?.shaftTrim ?? 0;
  const dash = graph3DDimensionDashPattern(annotation.lineStyle ?? "solid", radius);
  const shaft = segmentDrawable(
    projector,
    add3(annotation.from, scale3(direction, trim)),
    add3(annotation.to, scale3(direction, -trim)),
    color,
    1,
    Math.max(0.5, radius * 2 * pixelsPerUnit),
    dash ? { dashSize: dash.dashSize * pixelsPerUnit, gapSize: dash.gapSize * pixelsPerUnit } : undefined,
    true,
  );
  // `labelTex` is intentionally not drawn — the label layer draws it over this picture.
  return [...shaft, ...heads.flatMap((head) => head.drawables)];
}

// --- projection and serialization --------------------------------------------------------------

/**
 * Every corner of a primitive, or `null` when any of them is at or behind the near plane.
 *
 * TODO: a primitive straddling the near plane is dropped whole rather than clipped against it.
 * Every authored camera sits outside its subject, so nothing has been observed to straddle it;
 * polygon clipping is the fix if a figure ever needs the camera inside the geometry.
 */
function projectPolygon(
  projector: Graph3DProjector,
  points: readonly Graph3DPoint3[],
): { points: Point2[]; depth: number } | null {
  const projected: Point2[] = [];
  let depth = 0;
  for (const point of points) {
    const result = projector.project(point);
    if (!result) return null;
    projected.push({ x: result.x, y: result.y });
    depth += result.depth;
  }
  return projected.length > 0 ? { points: projected, depth: depth / projected.length } : null;
}

/**
 * A line, painted at the depth of its **nearest** end and optionally cut into pieces first.
 *
 * Both halves of that matter for a painter's algorithm. A line has no interior to hide behind, so
 * sorting it by its midpoint puts the wireframe edge opposite a triangle's nearest corner behind
 * its own face — one edge in three washed out under a translucent surface. And one `Drawable` can
 * only be wholly in front of or wholly behind anything it crosses, so a 10-unit grid line or a
 * 6-unit axis has to be cut near the scale of what it passes through, or the axes paint straight
 * across a solid standing at the origin. Mesh edges and contours are already short and are left
 * whole, which keeps the piece count bounded.
 */
function segmentDrawable(
  projector: Graph3DProjector,
  from: Graph3DPoint3,
  to: Graph3DPoint3,
  color: string,
  opacity: number,
  strokeWidth: number,
  dash?: { dashSize: number; gapSize: number },
  subdivide = false,
): Drawable[] {
  const dashAttr = dash
    ? ` stroke-dasharray="${formatNumber(Math.max(0.5, dash.dashSize))} ${formatNumber(Math.max(0.5, dash.gapSize))}"`
    : "";
  const opacityAttr = opacity >= 1 ? "" : ` stroke-opacity="${formatNumber(opacity)}"`;
  const span = subtract3(to, from);
  const pieces = subdivide
    ? Math.min(MAX_SEGMENT_PIECES, Math.max(1, Math.ceil(Math.hypot(span.x, span.y, span.z) / SEGMENT_PIECE_SCENE_LENGTH)))
    : 1;

  const drawables: Drawable[] = [];
  // How far along the whole line each piece starts, in pixels. Every piece is its own `<path>`,
  // and a dash pattern restarts at the beginning of a path — so without carrying the phase across
  // the cut, a doubled dot lands on every seam whenever the period does not divide the piece
  // length. three.js draws the line in one go (`computeLineDistances`), so this is what keeps the
  // two renderers showing the same dashes.
  let traversed = 0;
  for (let index = 0; index < pieces; index += 1) {
    const a = projector.project(add3(from, scale3(span, index / pieces)));
    const b = projector.project(add3(from, scale3(span, (index + 1) / pieces)));
    if (!a || !b) continue;
    const offsetAttr = dash && traversed > 0 ? ` stroke-dashoffset="${formatNumber(traversed)}"` : "";
    drawables.push({
      depth: Math.min(a.depth, b.depth),
      svg: `<path d="M${formatNumber(a.x)} ${formatNumber(a.y)}L${formatNumber(b.x)} ${formatNumber(b.y)}" fill="none" stroke="${color}" stroke-width="${formatNumber(strokeWidth)}"${opacityAttr}${dashAttr}${offsetAttr}/>`,
    });
    traversed += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return drawables;
}

function circleSvg(center: Graph3DProjectedPoint, radius: number, color: string, opacity: number): string {
  const opacityAttr = opacity >= 1 ? "" : ` fill-opacity="${formatNumber(opacity)}"`;
  return `<circle cx="${formatNumber(center.x)}" cy="${formatNumber(center.y)}" r="${formatNumber(radius)}" fill="${color}"${opacityAttr}/>`;
}

function polygonPath(points: readonly Point2[]): string {
  return `${openPath(points, false)} Z`;
}

function openPath(points: readonly Point2[], closed: boolean): string {
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${formatNumber(point.x)} ${formatNumber(point.y)}`)
    .join(" ");
  return closed ? `${path} Z` : path;
}

/**
 * Roughly how many pixels one scene unit covers near the subject.
 *
 * Dash patterns, dot radii and head stroke widths are all authored in scene units, and SVG wants
 * pixels. A perspective camera has no single answer, so this samples the three world axes at the
 * point the camera is aimed at — the part of the figure the reader is looking at.
 */
function estimatePixelsPerUnit(projector: Graph3DProjector, at: Graph3DPoint3): number {
  const base = projector.project(at);
  if (!base) return 0;
  let best = 0;
  for (const axis of [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }]) {
    const other = projector.project(add3(at, axis));
    if (other) best = Math.max(best, Math.hypot(other.x - base.x, other.y - base.y));
  }
  return best;
}

// --- colour --------------------------------------------------------------------------------

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * A colour safe to write into an SVG attribute, or the fallback.
 *
 * Authored colours reach this from model-written specs, and the value is interpolated into the
 * serialized markup: anything that is not recognisably a colour token is replaced rather than
 * escaped, which also keeps a half-typed value from painting the figure with something arbitrary.
 */
function safeCssColor(value: string | undefined, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  const hex = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  return hex.test(trimmed) || /^[a-z]{3,24}$/i.test(trimmed) ? trimmed : fallback;
}

function parseCssColor(value: string): Rgb | null {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (!hex) return null;
  const digits = hex[1];
  if (digits.length === 3 || digits.length === 4) {
    return {
      r: Number.parseInt(digits[0].repeat(2), 16),
      g: Number.parseInt(digits[1].repeat(2), 16),
      b: Number.parseInt(digits[2].repeat(2), 16),
    };
  }
  if (digits.length === 6 || digits.length === 8) {
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
    };
  }
  return null;
}

function shadeColor(rgb: Rgb, shade: number): string {
  const channel = (value: number) => Math.round(Math.min(255, Math.max(0, value * shade)));
  return `#${[channel(rgb.r), channel(rgb.g), channel(rgb.b)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function clampUnit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? Number(value.toFixed(3)).toString() : "0";
}

// --- vectors -------------------------------------------------------------------------------

function add3(a: Graph3DPoint3, b: Graph3DPoint3): Graph3DPoint3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subtract3(a: Graph3DPoint3, b: Graph3DPoint3): Graph3DPoint3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale3(vector: Graph3DPoint3, factor: number): Graph3DPoint3 {
  return { x: vector.x * factor, y: vector.y * factor, z: vector.z * factor };
}

function negate3(vector: Graph3DPoint3): Graph3DPoint3 {
  return scale3(vector, -1);
}

function dot3(a: Graph3DPoint3, b: Graph3DPoint3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross3(a: Graph3DPoint3, b: Graph3DPoint3): Graph3DPoint3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize3(vector: Graph3DPoint3): Graph3DPoint3 | null {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  return magnitude > 1e-9 ? scale3(vector, 1 / magnitude) : null;
}
