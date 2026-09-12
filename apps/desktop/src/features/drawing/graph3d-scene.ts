import type {
  Graph3DAnnotation,
  Graph3DCut,
  Graph3DDimensionEndStyle,
  Graph3DExpressionRange,
  Graph3DLineStyle,
  Graph3DObject,
  Graph3DObjectIntersectionRegion,
  Graph3DSpec,
} from "@/features/document";

import {
  MAX_PRIMITIVE_RING_SAMPLES,
  MAX_SCALAR_FIELD_RESOLUTION,
  buildGraph3DObjectGeometry,
  graph3DBoundedSolidResolution,
  type Graph3DMeshGeometry,
  type Graph3DMeshSection,
} from "./graph3d-geometry";
import {
  type Graph3DPoint3,
  type ResolvedGraph3DPlane,
} from "./graph3d-plane";
import {
  getGraph3DIntersectionGeometry,
  type Graph3DIntersectionGeometry,
} from "./graph3d-solid";
import type { MathExpressionVariables } from "./math-expression";
import { evaluateMathExpression } from "./math-expression";
import {
  Graph3DModelError,
  type Graph3DModelErrorCode,
} from "./graph3d-errors";

export interface Graph3DSceneObjectGeometry {
  objectId: string;
  object: Graph3DObject;
  geometry: Graph3DMeshGeometry;
}

export interface Graph3DSceneSection {
  objectId: string;
  section: Graph3DMeshSection;
}

export interface Graph3DSceneTrailFrame {
  parameterValue: number;
  plane: ResolvedGraph3DPlane;
  sections: Graph3DSceneSection[];
}

export interface Graph3DSceneCutGeometry {
  cutId: string;
  cut: Graph3DCut;
  plane: ResolvedGraph3DPlane;
  sections: Graph3DSceneSection[];
  trail?: Graph3DSceneTrailFrame[];
}

export interface Graph3DSceneBuildIssue {
  scope: "object" | "cut" | "trail" | "annotation" | "region";
  id: string;
  message: string;
  code?: Graph3DModelErrorCode;
  params?: Record<string, string>;
}

/** One authored common part, already meshed as either a shared volume or a shared flat area. */
export interface Graph3DSceneIntersection {
  regionId: string;
  region: Graph3DObjectIntersectionRegion;
  geometry: Graph3DIntersectionGeometry;
}

export type Graph3DSceneAnnotation =
  | {
      id: string;
      kind: "label";
      position: Graph3DPoint3;
      labelTex: string;
      color?: string;
    }
  | {
      id: string;
      kind: "dimension";
      from: Graph3DPoint3;
      to: Graph3DPoint3;
      labelTex: string;
      color?: string;
      lineStyle?: Graph3DLineStyle;
      lineWidth?: number;
      endStyle?: Graph3DDimensionEndStyle;
    };

export interface Graph3DSceneGeometry {
  parameters: MathExpressionVariables;
  objects: Graph3DSceneObjectGeometry[];
  cuts: Graph3DSceneCutGeometry[];
  intersections: Graph3DSceneIntersection[];
  annotations: Graph3DSceneAnnotation[];
  issues: Graph3DSceneBuildIssue[];
}

export type Graph3DRenderQuality = "full" | "balanced" | "lightweight";

const DEFAULT_SURFACE_SAMPLES = 36;
/** Ceilings and floors the settings panel already enforces on an authored count. */
const MAX_AUTHORED_SAMPLES = 256;
const MIN_AUTHORED_SAMPLES = 6;
const MIN_SCALAR_FIELD_RESOLUTION = 10;

/**
 * Animation is a derived view. It may sample fewer points while moving, but it must never mutate
 * the authored SigmaDoc ranges or leak the reduced values into saved/printed output.
 */
export function createGraph3DRenderSpec(
  spec: Graph3DSpec,
  quality: Graph3DRenderQuality,
): Graph3DSpec {
  if (quality === "full") return spec;
  return createGraph3DSampledSpec(spec, quality === "balanced" ? 0.65 : 0.4);
}

