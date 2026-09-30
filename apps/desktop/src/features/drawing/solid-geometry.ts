import type {
  OverlayDash,
  OverlayPoint,
  OverlayShape,
  OverlaySolidBaseSides,
  OverlayTextSize,
} from "@/features/document";

import { pagePointToUnrotatedShapePoint } from "./math";
import { getShapeRotation } from "./shape-bounds";
import { getShapeRotationPivot } from "./shape-visual-bounds";

/**
 * 立体図形 (角錐・角柱・球) の幾何。
 *
 * 教材で描く立体は、見えない辺を破線にした針金細工の図である。そのため面ではなく
 * **頂点と辺**を正本にする: 頂点は自由に動かせ、辺は1本ずつ線種を持てる。
 * 立体の種類と底面の辺の数が頂点・辺の並びを決め (`getSolidTopology`)、既定の見え方は
 * 3D の立体を固定のカメラで正射影し、面の向きから隠れる辺を求めて作る (`getSolidPreset`)。
 * 作った後の頂点は 2D の点として保存されるので、頂点を動かしても隠れ線の再計算はしない —
 * どの辺を破線にするかは作者の選択である。
 *
 * React・DOM・AI を知らない。編集画面 (React) と SVG 出力の両方がここを読む。
 */

type OverlayGeoShape = Extract<OverlayShape, { type: "geo" }>;

export const SOLID_BASE_SIDES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const satisfies readonly OverlaySolidBaseSides[];

export type OverlaySolidGeo = "pyramid" | "prism" | "sphere";
/** ギャラリーとツールが使うコマンド名。`pyramid3` = 三角錐、`prism5` = 五角柱。 */
export type OverlaySolidCommand = "sphere" | `pyramid${OverlaySolidBaseSides}` | `prism${OverlaySolidBaseSides}`;

/** ツール・ギャラリーが扱う立体コマンドの全部 (三角錐 … 十二角錐、三角柱 … 十二角柱、球)。 */
export const OVERLAY_SOLID_COMMANDS: readonly OverlaySolidCommand[] = [
  ...SOLID_BASE_SIDES.map((sides) => `pyramid${sides}` as const),
  ...SOLID_BASE_SIDES.map((sides) => `prism${sides}` as const),
  "sphere",
];

export interface OverlaySolidKind {
  geo: OverlaySolidGeo;
  /** 角錐・角柱の底面の辺の数。球は持たない。 */
  baseSides?: OverlaySolidBaseSides;
}

export function isSolidGeo(geo: string): geo is OverlaySolidGeo {
  return geo === "pyramid" || geo === "prism" || geo === "sphere";
}

/**
 * 立体図形 (`geo` 図形のうち角錐・角柱・球)。`OverlayGeoShape` そのものを返す型にしないのは、
 * 型ガードの偽の側で「`geo` 図形ぜんぶ」が消えてしまい、平面の図形を扱えなくなるため。
 */
export type OverlaySolidShape = OverlayGeoShape & { props: { geo: OverlaySolidGeo } };

export function isSolidShape(shape: OverlayShape): shape is OverlaySolidShape {
  return shape.type === "geo" && isSolidGeo(shape.props.geo);
}

export function normalizeSolidBaseSides(value: unknown): OverlaySolidBaseSides {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  const rounded = Math.round(Number.isFinite(parsed) ? parsed : 3);
  return Math.min(12, Math.max(3, rounded)) as OverlaySolidBaseSides;
}

const SOLID_COMMAND_PATTERN = /^(pyramid|prism)(\d{1,2})$/u;

export function solidFromCommand(command: string): OverlaySolidKind | null {
  if (command === "sphere") {
    return { geo: "sphere" };
  }
  const match = SOLID_COMMAND_PATTERN.exec(command);
  if (!match) {
    return null;
  }
  const sides = Number.parseInt(match[2], 10);
  if (sides < 3 || sides > 12) {
    return null;
  }
  return { geo: match[1] as "pyramid" | "prism", baseSides: sides as OverlaySolidBaseSides };
}

export function solidCommandFor(kind: OverlaySolidKind): OverlaySolidCommand {
  return kind.geo === "sphere"
    ? "sphere"
    : `${kind.geo}${normalizeSolidBaseSides(kind.baseSides)}` as OverlaySolidCommand;
}

