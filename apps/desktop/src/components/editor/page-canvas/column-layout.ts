import {
  roundTextFlowColumnBlockLayout,
  type TextFlowColumnBlockLayout,
} from "@/features/rendering/core";
import { findManualBreakOwnerForBlock } from "@/features/text-editing";
import {
  type BoxBlockChildBlock,
  type LayoutSectionChildBlock,
  type LayoutSectionNode,
  type ProblemAreaBlock,
  type SigmaBlock,
} from "@/features/document";
import { hasBreakBefore, PROBLEM_AREA_ORDER } from "./block-ops";
import { getLayoutSectionColumnCount } from "./render-units";
import type { ProblemAreaColumnLayout } from "./types";



interface ColumnBreakContextMenuLookup {
  blockId: string;
  blocks: SigmaBlock[];
  pageStridePx: number;
  problemAreaColumnLayouts: Record<string, ProblemAreaColumnLayout>;
  localColumnContextMenuLayout?: LocalColumnContextMenuLayout | null;
}

export interface LocalColumnContextMenuLayout {
  sectionId: string;
  layout: ProblemAreaColumnLayout;
}

export function getColumnBreakBeforeBlockIdForContextMenu({
  blockId,
  blocks,
  pageStridePx,
  problemAreaColumnLayouts,
  localColumnContextMenuLayout,
}: ColumnBreakContextMenuLookup): string | null {
  const section = findContainingLayoutSectionInBlocks(blocks, blockId);
  if (section && getLayoutSectionColumnCount(section) > 1) {
    const layout = problemAreaColumnLayouts[section.id]
      ?? (localColumnContextMenuLayout?.sectionId === section.id
        ? localColumnContextMenuLayout.layout
        : undefined);
    if (layout?.blockLayouts[blockId]) {
      return getLocalColumnBreakBeforeBlockId({
        blockId,
        layout,
        pageStridePx,
        section,
      });
    }
    return hasOneManualBreakPerColumnBoundary(section)
      ? getFollowingManualBreakBeforeBlockId(section, blockId)
      : null;
  }

  // 解除できるのは、そのブロック自身・それを囲む入れ物・すぐ後ろの区切りだけ。以前は「右クリック
  // したページ (段) を終わらせる区切り」を探していたので、ページの途中の無関係な段落にまで
  // 「改ページを挿入」と「改ページを解除」が同時に出ていた。
  return findManualBreakOwnerForBlock(blocks, blockId);
}

export function measureLocalColumnContextMenuLayout(
  target: Element | null,
  zoomFactor: number,
): LocalColumnContextMenuLayout | null {
  const section = target?.closest<HTMLElement>(".sigma-doc-layout-section-block[data-sigma-doc-id]") ?? null;
  const body = section?.querySelector<HTMLElement>(":scope > .sigma-doc-layout-section-body") ?? null;
  const sectionId = section?.getAttribute("data-sigma-doc-id") ?? null;
  if (!section || !body || !sectionId) {
    return null;
  }

  const columnCount = Number.parseInt(section.getAttribute("data-column-count") ?? "", 10);
  if (!Number.isFinite(columnCount) || columnCount <= 1) {
    return null;
  }

  const bodyRect = body.getBoundingClientRect();
  const safeZoomFactor = Math.max(0.01, zoomFactor);
  const parsedGap = Number.parseFloat(getComputedStyle(body).columnGap);
  const columnGapPx = Number.isFinite(parsedGap) ? Math.max(0, parsedGap) : 0;
  const bodyWidthPx = bodyRect.width / safeZoomFactor;
  const columnWidthPx = Math.max(1, (bodyWidthPx - (columnCount - 1) * columnGapPx) / columnCount);
  const blockLayouts: Record<string, TextFlowColumnBlockLayout> = {};
  const markerLayouts: Record<string, TextFlowColumnBlockLayout> = {};

  const columns = [...body.querySelectorAll<HTMLElement>(":scope > .layout-section-independent-column")];
  const children = columns.length > 0 ? columns.flatMap(column => [...column.children]) : [...body.children];
  for (const child of children) {
    if (!(child instanceof HTMLElement)) {
      continue;
    }
    const rect = child.getBoundingClientRect();
    const childLayout = roundTextFlowColumnBlockLayout({
      x: (rect.left - bodyRect.left) / safeZoomFactor,
      y: (rect.top - bodyRect.top) / safeZoomFactor,
      width: rect.width / safeZoomFactor,
    });
    const markerBlockId = child.getAttribute("data-page-break-marker") !== null
      ? child.getAttribute("data-page-break-block-id")
      : null;
    if (markerBlockId) {
      markerLayouts[markerBlockId] = childLayout;
      continue;
    }
    const childBlockId = child.getAttribute("data-sigma-doc-id");
    if (childBlockId) {
      blockLayouts[childBlockId] = childLayout;
    }
  }

  return {
    sectionId,
    layout: {
      blockLayouts,
      markerLayouts,
      totalHeightPx: bodyRect.height / safeZoomFactor,
      columnWidthPx,
      columnGapPx,
    },
  };
}

