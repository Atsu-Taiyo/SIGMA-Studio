import type { BodyPointerRoute } from "./body-pointer-routing";

export interface BlockSelectionPointerContext {
  isBlockSelectionControl: boolean;
  isOverlayEditing: boolean;
  isOverlaySelectionTarget: boolean;
  hitShapeId: string | null;
  bodyPointerRoute: BodyPointerRoute;
}

/**
 * A body block selection may coexist with an overlay shape selection. Everything else on the
 * page remains a click-away target so block selection does not become sticky.
 */
export function shouldKeepBlockSelectionOnPagePointerDown({
  isBlockSelectionControl,
  isOverlayEditing,
  isOverlaySelectionTarget,
  hitShapeId,
  bodyPointerRoute,
}: BlockSelectionPointerContext): boolean {
  if (isBlockSelectionControl) {
    return true;
  }

  if (isOverlayEditing) {
    return isOverlaySelectionTarget;
  }

  return hitShapeId !== null && bodyPointerRoute === "overlayShape";
}
