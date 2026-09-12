import type { OverlayArcShape, OverlayPoint } from "@/features/document";

import { snapPointAround } from "./angle";
import { normalizePositiveAngle } from "./math";
import { getArcRadii } from "./shape-bounds";

/** 半径ハンドルは掴みやすさのためこれ未満に縮めない。 */
const MIN_ARC_RADIUS_HANDLE_RESULT = 8;

/** 弧の中間角(startAngle から正方向 sweep の半分)。半径ハンドルの位置に使う。 */
export function getArcMidAngle(shape: OverlayArcShape): number {
  const sweep = normalizePositiveAngle(
    shape.props.endAngle - shape.props.startAngle,
  );
  return shape.props.startAngle + sweep / 2;
}

/**
 * 半径ハンドルのドラッグ。中心からの距離の比率で rx/ry をアスペクト維持のまま
 * 比例スケールする(中心固定、最小半径にクランプ)。point は shape.x/y と同じ
 * 座標系(回転前のローカル)であること。
 */
export function scaleArcRadiusFromDrag(
  shape: OverlayArcShape,
  point: OverlayPoint,
): OverlayArcShape {
  const { rx, ry } = getArcRadii(shape);
  const center = { x: shape.x + rx, y: shape.y + ry };
  const midAngle = getArcMidAngle(shape);
  const originalDistance = Math.hypot(
    Math.cos(midAngle) * rx,
    Math.sin(midAngle) * ry,
  );
  const draggedDistance = Math.hypot(
    point.x - center.x,
    point.y - center.y,
  );
  const rawScale = originalDistance > 0
    ? draggedDistance / originalDistance
    : 1;
  // アスペクト維持のため、rx/ry を個別にではなくスケール側で最小半径にクランプする。
  const scale = Math.max(
    rawScale,
    MIN_ARC_RADIUS_HANDLE_RESULT / Math.min(rx, ry),
  );
  const nextRx = rx * scale;
  const nextRy = ry * scale;

  return {
    ...shape,
    x: center.x - nextRx,
    y: center.y - nextRy,
    props: {
      ...shape.props,
      rx: nextRx,
      ry: nextRy,
      r: Math.max(nextRx, nextRy),
    },
  };
}

/** arc/sector の挿入ドラッグ方向を Shift 中だけ15°刻みにスナップする(距離は維持)。 */
export function getSnappedArcInsertDragPoint(
  start: OverlayPoint,
  point: OverlayPoint,
  shiftKey: boolean,
): OverlayPoint {
  return shiftKey ? snapPointAround(start, point) : point;
}
