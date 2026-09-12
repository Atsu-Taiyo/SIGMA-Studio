import { isGraphParameter } from "./graph-parameter-validation";
import type {
  Graph3DAnnotation,
  Graph3DBounds,
  Graph3DCamera,
  Graph3DCut,
  Graph3DExpressionRange,
  Graph3DExpressionVector3,
  Graph3DFillStyle,
  Graph3DObject,
  Graph3DObjectStyle,
  Graph3DPlaneDefinition,
  Graph3DRegion,
  Graph3DSpec,
  Graph3DViewSettings,
} from "./model/graph3d";
import { GRAPH3D_AXIS_END_STYLES } from "./model/graph3d";

export function isGraph3DSpec(value: unknown): value is Graph3DSpec {
  return isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.parameters) && value.parameters.every(isGraphParameter) &&
    Array.isArray(value.objects) && value.objects.every(isGraph3DObject) &&
    Array.isArray(value.cuts) && value.cuts.every(isGraph3DCut) &&
    Array.isArray(value.regions) && value.regions.every(isGraph3DRegion) &&
    Array.isArray(value.annotations) && value.annotations.every(isGraph3DAnnotation) &&
    isGraph3DCamera(value.camera) &&
    isGraph3DViewSettings(value.view);
}

function isGraph3DObject(value: unknown): value is Graph3DObject {
  if (!hasObjectBase(value)) {
    return false;
  }

  switch (value.kind) {
    case "implicitSurface":
      return typeof value.expression === "string" &&
        isBounds(value.bounds) &&
        isOptionalResolution(value.resolution);
    case "parametricCurve":
      return typeof value.x === "string" &&
        typeof value.y === "string" &&
        typeof value.z === "string" &&
        isNonemptyString(value.parameter) &&
        isExpressionRange(value.range);
    case "parametricSurface":
      return typeof value.x === "string" &&
        typeof value.y === "string" &&
        typeof value.z === "string" &&
        isExpressionRange(value.u) &&
        isExpressionRange(value.v);
    case "primitive":
      return (
        value.primitive === "sphere" ||
        value.primitive === "cylinder" ||
        value.primitive === "cone" ||
        value.primitive === "box"
      ) &&
        isExpressionVector3(value.center) &&
        isExpressionVector3(value.size) &&
        isOptionalResolution(value.resolution);
    case "solidOfRevolution":
      return isRevolutionAxis(value.axis) &&
        typeof value.radius === "string" &&
        isExpressionRange(value.axisRange) &&
        (value.angleRange === undefined || isExpressionRange(value.angleRange)) &&
        isOptionalBoolean(value.capped);
    case "polyhedron": {
      const vertices = value.vertices;
      return Array.isArray(vertices) &&
        vertices.length >= 4 &&
        vertices.every(isExpressionVector3) &&
        Array.isArray(value.faces) &&
        value.faces.every((face) => (
          Array.isArray(face) &&
          face.length >= 3 &&
          face.every((index) => Number.isInteger(index) && index >= 0 && index < vertices.length)
        ));
    }
    case "boundedSolid":
      return Array.isArray(value.inequalities) &&
        value.inequalities.length > 0 &&
        value.inequalities.every(isString) &&
        isBounds(value.bounds) &&
        isOptionalResolution(value.resolution);
    case "point":
      return isExpressionVector3(value.position) &&
        (value.radius === undefined || (isFiniteNumber(value.radius) && value.radius > 0));
    case "segment":
      return isExpressionVector3(value.from) && isExpressionVector3(value.to);
    case "plane":
      return isPlaneDefinition(value.plane) &&
        (value.size === undefined || isExpressionVector3(value.size));
    default:
      return false;
  }
}

function isRevolutionAxis(value: unknown): boolean {
  if (value === "x" || value === "y" || value === "z") {
    return true;
  }
  return isRecord(value) &&
    value.kind === "planeIntersection" &&
    Array.isArray(value.equations) &&
    value.equations.length === 2 &&
    value.equations.every(isString) &&
    (value.parameter === undefined || isNonemptyString(value.parameter));
}

