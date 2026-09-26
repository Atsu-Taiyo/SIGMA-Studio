import {
  type MeasuredBlock,
} from "@/components/editor/overlay-canvas/anchor";
import {
  roundTextFlowColumnBlockLayout,
  type TextFlowColumnBlockLayout,
} from "@/features/rendering/core";
import { collectBlocksById } from "@/lib/document-tree";
import {
  type PageMetrics,
  type BoxBlockChildBlock,
  type LayoutSectionChildBlock,
  type LayoutSectionNode,
  type ProblemAreaBlock,
  type SigmaBlock,
} from "@/features/document";
import { hasBreakBefore, PROBLEM_AREA_ORDER } from "./block-ops";
import {
  getFirstUnitBlock,
  getLayoutSectionColumnCount,
} from "./render-units";
import type {
  FlowUnitLayout,
  ProblemAreaColumnLayout,
  RenderUnit,
} from "./types";



interface ColumnBreakContextMenuLookup {
  blockId: string;
  blocks: SigmaBlock[];
  /**
   * **実際に描画しているユニット**。ここで組み直してはいけない — チャンク境界は前回の描画から
   * 引き継ぐ (`text-run-chunking.ts`) ので、blocks だけから作り直すと id が実描画とずれ、
   * `unitLayouts` が引けずにメニューが無言で出なくなる。
   */
  units: readonly RenderUnit[];
  isColumnFlow: boolean;
  metrics: PageMetrics;
  pageStridePx: number;
  blockRects?: ReadonlyMap<string, MeasuredBlock>;
  paginationMarkerLayouts: Record<string, FlowUnitLayout>;
  textFlowBlockLayouts: Record<string, TextFlowColumnBlockLayout>;
  unitLayouts: Record<string, FlowUnitLayout>;
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
  units,
  isColumnFlow,
  metrics,
  pageStridePx,
  blockRects = new Map(),
  paginationMarkerLayouts,
  textFlowBlockLayouts,
  unitLayouts,
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

  const clickedBlock = collectBlocksById(blocks).get(blockId);
  if (clickedBlock && clickedBlock.type !== "listItem" && hasBreakBefore(clickedBlock)) {
    return blockId;
  }

  // A box continuation has no top-level unit for each descendant. Resolve its explicit
  // boundary within the clicked box so its body can remove the same break as the box itself.
  const nestedBreak = getNestedBoxBreakBeforeId(blocks, blockId);
  if (nestedBreak) return nestedBreak;

  if (!isColumnFlow) {
    return getSingleColumnPageBreakBeforeBlockId({
      blockId,
      blocks,
      blockRects,
      pageStridePx,
      metrics,
    });
  }

  const unit = units.find((candidate) => {
    if (candidate.type === "textFlow" || candidate.type === "problemArea") {
      return candidate.blocks.some((block) => block.id === blockId);
    }
    return getFirstUnitBlock(candidate).id === blockId;
  });
  if (!unit) {
    return null;
  }

  const clickedLayout = getAbsoluteBlockColumnLayout(blockId, unit, unitLayouts, textFlowBlockLayouts);
  if (!clickedLayout) {
    return null;
  }

  const clickedColumn = getPageColumnKey(clickedLayout, metrics, pageStridePx);
  for (const [candidateId, markerLayout] of Object.entries(paginationMarkerLayouts)) {
    if (samePageColumn(clickedColumn, getPageColumnKey(markerLayout, metrics, pageStridePx))) {
      return candidateId;
    }
  }

  return null;
}

