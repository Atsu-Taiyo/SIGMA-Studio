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

export function roundTextFlowColumnBlockLayout(
  layout: TextFlowColumnBlockLayout,
): TextFlowColumnBlockLayout {
  return {
    x: Math.round(layout.x),
    y: Math.round(layout.y),
    width: Math.round(layout.width),
  };
}
