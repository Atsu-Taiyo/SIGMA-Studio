import {
  AlwaysStencilFunc,
  AmbientLight,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineDashedMaterial,
  LineLoop,
  LineSegments,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  NotEqualStencilFunc,
  Object3D,
  OctahedronGeometry,
  OrthographicCamera,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Quaternion,
  ReplaceStencilOp,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  ShapeUtils,
  SphereGeometry,
  Texture,
  TubeGeometry,
  UnsignedByteType,
  Vector2,
  Vector3,
  WireframeGeometry,
  type Camera,
} from "three";

import {
  resolveGraph3DDimensionEndStyle,
  type Graph3DAxisColors,
  type Graph3DAxisEndStyle,
  type Graph3DAxisLineStyle,
  type Graph3DCamera,
  type Graph3DViewSettings,
} from "@/features/document";
import {
  createGraph3DPlaneBasisFromPlane,
  type Graph3DMeshGeometry,
  type Graph3DMeshSection,
  type Graph3DPoint3,
  type Graph3DSceneAnnotation,
  type Graph3DSceneGeometry,
} from "@/features/drawing";
import {
  getArrowheadMarkerSpec,
  graph3DAxisDashPattern,
  graph3DAxisEndScale,
  graph3DAxisEndShaftTrim,
  graph3DDimensionDashPattern,
  graph3DDimensionHeadLength,
  graph3DDimensionRadius,
  GRAPH3D_AXIS_ARROW_LENGTH_RATIO,
  GRAPH3D_AXIS_LENGTH,
  GRAPH3D_DEFAULT_BACKGROUND_COLOR,
  GRAPH3D_DEFAULT_CONTOUR_COLOR,
  GRAPH3D_DEFAULT_FOV_DEGREES,
  GRAPH3D_DEFAULT_DIMENSION_COLOR,
  GRAPH3D_DEFAULT_INTERSECTION_OPACITY,
  GRAPH3D_DEFAULT_OBJECT_COLOR,
  GRAPH3D_DEFAULT_OBJECT_OPACITY,
  GRAPH3D_DEFAULT_WIREFRAME_COLOR,
  GRAPH3D_GRID,
  GRAPH3D_INTERSECTION_POINT_RADIUS,
  GRAPH3D_LIGHTS,
  GRAPH3D_NEAR_PLANE,
  GRAPH3D_VIEW_HALF_HEIGHT,
} from "@/features/rendering/core";

// The drawing conventions live in the core (`core/graph3d-style.ts`). Two renderers now put the
// same figure on paper, and a constant tuned on one side only is invisible until someone prints.

/**
 * Coloured coordinate axes with an arrow head on the positive end.
 *
 * `AxesHelper` cannot express either: it hard-codes red/green/blue vertex colours, draws only
 * the positive half, and has no head. Textbook figures need both directions and the arrow, and
 * teachers need to choose the colours.
 */
export function createThreeGraph3DAxes(
  length: number,
  colors: Graph3DAxisColors,
  lineStyle: Graph3DAxisLineStyle = "solid",
  endStyle: Graph3DAxisEndStyle = "arrow",
): Group {
  const group = new Group();
  group.name = "graph3d-axes";
  const headLength = length * GRAPH3D_AXIS_ARROW_LENGTH_RATIO;

  for (const axis of ["x", "y", "z"] as const) {
    const direction = new Vector3(
      axis === "x" ? 1 : 0,
      axis === "y" ? 1 : 0,
      axis === "z" ? 1 : 0,
    );
    const head = createAxisEnd(endStyle, colors[axis], headLength, direction);
    const line = new LineSegments(
      new BufferGeometry().setFromPoints([
        direction.clone().multiplyScalar(-length),
        direction.clone().multiplyScalar(length - (head?.shaftTrim ?? 0)),
      ]),
      pooledAxisLineMaterial(colors[axis], lineStyle, length * 2),
    );
    if (line.material instanceof LineDashedMaterial) line.computeLineDistances();
    line.name = `graph3d-axis-line:${axis}`;
    group.add(line);

    if (head) {
      head.object.position.copy(direction.clone().multiplyScalar(length));
      head.object.name = `graph3d-axis-arrow:${axis}`;
      group.add(head.object);
    }
  }

  return group;
}

function createAxisEnd(
  style: Graph3DAxisEndStyle,
  color: string,
  length: number,
  localDirection: Vector3,
): { object: Object3D; shaftTrim: number } | null {
  if (style === "none") return null;
  const spec = getArrowheadMarkerSpec(style);
  if (!spec) return null;
  const scale = graph3DAxisEndScale(spec, length);
  const geometry = spec.geometry.kind === "circle"
    ? new CircleGeometry(spec.geometry.r * scale, 24).translate(
      (spec.geometry.cx - spec.tipX) * scale,
      (spec.refY - spec.geometry.cy) * scale,
      0,
    )
    : createFlatAxisEndGeometry(spec.geometry.points.map((point) => new Vector2(
      (point.x - spec.tipX) * scale,
      (spec.refY - point.y) * scale,
    )), spec.geometry.closed && spec.geometry.filled);
  const object = spec.geometry.kind === "polyline" && !(spec.geometry.closed && spec.geometry.filled)
    ? new LineSegments(geometry, pooledLineMaterial(color))
    : new Mesh(geometry, pooledBasicMaterial(color));
  object.userData.graph3dAxisEndPlanar = true;
  keepFlatAxisEndFacingCamera(object, localDirection);
  return {
    object,
    shaftTrim: graph3DAxisEndShaftTrim(spec) * scale,
  };
}

