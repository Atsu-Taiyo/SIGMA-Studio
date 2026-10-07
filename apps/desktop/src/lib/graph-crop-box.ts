import type { GraphSvgCropBox } from "./graph2d";

/** グラフのプロット領域 (SVG 座標)。切り取り枠が動ける範囲の基準。 */
export interface GraphCropPlotRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GraphCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 切り取り枠の最小寸法 (SVG 座標)。 */
export const GRAPH_CROP_MIN_SIZE = 30;

/**
 * 描画範囲の拡大で、プロット領域の各辺から外へ広げられる量 (その方向のプロット寸法に対する比)。
 * 広げた分は縮尺を変えずに足されるので、図形の大きさそのものが増える。際限なく広げると
 * 紙面に収まらない図形になるため、1 回の切り取りで広げられる量に上限を置く。
 */
export const GRAPH_CROP_EXPAND_RATIO = 1;

/** SVG の座標変換行列 (`DOMMatrix` の a〜d。平行移動は移動量の換算には要らない)。 */
export interface GraphScreenMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
}

/**
 * 画面上のポインタの移動量を、図の SVG 座標の移動量へ換算する。
 *
 * 図の座標系から画面への変換行列 (`svg.getScreenCTM()`) の逆行列を掛ける。要素の大きさだけで割ると、
 * 回転した図形では画面上の外接矩形の大きさで割ることになり、移動の向きも縮尺も狂う。行列なら
 * 回転・拡大縮小・反転が一度に正しく扱える。つぶれた行列 (表示されていない要素など) は null。
 */
export function clientDeltaToSvgDelta(
  matrix: GraphScreenMatrix,
  dx: number,
  dy: number,
): { x: number; y: number } | null {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) {
    return null;
  }
  return {
    x: (matrix.d * dx - matrix.c * dy) / determinant,
    y: (-matrix.b * dx + matrix.a * dy) / determinant,
  };
}

export interface DragGraphCropBoxInput {
  /** ドラッグ開始時の枠。 */
  start: GraphSvgCropBox;
  /** 掴んだ場所。`center` は枠ごと移動、それ以外は `l` `r` `t` `b` の組み合わせ (`tl` など)。 */
  handle: string;
  /** 開始位置からの移動量 (SVG 座標)。 */
  dx: number;
  dy: number;
  plot: GraphCropPlotRect;
  /**
   * true の間はプロットの外へ広げられる (描画範囲の拡大)。false ではプロットの内側に留まる。
   * どちらでも、ドラッグ開始時にすでにある枠の位置までは動ける — 拡大済みの枠を
   * 縮めようとした瞬間にプロットの縁へ吸い込まれないようにするため。
   */
  expand: boolean;
}

/** 切り取り枠のハンドル操作を、動ける範囲に収めた新しい枠にする。 */
export function dragGraphCropBox({ start, handle, dx, dy, plot, expand }: DragGraphCropBoxInput): GraphSvgCropBox {
  const startRight = start.left + start.width;
  const startBottom = start.top + start.height;
  const roomX = expand ? (plot.right - plot.left) * GRAPH_CROP_EXPAND_RATIO : 0;
  const roomY = expand ? (plot.bottom - plot.top) * GRAPH_CROP_EXPAND_RATIO : 0;
  const minLeft = Math.min(plot.left - roomX, start.left);
  const maxRight = Math.max(plot.right + roomX, startRight);
  const minTop = Math.min(plot.top - roomY, start.top);
  const maxBottom = Math.max(plot.bottom + roomY, startBottom);

  const next = { ...start };

  if (handle === "center") {
    next.left = clamp(start.left + dx, minLeft, maxRight - start.width);
    next.top = clamp(start.top + dy, minTop, maxBottom - start.height);
    return next;
  }

  if (handle.includes("l")) {
    const left = clamp(start.left + dx, minLeft, startRight - GRAPH_CROP_MIN_SIZE);
    next.width = startRight - left;
    next.left = left;
  }
  if (handle.includes("r")) {
    next.width = Math.max(GRAPH_CROP_MIN_SIZE, Math.min(maxRight - start.left, start.width + dx));
  }
  if (handle.includes("t")) {
    const top = clamp(start.top + dy, minTop, startBottom - GRAPH_CROP_MIN_SIZE);
    next.height = startBottom - top;
    next.top = top;
  }
  if (handle.includes("b")) {
    next.height = Math.max(GRAPH_CROP_MIN_SIZE, Math.min(maxBottom - start.top, start.height + dy));
  }
  return next;
}

/** 枠がプロット領域の外へはみ出している (= 描画範囲を拡大している) か。 */
export function graphCropBoxExtendsBeyondPlot(box: GraphSvgCropBox, plot: GraphCropPlotRect): boolean {
  return box.left < plot.left - EPSILON
    || box.top < plot.top - EPSILON
    || box.left + box.width > plot.right + EPSILON
    || box.top + box.height > plot.bottom + EPSILON;
}

/** 枠のうちプロット領域と重なる部分。重ならなければ null。 */
export function intersectGraphCropBoxWithPlot(box: GraphSvgCropBox, plot: GraphCropPlotRect): GraphCropRect | null {
  const left = Math.max(box.left, plot.left);
  const top = Math.max(box.top, plot.top);
  const right = Math.min(box.left + box.width, plot.right);
  const bottom = Math.min(box.top + box.height, plot.bottom);
  if (right <= left || bottom <= top) {
    return null;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** プロット領域のうち、枠の外にあって切り落とされる部分 (影を掛ける矩形の並び)。 */
export function getGraphCropShadowRects(box: GraphSvgCropBox, plot: GraphCropPlotRect): GraphCropRect[] {
  const plotWidth = Math.max(0, plot.right - plot.left);
  const plotHeight = Math.max(0, plot.bottom - plot.top);
  const kept = intersectGraphCropBoxWithPlot(box, plot);
  if (!kept) {
    return [{ x: plot.left, y: plot.top, width: plotWidth, height: plotHeight }];
  }
  const keptRight = kept.x + kept.width;
  const keptBottom = kept.y + kept.height;
  return [
    { x: plot.left, y: plot.top, width: plotWidth, height: kept.y - plot.top },
    { x: plot.left, y: keptBottom, width: plotWidth, height: plot.bottom - keptBottom },
    { x: plot.left, y: kept.y, width: kept.x - plot.left, height: kept.height },
    { x: keptRight, y: kept.y, width: plot.right - keptRight, height: kept.height },
  ].filter((rect) => rect.width > EPSILON && rect.height > EPSILON);
}

/**
 * 枠のうちプロット領域の外 (= 拡大で足される部分) を切り抜く clip の path。
 * 外側の矩形が枠、内側の矩形が元のプロットと重なる部分で、`evenodd` で内側を抜く。
 */
export function getGraphCropExpansionClipPath(box: GraphSvgCropBox, plot: GraphCropPlotRect): string {
  const outer = rectPath(box.left, box.top, box.width, box.height);
  const kept = intersectGraphCropBoxWithPlot(box, plot);
  return kept ? `${outer} ${rectPath(kept.x, kept.y, kept.width, kept.height)}` : outer;
}

const EPSILON = 0.001;

function rectPath(x: number, y: number, width: number, height: number): string {
  return `M${x} ${y}h${width}v${height}h${-width}Z`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
