export function overlayStrokeWidth(size: "s" | "m" | "l" | "xl"): number {
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
