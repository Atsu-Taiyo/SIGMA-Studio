import type { Graph2DSpec } from "@/features/document";

import type {
  OverlayPoint,
  OverlayShapeId,
  SigmaTableSpec,
} from "./types";

export interface OriginPickPreview {
  shapeId: OverlayShapeId;
  spec: Graph2DSpec;
  point: OverlayPoint;
}

export type TableShapeResizePatch = {
  x?: number;
  y?: number;
  w: number;
  h: number;
  table: SigmaTableSpec;
};