/** 図形が持つ立体の種類。 */
export function getSolidKind(shape: OverlayGeoShape): OverlaySolidKind | null {
  if (!isSolidGeo(shape.props.geo)) {
    return null;
  }
  return shape.props.geo === "sphere"
    ? { geo: "sphere" }
    : { geo: shape.props.geo, baseSides: normalizeSolidBaseSides(shape.props.baseSides) };
}

export interface SolidTopology {
  vertexCount: number;
  /** 辺 = 頂点番号の組。並びが `solidEdgeDash` の添字になる。 */
  edges: ReadonlyArray<readonly [number, number]>;
  /** 面 = 頂点番号の輪。凸で平面の面だけを持つ (隠れ線の判定と塗りに使う)。 */
  faces: ReadonlyArray<readonly number[]>;
}

const topologyCache = new Map<string, SolidTopology>();

/**
 * 角錐・角柱の頂点と辺の並び。
 *
 * - 角錐: 頂点 = 底面の頂点 (0..n-1) → 頂点 (n)。辺 = 底面の辺 (n本) → 頂点への辺 (n本)。
 * - 角柱: 頂点 = 下底 (0..n-1) → 上底 (n..2n-1)。辺 = 下底 → 上底 → 側面の辺 (各 n 本)。
 */
export function getSolidTopology(geo: "pyramid" | "prism", baseSides: number): SolidTopology {
  const n = normalizeSolidBaseSides(baseSides);
  const key = `${geo}:${n}`;
  const cached = topologyCache.get(key);
  if (cached) {
    return cached;
  }

  const ring = Array.from({ length: n }, (_, index) => index);
  const next = (index: number) => (index + 1) % n;
  let topology: SolidTopology;
  if (geo === "pyramid") {
    topology = {
      vertexCount: n + 1,
      edges: [
        ...ring.map((index) => [index, next(index)] as const),
        ...ring.map((index) => [index, n] as const),
      ],
      faces: [
        ring,
        ...ring.map((index) => [index, next(index), n]),
      ],
    };
  } else {
    topology = {
      vertexCount: n * 2,
      edges: [
        ...ring.map((index) => [index, next(index)] as const),
        ...ring.map((index) => [n + index, n + next(index)] as const),
        ...ring.map((index) => [index, n + index] as const),
      ],
      faces: [
        ring,
        ring.map((index) => n + index),
        ...ring.map((index) => [index, next(index), n + next(index), n + index]),
      ],
    };
  }
  topologyCache.set(key, topology);
  return topology;
}

/** 球の辺: 輪郭 → 赤道の手前 → 赤道の奥。 */
export const SPHERE_EDGE_COUNT = 3;
/** 球の赤道の楕円の縦横比 (輪郭の半径に対する赤道の縦半径)。 */
const SPHERE_EQUATOR_TILT = 0.3;

