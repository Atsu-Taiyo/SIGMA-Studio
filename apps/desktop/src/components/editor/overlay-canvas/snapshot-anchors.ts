import { calculateReserveSpaceGaps } from "../page-canvas/layout-measure";
import {
  measureBlockTops,
  type MeasuredBlock
} from "./anchor";
import {
  reanchorShapesAgainstMeasuredBlocks
} from "./reanchor-model";
import type {
  OverlayShape
} from "./types";

export function reanchorShapesAgainstCanvas(
  shapes: OverlayShape[],
  canvasEl: HTMLDivElement | null,
  coordHeight: number,
  coordWidth: number,
  blockAnchorScope: ParentNode | null = null,
): OverlayShape[] {
  if (!canvasEl) {
    return shapes;
  }

  const scope = blockAnchorScope ?? canvasEl.closest(".page-canvas") ?? canvasEl.ownerDocument;
  const { ordered } = measureBlockTops(canvasEl, scope, coordHeight, coordWidth);
  if (ordered.length === 0) {
    return shapes;
  }

  return reanchorShapesAgainstMeasuredBlocks(
    shapes,
    ordered,
    calculateReserveSpaceGaps(shapes),
  );
}

export function anchorMeasurementKey(blocks: MeasuredBlock[]): string {
  return blocks
    .map((block) => [
      block.id,
      Math.round(block.top * 10) / 10,
      block.left === undefined ? "" : Math.round(block.left * 10) / 10,
      block.width === undefined ? "" : Math.round(block.width * 10) / 10,
      block.height === undefined ? "" : Math.round(block.height * 10) / 10,
      block.lines?.map((line) => [
        line.index,
        Math.round(line.top * 10) / 10,
        Math.round(line.height * 10) / 10,
      ].join("/")).join(",") ?? "",
    ].join(":"))
    .join("|");
}