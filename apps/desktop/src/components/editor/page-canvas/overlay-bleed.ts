export type OverlayBleed = {
  x: number;
  top: number;
};

export function resolveOverlayBleed({
  left,
  right,
  top,
}: {
  left: number;
  right: number;
  top: number;
}): OverlayBleed {
  return {
    x: Math.max(0, left, right),
    top: Math.max(0, top),
  };
}
