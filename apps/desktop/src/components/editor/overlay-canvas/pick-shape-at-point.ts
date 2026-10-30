import { hitTestShape } from "@/features/drawing";
import type { OverlayPoint, OverlayShape } from "./types";

/** Candidates are front to back. A nearby box must not steal a direct hit. */
export function pickShapeAtPoint(
  candidates: readonly OverlayShape[],
  point: OverlayPoint,
  margin: number,
  eligible: (shape: OverlayShape) => boolean,
): OverlayShape | undefined {
  let nearby: OverlayShape | undefined;
  for (const shape of candidates) {
    if (!hitTestShape(shape, point, margin) || !eligible(shape)) continue;
    if (margin <= 0 || hitTestShape(shape, point, 0)) return shape;
    nearby ??= shape;
  }
  return nearby;
}