function createFlatAxisEndGeometry(points: Vector2[], filled: boolean): BufferGeometry {
  const geometry = new BufferGeometry();
  if (filled) {
    const faces = ShapeUtils.triangulateShape(points, []);
    geometry.setAttribute("position", new Float32BufferAttribute(
      faces.flatMap((face) => face.flatMap((index) => [points[index].x, points[index].y, 0])),
      3,
    ));
    return geometry;
  }
  geometry.setFromPoints(points.flatMap((point, index) => index === 0
    ? []
    : [new Vector3(points[index - 1].x, points[index - 1].y, 0), new Vector3(point.x, point.y, 0)]));
  return geometry;
}

/**
 * A 2D endpoint constrained to the 3D axis: +x follows the axis while its plane faces the camera.
 * This is the same interaction pattern as a screen-space arrowhead, without turning it into a cone.
 */
function keepFlatAxisEndFacingCamera(object: Object3D, localDirection: Vector3): void {
  const endpoint = new Vector3();
  const cameraPosition = new Vector3();
  const parentRotation = new Quaternion();
  const direction = new Vector3();
  const normal = new Vector3();
  const across = new Vector3();
  const worldRotation = new Quaternion();
  const basis = new Matrix4();
  object.onBeforeRender = (_renderer, _scene, camera) => {
    object.getWorldPosition(endpoint);
    camera.getWorldPosition(cameraPosition);
    if (object.parent) object.parent.getWorldQuaternion(parentRotation);
    else parentRotation.identity();
    direction.copy(localDirection).applyQuaternion(parentRotation).normalize();
    normal.copy(cameraPosition).sub(endpoint);
    normal.addScaledVector(direction, -normal.dot(direction));
    if (normal.lengthSq() < 1e-8) {
      camera.getWorldDirection(normal).negate().addScaledVector(direction, normal.dot(direction));
    }
    if (normal.lengthSq() < 1e-8) {
      normal.set(Math.abs(direction.z) < 0.9 ? 0 : 1, 0, Math.abs(direction.z) < 0.9 ? 1 : 0);
      normal.addScaledVector(direction, -normal.dot(direction));
    }
    normal.normalize();
    across.crossVectors(normal, direction).normalize();
    basis.makeBasis(direction, across, normal);
    worldRotation.setFromRotationMatrix(basis);
    object.quaternion.copy(parentRotation.invert().multiply(worldRotation));
    object.updateMatrix();
    if (object.parent) object.matrixWorld.multiplyMatrices(object.parent.matrixWorld, object.matrix);
  };
}

const ROTATION_ARC_START_RADIANS = Math.PI * 0.06;
const ROTATION_ARC_SWEEP_RADIANS = Math.PI * 0.4;

/**
 * Local axes for a selected solid, with one handle per thing the drag can do: the whole axis line
 * moves it, the knob near the tip scales along that axis, and the arc between two axes turns it.
 *
 * Every handle carries an invisible pick body wider than what is drawn, so a drag catches it
 * without pixel-perfect aiming. They overlap on purpose — the shaft runs under the knob and
 * through the arcs — and the pointer controller resolves that by handle, not by depth.
 */
export function createThreeGraph3DObjectGizmo(length: number, colors: Graph3DAxisColors): Group {
  const group = new Group();
  group.name = "graph3d-object-gizmo";
  const visible = createThreeGraph3DAxes(length, colors);
  visible.name = "graph3d-object-gizmo-axes";
  group.add(visible);
  const pickMaterial = new MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: false,
  });
  const shaftRadius = Math.max(0.06, length * 0.09);
  const arcPickRadius = Math.max(0.05, length * 0.075);
  for (const axis of ["x", "y", "z"] as const) {
    const direction = new Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
    // The whole drawn axis moves the solid, both arms of it: a handle only at the middle reads as
    // a hotspot to hunt for, while the line itself is what the eye takes for "drag me along here".
    const shaft = new Mesh(
      new CylinderGeometry(shaftRadius, shaftRadius, length * 2, 10),
      pickMaterial,
    );
    shaft.quaternion.copy(new Quaternion().setFromUnitVectors(
      new Vector3(0, 1, 0),
      direction,
    ));
    shaft.name = `graph3d-object-gizmo-translate:${axis}`;
    shaft.userData.graph3dAxis = axis;
    shaft.userData.graph3dOperation = "translate";
    group.add(shaft);

    const knobCentre = direction.clone().multiplyScalar(length * 0.78);
    const scaleHandle = new Mesh(
      new OctahedronGeometry(Math.max(0.075, length * 0.065)),
      pooledBasicMaterial(colors[axis]),
    );
    scaleHandle.position.copy(knobCentre);
    scaleHandle.name = `graph3d-object-gizmo-scale:${axis}`;
    scaleHandle.userData.graph3dAxis = axis;
    scaleHandle.userData.graph3dOperation = "scale";
    group.add(scaleHandle);

    // The knob is small on screen, so it is aimed at rather than hit; the pick sphere is the
    // margin around it, and it wins over the shaft that now runs underneath.
    const scalePick = new Mesh(new SphereGeometry(Math.max(0.1, length * 0.1), 10, 8), pickMaterial);
    scalePick.position.copy(knobCentre);
    scalePick.name = `graph3d-object-gizmo-scale-pick:${axis}`;
    scalePick.userData.graph3dAxis = axis;
    scalePick.userData.graph3dOperation = "scale";
    group.add(scalePick);

    // The arc keeps clear of both axes it spans so that grabbing the line itself always moves.
    const arcPoints = Array.from({ length: 25 }, (_, index) => {
      const angle = (ROTATION_ARC_START_RADIANS + (index / 24) * ROTATION_ARC_SWEEP_RADIANS);
      const radius = length * 0.46;
      if (axis === "x") return new Vector3(0, Math.cos(angle) * radius, Math.sin(angle) * radius);
      if (axis === "y") return new Vector3(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
      return new Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
    });
    const curve = new CatmullRomCurve3(arcPoints);
    const rotationArc = new Mesh(
      new TubeGeometry(curve, 32, Math.max(0.012, length * 0.012), 8, false),
      pooledBasicMaterial(colors[axis]),
    );
    rotationArc.name = `graph3d-object-gizmo-rotate:${axis}`;
    rotationArc.userData.graph3dAxis = axis;
    rotationArc.userData.graph3dOperation = "rotate";
    group.add(rotationArc);

    const arcPick = new Mesh(
      new TubeGeometry(curve, 24, arcPickRadius, 6, false),
      pickMaterial,
    );
    arcPick.name = `graph3d-object-gizmo-rotate-pick:${axis}`;
    arcPick.userData.graph3dAxis = axis;
    arcPick.userData.graph3dOperation = "rotate";
    group.add(arcPick);

    const arcEnd = curve.getPoint(1);
    const tangent = curve.getTangent(1).normalize();
    const arcArrow = new Mesh(
      new ConeGeometry(Math.max(0.035, length * 0.034), Math.max(0.11, length * 0.12), 14),
      pooledBasicMaterial(colors[axis]),
    );
    arcArrow.position.copy(arcEnd);
    arcArrow.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), tangent));
    arcArrow.name = `graph3d-object-gizmo-rotate-arrow:${axis}`;
    arcArrow.userData.graph3dAxis = axis;
    arcArrow.userData.graph3dOperation = "rotate";
    group.add(arcArrow);
  }
  return group;
}


