import type { OverlayTextSize } from "@/features/document";

export function overlayStrokeWidth(size: OverlayTextSize, scale = 1): number {
  if (size === "xs") return 0.75 * scale;
  if (size === "s") {
    return 1.25 * scale;
  }
  if (size === "l") {
    return 3 * scale;
  }
  if (size === "xl") {
    return 5 * scale;
  }
  return 2 * scale;
}

export function overlayLabelFontSize(size: OverlayTextSize): number {
  if (size === "xs") return 12;
  if (size === "s") {
    return 14;
  }
  if (size === "l") {
    return 22;
  }
  if (size === "xl") {
    return 28;
  }
  return 18;
}
