// Compatibility entrypoint. Arc model behavior lives in the drawing feature.
export {
  createArcShapeFromCenterDrag,
  createArcShapeFromThreePoints,
} from "@/features/drawing/arc-creation";
export type {
  ArcShapeStyle,
  CenterDragArcKind,
} from "@/features/drawing/arc-creation";
export {
  getArcMidAngle,
  getSnappedArcInsertDragPoint,
  scaleArcRadiusFromDrag,
} from "@/features/drawing/arc-interaction";
export { getArcRadii } from "@/features/drawing/shape-bounds";
export { getArcDragReadoutText } from "./arc-readout";
export type { ArcDragReadoutFocus } from "./arc-readout";
