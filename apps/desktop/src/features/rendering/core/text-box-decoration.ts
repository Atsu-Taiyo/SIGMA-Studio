import type { OverlayTextShape } from "@/features/document";
import { overlayStrokeWidth } from "./overlay-render-attrs";

/** Paint behind glyphs without affecting wrapping, selection or measured height. */
export function getTextBoxDecoration(shape: OverlayTextShape) {
  const { fill, fillColor, fillOpacity, color, strokeColor, strokeOpacity, dash, strokeWidth } = shape.props;
  return {
    fill: fill === "solid" ? fillColor ?? color : "none",
    fillOpacity: fillOpacity ?? 1,
    stroke: dash ? strokeColor ?? color : "none",
    strokeOpacity: strokeOpacity ?? 1,
    strokeWidth: overlayStrokeWidth(strokeWidth ?? "s"),
    strokeDasharray: dash === "dashed" ? "8 6" : dash === "dotted" ? "1 6" : undefined,
  };
}