/**
 * Materials (and the pattern textures they carry) are pooled across rebuilds.
 *
 * Disposing a material releases the compiled WebGL program behind it, so recreating the scene
 * graph for every edit made three.js recompile and relink shaders on the next frame — a
 * synchronous GPU stall that dominated parameter dragging. Pooling by the values that define
 * the program keeps the programs alive; only geometry is rebuilt.
 */
const MAX_POOLED_MATERIALS = 96;
const materialPool = new Map<string, Material>();

function pooled<T extends Material>(key: string, create: () => T): T {
  const existing = materialPool.get(key);
  if (existing) {
    // Refresh insertion order so materials in active use are evicted last.
    materialPool.delete(key);
    materialPool.set(key, existing);
    return existing as T;
  }
  const material = create();
  material.userData.graph3dPooled = true;
  if (materialPool.size >= MAX_POOLED_MATERIALS) {
    const oldestKey = materialPool.keys().next().value;
    const oldest = oldestKey === undefined ? undefined : materialPool.get(oldestKey);
    if (oldestKey !== undefined) materialPool.delete(oldestKey);
    if (oldest) {
      if (oldest instanceof MeshStandardMaterial && oldest.map) oldest.map.dispose();
      oldest.dispose();
    }
  }
  materialPool.set(key, material);
  return material;
}

function isPooledMaterial(material: Material): boolean {
  return material.userData.graph3dPooled === true;
}

function pooledStandardMaterial(options: {
  color: string;
  opacity: number;
  roughness: number;
  depthWrite: boolean;
  pattern?: { kind: "diagonal" | "cross" | "dots"; color: string };
  stencil?: {
    ref: number;
    func: typeof NotEqualStencilFunc;
    replaceOnPass?: boolean;
  };
}): MeshStandardMaterial {
  const patternKey = options.pattern ? `${options.pattern.kind}:${options.pattern.color}` : "none";
  const stencilKey = options.stencil
    ? `${options.stencil.ref}:${options.stencil.func}:${options.stencil.replaceOnPass === true}`
    : "none";
  const key = `standard|${options.color}|${options.opacity}|${options.roughness}|${options.depthWrite}|${patternKey}|${stencilKey}`;
  return pooled(key, () => new MeshStandardMaterial({
    color: new Color(options.color),
    ...(options.pattern
      ? { map: createSectionPatternTexture(options.pattern.kind, options.pattern.color) }
      : {}),
    opacity: options.opacity,
    // Stencil-composited section meshes stay in one transparent render list with their masks,
    // even at opacity 1, so renderOrder cannot be split across opaque/transparent passes.
    transparent: options.opacity < 1 || options.stencil !== undefined,
    roughness: options.roughness,
    metalness: 0,
    side: DoubleSide,
    depthWrite: options.depthWrite,
    stencilWrite: options.stencil !== undefined,
    ...(options.stencil
      ? {
          stencilRef: options.stencil.ref,
          stencilFunc: options.stencil.func,
          ...(options.stencil.replaceOnPass ? { stencilZPass: ReplaceStencilOp } : {}),
        }
      : {}),
  }));
}

function pooledLineMaterial(color: string, opacity = 1, lineWidth = 1): LineBasicMaterial {
  return pooled(`line|${color}|${opacity}|${lineWidth}`, () => new LineBasicMaterial({
    color: new Color(color),
    opacity,
    transparent: opacity < 1,
    linewidth: lineWidth,
  }));
}

function pooledAxisLineMaterial(
  color: string,
  style: Graph3DAxisLineStyle,
  length: number,
): LineBasicMaterial | LineDashedMaterial {
  const pattern = graph3DAxisDashPattern(style, length);
  if (!pattern) return pooledLineMaterial(color);
  const { dashSize, gapSize } = pattern;
  return pooled(`axis-line|${color}|${style}|${dashSize}|${gapSize}`, () => new LineDashedMaterial({
    color: new Color(color),
    dashSize,
    gapSize,
  }));
}

function pooledPointsMaterial(color: string, size: number): PointsMaterial {
  return pooled(`points|${color}|${size}`, () => new PointsMaterial({
    color: new Color(color),
    size,
    sizeAttenuation: true,
  }));
}

function pooledBasicMaterial(color: string): MeshBasicMaterial {
  return pooled(`basic|${color}`, () => new MeshBasicMaterial({ color: new Color(color) }));
}

