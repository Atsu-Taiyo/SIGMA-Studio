import {
  getMeasuredLineBreakOffsets,
  measureElementLineBoxes,
  type MeasuredBlock,
  type MeasuredLine,
} from "@/components/editor/overlay-canvas/anchor";
import type {
  TextFlowBlock,
  TextFlowBoxFragmentSourceLayout,
} from "@/components/editor/TextFlowEditor";
import {
  computeProblemAreaColumnFlow,
  isFlowBlockFragmentable,
  getFlowBlockStartHeight,
  getSafeProblemAreaMinHeightPx,
  fragmentFlowBlock,
  roundTextFlowColumnBlockLayout,
  type TextFlowColumnBlockLayout,
} from "@/features/rendering/core";
import { boxBlockTitleText, boxFragmentMinStartHeightPx, findBoxDecoration, resolveBoxFrame } from "@/lib/box-blocks";
import { collectBlocksById } from "@/lib/document-tree";
import { getLayoutSectionColumns, getLayoutSectionColumnWidths, LAYOUT_SECTION_WIDTH_TOTAL } from "@/features/text-editing";
import { getProblemFrameChromePaddingPx } from "@/lib/problem-frame";
import {
  blockSpaceAfterPx,
  type PageMetrics,
  type BoxBlockChildBlock,
  type BoxBlockNode,
  type LayoutSectionChildBlock,
  type LayoutSectionNode,
  type ProblemAreaBlock,
  type SigmaBlock,
} from "@/features/document";
import { hasBreakBefore, isProblemFrameArea, PROBLEM_AREA_ORDER } from "./block-ops";
import {
  collectTextFlowBlockElements,
  getMeasuredColumnItemHeight,
  roundEditorBoxBlockFragmentLayout,
  roundFlowUnitLayout,
} from "./layout-measure";
import {
  getFirstUnitBlock,
  getLayoutSectionColumnCount,
  getLayoutSectionColumnGapPx,
  isFullSpanUnit,
  isProblemAreaColumnBlockFlowEligible,
} from "./render-units";
import type {
  EditorBoxBlockFragmentLayout,
  FlowUnitLayout,
  ProblemAreaColumnLayout,
  ProblemAreaFrameFragmentLayout,
  RenderUnit,
} from "./types";

/** The column geometry a block flow places against — normally the page's own
 * column count/width/gap, but a full-span area's flow substitutes a single
 * "column" spanning the whole content width (see fullSpanGeometry below). */
interface FlowColumnGeometry {
  columnCount: number;
  columnWidthPx: number;
  columnGapPx: number;
}

const MAX_EDITOR_FRAGMENTS_PER_BLOCK = 1_000;