function getNestedBoxBreakBeforeId(blocks: readonly SigmaBlock[], blockId: string): string | null {
  const visit = (
    children: readonly SigmaBlock[],
    insideBox: boolean,
    inheritedBoundary: string | null,
    ancestorBoundary: string | null,
  ): string | null | undefined => {
    let siblingBoundary = inheritedBoundary;
    for (const child of children) {
      const hasBreak = hasBreakBefore(child);
      const boundary = hasBreak ? child.id : siblingBoundary;
      const ownBoundary = hasBreak ? child.id : ancestorBoundary;
      if (child.id === blockId) return insideBox ? (child.type === "boxBlock" ? ownBoundary : boundary) : null;
      const groups = child.type === "boxBlock" || child.type === "quote" ? [child.blocks]
        : child.type === "problem" ? PROBLEM_AREA_ORDER.map(area => child[area])
          : child.type === "layoutSection" && child.layout.columnCount <= 1 ? [child.children] : [];
      for (const group of groups) {
        // A box owns a separate break scope. Its body can inherit a break on the box
        // or an ancestor, but not a break on a preceding sibling box or paragraph.
        const inheritedBoundary = child.type === "boxBlock"
          ? ownBoundary
          : boundary;
        const result = visit(group, insideBox || child.type === "boxBlock", inheritedBoundary, ownBoundary);
        if (result !== undefined) return result;
      }
      if (child.type !== "boxBlock") siblingBoundary = boundary;
    }
    return undefined;
  };
  return visit(blocks, false, null, null) ?? null;
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

/**
 * 右クリックしたブロックの領域 (ページ / 段) を終わらせている手動改ページ (改段) の持ち主。
 * 次の領域の先頭にある、手動改ページ付きのブロックのうち最も上のもの。
 */
function getSingleColumnPageBreakBeforeBlockId({
  blockId,
  blocks,
  blockRects,
  pageStridePx,
  metrics,
}: {
  blockId: string;
  blocks: SigmaBlock[];
  blockRects: ReadonlyMap<string, MeasuredBlock>;
  pageStridePx: number;
  metrics: PageMetrics;
}): string | null {
  const clicked = blockRects.get(blockId);
  if (!clicked) {
    return null;
  }

  const columnCount = Math.max(1, metrics.flow.columnCount);
  const columnStep = metrics.flow.columnWidthPx + metrics.flow.columnGapPx;
  const regionOf = (block: MeasuredBlock) => {
    const pageIndex = getPageIndexForMeasuredTop(block.top, pageStridePx);
    const columnIndex = columnCount > 1 && columnStep > 0
      ? Math.max(0, Math.min(columnCount - 1, Math.round(((block.left ?? metrics.margins.leftPx) - metrics.margins.leftPx) / columnStep)))
      : 0;
    return pageIndex * columnCount + columnIndex;
  };
  const clickedRegion = regionOf(clicked);
  const blocksById = collectBlocksById(blocks);
  let nearest: MeasuredBlock | null = null;

  for (const [candidateId, candidate] of blocksById) {
    if (candidate.type === "listItem" || !hasBreakBefore(candidate)) {
      continue;
    }

    // A break inside a multi-column layout section belongs to that local
    // column flow and is resolved above from its rendered block/marker column.
    const section = findContainingLayoutSectionInBlocks(blocks, candidateId);
    if (section && getLayoutSectionColumnCount(section) > 1) {
      continue;
    }

    const measured = blockRects.get(candidateId);
    if (
      !measured
      || regionOf(measured) !== clickedRegion + 1
    ) {
      continue;
    }

    if (!nearest || measured.top < nearest.top) {
      nearest = measured;
    }
  }

  return nearest?.id ?? null;
}

function getPageIndexForMeasuredTop(top: number, pageStridePx: number): number {
  return Math.max(0, Math.floor(Math.max(0, top) / Math.max(1, pageStridePx)));
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

function getAbsoluteBlockColumnLayout(
  blockId: string,
  unit: RenderUnit,
  unitLayouts: Record<string, FlowUnitLayout>,
  textFlowBlockLayouts: Record<string, TextFlowColumnBlockLayout>,
): FlowUnitLayout | null {
  const unitLayout = unitLayouts[unit.id];
  if (!unitLayout) {
    return null;
  }
  if (unit.type === "textFlow" || unit.type === "problemArea") {
    const blockLayout = textFlowBlockLayouts[blockId];
    return blockLayout
      ? {
          x: unitLayout.x + blockLayout.x,
          y: unitLayout.y + blockLayout.y,
          width: blockLayout.width,
        }
      : null;
  }
  return getFirstUnitBlock(unit).id === blockId ? unitLayout : null;
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

function getPageColumnKey(layout: Pick<FlowUnitLayout, "x" | "y">, metrics: PageMetrics, pageStridePx: number): PageColumnKey {
  const columnStep = metrics.flow.columnWidthPx + metrics.flow.columnGapPx;
  return {
    pageIndex: Math.max(0, Math.floor(Math.max(0, layout.y) / Math.max(1, pageStridePx))),
    columnIndex: columnStep > 0
      ? Math.max(0, Math.round((layout.x - metrics.margins.leftPx) / columnStep))
      : 0,
  };
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