/** Writes a target section into one cut's stencil without changing color or depth buffers. */
function pooledSectionStencilMaskMaterial(stencilRef: number): MeshBasicMaterial {
  return pooled(`section-stencil-mask|${stencilRef}`, () => new MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    colorWrite: false,
    depthWrite: false,
    depthTest: false,
    side: DoubleSide,
    stencilWrite: true,
    stencilRef,
    stencilFunc: AlwaysStencilFunc,
    stencilZPass: ReplaceStencilOp,
  }));
}

export function createThreeGraph3DGroup(scene: Graph3DSceneGeometry): Group {
  const root = new Group();
  root.name = "graph3d-root";

  for (const item of scene.objects) {
    root.add(createObjectGroup(item));
  }

  for (let cutIndex = 0; cutIndex < scene.cuts.length; cutIndex += 1) {
    const cut = scene.cuts[cutIndex];
    const cutGroup = new Group();
    cutGroup.name = `graph3d-cut:${cut.cutId}`;
    if (cut.cut.showPlane) {
      cutGroup.add(createCutPlaneMesh(cut.cutId, cut.plane));
    }
    for (const target of cut.sections) {
      for (const loop of target.section.loops) {
        if (cut.cut.showContour !== false) {
          const contour = new LineLoop(
            new BufferGeometry().setFromPoints(loop.points3D.map(toVector3)),
            pooledLineMaterial(
              cut.cut.section?.lineColor ?? GRAPH3D_DEFAULT_CONTOUR_COLOR,
              1,
              cut.cut.section?.lineWidth ?? 1.5,
            ),
          );
          contour.name = `graph3d-section-contour:${cut.cutId}:${target.objectId}`;
          cutGroup.add(contour);
        }
      }
    }
    const fill = cut.cut.section?.fill;
    if (cut.cut.section?.showInScene !== false && fill && fill.mode !== "none") {
      // Each authored cut gets a distinct stencil reference for this frame. Add mode writes the
      // reference while painting, so an overlap is painted only once. Subtract mode writes later
      // targets first and paints only the first target where that reference is absent.
      const stencilRef = cutIndex % 254 + 1;
      const overlapMode = cut.cut.section?.overlapMode ?? "add";
      const fillTargets = overlapMode === "subtract" ? cut.sections.slice(0, 1) : cut.sections;
      if (overlapMode === "subtract") {
        for (const target of cut.sections.slice(1)) {
          const maskGeometry = createThreeGraph3DSectionFillGeometry(target.section);
          if (!maskGeometry) continue;
          const maskMesh = new Mesh(maskGeometry, pooledSectionStencilMaskMaterial(stencilRef));
          maskMesh.name = `graph3d-section-subtract-mask:${cut.cutId}:${target.objectId}`;
          maskMesh.renderOrder = 1_000 + cutIndex * 2;
          cutGroup.add(maskMesh);
        }
      }
      for (const target of fillTargets) {
        const fillGeometry = createThreeGraph3DSectionFillGeometry(target.section);
        if (!fillGeometry) continue;
        const fillOpacity = fill.opacity ?? 0.32;
        const fillMesh = new Mesh(fillGeometry, pooledStandardMaterial({
          color: fill.mode === "pattern" ? "#ffffff" : fill.color,
          ...(fill.mode === "pattern"
            ? { pattern: { kind: "diagonal", color: fill.color } }
            : {}),
          opacity: fillOpacity,
          roughness: 0.85,
          depthWrite: false,
          stencil: {
            ref: stencilRef,
            func: NotEqualStencilFunc,
            replaceOnPass: overlapMode === "add",
          },
        }));
        fillMesh.name = `graph3d-section-fill:${cut.cutId}:${target.objectId}`;
        fillMesh.renderOrder = 1_001 + cutIndex * 2;
        cutGroup.add(fillMesh);
      }
    }
    for (const frame of cut.trail ?? []) {
      for (const target of frame.sections) {
        for (const loop of target.section.loops) {
          const trail = new LineLoop(
            new BufferGeometry().setFromPoints(loop.points3D.map(toVector3)),
            pooledLineMaterial(cut.cut.trail?.color ?? GRAPH3D_DEFAULT_CONTOUR_COLOR, cut.cut.trail?.opacity ?? 0.35),
          );
          trail.name = `graph3d-section-trail:${cut.cutId}:${target.objectId}`;
          cutGroup.add(trail);
        }
      }
    }
    root.add(cutGroup);
  }
  for (const intersection of scene.intersections) {
    const group = createIntersectionGroup(intersection);
    if (group) root.add(group);
  }
  for (const annotation of scene.annotations) {
    if (annotation.kind !== "dimension") continue;
    const dimension = createDimensionLines(annotation);
    dimension.name = `graph3d-dimension:${annotation.id}`;
    root.add(dimension);
  }
  return root;
}

function createObjectGroup(item: Graph3DSceneGeometry["objects"][number]): Group {
  const objectGroup = new Group();
  objectGroup.name = `graph3d-object-group:${item.objectId}`;
  const style = item.object.style;
  const color = style?.color ?? GRAPH3D_DEFAULT_OBJECT_COLOR;
  const opacity = style?.opacity ?? GRAPH3D_DEFAULT_OBJECT_OPACITY;
  const meshGeometry = createIndexedGeometry(item.geometry);

  if (item.geometry.triangles.length > 0) {
    const mesh = new Mesh(meshGeometry, pooledStandardMaterial({
      color,
      opacity,
      roughness: 0.72,
      depthWrite: opacity >= 0.98,
    }));
    mesh.name = `graph3d-object:${item.objectId}`;
    objectGroup.add(mesh);
  } else if (item.geometry.lineSegments.length > 0) {
    const lines = new LineSegments(
      createLineSegmentsGeometry(item.geometry),
      pooledLineMaterial(color, opacity),
    );
    lines.name = `graph3d-lines:${item.objectId}`;
    objectGroup.add(lines);
    meshGeometry.dispose();
  } else {
    const points = new Points(meshGeometry, pooledPointsMaterial(color, 0.08));
    points.name = `graph3d-points:${item.objectId}`;
    objectGroup.add(points);
  }

  if (style?.wireframe && item.geometry.triangles.length > 0) {
    const wireframe = new LineSegments(
      item.geometry.lineSegments.length > 0
        ? createLineSegmentsGeometry(item.geometry)
        : new WireframeGeometry(meshGeometry),
      pooledLineMaterial(
        style.wireframeColor ?? style.color ?? GRAPH3D_DEFAULT_WIREFRAME_COLOR,
        opacity < 0.8 ? Math.min(1, Math.max(0.2, opacity + 0.2)) : 1,
      ),
    );
    wireframe.name = `graph3d-wireframe:${item.objectId}`;
    objectGroup.add(wireframe);
  }
  return objectGroup;
}

