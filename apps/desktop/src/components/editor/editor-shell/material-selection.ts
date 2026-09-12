import { getShapesSelectionBounds } from "@/features/drawing";
import {
  normalizeOverlaySnapshot,
  type OverlayAsset,
  type OverlayShape,
  type SigmaBlock,
  type SigmaDocument,
} from "@/features/document";
import { collectBlocksById } from "@/lib/document-tree";
import {
  collectMaterialBlockIds,
  normalizeMaterialOverlayToOrigin,
} from "@/lib/materials";
import type { MaterialContent } from "@/types/material";

import {
  collectMaterialShapesForBlockIds,
  collectOverlayAssetsForShapes,
} from "./material-capture";

export function buildSelectedMaterialContent(
  document: SigmaDocument,
  selectedBlockId: string | null,
  selectedShapes: OverlayShape[],
  selectedAssets: Record<string, OverlayAsset>,
  selectedBlockIds?: readonly string[],
): MaterialContent | null {
  const requestedBlockIds = selectedBlockIds ?? (selectedBlockId ? [selectedBlockId] : []);
  const requestedBlockIdSet = new Set(requestedBlockIds);
  const blocks = [...collectBlocksById(document.content).entries()]
    .filter(([blockId, block]) => requestedBlockIdSet.has(blockId) && block.type !== "listItem")
    .map(([, block]) => structuredClone(block) as SigmaBlock);
  const materialBlockIds = new Set(collectMaterialBlockIds(blocks));
  const snapshot = normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot);
  const selectedShapesById = new Map<string, OverlayShape>();

  if (materialBlockIds.size > 0) {
    collectMaterialShapesForBlockIds(snapshot.shapes, materialBlockIds).forEach((shape) => {
      selectedShapesById.set(shape.id, shape);
    });
  }
  selectedShapes.forEach((shape) => {
    selectedShapesById.set(shape.id, shape);
  });

  const shapes = [...selectedShapesById.values()];
  if (blocks.length === 0 && shapes.length === 0) {
    return null;
  }

  const assets = collectOverlayAssetsForShapes(shapes, {
    ...snapshot.assets,
    ...selectedAssets,
  });
  const bounds = getShapesSelectionBounds(shapes);
  const overlaySnapshot = bounds
    ? normalizeMaterialOverlayToOrigin({
      version: 1,
      shapes,
      assets,
    }, { x: bounds.x, y: bounds.y }, { detachBlockAnchors: blocks.length === 0 })
    : {
      version: 1 as const,
      shapes,
      assets,
    };

  return {
    blocks,
    overlaySnapshot,
  };
}