function hasObjectBase(value: unknown): value is Record<string, unknown> & Pick<Graph3DObject, "id" | "kind"> {
  return isRecord(value) &&
    isNonemptyString(value.id) &&
    typeof value.kind === "string" &&
    isOptionalString(value.name) &&
    isOptionalBoolean(value.visible) &&
    (value.style === undefined || isObjectStyle(value.style)) &&
    (value.rotation === undefined || isExpressionVector3(value.rotation)) &&
    (value.translation === undefined || isExpressionVector3(value.translation)) &&
    (value.scale === undefined || isExpressionVector3(value.scale));
}

function isObjectStyle(value: unknown): value is Graph3DObjectStyle {
  return isRecord(value) &&
    isOptionalString(value.color) &&
    isOptionalOpacity(value.opacity) &&
    isOptionalBoolean(value.wireframe) &&
    isOptionalString(value.wireframeColor) &&
    (value.fill === undefined || isFillStyle(value.fill));
}

function isGraph3DCut(value: unknown): value is Graph3DCut {
  return isRecord(value) &&
    isNonemptyString(value.id) &&
    isOptionalString(value.label) &&
    Array.isArray(value.targetObjectIds) &&
    value.targetObjectIds.every(isNonemptyString) &&
    isPlaneDefinition(value.plane) &&
    isOptionalBoolean(value.visible) &&
    isOptionalBoolean(value.showPlane) &&
    isOptionalBoolean(value.showContour) &&
    (value.section === undefined || (
      isRecord(value.section) &&
      isOptionalBoolean(value.section.showInScene) &&
      isOptionalBoolean(value.section.showFlattened2D) &&
      (value.section.fill === undefined || isFillStyle(value.section.fill)) &&
      isOptionalString(value.section.lineColor) &&
      (value.section.lineWidth === undefined || (isFiniteNumber(value.section.lineWidth) && value.section.lineWidth > 0 && value.section.lineWidth <= 32)) &&
      (value.section.overlapMode === undefined || value.section.overlapMode === "add" || value.section.overlapMode === "subtract")
    )) &&
    (value.trail === undefined || (
      isRecord(value.trail) &&
      isNonemptyString(value.trail.parameterId) &&
      isSampleCount(value.trail.samples) &&
      isOptionalString(value.trail.color) &&
      isOptionalOpacity(value.trail.opacity)
    ));
}

function isPlaneDefinition(value: unknown): value is Graph3DPlaneDefinition {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "equation") {
    return typeof value.expression === "string";
  }
  if (value.kind === "threePoints") {
    return Array.isArray(value.points) &&
      value.points.length === 3 &&
      value.points.every(isExpressionVector3);
  }
  return value.kind === "pointNormal" &&
    isExpressionVector3(value.point) &&
    isExpressionVector3(value.normal);
}

function isGraph3DRegion(value: unknown): value is Graph3DRegion {
  if (!isRecord(value) || !isNonemptyString(value.id) || !isFillStyle(value.fill)) {
    return false;
  }
  if (value.kind === "section") {
    return isNonemptyString(value.cutId);
  }
  if (value.kind === "objectIntersection") {
    return Array.isArray(value.objectIds) &&
      value.objectIds.every(isNonemptyString) &&
      isOptionalString(value.label) &&
      isOptionalBoolean(value.visible) &&
      isOptionalResolution(value.resolution) &&
      isOptionalBoolean(value.showEdges) &&
      isOptionalString(value.edgeColor);
  }
  return value.kind === "inequality" &&
    Array.isArray(value.inequalities) &&
    value.inequalities.length > 0 &&
    value.inequalities.every(isString) &&
    isBounds(value.bounds);
}

