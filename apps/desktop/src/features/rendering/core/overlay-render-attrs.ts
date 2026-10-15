export function overlayStrokeWidth(size: "s" | "m" | "l" | "xl", scale = 1): number {
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

export function overlayLabelFontSize(size: "s" | "m" | "l" | "xl"): number {
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