/** Replace only scene branches whose source geometry or authored presentation changed. */
export function updateThreeGraph3DGroup(
  root: Group,
  previous: Graph3DSceneGeometry,
  next: Graph3DSceneGeometry,
): void {
  const previousObjects = new Map(previous.objects.map((item) => [item.objectId, item]));
  syncNamedChildren(
    root,
    "graph3d-object-group:",
    next.objects.map((item) => ({
      name: `graph3d-object-group:${item.objectId}`,
      stable: previousObjects.get(item.objectId)?.geometry === item.geometry
        && previousObjects.get(item.objectId)?.object === item.object,
      create: () => createObjectGroup(item),
    })),
  );

  const previousIntersections = new Map(previous.intersections.map((item) => [item.regionId, item]));
  syncNamedChildren(
    root,
    "graph3d-intersection:",
    next.intersections.flatMap((item) => {
      const created = () => createIntersectionGroup(item);
      if (item.geometry.kind === "empty" || item.region.fill.mode === "none") return [];
      const old = previousIntersections.get(item.regionId);
      return [{
        name: `graph3d-intersection:${item.regionId}`,
        stable: old?.geometry === item.geometry && old.region === item.region,
        create: created,
      }];
    }),
  );

  const previousDimensions = new Map(previous.annotations
    .filter((item) => item.kind === "dimension")
    .map((item) => [item.id, JSON.stringify(item)]));
  syncNamedChildren(
    root,
    "graph3d-dimension:",
    next.annotations.filter((item) => item.kind === "dimension").map((item) => ({
      name: `graph3d-dimension:${item.id}`,
      stable: previousDimensions.get(item.id) === JSON.stringify(item),
      create: () => {
        const group = createDimensionLines(item);
        group.name = `graph3d-dimension:${item.id}`;
        return group;
      },
    })),
  );
}

function syncNamedChildren(
  root: Group,
  prefix: string,
  desired: Array<{ name: string; stable: boolean; create: () => Object3D | null }>,
): void {
  const byName = new Map(desired.map((item) => [item.name, item]));
  for (const child of [...root.children]) {
    if (!child.name.startsWith(prefix)) continue;
    const target = byName.get(child.name);
    if (target?.stable) {
      byName.delete(child.name);
      continue;
    }
    root.remove(child);
    disposeThreeGraph3DGroup(child);
  }
  for (const target of byName.values()) {
    const child = target.create();
    if (child) root.add(child);
  }
}

/**
 * The part several objects share, painted as its own body.
 *
 * A shared volume is a closed mesh, so it is filled directly; a shared flat area arrives as a
 * plane section and is filled the same way a cut section is, hatching included. Once the members
 * constrain each other far enough the answer has no volume left — a piece of one curved surface, a
 * line, a single point — and those are drawn as an outline, because that is all there is to draw.
 */
