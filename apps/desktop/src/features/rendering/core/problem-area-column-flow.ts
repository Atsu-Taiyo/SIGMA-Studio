import type {
  BoxBlockNode,
  CodeBlockNode,
  DividerNode,
  HeadingNode,
  LayoutSectionNode,
  ListNode,
  ParagraphNode,
  QuoteBlockNode,
  SectionNode,
} from "@/features/document";
import { MM_TO_PX } from "@/features/document";
import type { CaretFragmentPlacement } from "./caret-placement";
import { isFlowBlockFragmentable, fragmentFlowBlock } from "./flow-fragmentation";

const MAX_PROBLEM_AREA_MIN_HEIGHT_SEGMENTS = 1_000;
const MAX_PROBLEM_AREA_FLOW_SEGMENTS = 1_000;
const MAX_PROBLEM_AREA_FLOW_FRAGMENTS = 1_000;

/** 文書由来の予約高を有限なページ数へ正規化する。 */
export function getSafeProblemAreaMinHeightPx(
  minHeightMm: number,
  segmentHeightPx: number,
): number {
  if (!Number.isFinite(minHeightMm) || minHeightMm <= 0) {
    return 0;
  }
  const safeSegmentHeightPx = Number.isFinite(segmentHeightPx)
    ? Math.max(1, segmentHeightPx)
    : 1;
  return Math.min(
    minHeightMm * MM_TO_PX,
    safeSegmentHeightPx * MAX_PROBLEM_AREA_MIN_HEIGHT_SEGMENTS,
  );
}

export interface TextFlowColumnBlockLayout {
  x: number;
  y: number;
  width: number;
}

/** The subset of a block's page-break hints this layer cares about. */
export interface ProblemAreaFlowEligibilityBlock {
  pagination?: {
    break?: boolean;
  };
}

/**
 * True when a block other than the area's first carries an explicit manual
 * 改ページ. (A `break` on the very first block has no page/column to break
 * away from, so it is not "inside" the area in any observable sense.)
 */
export function hasManualBreakInside(
  blocks: readonly ProblemAreaFlowEligibilityBlock[],
): boolean {
  return blocks.some((block, index) => index > 0 && block.pagination?.break === true);
}

export interface ProblemAreaFlowEligibilityInput {
  /** `areaLayout.<area>.columnSpan === "full"` for this area. */
  isFullSpan: boolean;
  /** `problem.frame?.enabled === true` AND this area is the framed one (prompt). */
  isFramedArea: boolean;
  blocks: readonly ProblemAreaFlowEligibilityBlock[];
  /** 現在の spacer / gap を除いた、非分割状態の実測高。 */
  gapFreeHeightPx?: number;
  /** 1ページまたは1段の本文高。 */
  segmentHeightPx?: number;
}

/** Measured framed areas use the same block/line flow as ordinary problem text.
 * Full-span areas retain their width transition and stay whole while they fit a
 * segment. Structural callers without measurements retain the atomic default. */
export function isProblemAreaFlowEligible({
  isFullSpan,
  isFramedArea,
  blocks,
  gapFreeHeightPx,
  segmentHeightPx,
}: ProblemAreaFlowEligibilityInput): boolean {
  const isAtomicByDefault = isFullSpan || isFramedArea;
  const isOverTall = typeof gapFreeHeightPx === "number"
    && Number.isFinite(gapFreeHeightPx)
    && typeof segmentHeightPx === "number"
    && Number.isFinite(segmentHeightPx)
    && segmentHeightPx > 0.5
    && gapFreeHeightPx > segmentHeightPx + 0.5;
  const isMeasuredFramedFlow = !isFullSpan && isFramedArea
    && typeof gapFreeHeightPx === "number" && Number.isFinite(gapFreeHeightPx)
    && typeof segmentHeightPx === "number" && Number.isFinite(segmentHeightPx) && segmentHeightPx > 0.5;
  return !isAtomicByDefault || isMeasuredFramedFlow || hasManualBreakInside(blocks) || isOverTall;
}