/**
 * The same figure with every plot count multiplied, inside the bounds the settings panel enforces.
 *
 * One factor for the whole figure, because the caller is trading against a single budget: a view
 * being dragged gives density up (`factor < 1`), a video being written buys as much as the machine
 * can still record (`factor > 1`). Sampling cost is not linear in the factor — a marched solid is
 * cubic in its resolution — so callers that raise it are expected to measure rather than guess.
 */
export function createGraph3DSampledSpec(spec: Graph3DSpec, factor: number): Graph3DSpec {
  if (!(factor > 0) || factor === 1) return spec;
  const scaleRange = (range: Graph3DExpressionRange, fallback = DEFAULT_SURFACE_SAMPLES) => ({
    ...range,
    samples: clamp(
      Math.round((range.samples ?? fallback) * factor),
      MIN_AUTHORED_SAMPLES,
      MAX_AUTHORED_SAMPLES,
    ),
  });
  const scaleResolution = (resolution: number) => clamp(
    Math.round(resolution * factor),
    MIN_SCALAR_FIELD_RESOLUTION,
    MAX_SCALAR_FIELD_RESOLUTION,
  );
  const objects = spec.objects.map((object): Graph3DObject => {
    switch (object.kind) {
      case "parametricSurface":
        return { ...object, u: scaleRange(object.u), v: scaleRange(object.v) };
      case "parametricCurve":
        return { ...object, range: scaleRange(object.range) };
      case "solidOfRevolution":
        return {
          ...object,
          axisRange: scaleRange(object.axisRange),
          angleRange: scaleRange(object.angleRange ?? { min: "0", max: "2*pi", samples: 48 }, 48),
        };
      case "implicitSurface":
        return { ...object, resolution: scaleResolution(object.resolution ?? 22) };
      case "boundedSolid":
        return { ...object, resolution: scaleResolution(graph3DBoundedSolidResolution(object)) };
      case "primitive":
        // A ring of segments costs almost nothing next to a marched solid, so a primitive is never
        // the reason a frame misses its budget: raising the figure's density pins it to the
        // ceiling, and lowering the figure's density leaves it alone.
        return factor > 1 ? { ...object, resolution: MAX_PRIMITIVE_RING_SAMPLES } : object;
      default:
        return object;
    }
  });
  const regions = spec.regions.map((region) => region.kind === "objectIntersection"
    ? { ...region, resolution: scaleResolution(region.resolution ?? 22) }
    : region);
  return { ...spec, objects, regions };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Specs are immutable values, so a rebuild for the same object identity is always the same
 * answer. Several surfaces read the same spec per change — the live 3D window, the flattened
 * 2D section view, the derived preview — and each rebuild is milliseconds of sampling.
 */
const sceneGeometryCache = new WeakMap<Graph3DSpec, { key: string; geometry: Graph3DSceneGeometry }>();

export function buildGraph3DSceneGeometry(
  spec: Graph3DSpec,
  parameterOverrides: MathExpressionVariables = {},
): Graph3DSceneGeometry {
  const cacheKey = getParameterOverrideKey(parameterOverrides);
  const cached = sceneGeometryCache.get(spec);
  if (cached && cached.key === cacheKey) {
    return cached.geometry;
  }
  const geometry = computeGraph3DSceneGeometry(spec, parameterOverrides);
  sceneGeometryCache.set(spec, { key: cacheKey, geometry });
  return geometry;
}

function getParameterOverrideKey(parameterOverrides: MathExpressionVariables): string {
  const names = Object.keys(parameterOverrides);
  if (names.length === 0) return "";
  return names.sort().map((name) => `${name}=${parameterOverrides[name]}`).join(",");
}

function computeGraph3DSceneGeometry(
  spec: Graph3DSpec,
  parameterOverrides: MathExpressionVariables,
): Graph3DSceneGeometry {
  const parameters = Object.fromEntries(spec.parameters.map((parameter) => [
    parameter.name,
    parameterOverrides[parameter.name] ?? parameter.value,
  ]));
  const issues: Graph3DSceneBuildIssue[] = [];
  const objects = spec.objects.flatMap((object) => {
    if (object.visible === false) return [];
    try {
      return [{ objectId: object.id, object, geometry: getObjectGeometry(object, parameters) }];
    } catch (error) {
      issues.push({ scope: "object", id: object.id, ...getErrorIssue(error) });
      return [];
    }
  });

  // Cuts stay in the persisted spec so older files still open, but they are no
  // longer drawn. A plane among the common-part members is the replacement.
  const cuts: Graph3DSceneCutGeometry[] = [];

  const intersections = spec.regions.flatMap((region) => {
    if (region.kind !== "objectIntersection" || region.visible === false) return [];
    const members = region.objectIds
      .map((objectId) => spec.objects.find((candidate) => candidate.id === objectId))
      .filter((object): object is Graph3DObject => object !== undefined);
    if (members.length < 2) return [];
    try {
      return [{
        regionId: region.id,
        region,
        geometry: getGraph3DIntersectionGeometry(members, parameters, {
          ...(region.resolution === undefined ? {} : { resolution: region.resolution }),
        }),
      }];
    } catch (error) {
      issues.push({ scope: "region", id: region.id, ...getErrorIssue(error) });
      return [];
    }
  });

  const annotations = spec.annotations.flatMap((annotation) => {
    try {
      return [resolveAnnotation(annotation, parameters)];
    } catch (error) {
      issues.push({ scope: "annotation", id: annotation.id, ...getErrorIssue(error) });
      return [];
    }
  });

  return { parameters, objects, cuts, intersections, annotations, issues };
}

function resolveAnnotation(
  annotation: Graph3DAnnotation,
  parameters: MathExpressionVariables,
): Graph3DSceneAnnotation {
  if (annotation.kind === "label") {
    return {
      ...annotation,
      position: resolvePoint(annotation.position, parameters),
    };
  }
  return {
    ...annotation,
    from: resolvePoint(annotation.from, parameters),
    to: resolvePoint(annotation.to, parameters),
  };
}

function resolvePoint(
  point: { x: string; y: string; z: string },
  parameters: MathExpressionVariables,
): Graph3DPoint3 {
  return {
    x: evaluateMathExpression(point.x, parameters),
    y: evaluateMathExpression(point.y, parameters),
    z: evaluateMathExpression(point.z, parameters),
  };
}

/**
 * Mesh geometry depends only on the shape-defining fields, never on colour, name, opacity or
 * visibility. Recolouring an object used to re-sample its whole surface; keying the cache on the
 * geometry-defining fields makes those edits free.
 */
const objectGeometryCache = new Map<string, Graph3DMeshGeometry>();
const MAX_OBJECT_GEOMETRY_CACHE_ENTRIES = 64;

function omitPresentationFields(key: string, value: unknown): unknown {
  return key === "style" || key === "name" || key === "visible" ? undefined : value;
}

function getObjectGeometry(
  object: Graph3DObject,
  parameters: MathExpressionVariables,
): Graph3DMeshGeometry {
  const source = JSON.stringify(object, omitPresentationFields);
  const key = `${source}|${getUsedParameterKey(source, parameters)}`;
  const cached = objectGeometryCache.get(key);
  if (cached) {
    return cached;
  }
  const geometry = buildGraph3DObjectGeometry(object, parameters);
  if (objectGeometryCache.size >= MAX_OBJECT_GEOMETRY_CACHE_ENTRIES) {
    const oldest = objectGeometryCache.keys().next().value;
    if (oldest !== undefined) objectGeometryCache.delete(oldest);
  }
  objectGeometryCache.set(key, geometry);
  return geometry;
}

function getUsedParameterKey(source: string, parameters: MathExpressionVariables): string {
  return Object.keys(parameters)
    .filter((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu").test(source))
    .sort()
    .map((name) => `${name}=${parameters[name]}`)
    .join(",");
}

function getErrorIssue(error: unknown): Pick<Graph3DSceneBuildIssue, "code" | "params" | "message"> {
  if (error instanceof Graph3DModelError) {
    return { code: error.code, params: error.params, message: error.message };
  }
  if (error instanceof Error) return { message: error.message };
  return { code: "sceneBuildFailed", message: "sceneBuildFailed" };
}