function createIntersectionGroup(
  intersection: Graph3DSceneGeometry["intersections"][number],
): Group | null {
  const fill = intersection.region.fill;
  if (fill.mode === "none") return null;
  const group = new Group();
  group.name = `graph3d-intersection:${intersection.regionId}`;
  const opacity = fill.opacity ?? GRAPH3D_DEFAULT_INTERSECTION_OPACITY;
  const edgeColor = intersection.region.edgeColor ?? fill.color;
  const showEdges = intersection.region.showEdges !== false;

  if (intersection.geometry.kind === "solid") {
    const geometry = createIndexedGeometry(intersection.geometry.geometry);
    const mesh = new Mesh(geometry, pooledStandardMaterial({
      // Hatching is a flat-figure convention; a shared volume reads as a solid body.
      color: fill.color,
      opacity,
      roughness: 0.6,
      depthWrite: opacity >= 0.98,
    }));
    mesh.name = `graph3d-intersection-solid:${intersection.regionId}`;
    group.add(mesh);
    if (showEdges) {
      const edges = new LineSegments(
        // Where the shared body changes which member it is following, the seams are the answer:
        // a marched surface has no clean dihedral creases for `EdgesGeometry` to find, and asking
        // it anyway keeps a third of all 40,000 triangle edges.
        intersection.geometry.seams
          ? new BufferGeometry().setFromPoints(
            intersection.geometry.seams.flatMap(([from, to]) => [toVector3(from), toVector3(to)]),
          )
          : new EdgesGeometry(geometry, 22),
        pooledLineMaterial(edgeColor, 1),
      );
      edges.name = `graph3d-intersection-edges:${intersection.regionId}`;
      group.add(edges);
    }
    return group;
  }

  if (intersection.geometry.kind === "surface") {
    // A shell shares a piece of itself, not a volume: fill the patch and draw where it stops.
    if (intersection.geometry.geometry.triangles.length > 0) {
      const patch = new Mesh(createIndexedGeometry(intersection.geometry.geometry), pooledStandardMaterial({
        color: fill.color,
        opacity,
        roughness: 0.7,
        depthWrite: false,
      }));
      patch.name = `graph3d-intersection-patch:${intersection.regionId}`;
      patch.renderOrder = 900;
      group.add(patch);
    }
    if (showEdges || intersection.geometry.geometry.triangles.length === 0) {
      const contour = createSegmentLines(intersection.geometry.contour, edgeColor);
      if (contour) {
        contour.name = `graph3d-intersection-contour:${intersection.regionId}`;
        group.add(contour);
      }
    }
    return group.children.length > 0 ? group : null;
  }

  if (intersection.geometry.kind === "curve") {
    const lines = createSegmentLines(intersection.geometry.segments, edgeColor);
    if (!lines) return null;
    lines.name = `graph3d-intersection-line:${intersection.regionId}`;
    group.add(lines);
    return group;
  }

  if (intersection.geometry.kind === "points") {
    if (intersection.geometry.points.length === 0) return null;
    // Drawn as little balls rather than as GL points: a point sprite is a couple of pixels at the
    // default camera and disappears entirely in the exported picture, and a shared point is the
    // whole answer when three planes meet.
    for (const point of intersection.geometry.points) {
      // A fresh geometry per dot, not a pooled one: `disposeThreeGraph3DGroup` frees every geometry
      // it finds, and a shared one would be freed out from under the next rebuild.
      const dot = new Mesh(
        new SphereGeometry(GRAPH3D_INTERSECTION_POINT_RADIUS, 16, 12),
        pooledStandardMaterial({ color: edgeColor, opacity: 1, roughness: 0.5, depthWrite: true }),
      );
      dot.position.copy(toVector3(point));
      dot.name = `graph3d-intersection-points:${intersection.regionId}`;
      group.add(dot);
    }
    return group;
  }

  if (intersection.geometry.kind !== "section") return null;
  const fillGeometry = createThreeGraph3DSectionFillGeometry(intersection.geometry.section);
  if (fillGeometry) {
    const mesh = new Mesh(fillGeometry, pooledStandardMaterial({
      color: fill.mode === "pattern" ? "#ffffff" : fill.color,
      ...(fill.mode === "pattern" ? { pattern: { kind: "diagonal", color: fill.color } } : {}),
      opacity,
      roughness: 0.85,
      depthWrite: false,
    }));
    mesh.name = `graph3d-intersection-area:${intersection.regionId}`;
    mesh.renderOrder = 900;
    group.add(mesh);
  }
  if (showEdges) {
    for (const loop of intersection.geometry.section.loops) {
      const outline = new LineLoop(
        new BufferGeometry().setFromPoints(loop.points3D.map(toVector3)),
        pooledLineMaterial(edgeColor, 1),
      );
      outline.name = `graph3d-intersection-outline:${intersection.regionId}`;
      group.add(outline);
    }
  }
  return group.children.length > 0 ? group : null;
}

export function disposeThreeGraph3DGroup(root: Object3D): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    if (hasGeometry(object)) geometries.add(object.geometry);
    if (hasMaterial(object)) {
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of objectMaterials) {
        if (isPooledMaterial(material)) continue;
        materials.add(material);
        if (material instanceof MeshStandardMaterial && material.map) textures.add(material.map);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  // Pooled materials outlive the group on purpose: disposing them throws away the compiled
  // shader program, which the very next rebuild would have to compile again.
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
}

function createIndexedGeometry(geometry: Graph3DMeshGeometry): BufferGeometry {
  const buffer = new BufferGeometry();
  buffer.setAttribute("position", new Float32BufferAttribute(
    geometry.positions.flatMap((point) => [point.x, point.y, point.z]),
    3,
  ));
  if (geometry.triangles.length > 0) {
    buffer.setIndex(geometry.triangles.flat());
    buffer.computeVertexNormals();
  }
  buffer.computeBoundingSphere();
  return buffer;
}

/** Loose 3D segments as one drawable line object; nothing is drawn for an empty run. */
function createSegmentLines(
  segments: ReadonlyArray<readonly [Graph3DPoint3, Graph3DPoint3]>,
  color: string,
): LineSegments | null {
  if (segments.length === 0) return null;
  return new LineSegments(
    new BufferGeometry().setFromPoints(segments.flatMap(([from, to]) => [toVector3(from), toVector3(to)])),
    pooledLineMaterial(color, 1),
  );
}

function createLineSegmentsGeometry(geometry: Graph3DMeshGeometry): BufferGeometry {
  return new BufferGeometry().setFromPoints(geometry.lineSegments.flatMap(([from, to]) => [
    toVector3(geometry.positions[from]),
    toVector3(geometry.positions[to]),
  ]));
}

