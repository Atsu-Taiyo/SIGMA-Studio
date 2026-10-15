import type { OverlayTextShape } from "@/features/document";

/** Pure layout shared by the editor, static view and SVG export. No auto fitting. */
export function overlayTextScale(shape: OverlayTextShape, width = shape.props.w) {
  const scale = shape.props.textScaleX ?? 1;
  return { width: width / scale, maxWidth: "none", transform: `scaleX(${scale})`, transformOrigin: "left top" };
}