function isGraph3DAnnotation(value: unknown): value is Graph3DAnnotation {
  if (!isRecord(value) || !isNonemptyString(value.id) || !isNonemptyString(value.labelTex)) {
    return false;
  }
  if (value.kind === "label") {
    return isExpressionVector3(value.position) && isOptionalString(value.color);
  }
  return value.kind === "dimension" &&
    isExpressionVector3(value.from) &&
    isExpressionVector3(value.to) &&
    isOptionalString(value.color) &&
    (value.lineStyle === undefined || value.lineStyle === "solid" || value.lineStyle === "dashed" || value.lineStyle === "dotted") &&
    (value.lineWidth === undefined || (isFiniteNumber(value.lineWidth) && value.lineWidth > 0 && value.lineWidth <= 32)) &&
    (
      value.endStyle === undefined
      || value.endStyle === "tick"
      || (typeof value.endStyle === "string" && (GRAPH3D_AXIS_END_STYLES as readonly string[]).includes(value.endStyle))
    );
}

function isGraph3DCamera(value: unknown): value is Graph3DCamera {
  return isRecord(value) &&
    (value.projection === "perspective" || value.projection === "orthographic") &&
    isNumericVector3(value.position) &&
    isNumericVector3(value.target) &&
    isNumericVector3(value.up) &&
    (value.fov === undefined || (isFiniteNumber(value.fov) && value.fov > 0 && value.fov < 180)) &&
    (value.zoom === undefined || (isFiniteNumber(value.zoom) && value.zoom > 0));
}

function isGraph3DViewSettings(value: unknown): value is Graph3DViewSettings {
  return isRecord(value) &&
    value.coordinateSystem === "zUp" &&
    typeof value.showAxes === "boolean" &&
    typeof value.showGrid === "boolean" &&
    typeof value.backgroundColor === "string" &&
    isOptionalBoolean(value.showAxisLabels) &&
    isGraph3DAxisColors(value.axisColors) &&
    (value.axisLineStyle === undefined || value.axisLineStyle === "solid" || value.axisLineStyle === "dashed" || value.axisLineStyle === "dotted") &&
    (
      value.axisEndStyle === undefined ||
      (typeof value.axisEndStyle === "string" &&
        (GRAPH3D_AXIS_END_STYLES as readonly string[]).includes(value.axisEndStyle))
    ) &&
    isOptionalBoolean(value.shadows);
}

function isGraph3DAxisColors(value: unknown): boolean {
  return value === undefined || (
    isRecord(value) &&
    typeof value.x === "string" &&
    typeof value.y === "string" &&
    typeof value.z === "string"
  );
}

function isExpressionRange(value: unknown): value is Graph3DExpressionRange {
  return isRecord(value) &&
    typeof value.min === "string" &&
    typeof value.max === "string" &&
    (value.samples === undefined || isSampleCount(value.samples));
}

function isBounds(value: unknown): value is Graph3DBounds {
  return isRecord(value) &&
    isExpressionRange(value.x) &&
    isExpressionRange(value.y) &&
    isExpressionRange(value.z);
}

function isExpressionVector3(value: unknown): value is Graph3DExpressionVector3 {
  return isRecord(value) &&
    typeof value.x === "string" &&
    typeof value.y === "string" &&
    typeof value.z === "string";
}

function isNumericVector3(value: unknown): boolean {
  return isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.z);
}

function isFillStyle(value: unknown): value is Graph3DFillStyle {
  if (!isRecord(value)) {
    return false;
  }
  if (value.mode === "none") {
    return true;
  }
  if (
    (value.mode !== "solid" && value.mode !== "pattern") ||
    typeof value.color !== "string" ||
    !isOptionalOpacity(value.opacity)
  ) {
    return false;
  }
  return value.mode === "solid" ||
    value.pattern === "diagonal" ||
    value.pattern === "cross" ||
    value.pattern === "dots";
}

function isOptionalResolution(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && Number(value) >= 4 && Number(value) <= 256);
}

function isSampleCount(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 2 && Number(value) <= 1024;
}

function isOptionalOpacity(value: unknown): boolean {
  return value === undefined || (isFiniteNumber(value) && value >= 0 && value <= 1);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
