import type { ReactNode } from "react";

import type { OverlayShapeId } from "./types";

/** Visual content supplied by an optional editor feature for one shape. */
export interface OverlayShapeDecoration {
  /** Added to the normal shape class list without changing its geometry. */
  className?: string;
  /** Rendered after the shape body, inside the existing shape bounds. */
  content?: ReactNode;
}

/**
 * Feature-neutral interaction policy for the overlay editor. Keeping the
 * policy outside the canvas lets desktop-only features reserve shapes without
 * making the drawing engine depend on their stores or lifecycle.
 */
export interface OverlayEditPolicy {
  lockedShapeIds: ReadonlySet<OverlayShapeId>;
  blockedMessage?: string;
  blockedNoticeClassName?: string;
}

export const EMPTY_OVERLAY_EDIT_POLICY: OverlayEditPolicy = {
  lockedShapeIds: new Set(),
};