export function getSolidEdgeCount(kind: OverlaySolidKind): number {
  return kind.geo === "sphere"
    ? SPHERE_EDGE_COUNT
    : getSolidTopology(kind.geo, kind.baseSides ?? 3).edges.length;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const PRESET_YAW = (24 * Math.PI) / 180;
/** 底面が三角形だと奥の頂点が手前の頂点と重なって見えるので、回す量を控えめにする。 */
const TRIANGLE_PRESET_YAW = (11 * Math.PI) / 180;
const PRESET_PITCH = (24 * Math.PI) / 180;
const PYRAMID_HEIGHT = 1.7;
const PRISM_HEIGHT = 1.5;

export interface SolidPreset {
  /** 0..1 の単位正方形に、外接矩形が四辺へ接するよう正規化した頂点。 */
  unitPoints: OverlayPoint[];
  /** 既定の見え方で他の面に隠れる辺。 */
  hiddenEdges: boolean[];
  /** 既定の見え方の縦横比 (h / w)。 */
  aspect: number;
}

const presetCache = new Map<string, SolidPreset>();

/**
 * 既定の見え方。
 *
 * 底面の頂点を、手前に辺が来る向きから少し回して (`PRESET_YAW`) 斜め上から見下ろす
 * (`PRESET_PITCH`)。教科書の作図と同じく、底面の奥側の頂点だけが隠れる。
 */
export function getSolidPreset(geo: "pyramid" | "prism", baseSides: number): SolidPreset {
  const n = normalizeSolidBaseSides(baseSides);
  const key = `${geo}:${n}`;
  const cached = presetCache.get(key);
  if (cached) {
    return cached;
  }

  const topology = getSolidTopology(geo, n);
  const yaw = n === 3 ? TRIANGLE_PRESET_YAW : PRESET_YAW;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const ringAt = (y: number): Vec3[] => Array.from({ length: n }, (_, index) => {
    // 手前 (+z、カメラ側) の中央に辺が来る向きから始める。
    const angle = Math.PI / 2 - Math.PI / n + (Math.PI * 2 * index) / n;
    const x = Math.cos(angle);
    const z = Math.sin(angle);
    return { x: x * cosYaw + z * sinYaw, y, z: -x * sinYaw + z * cosYaw };
  });
  const vertices: Vec3[] = geo === "pyramid"
    ? [...ringAt(0), { x: 0, y: PYRAMID_HEIGHT, z: 0 }]
    : [...ringAt(0), ...ringAt(PRISM_HEIGHT)];

  const center = averageOf(vertices);
  const toCamera: Vec3 = { x: 0, y: Math.sin(PRESET_PITCH), z: Math.cos(PRESET_PITCH) };
  const faceVisible = topology.faces.map((face) => {
    const [a, b, c] = face.map((index) => vertices[index]);
    let normal = cross(subtract(b, a), subtract(c, a));
    // 立体の中心から外へ向く側を表とする。頂点の巡り方に依存しない。
    if (dot(normal, subtract(averageOf(face.map((index) => vertices[index])), center)) < 0) {
      normal = { x: -normal.x, y: -normal.y, z: -normal.z };
    }
    return dot(normal, toCamera) > 1e-6;
  });
  const hiddenEdges = topology.edges.map(([a, b]) => {
    const faces = topology.faces.filter((face) => isConsecutiveInLoop(face, a, b));
    return faces.length > 0 && faces.every((face) => !faceVisible[topology.faces.indexOf(face)]);
  });

  const cosPitch = Math.cos(PRESET_PITCH);
  const sinPitch = Math.sin(PRESET_PITCH);
  // カメラに近い点ほど画面の下に来る。
  const projected = vertices.map((vertex) => ({
    x: vertex.x,
    y: -vertex.y * cosPitch + vertex.z * sinPitch,
  }));
  const minX = Math.min(...projected.map((point) => point.x));
  const maxX = Math.max(...projected.map((point) => point.x));
  const minY = Math.min(...projected.map((point) => point.y));
  const maxY = Math.max(...projected.map((point) => point.y));
  const width = Math.max(Number.EPSILON, maxX - minX);
  const height = Math.max(Number.EPSILON, maxY - minY);

  const preset: SolidPreset = {
    unitPoints: projected.map((point) => ({ x: (point.x - minX) / width, y: (point.y - minY) / height })),
    hiddenEdges,
    aspect: height / width,
  };
  presetCache.set(key, preset);
  return preset;
}

/** 立体を挿入するとき、Ctrl でそろえる既定の縦横比 (h / w)。 */
export function getSolidNaturalAspect(kind: OverlaySolidKind): number {
  return kind.geo === "sphere" ? 1 : getSolidPreset(kind.geo, kind.baseSides ?? 3).aspect;
}

/**
 * 新しい立体の辺ごとの線種。見えない辺は破線、見える辺は `visibleDash`。
 * 球は赤道の奥だけが破線。
 */
export function createSolidEdgeDash(kind: OverlaySolidKind, visibleDash: OverlayDash = "solid"): OverlayDash[] {
  if (kind.geo === "sphere") {
    return [visibleDash, visibleDash, "dashed"];
  }
  return getSolidPreset(kind.geo, kind.baseSides ?? 3).hiddenEdges.map((hidden) => (hidden ? "dashed" : visibleDash));
}

/** 立体の頂点 (図形ローカル座標)。保存された頂点が立体と合わなければ既定の見え方に戻す。 */
export function getSolidPoints(shape: OverlayGeoShape): OverlayPoint[] {
  const kind = getSolidKind(shape);
  if (!kind || kind.geo === "sphere") {
    return [];
  }
  const topology = getSolidTopology(kind.geo, kind.baseSides ?? 3);
  const stored = shape.props.solidPoints;
  if (
    stored &&
    stored.length === topology.vertexCount &&
    stored.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
  ) {
    return stored;
  }
  const { w, h } = shape.props;
  return getSolidPreset(kind.geo, kind.baseSides ?? 3).unitPoints.map((point) => ({
    x: point.x * w,
    y: point.y * h,
  }));
}

/** 頂点を動かした (= 既定の見え方から外れた) 立体か。 */
export function hasCustomSolidPoints(shape: OverlayGeoShape): boolean {
  const kind = getSolidKind(shape);
  if (!kind || kind.geo === "sphere") {
    return false;
  }
  return shape.props.solidPoints?.length === getSolidTopology(kind.geo, kind.baseSides ?? 3).vertexCount;
}

/** 辺 `index` の線種。指定がなければ図形全体の `dash`。 */
export function getSolidEdgeDash(shape: OverlayGeoShape, index: number): OverlayDash {
  return shape.props.solidEdgeDash?.[index] ?? shape.props.dash;
}

/** 辺 `index` の線の太さ。指定がなければ図形全体の `size`。 */
export function getSolidEdgeSize(shape: OverlayGeoShape, index: number): OverlayTextSize {
  return shape.props.solidEdgeSize?.[index] ?? shape.props.size;
}

export interface SolidStroke {
  /** 辺の番号 (`solidEdgeDash` / `solidEdgeSize` の添字)。 */
  index: number;
  /** 図形ローカル座標の SVG path data。 */
  d: string;
  /** 当たり判定用の折れ線 (図形ローカル座標)。曲線は細かい折れ線で近似する。 */
  points: OverlayPoint[];
  dash: OverlayDash;
  size: OverlayTextSize;
}

const CURVE_SAMPLE_COUNT = 48;

/** 立体の線 1 本ずつ。編集画面と SVG 出力が同じものを描く。 */
export function getSolidStrokes(shape: OverlayGeoShape): SolidStroke[] {
  const kind = getSolidKind(shape);
  if (!kind) {
    return [];
  }
  if (kind.geo === "sphere") {
    return getSphereStrokes(shape);
  }

  const points = getSolidPoints(shape);
  return getSolidTopology(kind.geo, kind.baseSides ?? 3).edges.map(([a, b], index) => ({
    index,
    d: `M ${points[a].x} ${points[a].y} L ${points[b].x} ${points[b].y}`,
    points: [points[a], points[b]],
    dash: getSolidEdgeDash(shape, index),
    size: getSolidEdgeSize(shape, index),
  }));
}

function getSphereStrokes(shape: OverlayGeoShape): SolidStroke[] {
  const { w, h } = shape.props;
  const rx = w / 2;
  const ry = h / 2;
  const equatorRy = ry * SPHERE_EQUATOR_TILT;
  const sample = (radiusY: number, from: number, to: number): OverlayPoint[] => (
    Array.from({ length: CURVE_SAMPLE_COUNT + 1 }, (_, step) => {
      const angle = from + ((to - from) * step) / CURVE_SAMPLE_COUNT;
      return { x: rx + Math.cos(angle) * rx, y: ry + Math.sin(angle) * radiusY };
    })
  );
  return [
    {
      index: 0,
      d: `M 0 ${ry} A ${rx} ${ry} 0 1 1 ${w} ${ry} A ${rx} ${ry} 0 1 1 0 ${ry}`,
      points: sample(ry, 0, Math.PI * 2),
      dash: getSolidEdgeDash(shape, 0),
      size: getSolidEdgeSize(shape, 0),
    },
    {
      // 手前 (画面の下) の半周。
      index: 1,
      d: `M 0 ${ry} A ${rx} ${equatorRy} 0 0 0 ${w} ${ry}`,
      points: sample(equatorRy, Math.PI, 0),
      dash: getSolidEdgeDash(shape, 1),
      size: getSolidEdgeSize(shape, 1),
    },
    {
      // 奥 (画面の上) の半周。
      index: 2,
      d: `M 0 ${ry} A ${rx} ${equatorRy} 0 0 1 ${w} ${ry}`,
      points: sample(equatorRy, Math.PI, Math.PI * 2),
      dash: getSolidEdgeDash(shape, 2),
      size: getSolidEdgeSize(shape, 2),
    },
  ];
}

/** 塗りつぶしに使う外周。頂点の凸包 (角錐・角柱の見た目の輪郭に当たる)。 */
export function getSolidFillPolygon(shape: OverlayGeoShape): OverlayPoint[] {
  return getConvexHull(getSolidPoints(shape));
}

/**
 * 線に近い点を指す辺の番号。辺の上にない点は `null`。
 * 近い辺が重なる場所 (頂点の付近) では、いちばん近い辺を選ぶ。
 */
export function hitTestSolidEdge(shape: OverlayGeoShape, localPoint: OverlayPoint, tolerance: number): number | null {
  let best: { index: number; distance: number } | null = null;
  for (const stroke of getSolidStrokes(shape)) {
    for (let step = 0; step < stroke.points.length - 1; step += 1) {
      const distance = distanceToSegment(localPoint, stroke.points[step], stroke.points[step + 1]);
      if (distance <= tolerance && (!best || distance < best.distance)) {
        best = { index: stroke.index, distance };
      }
    }
  }
  return best ? best.index : null;
}

/** 回転・反転したページ上の点で、辺を選ぶ。 */
export function hitTestSolidEdgeAtPagePoint(shape: OverlayGeoShape, pagePoint: OverlayPoint, tolerance: number): number | null {
  const point = pagePointToUnrotatedShapePoint(
    pagePoint,
    getShapeRotationPivot(shape),
    getShapeRotation(shape),
    shape.flipX,
    shape.flipY,
  );
  return hitTestSolidEdge(shape, { x: point.x - shape.x, y: point.y - shape.y }, tolerance);
}

const MIN_SOLID_FRAME = 1;

/**
 * 頂点を動かす。`point` は図形が回転・反転する前のページ座標。
 *
 * 外接矩形 (`x`/`y`/`w`/`h`) は頂点にぴったり接する決まりなので、頂点を枠の外へ出したら
 * 枠のほうを取り直す。図形は枠の中心で回るため、枠を取り直すと回転の軸が動く。動かしていない
 * 頂点が画面上で動かないよう、回転・反転をかけた後の中心のずれを `x`/`y` へ足す。
 */
export function moveSolidVertex(shape: OverlayGeoShape, index: number, point: OverlayPoint): OverlayGeoShape {
  const points = getSolidPoints(shape);
  if (index < 0 || index >= points.length) {
    return shape;
  }
  return refitSolidFrame(shape, points.map((item, itemIndex) => (
    itemIndex === index ? { x: point.x - shape.x, y: point.y - shape.y } : item
  )));
}

function refitSolidFrame(shape: OverlayGeoShape, points: OverlayPoint[]): OverlayGeoShape {
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const w = Math.max(MIN_SOLID_FRAME, Math.max(...points.map((point) => point.x)) - minX);
  const h = Math.max(MIN_SOLID_FRAME, Math.max(...points.map((point) => point.y)) - minY);

  // 新しい枠の中心 (旧ローカル座標) が、旧い枠の中心からどれだけ動いたか。
  const shift = { x: minX + w / 2 - shape.props.w / 2, y: minY + h / 2 - shape.props.h / 2 };
  const flipped = { x: shape.flipX ? -shift.x : shift.x, y: shape.flipY ? -shift.y : shift.y };
  const rotation = typeof shape.rotation === "number" && Number.isFinite(shape.rotation) ? shape.rotation : 0;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const center = {
    x: shape.x + shape.props.w / 2 + flipped.x * cos - flipped.y * sin,
    y: shape.y + shape.props.h / 2 + flipped.x * sin + flipped.y * cos,
  };

  return {
    ...shape,
    x: center.x - w / 2,
    y: center.y - h / 2,
    props: {
      ...shape.props,
      w,
      h,
      solidPoints: points.map((point) => ({ x: point.x - minX, y: point.y - minY })),
    },
  };
}

/** 枠を `w` × `h` に伸縮したときの、保存された頂点。頂点を動かしていない立体は `undefined`。 */
export function scaleSolidPoints(shape: OverlayGeoShape, w: number, h: number): OverlayPoint[] | undefined {
  if (!hasCustomSolidPoints(shape)) {
    return undefined;
  }
  const scaleX = w / Math.max(MIN_SOLID_FRAME, shape.props.w);
  const scaleY = h / Math.max(MIN_SOLID_FRAME, shape.props.h);
  return getSolidPoints(shape).map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }));
}

