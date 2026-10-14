import type { OverlayTextSize } from "@/features/document";

export function overlayStrokeWidth(size: OverlayTextSize): number {
  if (size === "xs") {
    return 0.75;
  }
  if (size === "s") {
    return 1.25;
  }
  if (size === "l") {
    return 3;
  }
  if (size === "xl") {
    return 5;
  }
  return 2;
}

export function overlayLabelFontSize(size: OverlayTextSize): number {
  if (size === "xs") {
    return 12;
  }
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
