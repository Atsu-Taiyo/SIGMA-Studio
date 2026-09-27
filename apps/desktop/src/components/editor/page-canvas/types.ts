import type {
  LayoutSectionNode,
  PageLayout,
  ProblemAreaKind,
  ProblemNode,
  SigmaBlock,
} from "@/features/document";
import type { CaretFragmentPlacement, TextFlowColumnBlockLayout } from "@/features/rendering/core";
import type { TextFlowBlock } from "@/features/text-editing";

export type RenderUnit =
  | {
      type: "textFlow";
      id: string;
      /** React identity survives removal of the first block; id remains the measurement anchor. */
      renderKey?: string;
      blocks: TextFlowBlock[];
      headingNumbers?: Readonly<Record<string, string>>;
    }
  | {
      type: "problemArea";
      id: string;
      problem: ProblemNode;
      area: ProblemAreaKind;
      blocks: TextFlowBlock[];
      problemNumber?: number;
      isFirstProblemArea: boolean;
      isLastProblemArea: boolean;
      /** 同じ semantic area を構成する render unit の中で先頭か。 */
      isFirstProblemAreaUnit: boolean;
      /** 同じ semantic area を構成する render unit の総数。 */
      problemAreaUnitCount: number;
      isFirstProblemFrameArea: boolean;
      isLastProblemFrameArea: boolean;
    }
  | {
      type: "layoutSection";
      id: string;
      section: LayoutSectionNode;
      blocks: TextFlowBlock[];
      headingNumbers?: Readonly<Record<string, string>>;
    }
  | {
      type: "problemLayoutSection";
      id: string;
      section: LayoutSectionNode;
      blocks: TextFlowBlock[];
      headingNumbers?: Readonly<Record<string, string>>;
      problem: ProblemNode;
      area: ProblemAreaKind;
      problemNumber?: number;
      isFirstProblemArea: boolean;
      isLastProblemArea: boolean;
      isFirstProblemAreaUnit: boolean;
      problemAreaUnitCount: number;
      isFirstProblemFrameArea: boolean;
      isLastProblemFrameArea: boolean;
      showAreaSideNote: boolean;
    }
  | {
      type: "block";
      id: string;
      block: SigmaBlock;
    };

export interface FlowUnitLayout {
  x: number;
  y: number;
  width: number;
  height?: number;
}

/**
 * Layout for a problem-area whose internal columns continue across page
 * boundaries (single-page-column flow). When present, the area renders with
 * absolute per-block placement instead of CSS multicol balance.
 */
export interface ProblemAreaColumnLayout {
  blockLayouts: Record<string, TextFlowColumnBlockLayout>;
  markerLayouts: Record<string, TextFlowColumnBlockLayout>;
  totalHeightPx: number;
  columnWidthPx: number;
  columnGapPx: number;
}

/**
 * A visual "piece" of a framed problem area's border, positioned relative to the
 * area's own render-unit origin. When a framed area is split by a manual break
 * (see isProblemAreaColumnBlockFlowEligible), its blocks are placed individually
 * and the border can no longer be a single CSS box around the whole unit — each
 * page/column segment the blocks land in gets its own fragment rect instead, so
 * the frame can be drawn as open-ended pieces across the break (first draws the
 * top edge, last draws the bottom edge, middles draw sides only).
 */
export interface ProblemAreaFrameFragmentLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 切れ目の辺 (上下) を開くか。配置エンジンの枠片だけが持つ。 */
  openTop?: boolean;
  openBottom?: boolean;
}

/**
 * 断片の矩形。`fragmentIndex` / `sourceOffsetY` / `height` は「どの断片がブロックのどの帯を
 * 見せているか」そのものなので、面を決める純関数と同じ型を共有する。
 */
export interface EditorBoxBlockFragmentLayout extends CaretFragmentPlacement {
  blockId: string;
  x: number;
  y: number;
  width: number;
  totalHeight: number;
}

export type RunningRegionKind = "header" | "footer";
export type RunningRegionEdge = "start" | "end";
export type PageMarginEdge = "left" | "right";

export interface RunningRegionDragState {
  kind: RunningRegionKind;
  edge: RunningRegionEdge;
  startClientY: number;
  startTopMm: number;
  startBottomMm: number;
  baseLayout: PageLayout;
}

export interface PageMarginDragState {
  edge: PageMarginEdge;
  startClientX: number;
  startLeftMm: number;
  startRightMm: number;
  baseLayout: PageLayout;
}