/** 辺の線種を 1 本だけ変える。辺の数に足りない分は図形全体の `dash` で埋める。 */
export function setSolidEdgeDash(shape: OverlayGeoShape, index: number, dash: OverlayDash): OverlayGeoShape {
  const kind = getSolidKind(shape);
  if (!kind) {
    return shape;
  }
  const count = getSolidEdgeCount(kind);
  if (index < 0 || index >= count) {
    return shape;
  }
  const next = Array.from({ length: count }, (_, edge) => (
    edge === index ? dash : getSolidEdgeDash(shape, edge)
  ));
  return { ...shape, props: { ...shape.props, solidEdgeDash: next } };
}

/** 辺すべてを同じ線種にする。 */
export function setSolidDash(shape: OverlayGeoShape, dash: OverlayDash): OverlayGeoShape {
  const props = { ...shape.props, dash };
  delete props.solidEdgeDash;
  return { ...shape, props };
}

/** 辺の線の太さを 1 本だけ変える。辺の数に足りない分は図形全体の `size` で埋める。 */
export function setSolidEdgeSize(shape: OverlayGeoShape, index: number, size: OverlayTextSize): OverlayGeoShape {
  const kind = getSolidKind(shape);
  if (!kind) {
    return shape;
  }
  const count = getSolidEdgeCount(kind);
  if (index < 0 || index >= count) {
    return shape;
  }
  const next = Array.from({ length: count }, (_, edge) => (
    edge === index ? size : getSolidEdgeSize(shape, edge)
  ));
  return { ...shape, props: { ...shape.props, solidEdgeSize: next } };
}