type ProblemAreaColumnFlowBlockType = (
  | SectionNode
  | HeadingNode
  | ParagraphNode
  | ListNode
  | QuoteBlockNode
  | CodeBlockNode
  | DividerNode
  | BoxBlockNode
  | LayoutSectionNode
)["type"] | "problem";

export interface ProblemAreaColumnFlowBlock {
  id: string;
  height: number;
  type?: ProblemAreaColumnFlowBlockType;
  break?: boolean;
  breakOffsets?: number[];
  /** 箱を現在の段で開始するのに必要な最小残高。 */
  minStartHeightPx?: number;
  /**
   * `height` のうち末尾のブロック下余白 (`spaceAfterPx`) ぶん。**収まり判定からは除き、
   * カーソル前進には含める** — 本文フローの `PaginationItem.trailingSpacePx` と同じ規約で、
   * 「余白を足したらそのブロック自身が次の段へ飛ぶ」逆挙動を避ける。
   */
  trailingSpacePx?: number;
  /** Fixed independent column. When present, blocks never flow into a neighboring column. */
  columnIndex?: number;
  columnWidthPx?: number;
  columnOffsetPx?: number;
  /** 次のブロックと同じ段に置く。組が1段に収まる場合だけ有効。 */
  keepWithNext?: boolean;
  /** ブロック自身が1段に収まる場合は分割せず次段へ送る。 */
  keepTogether?: boolean;
}

export interface ProblemAreaColumnFlowFragment extends CaretFragmentPlacement {
  /** 問題エリアシェル左上を原点とする描画座標。 */
  x: number;
  y: number;
  width: number;
}

export interface ProblemAreaColumnFlowResult {
  /** "balance": fits on the current page, use CSS multicol balance (no absolute layout). */
  /** "flow": columns continue across page boundaries via absolute per-block placement. */
  mode: "balance" | "flow";
  /** Number of page-segments the area spans (1 in balance mode). */
  segments: number;
  /** Shell height in px. In flow mode this includes the inter-page gap regions. */
  totalHeightPx: number;
  /** Per-block absolute layout relative to the shell top-left (flow mode only). */
  blockLayouts: Record<string, TextFlowColumnBlockLayout>;
  /** Per-block slices, present only when one block spans two or more segments/columns. */
  fragmentLayouts: Record<string, ProblemAreaColumnFlowFragment[]>;
  /** Per-manual-break marker layout relative to the shell top-left (flow mode only). */
  markerLayouts: Record<string, TextFlowColumnBlockLayout>;
}

/**
 * Approximates the height a CSS `column-fill: balance` multicol would settle at:
 * the smallest column height where a greedy column fill needs no more than
 * `columnCount` columns. Used only to decide whether the area fits on the current
 * page; the input heights are measured at the fixed column width.
 */