export { isFlowBlockFragmentable } from "@/features/rendering/core";

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
  // boundary from document order so its body can remove the same break as the box itself.
  const nestedBreak = getNestedBoxBreakBeforeId(blocks, blockId);
  if (nestedBreak) return nestedBreak;

  if (!isColumnFlow) {
    return getSingleColumnPageBreakBeforeBlockId({
      blockId,
      blocks,
      blockRects,
      pageStridePx,
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
  let boundary: string | null = null;
  const visit = (children: readonly SigmaBlock[], insideBox: boolean): string | null | undefined => {
    for (const child of children) {
      if (hasBreakBefore(child)) boundary = child.id;
      if (child.id === blockId) return insideBox ? boundary : null;
      const groups = child.type === "boxBlock" || child.type === "quote" ? [child.blocks]
        : child.type === "problem" ? PROBLEM_AREA_ORDER.map(area => child[area])
          : child.type === "layoutSection" && child.layout.columnCount <= 1 ? [child.children] : [];
      for (const group of groups) {
        const result = visit(group, insideBox || child.type === "boxBlock");
        if (result !== undefined) return result;
      }
    }
    return undefined;
  };
  return visit(blocks, false) ?? null;
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

function getSingleColumnPageBreakBeforeBlockId({
  blockId,
  blocks,
  blockRects,
  pageStridePx,
}: {
  blockId: string;
  blocks: SigmaBlock[];
  blockRects: ReadonlyMap<string, MeasuredBlock>;
  pageStridePx: number;
}): string | null {
  const clicked = blockRects.get(blockId);
  if (!clicked) {
    return null;
  }

  const clickedPageIndex = getPageIndexForMeasuredTop(clicked.top, pageStridePx);
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
      || getPageIndexForMeasuredTop(measured.top, pageStridePx) !== clickedPageIndex + 1
      || measured.top <= clicked.top
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

export function computeColumnUnitLayouts(
  flow: HTMLElement,
  units: RenderUnit[],
  metrics: PageMetrics,
  pageHeightPx: number,
  pageGapPx: number,
  zoomFactor: number,
  reserveSpaceGaps: Readonly<Record<string, number>> = {},
): {
  layouts: Record<string, FlowUnitLayout>;
  blockLayouts: Record<string, TextFlowColumnBlockLayout>;
  boxBlockFragmentLayouts: Record<string, EditorBoxBlockFragmentLayout[]>;
  boxFragmentSourceLayouts: Record<string, TextFlowBoxFragmentSourceLayout>;
  frameFragmentLayouts: Record<string, ProblemAreaFrameFragmentLayout[]>;
  nestedColumnLayouts: Record<string, ProblemAreaColumnLayout>;
  markerLayouts: Record<string, FlowUnitLayout>;
  pageCount: number;
} {
  const elements = new Map<string, HTMLElement>();
  flow.querySelectorAll<HTMLElement>("[data-flow-unit-id]").forEach((element) => {
    const id = element.getAttribute("data-flow-unit-id");
    if (id) {
      elements.set(id, element);
    }
  });
  const textBlockElementsByUnit = new Map<string, Map<string, HTMLElement>>();
  for (const [unitId, element] of elements) {
    textBlockElementsByUnit.set(unitId, collectTextFlowBlockElements(element));
  }
  const problemAreaOccupiedHeightByKey = new Map<string, number>();
  const problemAreaLastUnitIdByKey = new Map<string, string>();
  for (const unit of units) {
    if (unit.type !== "problemArea" && unit.type !== "problemLayoutSection") {
      continue;
    }
    const key = `${unit.problem.id}:${unit.area}`;
    problemAreaLastUnitIdByKey.set(key, unit.id);
  }
  const recordProblemAreaOccupiedHeight = (unit: RenderUnit, occupiedHeightPx: number) => {
    if (unit.type !== "problemArea" && unit.type !== "problemLayoutSection") {
      return;
    }
    const key = `${unit.problem.id}:${unit.area}`;
    problemAreaOccupiedHeightByKey.set(
      key,
      (problemAreaOccupiedHeightByKey.get(key) ?? 0) + Math.max(0, occupiedHeightPx),
    );
  };
  const trailingReservationForUnit = (unit: RenderUnit): number => {
    if (unit.type !== "problemArea" && unit.type !== "problemLayoutSection") {
      return 0;
    }
    const key = `${unit.problem.id}:${unit.area}`;
    if (problemAreaLastUnitIdByKey.get(key) !== unit.id) {
      return 0;
    }
    return Math.max(
      0,
      getSafeProblemAreaMinHeightPx(
        unit.problem.areaLayout?.[unit.area]?.minHeightMm ?? 0,
        metrics.content.heightPx,
      ) - (problemAreaOccupiedHeightByKey.get(key) ?? 0),
    );
  };

  const layouts: Record<string, FlowUnitLayout> = {};
  const blockLayouts: Record<string, TextFlowColumnBlockLayout> = {};
  const boxBlockFragmentLayouts: Record<string, EditorBoxBlockFragmentLayout[]> = {};
  const boxFragmentSourceLayouts: Record<string, TextFlowBoxFragmentSourceLayout> = {};
  const markerLayouts: Record<string, FlowUnitLayout> = {};
  const frameFragmentLayouts: Record<string, ProblemAreaFrameFragmentLayout[]> = {};
  const nestedColumnLayouts: Record<string, ProblemAreaColumnLayout> = {};
  const columnGeometry: FlowColumnGeometry = {
    columnCount: metrics.flow.columnCount,
    columnWidthPx: metrics.flow.columnWidthPx,
    columnGapPx: metrics.flow.columnGapPx,
  };
  // A full-span problem area (`columnSpan: "full"`) that flows past a manual break
  // is placed like a single-column page: one "column" spanning the full content
  // width, so each fragment lands at the same x/width as the atomic full-span
  // placement below, not squeezed into a page-column's width.
  const fullSpanGeometry: FlowColumnGeometry = {
    columnCount: 1,
    columnWidthPx: metrics.content.widthPx,
    columnGapPx: 0,
  };
  const pageStride = pageHeightPx + pageGapPx;
  let pageIndex = 0;
  let columnIndex = 0;
  let cursorY = 0;
  let pageColumnStartY = 0;
  let maxPageIndex = 0;
  let maxPlacedUnitBottom = 0;

  const advanceColumn = (geometry: FlowColumnGeometry = columnGeometry) => {
    if (columnIndex < geometry.columnCount - 1) {
      columnIndex += 1;
      cursorY = pageColumnStartY;
      return;
    }

    pageIndex += 1;
    columnIndex = 0;
    cursorY = 0;
    pageColumnStartY = 0;
  };

  const placeAtPageStart = (nextPageIndex: number) => {
    pageIndex = Math.max(pageIndex, nextPageIndex);
    columnIndex = 0;
    cursorY = 0;
    pageColumnStartY = 0;
  };

  const placeOnNextPage = () => {
    pageIndex += 1;
    columnIndex = 0;
    cursorY = 0;
    pageColumnStartY = 0;
  };

  const currentColumnX = (geometry: FlowColumnGeometry = columnGeometry) =>
    metrics.margins.leftPx + columnIndex * (geometry.columnWidthPx + geometry.columnGapPx);

  const placeLayout = (
    target: Record<string, FlowUnitLayout>,
    id: string,
    x: number,
    width: number,
    height: number,
    includeHeight = false,
  ): FlowUnitLayout => {
    const y = pageIndex * pageStride + metrics.margins.topPx + cursorY;
    const layout = roundFlowUnitLayout({
      x,
      y,
      width,
      ...(includeHeight ? { height } : {}),
    });
    target[id] = layout;
    maxPageIndex = Math.max(maxPageIndex, pageIndex);
    return layout;
  };

  const pageHasColumnContent = () => columnIndex > 0 || cursorY > pageColumnStartY + 0.5;
  const pageHasPlacedContent = () => pageHasColumnContent() || pageColumnStartY > 0.5;
  const movePastOverflowingUnit = (unitTop: number, height: number) => {
    const currentContentBottom = pageIndex * pageStride + metrics.margins.topPx + metrics.content.heightPx;
    const unitBottom = unitTop + Math.max(0, height);
    if (unitBottom <= currentContentBottom + 0.5) {
      return false;
    }

    const safePageIndex = Math.max(
      pageIndex + 1,
      Math.ceil(Math.max(0, unitBottom - metrics.margins.topPx) / pageStride),
    );
    placeAtPageStart(safePageIndex);
    return true;
  };
  const recordPlacedUnitBottom = (layout: FlowUnitLayout, height: number) => {
    maxPlacedUnitBottom = Math.max(maxPlacedUnitBottom, layout.y + Math.max(0, height));
  };
  const consumeTrailingReservation = (
    reservationPx: number,
    geometry: FlowColumnGeometry,
  ): number => {
    let remaining = Math.max(0, reservationPx);
    let bottom = pageIndex * pageStride + metrics.margins.topPx + cursorY;
    const maxSteps = 1_002;
    for (let guard = 0; remaining > 0.5 && guard < maxSteps; guard += 1) {
      const available = Math.max(0, metrics.content.heightPx - cursorY);
      if (available <= 0.5) {
        advanceColumn(geometry);
        continue;
      }
      const consumed = Math.min(remaining, available);
      cursorY += consumed;
      remaining -= consumed;
      bottom = pageIndex * pageStride + metrics.margins.topPx + cursorY;
      maxPlacedUnitBottom = Math.max(maxPlacedUnitBottom, bottom);
      maxPageIndex = Math.max(maxPageIndex, pageIndex);
      if (remaining > 0.5) {
        advanceColumn(geometry);
      }
    }
    return bottom;
  };
  const createColumnBoxFragments = (
    blockId: string,
    height: number,
    breakOffsets?: number[],
    geometry: FlowColumnGeometry = columnGeometry,
    fragmentEndSpacePx = 0,
    forcedBreakOffsets?: readonly number[],
  ): {
    fragments: EditorBoxBlockFragmentLayout[];
    nextPageIndex: number;
    nextColumnIndex: number;
    nextCursorY: number;
    nextPageColumnStartY: number;
    bottom: number;
  } => {
    const fragmentStep = geometry.columnWidthPx + geometry.columnGapPx;
    let fragmentPageIndex = pageIndex;
    let fragmentColumnIndex = columnIndex;
    let fragmentCursorY = cursorY;
    let fragmentPageColumnStartY = pageColumnStartY;
    let bottom = pageIndex * pageStride + metrics.margins.topPx + cursorY;
    const fragments = fragmentFlowBlock({
      height, breakOffsets, forcedBreakOffsets,
      maxFragments: MAX_EDITOR_FRAGMENTS_PER_BLOCK,
      region: () => ({
        x: metrics.margins.leftPx + fragmentColumnIndex * fragmentStep,
        y: fragmentPageIndex * pageStride + metrics.margins.topPx + fragmentCursorY,
        width: geometry.columnWidthPx,
        available: Math.max(1, metrics.content.heightPx - fragmentEndSpacePx) - fragmentCursorY,
        fullHeight: Math.max(1, metrics.content.heightPx - fragmentEndSpacePx),
      }),
      advance: () => {
        if (fragmentColumnIndex < geometry.columnCount - 1) {
          fragmentColumnIndex += 1;
          fragmentCursorY = fragmentPageColumnStartY;
        } else {
          fragmentPageIndex += 1;
          fragmentColumnIndex = 0;
          fragmentCursorY = 0;
          fragmentPageColumnStartY = 0;
        }
        return true;
      },
      consume: (consumed) => {
        fragmentCursorY += consumed;
        bottom = Math.max(bottom, fragmentPageIndex * pageStride + metrics.margins.topPx + fragmentCursorY);
        maxPageIndex = Math.max(maxPageIndex, fragmentPageIndex);
      },
    }).map((fragment) => ({ ...fragment, blockId, totalHeight: height }));

    return {
      fragments,
      nextPageIndex: fragmentPageIndex,
      nextColumnIndex: fragmentColumnIndex,
      nextCursorY: fragmentCursorY,
      nextPageColumnStartY: fragmentPageColumnStartY,
      bottom,
    };
  };

  const implicitLeadKeepWithNextHeight = (
    unit: RenderUnit,
    unitIndex: number,
    currentHeight: number,
  ): number => {
    if (
      (unit.type !== "problemArea" && unit.type !== "problemLayoutSection")
      || unit.area !== "lead"
    ) {
      return 0;
    }
    const nextUnit = units[unitIndex + 1];
    if (
      !nextUnit
      || (nextUnit.type !== "problemArea" && nextUnit.type !== "problemLayoutSection")
      || nextUnit.problem.id !== unit.problem.id
      || nextUnit.area === "lead"
      || getFirstUnitBlock(nextUnit).pagination?.break === true
    ) {
      return 0;
    }

    const nextFramePadding = nextUnit.problem.frame?.enabled === true
      && isProblemFrameArea(nextUnit.area)
      ? getProblemFrameChromePaddingPx(nextUnit.problem.frame?.styleId)
      : undefined;
    const nextBlockElements = textBlockElementsByUnit.get(nextUnit.id);
    const nextMeasuredBlocks = nextUnit.blocks.map((block) => ({
      block,
      height: getMeasuredColumnItemHeight(
        nextBlockElements?.get(block.id) ?? (nextUnit.blocks.length === 1 ? elements.get(nextUnit.id) : undefined),
        zoomFactor,
      ),
    }));
    const nextContentHeight = nextMeasuredBlocks.reduce((sum, measured) => sum + measured.height, 0);
    const nextFrameChromeHeight = (nextFramePadding?.y ?? 0) * 2;
    const nextGapFreeHeight = Math.max(
      nextContentHeight + nextFrameChromeHeight,
      getSafeProblemAreaMinHeightPx(
        nextUnit.problem.areaLayout?.[nextUnit.area]?.minHeightMm ?? 0,
        metrics.content.heightPx,
      ),
    );
    const nextFlowsByBlock = nextUnit.type === "problemLayoutSection"
      || isProblemAreaColumnBlockFlowEligible(nextUnit, nextGapFreeHeight, metrics.content.heightPx);
    const firstMeasured = nextMeasuredBlocks[0];
    const nextRequiredHeight = nextFlowsByBlock
      ? getFlowBlockStartHeight(
        firstMeasured?.block,
        Math.max(0, (firstMeasured?.height ?? 0) - (firstMeasured ? blockSpaceAfterPx(firstMeasured.block) : 0)),
        metrics.content.heightPx,
        getBlockFragmentBreakOffsetsFromElement(firstMeasured ? nextBlockElements?.get(firstMeasured.block.id) : undefined, zoomFactor),
      ) + nextFrameChromeHeight
      : nextGapFreeHeight;
    return currentHeight + nextRequiredHeight;
  };
  const isFullSpanFollowerOfLead = (unit: RenderUnit, unitIndex: number): boolean => {
    const previousUnit = units[unitIndex - 1];
    return (unit.type === "problemArea" || unit.type === "problemLayoutSection")
      && isFullSpanUnit(unit)
      && (previousUnit?.type === "problemArea" || previousUnit?.type === "problemLayoutSection")
      && previousUnit.area === "lead"
      && previousUnit.problem.id === unit.problem.id;
  };
  const leadNextIsFullSpan = (unit: RenderUnit, unitIndex: number): boolean => {
    const nextUnit = units[unitIndex + 1];
    return (unit.type === "problemArea" || unit.type === "problemLayoutSection")
      && unit.area === "lead"
      && (nextUnit?.type === "problemArea" || nextUnit?.type === "problemLayoutSection")
      && nextUnit.problem.id === unit.problem.id
      && isFullSpanUnit(nextUnit);
  };

  const placeColumnBlock = (
    block: TextFlowBlock,
    height: number,
    breakOffsets?: number[],
    geometry: FlowColumnGeometry = columnGeometry,
    nextBlock?: { fitHeight: number; hasExplicitBreak: boolean },
    fragmentEndSpacePx = 0,
    forcedBreakOffsets?: readonly number[],
  ): FlowUnitLayout => {
    // 実測 height にはブロック下余白 (padding) が入っている。段に「収まるか」は本文だけで
    // 決め (余白で溢れたら送るのは次のブロック)、カーソルの前進には余白ごと含める。
    const trailingSpacePx = blockSpaceAfterPx(block);
    const fitHeight = Math.max(0, height - trailingSpacePx);
    const segmentContentHeightPx = Math.max(1, metrics.content.heightPx - fragmentEndSpacePx);
    const framedFitHeight = fragmentEndSpacePx > 0 ? height : fitHeight;
    if (block.pagination?.break === true && (cursorY > 0 || columnIndex > 0)) {
      markerLayouts[block.id] = roundFlowUnitLayout({
        x: currentColumnX(geometry),
        y: pageIndex * pageStride + metrics.margins.topPx + cursorY,
        width: geometry.columnWidthPx,
      });
      advanceColumn(geometry);
    }

    // current の末尾余白は段内の間隔として数え、next の末尾余白は収まり判定から除く。
    const keepWithNextHeight = block.pagination?.keepWithNext === true
      && nextBlock
      && !nextBlock.hasExplicitBreak
      ? height + nextBlock.fitHeight
      : 0;
    if (
      cursorY > pageColumnStartY + 0.5
      && keepWithNextHeight + fragmentEndSpacePx > metrics.content.heightPx - cursorY + 0.5
      && keepWithNextHeight + fragmentEndSpacePx <= metrics.content.heightPx + 0.5
    ) {
      advanceColumn(geometry);
    }

    const reserveGap = Math.max(0, reserveSpaceGaps[block.id] ?? 0);
    if (
      reserveGap > 0.5 &&
      cursorY > pageColumnStartY + 0.5 &&
      reserveGap + Math.min(fitHeight, metrics.content.heightPx) > metrics.content.heightPx - cursorY + 0.5 &&
      reserveGap + Math.min(fitHeight, metrics.content.heightPx) <= metrics.content.heightPx + 0.5
    ) {
      advanceColumn(geometry);
    }
    cursorY += reserveGap;

    if (isFlowBlockFragmentable(block, fitHeight, metrics.content.heightPx, breakOffsets)) {
      // A box flows like body text across columns/pages: it fills the rest of the
      // current column and continues (open-edged) into the next. So we don't push
      // the whole box to the next column when it overflows — only when too little
      // room remains in the current column to start it cleanly.
      const available = segmentContentHeightPx - cursorY;
      if (
        block.pagination?.keepTogether === true
        && cursorY > pageColumnStartY + 0.5
        && fitHeight > available + 0.5
        && fitHeight <= segmentContentHeightPx + 0.5
      ) {
        advanceColumn(geometry);
      }
      const nextAvailable = segmentContentHeightPx - cursorY;
      const minStart = block.type === "boxBlock"
        ? boxFragmentMinStartHeightPx(resolveBoxFrame(block), boxBlockTitleText(block).length > 0)
        : breakOffsets?.[0] ?? 0;
      if (cursorY > pageColumnStartY + 0.5 && fitHeight > nextAvailable + 0.5 && nextAvailable < minStart - 0.5) {
        advanceColumn(geometry);
      }
    } else if (
      cursorY <= pageColumnStartY + 0.5 &&
      pageColumnStartY > 0.5 &&
      height > 0 &&
      cursorY + framedFitHeight > segmentContentHeightPx + 0.5
    ) {
      placeOnNextPage();
    } else if (cursorY > pageColumnStartY + 0.5 && height > 0 && cursorY + framedFitHeight > segmentContentHeightPx + 0.5) {
      advanceColumn(geometry);
    }

    const layout = placeLayout(blockLayouts as Record<string, FlowUnitLayout>, block.id, currentColumnX(geometry), geometry.columnWidthPx, height, true);
    // Text and boxes fill the remaining column at measured line boundaries.
    const shouldFragment = (isFlowBlockFragmentable(block, fitHeight, metrics.content.heightPx, breakOffsets)
      && (block.type === "boxBlock" || framedFitHeight > segmentContentHeightPx - cursorY + 0.5))
      || (fragmentEndSpacePx > 0 && height > segmentContentHeightPx + 0.5);
    const fragmentResult = shouldFragment
      ? createColumnBoxFragments(block.id, height, breakOffsets, geometry, fragmentEndSpacePx,
        forcedBreakOffsets)
      : null;
    if (fragmentResult && fragmentResult.fragments.length > 1) {
      const firstFragment = fragmentResult.fragments[0];
      boxBlockFragmentLayouts[block.id] = fragmentResult.fragments.slice(1).map(roundEditorBoxBlockFragmentLayout);
      boxFragmentSourceLayouts[block.id] = {
        visibleHeight: firstFragment.height,
        origin: { x: firstFragment.x, y: firstFragment.y, width: firstFragment.width },
        totalHeight: height,
      };
      maxPlacedUnitBottom = Math.max(maxPlacedUnitBottom, fragmentResult.bottom);
      pageIndex = fragmentResult.nextPageIndex;
      columnIndex = fragmentResult.nextColumnIndex;
      cursorY = fragmentResult.nextCursorY;
      pageColumnStartY = fragmentResult.nextPageColumnStartY;
    } else {
      cursorY += Math.max(0, height);
      recordPlacedUnitBottom(layout, height);
      movePastOverflowingUnit(layout.y, height);
    }

    return layout;
  };

  const placeBlockFlowUnit = (
    unit: Extract<RenderUnit, { type: "textFlow" | "problemArea" }>,
    element: HTMLElement | undefined,
    unitIndex: number,
  ): boolean => {
    if (unit.blocks.length === 0) {
      return false;
    }

    const blockElements = textBlockElementsByUnit.get(unit.id);
    const measuredBlocks = unit.blocks.map((block) => {
      const blockElement = blockElements?.get(block.id);
      return {
        block,
        blockElement,
        height: getMeasuredColumnItemHeight(blockElement ?? (unit.blocks.length === 1 ? element : undefined), zoomFactor),
      };
    });
    const isFrameArea = unit.type === "problemArea"
      && unit.problem.frame?.enabled === true
      && isProblemFrameArea(unit.area);
    const flowedFramePadding = isFrameArea
      ? getProblemFrameChromePaddingPx(unit.problem.frame?.styleId)
      : undefined;
    if (unit.type === "problemArea") {
      const gapFreeHeightPx = measuredBlocks.reduce((sum, measured) => sum + measured.height, 0)
        + (flowedFramePadding ? flowedFramePadding.y * 2 : 0);
      if (!isProblemAreaColumnBlockFlowEligible(unit, gapFreeHeightPx, metrics.content.heightPx)) {
        return false;
      }
    }

    const leadKeepHeight = implicitLeadKeepWithNextHeight(
      unit,
      unitIndex,
      measuredBlocks.reduce((sum, measured) => sum + measured.height, 0),
    );
    if (
      cursorY > pageColumnStartY + 0.5
      && leadKeepHeight > metrics.content.heightPx - cursorY + 0.5
      && leadKeepHeight <= metrics.content.heightPx + 0.5
    ) {
      if (leadNextIsFullSpan(unit, unitIndex)) {
        placeOnNextPage();
      } else {
        advanceColumn();
      }
    }

    // A full-span problem area's flow places blocks against a single "column"
    // spanning the whole content width (see fullSpanGeometry), not the page's own
    // column width — otherwise a split full-span area would render squeezed into
    // one page-column instead of the full page width it is meant to occupy.
    const isFullSpanFlow = unit.type === "problemArea" && isFullSpanUnit(unit);
    const geometry = isFullSpanFlow ? fullSpanGeometry : columnGeometry;
    // Mirrors the atomic full-span placement below: full-span content can't share
    // a horizontal band with page-column content, so it always starts a fresh page
    // when there is already column content on the current one.
    if (
      isFullSpanFlow
      && pageHasColumnContent()
      && !(columnIndex === 0 && isFullSpanFollowerOfLead(unit, unitIndex))
    ) {
      placeOnNextPage();
    }

    const firstUnitBlock = unit.type === "problemArea" ? getFirstUnitBlock(unit) : undefined;
    const problemPageBreakBlock = firstUnitBlock && !unit.blocks.some((block) => block.id === firstUnitBlock.id)
      ? firstUnitBlock
      : undefined;
    if (problemPageBreakBlock?.pagination?.break === true && (cursorY > 0 || columnIndex > 0)) {
      markerLayouts[problemPageBreakBlock.id] = roundFlowUnitLayout({
        x: currentColumnX(geometry),
        y: pageIndex * pageStride + metrics.margins.topPx + cursorY,
        width: geometry.columnWidthPx,
      });
      advanceColumn(geometry);
    }
    if (flowedFramePadding) {
      cursorY += flowedFramePadding.y;
    }

    const placedBlocks: Array<{ blockId: string; layout: FlowUnitLayout }> = [];
    for (const [index, { block, blockElement, height }] of measuredBlocks.entries()) {
      const next = measuredBlocks[index + 1];
      placedBlocks.push({
        blockId: block.id,
        layout: placeColumnBlock(
          block,
          height,
          block.type === "boxBlock"
            ? getBoxFragmentBreakOffsetsFromElement(block, blockElement, zoomFactor)
            : getBlockFragmentBreakOffsetsFromElement(blockElement, zoomFactor),
          geometry,
          next ? {
            fitHeight: Math.max(0, next.height - blockSpaceAfterPx(next.block)),
            hasExplicitBreak: next.block.pagination?.break === true,
          } : undefined,
          flowedFramePadding?.y ?? 0,
          block.type === "boxBlock" ? getBoxManualBreakOffsetsFromElement(block, blockElement, zoomFactor) : undefined,
        ),
      });
    }
    if (flowedFramePadding) {
      // Each piece owns a bottom outset. Earlier pieces reserve it by reducing
      // fragment capacity; consume the final outset and round upward so the next
      // unit can never land one pixel inside the painted frame.
      cursorY = Math.ceil(cursorY + flowedFramePadding.y - 0.001);
    }

    const x = Math.min(...placedBlocks.map((entry) => entry.layout.x));
    const y = Math.min(...placedBlocks.map((entry) => entry.layout.y));
    const right = Math.max(...placedBlocks.map((entry) => entry.layout.x + entry.layout.width));
    const bottom = Math.max(...placedBlocks.map((entry) => entry.layout.y + (entry.layout.height ?? 0)));
    const unitLayout = roundFlowUnitLayout({
      x,
      y,
      width: right - x,
      height: Math.max(1, bottom - y),
    });

    let frameFragmentCount = 0;
    if (isFrameArea) {
      // The frame can no longer be a single CSS box around the whole unit once its
      // blocks are split across a page/column break — group the placed blocks back
      // into the page/column segments they actually landed in, so the caller can
      // render one border "piece" per segment (open at the break, see
      // ProblemAreaFrameFragmentLayout).
      const frameVisuals = placedBlocks.flatMap((entry) => {
        const source = boxFragmentSourceLayouts[entry.blockId];
        const continuations = boxBlockFragmentLayouts[entry.blockId] ?? [];
        if (!source || continuations.length === 0) {
          return [{ layout: entry.layout, height: entry.layout.height ?? 0 }];
        }
        return [
          { layout: entry.layout, height: source.visibleHeight },
          ...continuations.map((fragment) => ({ layout: fragment, height: fragment.height })),
        ];
      });
      const segments: ProblemAreaFrameFragmentLayout[] = [];
      let segmentStart = 0;
      for (let i = 1; i <= frameVisuals.length; i += 1) {
        const atSegmentBoundary = i === frameVisuals.length || !samePageColumn(
          getPageColumnKey(frameVisuals[segmentStart].layout, metrics, pageStride),
          getPageColumnKey(frameVisuals[i].layout, metrics, pageStride),
        );
        if (!atSegmentBoundary) {
          continue;
        }
        const segmentBlocks = frameVisuals.slice(segmentStart, i);
        const segmentX = Math.min(...segmentBlocks.map((entry) => entry.layout.x));
        const segmentY = Math.min(...segmentBlocks.map((entry) => entry.layout.y));
        const segmentRight = Math.max(...segmentBlocks.map((entry) => entry.layout.x + entry.layout.width));
        const segmentBottom = Math.max(...segmentBlocks.map((entry) => entry.layout.y + entry.height));
        segments.push({
          x: segmentX - unitLayout.x,
          y: segmentY - unitLayout.y,
          width: segmentRight - segmentX,
          height: Math.max(1, segmentBottom - segmentY),
        });
        segmentStart = i;
      }
      if (segments.length > 1) {
        frameFragmentLayouts[unit.id] = segments;
        frameFragmentCount = segments.length;
      }
    }

    const frameChromePadding = isFrameArea && frameFragmentCount > 1
      ? getProblemFrameChromePaddingPx(unit.problem.frame?.styleId)
      : undefined;
    const frameChromeHeightPx = frameChromePadding
      ? frameChromePadding.y * 2 * frameFragmentCount
      : 0;
    recordProblemAreaOccupiedHeight(
      unit,
      measuredBlocks.reduce((height, measured) => height + measured.height, 0) + frameChromeHeightPx,
    );
    const trailingReservationPx = trailingReservationForUnit(unit);
    if (trailingReservationPx > 0.5) {
      const reservedBottom = consumeTrailingReservation(trailingReservationPx, geometry);
      unitLayout.height = Math.round(Math.max(unitLayout.height ?? 0, reservedBottom - unitLayout.y));
      recordPlacedUnitBottom(unitLayout, unitLayout.height);
    }

    if (isFullSpanFlow) {
      // Mirrors the atomic full-span placement below: subsequent page-column
      // content must start below the full-span band on every column, not beside it.
      pageColumnStartY = cursorY;
      columnIndex = 0;
    }

    layouts[unit.id] = unitLayout;
    for (const entry of placedBlocks) {
      blockLayouts[entry.blockId] = roundTextFlowColumnBlockLayout({
        x: entry.layout.x - unitLayout.x,
        y: entry.layout.y - unitLayout.y,
        width: entry.layout.width,
      });
    }
    return true;
  };

  const placeNestedColumnSection = (
    unit: Extract<RenderUnit, { type: "layoutSection" | "problemLayoutSection" }>,
    element: HTMLElement | undefined,
    unitIndex: number,
  ): boolean => {
    if (unit.blocks.length === 0) {
      return false;
    }
    const initialCursor = { pageIndex, columnIndex, cursorY, pageColumnStartY };

    const isFullSpanFlow = isFullSpanUnit(unit);
    const outerGeometry = isFullSpanFlow ? fullSpanGeometry : columnGeometry;
    if (unit.section.pagination?.break === true && (cursorY > 0 || columnIndex > 0)) {
      markerLayouts[unit.section.id] = roundFlowUnitLayout({
        x: currentColumnX(),
        y: pageIndex * pageStride + metrics.margins.topPx + cursorY,
        width: outerGeometry.columnWidthPx,
      });
      advanceColumn(outerGeometry);
    }
    if (isFullSpanFlow && pageHasColumnContent()) {
      placeOnNextPage();
    }

    const sectionHeight = getMeasuredColumnItemHeight(element, zoomFactor);
    const nextUnit = units[unitIndex + 1];
    const nextBlock = nextUnit ? getFirstUnitBlock(nextUnit) : undefined;
    const nextHeight = nextUnit ? getMeasuredColumnItemHeight(elements.get(nextUnit.id), zoomFactor) : 0;
    const remainingHeight = metrics.content.heightPx - cursorY;
    const keepWithNextHeight = unit.section.pagination?.keepWithNext === true
      && nextBlock?.pagination?.break !== true
      && nextUnit
      && !isFullSpanFlow
      && !isFullSpanUnit(nextUnit)
      ? sectionHeight + Math.max(0, nextHeight - (nextBlock ? blockSpaceAfterPx(nextBlock) : 0))
      : 0;
    if (
      cursorY > pageColumnStartY + 0.5
      && (
        (unit.section.pagination?.keepTogether === true
          && sectionHeight > remainingHeight + 0.5
          && sectionHeight <= metrics.content.heightPx + 0.5)
        || (keepWithNextHeight > remainingHeight + 0.5
          && keepWithNextHeight <= metrics.content.heightPx + 0.5)
      )
    ) {
      advanceColumn(outerGeometry);
    }

    const columns = getLayoutSectionColumns(unit.section);
    const innerColumnCount = columns.length;
    const innerColumnGapPx = getLayoutSectionColumnGapPx(
      unit.section, metrics.flow.columnGapMm, metrics.flow.columnGapPx,
    );
    const availableWidth = Math.max(1, outerGeometry.columnWidthPx - (innerColumnCount - 1) * innerColumnGapPx);
    const columnWidths = getLayoutSectionColumnWidths(unit.section, innerColumnCount)
      .map((width) => availableWidth * width / LAYOUT_SECTION_WIDTH_TOTAL);
    const columnByBlockId = new Map<string, { columnIndex: number; columnWidthPx: number; columnOffsetPx: number }>();
    let columnOffsetPx = 0;
    columns.forEach((column, columnIndex) => {
      const geometry = { columnIndex, columnWidthPx: columnWidths[columnIndex], columnOffsetPx };
      column.forEach((block) => columnByBlockId.set(block.id, geometry));
      columnOffsetPx += columnWidths[columnIndex] + innerColumnGapPx;
    });
    const blockElements = textBlockElementsByUnit.get(unit.id);
    const blocks = unit.blocks.map((block) => {
      const blockElement = blockElements?.get(block.id);
      return {
        id: block.id,
        ...columnByBlockId.get(block.id)!,
        height: getMeasuredColumnItemHeight(
          blockElement ?? (unit.blocks.length === 1 ? element : undefined),
          zoomFactor,
        ),
        type: block.type,
        break: block.pagination?.break === true,
        trailingSpacePx: blockSpaceAfterPx(block),
        keepWithNext: block.pagination?.keepWithNext === true,
        keepTogether: block.type === "boxBlock" && block.pagination?.keepTogether === true,
        minStartHeightPx: block.type === "boxBlock"
          ? boxFragmentMinStartHeightPx(
            resolveBoxFrame(block),
            boxBlockTitleText(block).length > 0,
          )
          : undefined,
        breakOffsets: block.type === "boxBlock"
          ? getBoxFragmentBreakOffsetsFromElement(block, blockElement, zoomFactor)
          : getBlockFragmentBreakOffsetsFromElement(blockElement, zoomFactor),
      };
    });
    const innerColumnWidthPx = columnWidths[0];
    let availableFirstHeightPx = Math.max(0, metrics.content.heightPx - cursorY);
    const firstFitHeightPx = getFlowBlockStartHeight(
      blocks[0],
      Math.max(0, blocks[0].height - (blocks[0].trailingSpacePx ?? 0)),
      metrics.content.heightPx,
      blocks[0].keepTogether ? undefined : blocks[0].breakOffsets,
    );
    if (
      firstFitHeightPx > availableFirstHeightPx + 0.5
      && firstFitHeightPx <= metrics.content.heightPx + 0.5
    ) {
      advanceColumn(outerGeometry);
      availableFirstHeightPx = Math.max(0, metrics.content.heightPx - cursorY);
    }
    // The shared inner-column flow treats each outer page-column as one segment.
    // Its synthetic stride intentionally excludes the physical page gap; mapping
    // below restores the real outer page/column coordinates exactly once.
    const remainingPageSegmentCount = outerGeometry.columnCount - columnIndex;
    const initialSegmentHeightsPx = Array.from(
      { length: remainingPageSegmentCount },
      (_, segmentIndex) => segmentIndex === 0
        ? availableFirstHeightPx
        : Math.max(0, metrics.content.heightPx - pageColumnStartY),
    );
    const flowResult = computeProblemAreaColumnFlow(
      blocks,
      innerColumnCount,
      innerColumnWidthPx,
      innerColumnGapPx,
      availableFirstHeightPx,
      metrics.content.heightPx,
      metrics.content.heightPx,
      initialSegmentHeightsPx,
    );
    if (flowResult.mode !== "flow") {
      // Balanced sections use the ordinary unit placement below. Restore the
      // cursor so its explicit break/keep hints are consumed exactly once.
      ({ pageIndex, columnIndex, cursorY, pageColumnStartY } = initialCursor);
      delete markerLayouts[unit.section.id];
      return false;
    }

    const startPageIndex = pageIndex;
    const startColumnIndex = columnIndex;
    const startCursorY = cursorY;
    const startPageColumnStartY = pageColumnStartY;
    const segmentHeight = (segmentIndex: number) => (
      initialSegmentHeightsPx[segmentIndex] ?? metrics.content.heightPx
    );
    // Keep cumulative offsets for this layout pass. Re-summing the same prefix
    // for every fragment makes long nested columns quadratic in page count.
    // Incremental addition retains the original floating-point summation order.
    const segmentTops = [0];
    const segmentTop = (segmentIndex: number) => {
      while (segmentTops.length <= segmentIndex) {
        const previous = segmentTops.length - 1;
        segmentTops.push(segmentTops[previous] + segmentHeight(previous));
      }
      return segmentTops[segmentIndex];
    };
    const segmentIndexForY = (y: number) => {
      let segmentIndex = 0;
      while (y >= segmentTop(segmentIndex) + segmentHeight(segmentIndex) - 0.5) {
        segmentIndex += 1;
      }
      return segmentIndex;
    };
    const outerSegmentState = (segmentIndex: number) => {
      const absoluteColumnIndex = startColumnIndex + segmentIndex;
      const pageOffset = Math.floor(absoluteColumnIndex / outerGeometry.columnCount);
      return {
        pageIndex: startPageIndex + pageOffset,
        columnIndex: absoluteColumnIndex % outerGeometry.columnCount,
        baseCursorY: segmentIndex === 0
          ? startCursorY
          : pageOffset === 0 ? startPageColumnStartY : 0,
      };
    };
    const mapInnerLayout = (inner: TextFlowColumnBlockLayout): FlowUnitLayout => {
      const segmentIndex = segmentIndexForY(inner.y);
      const outer = outerSegmentState(segmentIndex);
      return {
        x: metrics.margins.leftPx
          + outer.columnIndex * (outerGeometry.columnWidthPx + outerGeometry.columnGapPx)
          + inner.x,
        y: outer.pageIndex * pageStride
          + metrics.margins.topPx
          + outer.baseCursorY
          + inner.y
          - segmentTop(segmentIndex),
        width: inner.width,
      };
    };

    const absoluteBlockLayouts = blocks.map((block) => ({
      block,
      layout: mapInnerLayout({
        ...flowResult.blockLayouts[block.id],
        x: flowResult.blockLayouts[block.id].x + block.columnOffsetPx,
      }),
    }));
    const absoluteFragmentLayouts = blocks.flatMap((block) => {
      const fragments = flowResult.fragmentLayouts[block.id];
      if (!fragments) {
        return [{ block, layout: mapInnerLayout({
          ...flowResult.blockLayouts[block.id],
          x: flowResult.blockLayouts[block.id].x + block.columnOffsetPx,
        }), height: block.height }];
      }
      return fragments.map((fragment) => ({
        block,
        fragment,
        layout: mapInnerLayout(fragment),
        height: fragment.height,
      }));
    });
    const fragmentBounds = absoluteFragmentLayouts.reduce((bounds, { layout, height }) => ({
      left: Math.min(bounds.left, layout.x),
      top: Math.min(bounds.top, layout.y),
      right: Math.max(bounds.right, layout.x + layout.width),
      bottom: Math.max(bounds.bottom, layout.y + height),
    }), {
      left: Number.POSITIVE_INFINITY,
      top: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY,
    });
    // The source grid keeps one outer column's geometry. Continuations may
    // overflow into other outer columns/pages without resizing that grid.
    const unitX = metrics.margins.leftPx + startColumnIndex * (outerGeometry.columnWidthPx + outerGeometry.columnGapPx);
    const unitY = startPageIndex * pageStride + metrics.margins.topPx + startCursorY;
    const unitBottom = fragmentBounds.bottom;
    const unitLayout = roundFlowUnitLayout({
      x: unitX,
      y: unitY,
      width: outerGeometry.columnWidthPx,
      height: Math.max(1, unitBottom - unitY),
    });
    layouts[unit.id] = unitLayout;
    recordPlacedUnitBottom(unitLayout, unitBottom - unitY);

    const relativeBlockLayouts = Object.fromEntries(absoluteBlockLayouts.map(({ block, layout }) => [
      block.id,
      roundTextFlowColumnBlockLayout({
        x: layout.x - unitX - block.columnOffsetPx,
        y: layout.y - unitY,
        width: layout.width,
      }),
    ]));
    const relativeMarkerLayouts = Object.fromEntries(Object.entries(flowResult.markerLayouts).map(([blockId, marker]) => {
      const ownerOffset = columnByBlockId.get(blockId)?.columnOffsetPx ?? 0;
      const absolute = mapInnerLayout({ ...marker, x: marker.x + ownerOffset });
      return [blockId, roundTextFlowColumnBlockLayout({
        x: absolute.x - unitX - ownerOffset,
        y: absolute.y - unitY,
        width: absolute.width,
      })];
    }));
    nestedColumnLayouts[unit.id] = {
      blockLayouts: relativeBlockLayouts,
      markerLayouts: relativeMarkerLayouts,
      totalHeightPx: unitBottom - unitY,
      columnWidthPx: innerColumnWidthPx,
      columnGapPx: innerColumnGapPx,
    };

    for (const block of blocks) {
      const fragments = flowResult.fragmentLayouts[block.id];
      if (!fragments || fragments.length <= 1) {
        continue;
      }
      const absoluteFragments = fragments.map((fragment) => {
        const absolute = mapInnerLayout(fragment);
        return roundEditorBoxBlockFragmentLayout({
          blockId: block.id,
          fragmentIndex: fragment.fragmentIndex,
          sourceOffsetY: fragment.sourceOffsetY,
          height: fragment.height,
          x: absolute.x,
          y: absolute.y,
          width: absolute.width,
          totalHeight: block.height,
        });
      });
      boxFragmentSourceLayouts[block.id] = {
        visibleHeight: absoluteFragments[0].height,
        origin: { x: absoluteFragments[0].x, y: absoluteFragments[0].y, width: absoluteFragments[0].width },
        totalHeight: block.height,
      };
      boxBlockFragmentLayouts[block.id] = absoluteFragments.slice(1);
    }

    recordProblemAreaOccupiedHeight(unit, flowResult.totalHeightPx);

    const lastSegmentIndex = Math.max(0, flowResult.segments - 1);
    const lastOuter = outerSegmentState(lastSegmentIndex);
    const lastSegmentTop = segmentTop(lastSegmentIndex);
    const lastSegmentBottom = blocks.reduce((bottom, block) => {
      const fragments = flowResult.fragmentLayouts[block.id];
      if (fragments) {
        return fragments.reduce((fragmentBottom, fragment) => (
          segmentIndexForY(fragment.y) === lastSegmentIndex
            ? Math.max(fragmentBottom, fragment.y - lastSegmentTop + fragment.height)
            : fragmentBottom
        ), bottom);
      }
      const inner = flowResult.blockLayouts[block.id];
      return segmentIndexForY(inner.y) === lastSegmentIndex
        ? Math.max(bottom, inner.y - lastSegmentTop + block.height)
        : bottom;
    }, 0);
    pageIndex = lastOuter.pageIndex;
    columnIndex = lastOuter.columnIndex;
    pageColumnStartY = lastOuter.pageIndex === startPageIndex ? startPageColumnStartY : 0;
    cursorY = lastOuter.baseCursorY + lastSegmentBottom;
    maxPageIndex = Math.max(maxPageIndex, pageIndex);
    if (isFullSpanFlow) {
      pageColumnStartY = cursorY;
      columnIndex = 0;
    }
    const trailingReservationPx = trailingReservationForUnit(unit);
    if (trailingReservationPx > 0.5) {
      const reservedBottom = consumeTrailingReservation(trailingReservationPx, outerGeometry);
      unitLayout.height = Math.round(Math.max(unitLayout.height ?? 0, reservedBottom - unitLayout.y));
      nestedColumnLayouts[unit.id].totalHeightPx = Math.max(
        nestedColumnLayouts[unit.id].totalHeightPx,
        reservedBottom - unitLayout.y,
      );
      recordPlacedUnitBottom(unitLayout, unitLayout.height);
      if (isFullSpanFlow) {
        pageColumnStartY = cursorY;
        columnIndex = 0;
      }
    }
    return true;
  };

  for (const [unitIndex, unit] of units.entries()) {
    const element = elements.get(unit.id);
    if (
      (unit.type === "layoutSection" || unit.type === "problemLayoutSection")
      && placeNestedColumnSection(unit, element, unitIndex)
    ) {
      continue;
    }
    if (unit.type === "textFlow" || unit.type === "problemArea") {
      if (placeBlockFlowUnit(unit, element, unitIndex)) {
        continue;
      }
    }

    if (unit.type === "textFlow") {
      continue;
    }

    const height = getMeasuredColumnItemHeight(element, zoomFactor);
    const block = getFirstUnitBlock(unit);
    const isFullSpan = isFullSpanUnit(unit);
    const reserveGap = Math.max(0, reserveSpaceGaps[block.id] ?? 0);

    if (block.pagination?.break === true && (cursorY > 0 || columnIndex > 0)) {
      markerLayouts[block.id] = roundFlowUnitLayout({
        x: currentColumnX(),
        y: pageIndex * pageStride + metrics.margins.topPx + cursorY,
        width: isFullSpan ? metrics.content.widthPx : metrics.flow.columnWidthPx,
      });
      advanceColumn();
    }

    const nextUnit = units[unitIndex + 1];
    const nextBlock = nextUnit ? getFirstUnitBlock(nextUnit) : undefined;
    const nextHeight = nextUnit ? getMeasuredColumnItemHeight(elements.get(nextUnit.id), zoomFactor) : 0;
    const explicitKeepWithNextHeight = block.pagination?.keepWithNext === true
      && nextBlock
      && nextBlock.pagination?.break !== true
      && nextUnit
      && !isFullSpan
      && !isFullSpanUnit(nextUnit)
      ? reserveGap + height + Math.max(0, nextHeight - blockSpaceAfterPx(nextBlock))
      : 0;
    const keepWithNextHeight = Math.max(
      explicitKeepWithNextHeight,
      reserveGap + implicitLeadKeepWithNextHeight(unit, unitIndex, height),
    );
    if (
      cursorY > pageColumnStartY + 0.5
      && keepWithNextHeight > metrics.content.heightPx - cursorY + 0.5
      && keepWithNextHeight <= metrics.content.heightPx + 0.5
    ) {
      if (leadNextIsFullSpan(unit, unitIndex)) {
        placeOnNextPage();
      } else {
        advanceColumn();
      }
    }

    if (isFullSpan) {
      if (
        pageHasColumnContent()
        && !(columnIndex === 0 && isFullSpanFollowerOfLead(unit, unitIndex))
      ) {
        placeOnNextPage();
      }

      if (cursorY > 0 && height > 0 && cursorY + reserveGap + height > metrics.content.heightPx + 0.5) {
        placeOnNextPage();
      }

      cursorY += reserveGap;

      const layout = placeLayout(layouts, unit.id, metrics.margins.leftPx, metrics.content.widthPx, height);

      cursorY += Math.max(0, height);
      if (!movePastOverflowingUnit(layout.y, height)) {
        pageColumnStartY = cursorY;
        columnIndex = 0;
      }

      recordProblemAreaOccupiedHeight(unit, height);
      const trailingReservationPx = trailingReservationForUnit(unit);
      if (trailingReservationPx > 0.5) {
        const reservedBottom = consumeTrailingReservation(trailingReservationPx, fullSpanGeometry);
        layout.height = Math.round(Math.max(height, reservedBottom - layout.y));
        recordPlacedUnitBottom(layout, layout.height);
        pageColumnStartY = cursorY;
        columnIndex = 0;
      }

      continue;
    }

    const exceedsBlankColumn = height > metrics.content.heightPx + 0.5;
    if (
      reserveGap > 0.5 &&
      cursorY > pageColumnStartY + 0.5 &&
      reserveGap + Math.min(height, metrics.content.heightPx) > metrics.content.heightPx - cursorY + 0.5 &&
      reserveGap + Math.min(height, metrics.content.heightPx) <= metrics.content.heightPx + 0.5
    ) {
      advanceColumn();
    }
    cursorY += reserveGap;
    if (exceedsBlankColumn && pageHasPlacedContent()) {
      placeOnNextPage();
    } else if (
      cursorY <= pageColumnStartY + 0.5 &&
      pageColumnStartY > 0.5 &&
      height > 0 &&
      cursorY + height > metrics.content.heightPx + 0.5
    ) {
      placeOnNextPage();
    } else if (cursorY > pageColumnStartY + 0.5 && height > 0 && cursorY + height > metrics.content.heightPx + 0.5) {
      advanceColumn();
    }

    const layout = placeLayout(layouts, unit.id, currentColumnX(), metrics.flow.columnWidthPx, height);
    recordPlacedUnitBottom(layout, height);

    cursorY += Math.max(0, height);
    movePastOverflowingUnit(layout.y, height);

    recordProblemAreaOccupiedHeight(unit, height);
    const trailingReservationPx = trailingReservationForUnit(unit);
    if (trailingReservationPx > 0.5) {
      const reservedBottom = consumeTrailingReservation(trailingReservationPx, columnGeometry);
      layout.height = Math.round(Math.max(height, reservedBottom - layout.y));
      recordPlacedUnitBottom(layout, layout.height);
    }

  }

  return {
    layouts,
    blockLayouts,
    boxBlockFragmentLayouts,
    boxFragmentSourceLayouts,
    frameFragmentLayouts,
    nestedColumnLayouts,
    markerLayouts,
    pageCount: Math.max(1, maxPageIndex + 1, getPageCountForBottom(maxPlacedUnitBottom, pageHeightPx, pageStride)),
  };
}

export function getPageCountForBottom(bottom: number, pageHeightPx: number, pageStridePx: number): number {
  return bottom > pageHeightPx
    ? Math.ceil((bottom - pageHeightPx) / pageStridePx) + 1
    : 1;
}

export function getPageIndexForY(y: number, pageStridePx: number): number {
  return Math.max(0, Math.floor(Math.max(0, y) / pageStridePx));
}

export function createSingleColumnBoxFragments({
  blockId,
  height,
  metrics,
  pageHeightPx,
  pageStride,
  sourceTop,
  width,
  x,
  breakOffsets,
  forcedBreakOffsets,
  fragmentEndSpacePx = 0,
}: {
  blockId: string;
  height: number;
  metrics: PageMetrics;
  pageHeightPx: number;
  pageStride: number;
  sourceTop: number;
  width: number;
  x: number;
  breakOffsets?: number[];
  forcedBreakOffsets?: readonly number[];
  /** 各ページ片の下端に残す、枠などの非コンテンツ chrome。 */
  fragmentEndSpacePx?: number;
}): EditorBoxBlockFragmentLayout[] {
  let fragmentPageIndex = getPageIndexForY(sourceTop, pageStride);
  let fragmentY = sourceTop;
  const fragments = fragmentFlowBlock({
    height, breakOffsets, forcedBreakOffsets,
    maxFragments: MAX_EDITOR_FRAGMENTS_PER_BLOCK,
    region: () => ({
      x, y: fragmentY, width,
      available: fragmentPageIndex * pageStride + metrics.margins.topPx
        + metrics.content.heightPx - Math.max(0, fragmentEndSpacePx) - fragmentY,
      fullHeight: metrics.content.heightPx,
    }),
    advance: () => {
      fragmentPageIndex += 1;
      fragmentY = fragmentPageIndex * pageStride + metrics.margins.topPx;
      return true;
    },
    consume: (consumed) => { fragmentY += consumed; },
  }).map((fragment) => ({ ...fragment, blockId, totalHeight: height }));

  return fragments.length > 0
    ? fragments
    : [{
      blockId,
      fragmentIndex: 0,
      x,
      y: sourceTop,
      width,
      height: Math.max(0, Math.min(height, pageHeightPx)),
      sourceOffsetY: 0,
      totalHeight: height,
    }];
}

/** Local independent columns own their breaks; all other box descendants use the outer flow. */
function getBoxOuterFlowBreakIds(box: BoxBlockNode): string[] {
  const ids: string[] = [];
  const visit = (blocks: readonly SigmaBlock[]) => {
    for (const block of blocks) {
      if (block.pagination?.break) ids.push(block.id);
      if (block.type === "boxBlock" || block.type === "quote") visit(block.blocks);
      else if (block.type === "layoutSection" && block.layout.columnCount <= 1) visit(block.children);
      else if (block.type === "problem") PROBLEM_AREA_ORDER.forEach((area) => visit(block[area]));
    }
  };
  visit(box.blocks);
  return ids;
}

export function getBoxManualBreakOffsetsFromMeasuredBox(
  block: BoxBlockNode,
  measured: MeasuredBlock | undefined,
  measuredBlocks: ReadonlyMap<string, MeasuredBlock>,
): number[] {
  if (!measured) return [];
  return getBoxOuterFlowBreakIds(block).flatMap((id) => {
    const child = measuredBlocks.get(id);
    const offset = child ? child.top - measured.top : 0;
    return offset > 0.5 && offset < (measured.height ?? 0) - 0.5 ? [offset] : [];
  });
}

function getBoxManualBreakOffsetsFromElement(block: BoxBlockNode, element: HTMLElement | undefined, zoomFactor: number): number[] {
  if (!element) return [];
  const ids = getBoxOuterFlowBreakIds(block);
  if (ids.length === 0) return [];
  const bounds = element.getBoundingClientRect();
  const elements = collectTextFlowBlockElements(element);
  return ids.flatMap((id) => {
    const child = elements.get(id);
    const offset = child ? (child.getBoundingClientRect().top - bounds.top) / zoomFactor : 0;
    return offset > 0.5 && offset < bounds.height / zoomFactor - 0.5 ? [offset] : [];
  });
}

export function getBoxFragmentBreakOffsetsFromMeasuredBox(
  block: BoxBlockNode,
  measured: MeasuredBlock | undefined,
  measuredBlocks?: ReadonlyMap<string, MeasuredBlock>,
): number[] | undefined {
  const measuredHeight = measured?.height ?? 0;
  const lineOffsets = measured && measuredBlocks && measuredHeight > 0
    ? getMeasuredLineBreakOffsets(
      getLeafMeasuredDescendantLines(block.id, measuredBlocks),
      measured.top,
    ).filter((offset) => offset > 0.5 && offset < measuredHeight - 0.5)
    : measured?.lines && measured.lines.length > 0 && measuredHeight > 0
      ? getMeasuredLineBreakOffsets(measured.lines, measured.top)
        .filter((offset) => offset > 0.5 && offset < measuredHeight - 0.5)
      : [];
  return mergeBoxFragmentBreakOffsets(lineOffsets, getNotebookRingBreakOffsets(block, measuredHeight), measuredHeight);
}

function getLeafMeasuredDescendantLines(
  containerId: string,
  measuredBlocks: ReadonlyMap<string, MeasuredBlock>,
): MeasuredLine[] {
  const descendants = [...measuredBlocks.values()].filter((candidate) =>
    candidate.id !== containerId && measuredBlockIsInside(candidate, containerId, measuredBlocks),
  );
  const containers = new Set(
    descendants.flatMap((candidate) => candidate.containerId ? [candidate.containerId] : []),
  );
  return descendants
    .filter((candidate) => !containers.has(candidate.id))
    .flatMap((candidate) => candidate.lines ?? []);
}

function measuredBlockIsInside(
  candidate: MeasuredBlock,
  containerId: string,
  measuredBlocks: ReadonlyMap<string, MeasuredBlock>,
): boolean {
  let parentId = candidate.containerId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    if (parentId === containerId) {
      return true;
    }
    visited.add(parentId);
    parentId = measuredBlocks.get(parentId)?.containerId;
  }
  return false;
}

/**
 * Break offsets for a non-box block split into clipped fragments: the bottoms of
 * its measured text line boxes, so a slice falls between lines rather than through
 * the middle of one.
 */
export function getBlockFragmentBreakOffsetsFromMeasured(measured: MeasuredBlock | undefined): number[] | undefined {
  const measuredHeight = measured?.height ?? 0;
  if (!measured?.lines || measured.lines.length === 0 || measuredHeight <= 0) {
    return undefined;
  }
  const lineOffsets = getMeasuredLineBreakOffsets(measured.lines, measured.top)
    .filter((offset) => offset > 0.5 && offset < measuredHeight - 0.5);
  return mergeBoxFragmentBreakOffsets(lineOffsets, undefined, measuredHeight);
}

export function getBlockFragmentBreakOffsetsFromElement(
  element: HTMLElement | undefined,
  zoomFactor: number,
): number[] | undefined {
  if (!element || !element.ownerDocument) {
    return undefined;
  }
  const rootRect = element.getBoundingClientRect();
  const measuredHeight = rootRect.height / zoomFactor;
  const lineOffsets = getMeasuredLineBreakOffsets(
    measureElementLineBoxes(element, rootRect, 1 / zoomFactor, 1 / zoomFactor),
  );
  return mergeBoxFragmentBreakOffsets(lineOffsets, undefined, measuredHeight);
}

export function getBoxFragmentBreakOffsetsFromElement(
  block: BoxBlockNode,
  element: HTMLElement | undefined,
  zoomFactor: number,
): number[] | undefined {
  if (!element) {
    return getNotebookRingBreakOffsets(block, 0);
  }

  const rootRect = element.getBoundingClientRect();
  const measuredHeight = rootRect.height / zoomFactor;
  const childOffsets = Array.from(element.querySelectorAll<HTMLElement>(":scope > .sigma-doc-box-body > [data-sigma-doc-id]"))
    .map((child) => {
      const rect = child.getBoundingClientRect();
      return (rect.bottom - rootRect.top) / zoomFactor;
    });
  const descendants = Array.from(element.querySelectorAll<HTMLElement>(
    ".sigma-doc-box-body [data-sigma-doc-id]",
  ));
  const leafDescendants = descendants.filter((candidate) =>
    !descendants.some((other) => other !== candidate && candidate.contains(other)),
  );
  const lineOffsets = element.ownerDocument
    ? getMeasuredLineBreakOffsets(
      leafDescendants.flatMap((child) =>
        measureElementLineBoxes(child, rootRect, 1 / zoomFactor, 1 / zoomFactor),
      ),
    )
    : [];
  // Child bottoms preserve semantic block boundaries, while line bottoms let a
  // single long paragraph/code child continue without being cut mid-line.
  return mergeBoxFragmentBreakOffsets(
    [...childOffsets, ...lineOffsets],
    getNotebookRingBreakOffsets(block, measuredHeight),
    measuredHeight,
  );
}

/** Prefer measured content boundaries and retain decoration geometry only as an
 * initial-render fallback. Both inputs are candidates, never forced page breaks. */
function mergeBoxFragmentBreakOffsets(
  primaryOffsets: number[],
  fallbackDecorationOffsets: number[] | undefined,
  totalHeight: number,
): number[] | undefined {
  // Measured visual-line boundaries always win. Decoration geometry (notebook
  // rings) is useful only while text has not been measured; choosing it over
  // the lines can put a page edge straight through a glyph.
  const sourceOffsets = primaryOffsets.length > 0
    ? primaryOffsets
    : fallbackDecorationOffsets ?? [];
  const offsets = sourceOffsets
    .filter((offset) => Number.isFinite(offset) && offset > 0.5 && offset < totalHeight - 0.5)
    .sort((a, b) => a - b);
  return offsets.length > 0 ? Array.from(new Set(offsets.map((offset) => Math.round(offset)))) : undefined;
}

function getNotebookRingBreakOffsets(block: BoxBlockNode, totalHeight: number): number[] | undefined {
  if (totalHeight <= 0) {
    return undefined;
  }

  const frame = resolveBoxFrame(block);
  const notebookRules = findBoxDecoration(frame, "notebookRules");
  if (!notebookRules) {
    return undefined;
  }

  const ringGap = notebookRules.ringGapPx ?? 23.35;
  const ringTop = notebookRules.ringTopPx ?? 8;
  const ringHeight = notebookRules.ringHeightPx ?? 12;
  if (ringGap <= 0 || ringHeight <= 0) {
    return undefined;
  }

  const offsets: number[] = [];
  for (let bottom = ringTop + ringHeight; bottom < totalHeight - 0.5; bottom += ringGap) {
    offsets.push(bottom);
  }
  return offsets;
}