/** 辺すべてを同じ太さにする。 */
export function setSolidSize(shape: OverlayGeoShape, size: OverlayTextSize): OverlayGeoShape {
  const props = { ...shape.props, size };
  delete props.solidEdgeSize;
  return { ...shape, props };
}

/** 辺の線の太さが全部そろっていればその太さ、ばらばらなら `null`。 */
export function getSharedSolidSize(shape: OverlayGeoShape): OverlayTextSize | null {
  const kind = getSolidKind(shape);
  if (!kind) {
    return shape.props.size;
  }
  const count = getSolidEdgeCount(kind);
  const first = getSolidEdgeSize(shape, 0);
  for (let index = 1; index < count; index += 1) {
    if (getSolidEdgeSize(shape, index) !== first) {
      return null;
    }
  }
  return first;
}

/** 辺の線種が全部そろっていればその線種、ばらばらなら `null`。 */
export function getSharedSolidDash(shape: OverlayGeoShape): OverlayDash | null {
  const kind = getSolidKind(shape);
  if (!kind) {
    return shape.props.dash;
  }
  const count = getSolidEdgeCount(kind);
  const first = getSolidEdgeDash(shape, 0);
  for (let index = 1; index < count; index += 1) {
    if (getSolidEdgeDash(shape, index) !== first) {
      return null;
    }
  }
  return first;
}

