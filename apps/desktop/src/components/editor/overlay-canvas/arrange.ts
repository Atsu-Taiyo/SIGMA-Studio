// Compatibility entrypoint. Pure arrangement lives in the drawing feature;
// group-aware stack ordering remains in the overlay editing application.
export {
  alignShapes,
  distributeShapes,
  fitShapesWithinPage,
  getShapesSelectionBounds,
  moveShapes,
  resizeRotatedShapeToBounds,
  resizeShapesToBounds,
  rotateShapesAround,
} from "@/features/drawing";
export type {
  OverlayAlignAction,
  OverlayDistributeAxis,
} from "@/features/drawing";
export {
  reorderShapes,
} from "./reorder-shapes";
export type {
  OverlayArrangeAction,
} from "./reorder-shapes";
