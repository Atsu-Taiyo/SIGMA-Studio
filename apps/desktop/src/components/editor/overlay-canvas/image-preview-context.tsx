"use client";

import { createContext } from "react";

/** A view-only image replacement. Never enters SigmaDoc, history, or output. */
export interface OverlayImagePreview {
  shapeId: string;
  src: string;
  width: number;
  height: number;
}

export const OverlayImagePreviewContext = createContext<OverlayImagePreview | null>(null);
