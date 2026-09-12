import {
  inlineNodesToPlainText,
  type OverlayAsset,
  type OverlayShape,
  type BoxBlockChildBlock,
  type LayoutSectionChildBlock,
  type RichBlock,
  type SigmaBlock,
} from "@/features/document";
import type { Translate } from "@/lib/i18n/translator";

export function collectMaterialShapesForBlockIds(
  shapes: OverlayShape[],
  blockIds: Set<string>,
): OverlayShape[] {
  const includedShapeIds = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    shapes.forEach((shape) => {
      if (includedShapeIds.has(shape.id)) {
        return;
      }

      const anchor = shape.anchor;
      const shouldInclude =
        (anchor?.type === "block" && blockIds.has(anchor.blockId)) ||
        (anchor?.type === "shape" && includedShapeIds.has(anchor.shapeId)) ||
        Boolean(shape.parentId && includedShapeIds.has(shape.parentId)) ||
        Boolean(shape.groupId && includedShapeIds.has(shape.groupId)) ||
        shapes.some((child) =>
          includedShapeIds.has(child.id) && (child.parentId === shape.id || child.groupId === shape.id),
        );

      if (shouldInclude) {
        includedShapeIds.add(shape.id);
        changed = true;
      }
    });
  }

  return shapes.filter((shape) => includedShapeIds.has(shape.id));
}

export function collectOverlayAssetsForShapes(
  shapes: OverlayShape[],
  assets: Record<string, OverlayAsset>,
): Record<string, OverlayAsset> {
  return shapes.reduce<Record<string, OverlayAsset>>((nextAssets, shape) => {
    if (shape.type !== "image") {
      return nextAssets;
    }
    const asset = assets[shape.props.assetId];
    if (asset) {
      nextAssets[asset.id] = asset;
    }
    return nextAssets;
  }, {});
}

/**
 * 保存する素材の既定名。
 *
 * **D3: これは素材へ保存される名前**で、素材ライブラリの表示名にもなる。
 * 作成した時点の UI 言語で焼く (既存の素材は書き換えない)。`t` を省略可能に
 * しないのは、落とすと英語 UI でここだけ日本語になるため。
 */
export function getMaterialNameFromBlock(block: SigmaBlock, t: Translate<"workspace">): string {
  if (block.type === "section") {
    return block.title.trim() || t("asset.nameSection");
  }
  if (block.type === "heading" || block.type === "paragraph") {
    return inlineNodesToPlainText(block.children).trim() || t("asset.nameBody");
  }
  if (block.type === "list") {
    const firstItem = block.items[0];
    return firstItem ? inlineNodesToPlainText(firstItem.children).trim() || t("asset.nameList") : t("asset.nameList");
  }
  if (block.type === "boxBlock") {
    const title = inlineNodesToPlainText(block.title ?? []).trim();
    const body = block.blocks.map((child) => boxBlockChildMaterialName(child, t)).find(Boolean);
    return title || body || t("asset.nameBox");
  }
  return t("asset.nameProblem");
}

function richBlockMaterialName(block: RichBlock): string {
  if (block.type === "list") {
    return block.items.map((item) => inlineNodesToPlainText(item.children).trim()).find(Boolean) ?? "";
  }
  return inlineNodesToPlainText(block.children).trim();
}

function boxBlockChildMaterialName(block: BoxBlockChildBlock, t: Translate<"workspace">): string {
  if (block.type === "problem") return getMaterialNameFromBlock(block, t);
  if (block.type === "layoutSection") {
    return block.children.map((child) => layoutSectionChildMaterialName(child, t)).find(Boolean) ?? "";
  }
  return layoutSectionChildMaterialName(block, t);
}

function layoutSectionChildMaterialName(block: LayoutSectionChildBlock, t: Translate<"workspace">): string {
  if (block.type === "section") {
    return block.title.trim();
  }
  if (block.type === "divider") {
    return "";
  }
  if (block.type === "boxBlock" || block.type === "quote" || block.type === "codeBlock") {
    return getMaterialNameFromBlock(block, t);
  }
  return richBlockMaterialName(block);
}
