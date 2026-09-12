import {
  expandMarginsForRunningRegions,
  enablePageRunningRegion,
  type PageLayout,
  type PageRunningRegion,
  type RichBlock,
} from "@/features/document";
import type { TextFlowBlock } from "@/features/text-editing";
import { createTranslator, DEFAULT_LOCALE, type Translate } from "@/lib/i18n";

import { cloneTextFlowBlock } from "./block-ops";
import { getTextFlowBlockChildren } from "@/features/text-editing";
import { textFlowBlockToProblemAreaBlock } from "./reconciliation";
import type { RunningRegionKind } from "./types";

export function pageRunningRegionToTextFlowBlocks(
  region: PageRunningRegion,
  kind: RunningRegionKind,
): TextFlowBlock[] {
  if (region.blocks.length) {
    return region.blocks.map(cloneTextFlowBlock);
  }

  return [{
    type: "paragraph",
    id: `page_${kind}_running_body`,
    children: [],
  }];
}

/**
 * 箱や段組をヘッダー/フッターのリッチ本文へ落とすときの退避表現。ここで作る
 * 文字列は**文書に残る**ので、作った時点の UI 言語で焼く (`BlockEditor` の
 * `textFlowBlockToRichBlock` と同じ規約)。`t` の既定が日本語なのは、既存の
 * 呼び出しとテストを無傷にするため。
 */
export function textFlowBlocksToRunningBlocks(
  blocks: TextFlowBlock[],
  t: Translate<"editor"> = createTranslator(DEFAULT_LOCALE, "editor"),
): RichBlock[] {
  return blocks.flatMap((block): RichBlock[] => {
    if (block.type === "section") {
      return [{
        type: "heading",
        id: block.id,
        level: 2,
        children: block.title ? [{ type: "text", text: block.title }] : [],
        align: block.align,
        lineHeight: block.lineHeight,
      }];
    }

    if (block.type === "boxBlock") {
      return [{
        type: "paragraph",
        id: block.id,
        children: block.title?.length
          ? block.title
          : [{ type: "text", text: t("block.box") }],
        pagination: block.pagination,
      }];
    }

    const converted = textFlowBlockToProblemAreaBlock(block);
    if (converted.type === "layoutSection") {
      return [{
        type: "paragraph",
        id: converted.id,
        children: [{ type: "text", text: t("block.columns", { columns: converted.layout.columnCount }) }],
        pagination: converted.pagination,
      }];
    }
    if (converted.type === "boxBlock") {
      return [{
        type: "paragraph",
        id: converted.id,
        children: converted.title?.length
          ? converted.title
          : [{ type: "text", text: t("block.box") }],
        pagination: converted.pagination,
      }];
    }
    // ヘッダー/フッターは `RichBlock` しか持てない (ページごとに複製・採寸されるため)。
    // 区切り線・引用・コードを持ち込まれたら段落へ落として、書いた文字だけは残す。
    if (converted.type === "divider") {
      return [{ type: "paragraph", id: converted.id, children: [], pagination: converted.pagination }];
    }
    if (converted.type === "codeBlock") {
      return [{
        type: "paragraph",
        id: converted.id,
        children: converted.children,
        pagination: converted.pagination,
      }];
    }
    if (converted.type === "quote") {
      return [{
        type: "paragraph",
        id: converted.id,
        children: converted.blocks.flatMap(getTextFlowBlockChildren),
        pagination: converted.pagination,
      }];
    }
    return [converted];
  });
}

export function replacePageRunningRegionTextFlow(
  layout: PageLayout,
  kind: RunningRegionKind,
  nextBlocks: TextFlowBlock[],
  t: Translate<"editor"> = createTranslator(DEFAULT_LOCALE, "editor"),
): PageLayout | null {
  const enabledLayout = expandMarginsForRunningRegions(
    enablePageRunningRegion(layout, kind),
  );
  const region = enabledLayout[kind];
  if (!region) {
    return null;
  }

  return {
    ...enabledLayout,
    [kind]: {
      ...region,
      blocks: textFlowBlocksToRunningBlocks(nextBlocks, t),
    },
  };
}