function averageOf(vertices: readonly Vec3[]): Vec3 {
  const sum = vertices.reduce((total, vertex) => ({
    x: total.x + vertex.x,
    y: total.y + vertex.y,
    z: total.z + vertex.z,
  }), { x: 0, y: 0, z: 0 });
  return { x: sum.x / vertices.length, y: sum.y / vertices.length, z: sum.z / vertices.length };
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** 輪 `loop` の中で `a` と `b` が隣り合っているか (辺がその面に属するか)。 */
function isConsecutiveInLoop(loop: readonly number[], a: number, b: number): boolean {
  return loop.some((vertex, position) => {
    const following = loop[(position + 1) % loop.length];
    return (vertex === a && following === b) || (vertex === b && following === a);
  });
}

function distanceToSegment(point: OverlayPoint, start: OverlayPoint, end: OverlayPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

/** Andrew の単調連鎖法。 */
function getConvexHull(points: readonly OverlayPoint[]): OverlayPoint[] {
  if (points.length < 3) {
    return [...points];
  }
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const turn = (o: OverlayPoint, a: OverlayPoint, b: OverlayPoint) => (
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  );
  const build = (ordered: readonly OverlayPoint[]): OverlayPoint[] => {
    const chain: OverlayPoint[] = [];
    for (const point of ordered) {
      while (chain.length >= 2 && turn(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) {
        chain.pop();
      }
      chain.push(point);
    }
    chain.pop();
    return chain;
  };
  return [...build(sorted), ...build([...sorted].reverse())];
}
