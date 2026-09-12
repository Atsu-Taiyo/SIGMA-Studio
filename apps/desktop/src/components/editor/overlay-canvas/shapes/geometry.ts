// Compatibility entrypoint. Headless shape geometry lives in the drawing feature.
export {
  MIN_TEXT_SHAPE_WIDTH,
  TEXT_SHAPE_LINE_HEIGHT,
  getShapeBounds,
  getShapeCenter,
  getShapeDimensionBounds,
  getShapeRotation,
  getShapeSelectionBounds,
  getTextShapeFontSizePt,
  getTextShapeFontSizePx,
  getTextShapeLineHeightPx,
  getTextShapeRenderedFontSizePx,
  getTextShapeRenderedLineHeightPx,
} from "@/features/drawing/shape-bounds";
export { hitTestShape } from "@/features/drawing/shape-hit-test";
export {
  canBoxResize,
  moveShape,
  resizeBoxShape,
  rotateShape,
} from "@/features/drawing/shape-transform";