function getLocalColumnBreakBeforeBlockId({
  blockId,
  layout,
  pageStridePx,
  section,
}: {
  blockId: string;
  layout: ProblemAreaColumnLayout;
  pageStridePx: number;
  section: LayoutSectionNode;
}): string | null {
  const clickedLayout = layout.blockLayouts[blockId];
  if (!clickedLayout) {
    return null;
  }
  const clickedIndex = section.children.findIndex((child) => child.id === blockId);
  if (clickedIndex < 0) {
    return null;
  }

  const clickedColumn = getLocalColumnKey(
    clickedLayout,
    layout.columnWidthPx,
    layout.columnGapPx,
    pageStridePx,
  );
  for (let index = clickedIndex + 1; index < section.children.length; index += 1) {
    const child = section.children[index];
    if (!child || !hasBreakBefore(child)) {
      continue;
    }
    const markerLayout = layout.markerLayouts[child.id];
    if (
      markerLayout
      && samePageColumn(
        clickedColumn,
        getLocalColumnKey(markerLayout, layout.columnWidthPx, layout.columnGapPx, pageStridePx),
      )
    ) {
      return child.id;
    }
  }
  return null;
}

function hasOneManualBreakPerColumnBoundary(section: LayoutSectionNode): boolean {
  const manualBreakCount = section.children.slice(1).filter(hasBreakBefore).length;
  return manualBreakCount === getLayoutSectionColumnCount(section) - 1;
}

function getFollowingManualBreakBeforeBlockId(
  section: LayoutSectionNode,
  blockId: string,
): string | null {
  const clickedIndex = section.children.findIndex((child) => child.id === blockId);
  if (clickedIndex < 0) {
    return null;
  }

  // A break-owning child starts the clicked segment; the removable break is
  // the next one that ends it. Direct marker clicks bypass this lookup.
  for (let index = clickedIndex + 1; index < section.children.length; index += 1) {
    const child = section.children[index];
    if (child && hasBreakBefore(child)) {
      return child.id;
    }
  }

  return null;
}

function findContainingLayoutSectionInBlocks(blocks: SigmaBlock[], blockId: string): LayoutSectionNode | null {
  for (const block of blocks) {
    const section = findContainingLayoutSectionInBlock(block, blockId);
    if (section) {
      return section;
    }
  }
  return null;
}

function findContainingLayoutSectionInBlock(
  block: SigmaBlock | ProblemAreaBlock | LayoutSectionChildBlock | BoxBlockChildBlock,
  blockId: string,
): LayoutSectionNode | null {
  if (block.type === "layoutSection") {
    if (block.id === blockId || block.children.some((child) => child.id === blockId)) {
      return block;
    }
    for (const child of block.children) {
      const nested = findContainingLayoutSectionInBlock(child, blockId);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  if (block.type === "boxBlock") {
    for (const child of block.blocks) {
      const nested = findContainingLayoutSectionInBlock(child, blockId);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  if (block.type === "problem") {
    for (const area of PROBLEM_AREA_ORDER) {
      for (const child of block[area]) {
        const nested = findContainingLayoutSectionInBlock(child, blockId);
        if (nested) {
          return nested;
        }
      }
    }
  }

  return null;
}

interface PageColumnKey {
  pageIndex: number;
  columnIndex: number;
}

function getLocalColumnKey(
  layout: Pick<TextFlowColumnBlockLayout, "x" | "y">,
  columnWidthPx: number,
  columnGapPx: number,
  pageStridePx: number,
): PageColumnKey {
  const columnStep = columnWidthPx + columnGapPx;
  return {
    pageIndex: Math.max(0, Math.floor(Math.max(0, layout.y) / Math.max(1, pageStridePx))),
    columnIndex: columnStep > 0 ? Math.max(0, Math.round(layout.x / columnStep)) : 0,
  };
}

function samePageColumn(a: PageColumnKey, b: PageColumnKey): boolean {
  return a.pageIndex === b.pageIndex && a.columnIndex === b.columnIndex;
}

export function getPageCountForBottom(bottom: number, pageHeightPx: number, pageStridePx: number): number {
  return bottom > pageHeightPx
    ? Math.ceil((bottom - pageHeightPx) / pageStridePx) + 1
    : 1;
}

export function getPageIndexForY(y: number, pageStridePx: number): number {
  return Math.max(0, Math.floor(Math.max(0, y) / pageStridePx));
}