function createLoopFillGeometry(
  points: Graph3DPoint3[],
  triangles: Array<[number, number, number]>,
  points2D?: Array<{ x: number; y: number }>,
): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(
    points.flatMap((point) => [point.x, point.y, point.z]),
    3,
  ));
  geometry.setIndex(triangles.flat());
  if (points2D?.length === points.length) {
    geometry.setAttribute("uv", new Float32BufferAttribute(
      points2D.flatMap((point) => [point.x / 0.35, point.y / 0.35]),
      2,
    ));
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Triangulates a complete cross-section, grouping nested loops as holes. Treating each loop as a
 * separate polygon fills the centre of annular sections; the even/odd nesting rule keeps only the
 * actual plane-solid intersection.
 */
export function createThreeGraph3DSectionFillGeometry(
  section: Graph3DMeshSection,
): BufferGeometry | null {
  const groups = groupSectionLoops(section);
  if (groups.length === 0) return null;

  const positions: number[] = [];
  const uvs: number[] = [];
  const triangles: number[] = [];
  for (const { outer, holes } of groups) {
    const orderedLoops = [outer, ...holes];
    const contour = outer.points2D.map((point) => new Vector2(point.x, point.y));
    const holePoints = holes.map((hole) => hole.points2D.map((point) => new Vector2(point.x, point.y)));
    const offset = positions.length / 3;
    for (const loop of orderedLoops) {
      for (let index = 0; index < loop.points3D.length; index += 1) {
        const point3D = loop.points3D[index];
        const point2D = loop.points2D[index];
        positions.push(point3D.x, point3D.y, point3D.z);
        uvs.push(point2D.x / 0.35, point2D.y / 0.35);
      }
    }
    for (const face of ShapeUtils.triangulateShape(contour, holePoints)) {
      triangles.push(offset + face[0], offset + face[1], offset + face[2]);
    }
  }

  if (triangles.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(triangles);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function groupSectionLoops(section: Graph3DMeshSection): Array<{
  outer: Graph3DMeshSection["loops"][number];
  holes: Graph3DMeshSection["loops"];
}> {
  const loops = section.loops.filter((loop) => loop.points2D.length >= 3);
  const areas = loops.map((loop) => Math.abs(signedArea2D(loop.points2D)));
  const parents = loops.map((loop, index) => {
    const point = loop.points2D[0];
    let parent = -1;
    let parentArea = Infinity;
    for (let candidate = 0; candidate < loops.length; candidate += 1) {
      if (candidate === index || areas[candidate] <= areas[index]) continue;
      if (areas[candidate] < parentArea && pointInPolygon2D(point, loops[candidate].points2D)) {
        parent = candidate;
        parentArea = areas[candidate];
      }
    }
    return parent;
  });
  const depths = parents.map((_, index) => {
    let depth = 0;
    let parent = parents[index];
    while (parent >= 0 && depth <= loops.length) {
      depth += 1;
      parent = parents[parent];
    }
    return depth;
  });

  return loops.flatMap((outer, index) => depths[index] % 2 === 0
    ? [{
        outer,
        holes: loops.filter((_, candidate) => parents[candidate] === index && depths[candidate] % 2 === 1),
      }]
    : []);
}

function signedArea2D(points: Array<{ x: number; y: number }>): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    area += points[index].x * next.y - next.x * points[index].y;
  }
  return area / 2;
}

function pointInPolygon2D(
  point: { x: number; y: number },
  polygon: Array<{ x: number; y: number }>,
): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const a = polygon[current];
    const b = polygon[previous];
    if (
      (a.y > point.y) !== (b.y > point.y) &&
      point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x
    ) inside = !inside;
  }
  return inside;
}