export function simulateBalancedColumnHeightPx(
  heights: number[],
  columnCount: number,
): number {
  const total = heights.reduce((sum, height) => sum + Math.max(0, height), 0);
  if (columnCount <= 1 || heights.length === 0) {
    return total;
  }

  const maxBlock = heights.reduce((max, height) => Math.max(max, Math.max(0, height)), 0);
  const colsNeeded = (cap: number): number => {
    let columns = 1;
    let cursor = 0;
    for (const height of heights) {
      const h = Math.max(0, height);
      if (cursor > 0 && cursor + h > cap + 0.5) {
        columns += 1;
        cursor = 0;
      }
      cursor += h;
    }
    return columns;
  };

  let lo = Math.max(maxBlock, total / columnCount);
  let hi = Math.max(lo, total);
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (colsNeeded(mid) <= columnCount) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

/**
 * Lays out a problem area's blocks into columns that continue across page
 * boundaries. Coordinates are relative to the area shell and include the
 * inter-page gap so the shell reserves the same physical span as the canvas.
 * Boxes always flow once they have enough room to start; other blocks split at
 * measured safe offsets only when they are taller than a complete segment.
 * The cursor resumes immediately after the final slice.
 */
export function computeProblemAreaColumnFlow(
  blocks: ProblemAreaColumnFlowBlock[],
  columnCount: number,
  columnWidthPx: number,
  columnGapPx: number,
  availableFirstHeightPx: number,
  pageContentHeightPx: number,
  pageStridePx: number,
  initialSegmentHeightsPx?: readonly number[],
): ProblemAreaColumnFlowResult {
  const heights = blocks.map((block) => Number.isFinite(block.height) ? Math.max(0, block.height) : 0);
  const fitHeights = blocks.map((block, index) => (
    Math.max(0, heights[index] - Math.max(0, block.trailingSpacePx ?? 0))
  ));
  const columns = Math.max(1, columnCount);
  const independent = blocks.some((block) => block.columnIndex !== undefined);

  if ((!independent && columns <= 1) || blocks.length === 0) {
    return {
      mode: "balance",
      segments: 1,
      totalHeightPx: heights.reduce((sum, h) => sum + h, 0),
      blockLayouts: {},
      fragmentLayouts: {},
      markerLayouts: {},
    };
  }

  if (!Number.isFinite(pageContentHeightPx) || pageContentHeightPx <= 0.5) {
    return {
      mode: "balance",
      segments: 1,
      totalHeightPx: heights.reduce((sum, height) => sum + height, 0),
      blockLayouts: {},
      fragmentLayouts: {},
      markerLayouts: {},
    };
  }

  const hasManualColumnBreak = !independent && blocks.some((block, index) => index > 0 && block.break);
  const balanced = independent
    ? Math.max(...Array.from({ length: columns }, (_, columnIndex) => blocks.reduce((sum, block, index) => (
      block.columnIndex === columnIndex ? sum + heights[index] : sum
    ), 0)))
    : simulateBalancedColumnHeightPx(heights, columns);
  if (!hasManualColumnBreak && balanced <= availableFirstHeightPx + 0.5) {
    return {
      mode: "balance",
      segments: 1,
      totalHeightPx: balanced,
      blockLayouts: {},
      fragmentLayouts: {},
      markerLayouts: {},
    };
  }

  const pageGapToContentPx = Math.max(0, pageStridePx - pageContentHeightPx);
  const segmentHeight = (segmentIndex: number) => {
    const candidate = initialSegmentHeightsPx?.[segmentIndex]
      ?? (segmentIndex === 0 ? availableFirstHeightPx : pageContentHeightPx);
    return Number.isFinite(candidate) ? Math.max(0, candidate) : 0;
  };
  // Prefix tops make fragment placement linear in the number of segments. The old
  // implementation rescanned every prior segment for every fragment.
  const segmentTopShellYs = [0];
  const segmentTopShellY = (targetIndex: number) => {
    while (segmentTopShellYs.length <= targetIndex) {
      const previousIndex = segmentTopShellYs.length - 1;
      segmentTopShellYs.push(
        segmentTopShellYs[previousIndex] + segmentHeight(previousIndex) + pageGapToContentPx,
      );
    }
    return segmentTopShellYs[targetIndex];
  };

  const blockLayouts: Record<string, TextFlowColumnBlockLayout> = {};
  const fragmentLayouts: Record<string, ProblemAreaColumnFlowFragment[]> = {};
  const markerLayouts: Record<string, TextFlowColumnBlockLayout> = {};
  const step = columnWidthPx + columnGapPx;
  if (independent) {
    const cursors = Array.from({ length: columns }, () => ({ segment: 0, y: 0 }));
    let maxSegment = 0;
    let maxBottom = 0;
    let remainingFragmentBudget = MAX_PROBLEM_AREA_FLOW_FRAGMENTS;
    const blocksByColumn = Array.from({ length: columns }, () => [] as Array<{
      block: ProblemAreaColumnFlowBlock;
      index: number;
    }>);
    blocks.forEach((block, index) => {
      const columnIndex = Math.min(columns - 1, Math.max(0, block.columnIndex ?? 0));
      blocksByColumn[columnIndex].push({ block, index });
    });

    blocksByColumn.forEach((columnBlocks, columnIndex) => {
      const cursor = cursors[columnIndex];
      const advanceSegment = () => {
        cursor.segment += 1;
        cursor.y = 0;
      };
      const advanceToUsableSegment = (): boolean => {
        for (let guard = 0; guard < MAX_PROBLEM_AREA_FLOW_SEGMENTS; guard += 1) {
          if (segmentHeight(cursor.segment) > 0.5) {
            return true;
          }
          advanceSegment();
        }
        return false;
      };

      columnBlocks.forEach(({ block, index }, columnBlockIndex) => {
        if (!advanceToUsableSegment()) {
          return;
        }
        const height = heights[index];
        const fitHeight = fitHeights[index];
        const width = block.columnWidthPx ?? columnWidthPx;
        const fragmentX = block.columnOffsetPx ?? columnIndex * step;
        const nextEntry = columnBlocks[columnBlockIndex + 1];

        if (columnBlockIndex > 0 && block.break && cursor.y > 0.5) {
          markerLayouts[block.id] = roundTextFlowColumnBlockLayout({
            x: 0,
            y: segmentTopShellY(cursor.segment) + cursor.y,
            width,
          });
          advanceSegment();
        }

        let available = segmentHeight(cursor.segment) - cursor.y;
        const keepWithNextHeight = block.keepWithNext === true
          && nextEntry
          && !nextEntry.block.break
          ? height + fitHeights[nextEntry.index]
          : 0;
        const shouldAdvanceShortFirstSegment = cursor.segment === 0
          && cursor.y <= 0.5
          && segmentHeight(cursor.segment) < pageContentHeightPx - 0.5
          && keepWithNextHeight > segmentHeight(cursor.segment) + 0.5
          && keepWithNextHeight <= pageContentHeightPx + 0.5;
        const shouldKeepWithNext = cursor.y > 0
          && keepWithNextHeight > available + 0.5
          && keepWithNextHeight <= segmentHeight(cursor.segment) + 0.5;
        const shouldKeepTogether = block.keepTogether === true
          && cursor.y > 0
          && fitHeight > available + 0.5
          && fitHeight <= Math.max(segmentHeight(cursor.segment), pageContentHeightPx) + 0.5;
        if (shouldAdvanceShortFirstSegment || shouldKeepWithNext || shouldKeepTogether) {
          advanceSegment();
        }

        available = segmentHeight(cursor.segment) - cursor.y;
        const isBox = block.type === "boxBlock";
        const isFlow = isFlowBlockFragmentable(block, fitHeight, pageContentHeightPx, block.breakOffsets);
        if (
          isBox
          && cursor.y > 0
          && fitHeight > available + 0.5
          && available < Math.max(0, block.minStartHeightPx ?? 0) - 0.5
        ) {
          advanceSegment();
        } else if (
          !isFlow
          && cursor.y > 0
          && fitHeight > available + 0.5
          && fitHeight <= Math.max(segmentHeight(cursor.segment), pageContentHeightPx) + 0.5
        ) {
          advanceSegment();
        }

        if (
          (!isFlow || block.keepTogether === true)
          && cursor.y <= 0.5
          && fitHeight > segmentHeight(cursor.segment) + 0.5
          && fitHeight <= pageContentHeightPx + 0.5
        ) {
          advanceSegment();
        }

        const shouldFragment = height > 0
          && (isBox || (isFlow && fitHeight > segmentHeight(cursor.segment) - cursor.y + 0.5));
        if (shouldFragment && remainingFragmentBudget > 0) {
          const fragments = fragmentFlowBlock({
            height, breakOffsets: block.breakOffsets,
            maxFragments: Math.min(MAX_PROBLEM_AREA_FLOW_SEGMENTS, remainingFragmentBudget),
            region: () => ({
              x: fragmentX, y: segmentTopShellY(cursor.segment) + cursor.y, width,
              available: segmentHeight(cursor.segment) - cursor.y,
              fullHeight: pageContentHeightPx,
            }),
            advance: () => {
              advanceSegment();
              return advanceToUsableSegment();
            },
            consume: (consumed) => { cursor.y += consumed; },
          }).map(roundProblemAreaColumnFlowFragment);
          remainingFragmentBudget -= fragments.length;
          for (const fragment of fragments) maxBottom = Math.max(maxBottom, fragment.y + fragment.height);

          const firstFragment = fragments[0];
          if (firstFragment) {
            blockLayouts[block.id] = roundTextFlowColumnBlockLayout({
              ...firstFragment,
              x: 0,
            });
            if (fragments.length > 1) {
              fragmentLayouts[block.id] = fragments;
            }
            maxSegment = Math.max(maxSegment, cursor.segment);
            return;
          }
        }

        const y = segmentTopShellY(cursor.segment) + cursor.y;
        blockLayouts[block.id] = roundTextFlowColumnBlockLayout({ x: 0, y, width });
        cursor.y += height;
        maxSegment = Math.max(maxSegment, cursor.segment);
        maxBottom = Math.max(maxBottom, y + height);
      });
    });
    return {
      mode: "flow",
      segments: maxSegment + 1,
      totalHeightPx: maxBottom,
      blockLayouts,
      fragmentLayouts,
      markerLayouts,
    };
  }
  let segmentIndex = 0;
  let columnIndex = 0;
  let columnCursorY = 0;
  let maxBottom = 0;
  let remainingFragmentBudget = MAX_PROBLEM_AREA_FLOW_FRAGMENTS;

  const advanceColumn = () => {
    columnIndex += 1;
    if (columnIndex >= columns) {
      segmentIndex += 1;
      columnIndex = 0;
    }
    columnCursorY = 0;
  };

  const advanceSegment = () => {
    segmentIndex += 1;
    columnIndex = 0;
    columnCursorY = 0;
  };

  const advanceToUsableSegment = (): boolean => {
    for (let guard = 0; guard < MAX_PROBLEM_AREA_FLOW_SEGMENTS; guard += 1) {
      if (segmentHeight(segmentIndex) > 0.5) {
        return true;
      }
      advanceColumn();
    }
    return false;
  };

  for (let i = 0; i < blocks.length; i += 1) {
    if (!advanceToUsableSegment()) {
      return {
        mode: "balance",
        segments: 1,
        totalHeightPx: heights.reduce((sum, blockHeight) => sum + blockHeight, 0),
        blockLayouts: {},
        fragmentLayouts: {},
        markerLayouts: {},
      };
    }
    const height = heights[i];
    const hasManualBreakBefore = i > 0 && blocks[i].break;
    if (hasManualBreakBefore && (columnCursorY > 0 || columnIndex > 0)) {
      markerLayouts[blocks[i].id] = roundTextFlowColumnBlockLayout({
        x: columnIndex * step,
        y: segmentTopShellY(segmentIndex) + columnCursorY,
        width: columnWidthPx,
      });
      advanceColumn();
    }
    let available = segmentHeight(segmentIndex) - columnCursorY;
    const keepWithNextHeight = blocks[i].keepWithNext === true
      && blocks[i + 1]
      && !blocks[i + 1].break
      ? heights[i] + fitHeights[i + 1]
      : 0;
    const shouldAdvanceShortFirstSegment = segmentIndex === 0
      && columnIndex === 0
      && columnCursorY <= 0.5
      && segmentHeight(segmentIndex) < pageContentHeightPx - 0.5
      && keepWithNextHeight > segmentHeight(segmentIndex) + 0.5
      && keepWithNextHeight <= pageContentHeightPx + 0.5;
    const shouldKeepWithNext = columnCursorY > 0
      && keepWithNextHeight > available + 0.5
      && keepWithNextHeight <= segmentHeight(segmentIndex) + 0.5;
    const shouldKeepTogether = blocks[i].keepTogether === true
      && columnCursorY > 0
      && fitHeights[i] > available + 0.5
      && fitHeights[i] <= Math.max(segmentHeight(segmentIndex), pageContentHeightPx) + 0.5;
    if (shouldAdvanceShortFirstSegment) {
      advanceSegment();
    } else if (
      shouldKeepWithNext
      || shouldKeepTogether
    ) {
      advanceColumn();
    }

    available = segmentHeight(segmentIndex) - columnCursorY;
    const isBox = blocks[i].type === "boxBlock";
    const isFlow = isFlowBlockFragmentable(blocks[i], fitHeights[i], pageContentHeightPx, blocks[i].breakOffsets);
    if (
      isBox
      && columnCursorY > 0
      && fitHeights[i] > available + 0.5
      && available < Math.max(0, blocks[i].minStartHeightPx ?? 0) - 0.5
    ) {
      advanceColumn();
    } else if (
      !isFlow
      && columnCursorY > 0
      && fitHeights[i] > available + 0.5
      && fitHeights[i] <= Math.max(segmentHeight(segmentIndex), pageContentHeightPx) + 0.5
    ) {
      advanceColumn();
    }

    if (
      (!isFlow || blocks[i].keepTogether === true)
      && columnCursorY <= 0.5
      && fitHeights[i] > segmentHeight(segmentIndex) + 0.5
      && fitHeights[i] <= pageContentHeightPx + 0.5
    ) {
      segmentIndex += 1;
      columnIndex = 0;
      columnCursorY = 0;
    }

    const shouldFragment = height > 0
      && (
        isBox
        || (isFlow && fitHeights[i] > segmentHeight(segmentIndex) - columnCursorY + 0.5)
      );
    if (shouldFragment && remainingFragmentBudget > 0) {
      const fragments = fragmentFlowBlock({
        height, breakOffsets: blocks[i].breakOffsets,
        maxFragments: Math.min(MAX_PROBLEM_AREA_FLOW_SEGMENTS, remainingFragmentBudget),
        region: () => ({
          x: columnIndex * step, y: segmentTopShellY(segmentIndex) + columnCursorY,
          width: columnWidthPx,
          available: segmentHeight(segmentIndex) - columnCursorY,
          fullHeight: pageContentHeightPx,
        }),
        advance: () => {
          advanceColumn();
          return advanceToUsableSegment();
        },
        consume: (consumed) => { columnCursorY += consumed; },
      }).map(roundProblemAreaColumnFlowFragment);
      remainingFragmentBudget -= fragments.length;
      for (const fragment of fragments) maxBottom = Math.max(maxBottom, fragment.y + fragment.height);

      const firstFragment = fragments[0];
      if (firstFragment) {
        blockLayouts[blocks[i].id] = roundTextFlowColumnBlockLayout(firstFragment);
        if (fragments.length > 1) {
          fragmentLayouts[blocks[i].id] = fragments;
        }
        continue;
      }
    }

    const layout = roundTextFlowColumnBlockLayout({
      x: columnIndex * step,
      y: segmentTopShellY(segmentIndex) + columnCursorY,
      width: columnWidthPx,
    });
    blockLayouts[blocks[i].id] = layout;
    columnCursorY += height;
    maxBottom = Math.max(maxBottom, layout.y + height);
  }

  return {
    mode: "flow",
    segments: segmentIndex + 1,
    totalHeightPx: maxBottom,
    blockLayouts,
    fragmentLayouts,
    markerLayouts,
  };
}

function roundProblemAreaColumnFlowFragment(
  fragment: ProblemAreaColumnFlowFragment,
): ProblemAreaColumnFlowFragment {
  const roundFragmentPx = (value: number) => Math.round(value * 100) / 100;
  return {
    fragmentIndex: Math.round(fragment.fragmentIndex),
    sourceOffsetY: roundFragmentPx(fragment.sourceOffsetY),
    height: roundFragmentPx(fragment.height),
    x: Math.round(fragment.x),
    y: Math.round(fragment.y),
    width: Math.round(fragment.width),
  };
}

export function roundTextFlowColumnBlockLayout(
  layout: TextFlowColumnBlockLayout,
): TextFlowColumnBlockLayout {
  return {
    x: Math.round(layout.x),
    y: Math.round(layout.y),
    width: Math.round(layout.width),
  };
}