function createSectionPatternTexture(
  _pattern: "diagonal" | "cross" | "dots",
  colorValue: string,
): DataTexture {
  const size = 8;
  const data = new Uint8Array(size * size * 4);
  const color = new Color(colorValue);
  const red = Math.round(color.r * 255);
  const green = Math.round(color.g * 255);
  const blue = Math.round(color.b * 255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const diagonal = (x + y) % size <= 1;
      // Legacy documents used cross and dots. Render them as diagonal hatching so the current
      // product exposes and displays only the two requested styles: hatch or solid.
      const marked = diagonal;
      const offset = (y * size + x) * 4;
      data[offset] = marked ? red : 255;
      data[offset + 1] = marked ? green : 255;
      data[offset + 2] = marked ? blue : 255;
      data[offset + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

function createCutPlaneMesh(
  cutId: string,
  plane: Graph3DSceneGeometry["cuts"][number]["plane"],
): Mesh {
  const basis = createGraph3DPlaneBasisFromPlane(plane);
  const extent = 4;
  const points = [
    add3(plane.point, add3(scale3(basis.u, -extent), scale3(basis.v, -extent))),
    add3(plane.point, add3(scale3(basis.u, extent), scale3(basis.v, -extent))),
    add3(plane.point, add3(scale3(basis.u, extent), scale3(basis.v, extent))),
    add3(plane.point, add3(scale3(basis.u, -extent), scale3(basis.v, extent))),
  ];
  const geometry = createLoopFillGeometry(points, [[0, 1, 2], [0, 2, 3]]);
  const mesh = new Mesh(geometry, pooledStandardMaterial({
    color: "#d8e0e8",
    opacity: 0.16,
    roughness: 0.72,
    depthWrite: false,
  }));
  mesh.name = `graph3d-cut-plane:${cutId}`;
  return mesh;
}

/**
 * Dimension lines are drawn as thin cylinders rather than `LineSegments`.
 *
 * WebGL ignores `linewidth` on almost every platform, so a line-based dimension can only ever be
 * one pixel: an authored thickness, a dash pattern and an arrow head all need real geometry.
 */
function createDimensionLines(annotation: Extract<Graph3DSceneAnnotation, { kind: "dimension" }>): Group {
  const color = annotation.color ?? GRAPH3D_DEFAULT_DIMENSION_COLOR;
  const endStyle = resolveGraph3DDimensionEndStyle(annotation.endStyle);
  const radius = graph3DDimensionRadius(annotation.lineWidth);
  const start = toVector3(annotation.from);
  const end = toVector3(annotation.to);
  const span = end.clone().sub(start);
  const total = span.length();
  const group = new Group();
  if (total <= 1e-6) return group;
  const direction = span.clone().divideScalar(total);
  const headLength = graph3DDimensionHeadLength(radius, total);
  const startHead = createAxisEnd(endStyle, color, headLength, direction.clone().negate());
  const endHead = createAxisEnd(endStyle, color, headLength, direction);
  const trim = endHead?.shaftTrim ?? startHead?.shaftTrim ?? 0;
  const shaftStart = start.clone().addScaledVector(direction, trim);
  const shaftLength = Math.max(0, total - trim * 2);

  for (const [offset, length] of dashRuns(shaftLength, annotation.lineStyle ?? "solid", radius)) {
    group.add(createShaftSegment(
      shaftStart.clone().addScaledVector(direction, offset),
      direction,
      length,
      radius,
      color,
    ));
  }

  if (startHead) {
    startHead.object.position.copy(start);
    group.add(startHead.object);
  }
  if (endHead) {
    endHead.object.position.copy(end);
    group.add(endHead.object);
  }
  return group;
}

/** `[offset, length]` pairs along the shaft; one run for a solid line, many for a dash pattern. */
function dashRuns(
  shaftLength: number,
  lineStyle: "solid" | "dashed" | "dotted",
  radius: number,
): Array<[number, number]> {
  if (shaftLength <= 1e-6) return [];
  const pattern = graph3DDimensionDashPattern(lineStyle, radius);
  if (!pattern) return [[0, shaftLength]];
  const dash = pattern.dashSize;
  const gap = pattern.gapSize;
  const period = dash + gap;
  const count = Math.min(240, Math.max(1, Math.round(shaftLength / period)));
  const scaled = shaftLength / count;
  const dashLength = Math.max(radius * 0.8, scaled * (dash / period));
  return Array.from({ length: count }, (_, index) => [index * scaled, dashLength] as [number, number]);
}

function createShaftSegment(
  from: Vector3,
  direction: Vector3,
  length: number,
  radius: number,
  color: string,
): Mesh {
  const mesh = new Mesh(new CylinderGeometry(radius, radius, length, 10), pooledBasicMaterial(color));
  // `CylinderGeometry` runs along +y and is centred on its own height.
  mesh.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction));
  mesh.position.copy(from.clone().addScaledVector(direction, length / 2));
  return mesh;
}

function toVector3(point: Graph3DPoint3): Vector3 {
  return new Vector3(point.x, point.y, point.z);
}

function add3(a: Graph3DPoint3, b: Graph3DPoint3): Graph3DPoint3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale3(point: Graph3DPoint3, factor: number): Graph3DPoint3 {
  return { x: point.x * factor, y: point.y * factor, z: point.z * factor };
}

function hasGeometry(object: Object3D): object is Object3D & { geometry: BufferGeometry } {
  return "geometry" in object && object.geometry instanceof BufferGeometry;
}

function hasMaterial(object: Object3D): object is Object3D & { material: Material | Material[] } {
  return "material" in object && (
    object.material instanceof Material ||
    (Array.isArray(object.material) && object.material.every((material) => material instanceof Material))
  );
}

/**
 * Camera for the authored viewpoint.
 *
 * Both projections keep the same 6-unit vertical view box, so switching between them only
 * changes the perspective divide — never the framing the author set up.
 */
export function createThreeGraph3DCamera(camera: Graph3DCamera, aspect: number): Camera {
  const half = GRAPH3D_VIEW_HALF_HEIGHT;
  const result = camera.projection === "orthographic"
    ? new OrthographicCamera(-half * aspect, half * aspect, half, -half, GRAPH3D_NEAR_PLANE, 10_000)
    : new PerspectiveCamera(camera.fov ?? GRAPH3D_DEFAULT_FOV_DEGREES, aspect, GRAPH3D_NEAR_PLANE, 10_000);
  result.position.set(camera.position.x, camera.position.y, camera.position.z);
  result.up.set(camera.up.x, camera.up.y, camera.up.z);
  if (result instanceof OrthographicCamera) result.zoom = camera.zoom ?? 1;
  result.lookAt(camera.target.x, camera.target.y, camera.target.z);
  result.updateProjectionMatrix();
  return result;
}

/** Keeps the authored 6-unit view box while the viewport's shape changes. */
export function updateThreeGraph3DCameraAspect(camera: Camera, aspect: number): void {
  if (camera instanceof PerspectiveCamera) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  } else if (camera instanceof OrthographicCamera) {
    camera.left = -GRAPH3D_VIEW_HALF_HEIGHT * aspect;
    camera.right = GRAPH3D_VIEW_HALF_HEIGHT * aspect;
    camera.top = GRAPH3D_VIEW_HALF_HEIGHT;
    camera.bottom = -GRAPH3D_VIEW_HALF_HEIGHT;
    camera.updateProjectionMatrix();
  }
}

/** The three lights every 3D surface is lit with, so a still, an animation and a video match. */
export function addThreeGraph3DLights(scene: Scene): void {
  scene.add(new AmbientLight(GRAPH3D_LIGHTS.ambient.color, GRAPH3D_LIGHTS.ambient.intensity));
  for (const light of [GRAPH3D_LIGHTS.key, GRAPH3D_LIGHTS.fill]) {
    const directional = new DirectionalLight(light.color, light.intensity);
    directional.position.set(light.direction.x, light.direction.y, light.direction.z);
    scene.add(directional);
  }
}

/**
 * Background, grid and axes, swapped in place.
 *
 * Recreating the renderer for them cost a WebGL context per colour-picker step, and browsers
 * only keep a handful alive.
 */
export function applyThreeGraph3DView(
  scene: Scene,
  view: Graph3DViewSettings,
  axisColors: Graph3DAxisColors,
): void {
  for (const name of ["graph3d-grid", "graph3d-axes"]) {
    const existing = scene.getObjectByName(name);
    if (!existing) continue;
    scene.remove(existing);
    disposeThreeGraph3DGroup(existing);
  }
  scene.background = safeThreeColor(view.backgroundColor, GRAPH3D_DEFAULT_BACKGROUND_COLOR);
  if (view.showGrid) {
    const grid = new GridHelper(
      GRAPH3D_GRID.size,
      GRAPH3D_GRID.divisions,
      GRAPH3D_GRID.centerLineColor,
      GRAPH3D_GRID.gridColor,
    );
    grid.rotation.x = Math.PI / 2;
    grid.name = "graph3d-grid";
    scene.add(grid);
  }
  if (view.showAxes) {
    scene.add(createThreeGraph3DAxes(
      GRAPH3D_AXIS_LENGTH,
      axisColors,
      view.axisLineStyle ?? "solid",
      view.axisEndStyle ?? "arrow",
    ));
  }
}

export function safeThreeColor(value: string, fallback: string): Color {
  const color = new Color(fallback);
  try {
    color.set(value);
  } catch {
    // Keep the deterministic fallback for malformed in-progress color input.
  }
  return color;
}
