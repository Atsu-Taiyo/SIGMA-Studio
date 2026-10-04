import type { ReactNode } from "react";

import type { TextFlowChangeDecorationState } from "@/components/tiptap/change-decoration";
import type { MeasuredBlock } from "@/components/editor/overlay-canvas/anchor";
import type { OverlayAsset, OverlayShape } from "@/components/editor/overlay-canvas/types";
import type { OverlaySelectionSummary } from "@/components/editor/page-overlay-types";
import type { OverlayPoint, SigmaCommentAnchor, SigmaDocument } from "@/features/document";

import type { SelectionActionPopoverPosition } from "./popover-anchors";

/** A feature-owned element inserted immediately after a body block. */
export interface PageCanvasInlineContent {
  key: string;
  content: ReactNode;
}

/** Read-only shape state rendered over the persisted overlay view. */
export interface PageCanvasGhostShape {
  key: string;
  shape: OverlayShape;
  assets: Record<string, OverlayAsset>;
  className: string;
}

export interface PageCanvasOverlayPresentationContext {
  overlayShapes: OverlayShape[];
  overlayAssets: Record<string, OverlayAsset>;
  blockRects: Map<string, MeasuredBlock>;
  blockGaps: Record<string, number>;
  contentWidthPx: number;
  pageWidthPx: number;
  pageHeightPx: number;
}

export interface PageCanvasOverlayPresentation {
  ghostShapes?: readonly PageCanvasGhostShape[];
  floatingContent?: ReactNode;
}

export type PageCanvasSelectionSource =
  | {
      kind: "textRange";
      targetId: string;
      selectedText: string;
      mathTex: string[];
      textRange?: Extract<SigmaCommentAnchor, { type: "textRange" }>;
    }
  | {
      kind: "inlineMath";
      targetId: string;
      mathInlineId: string;
      tex: string;
    }
  | {
      kind: "block";
      targetId: string | null;
    }
  | {
      kind: "overlaySelection";
      targetId: string | null;
      selection: OverlaySelectionSummary;
    };

/**
 * Opaque selection action supplied by a host feature. The page editor owns
 * selection measurement; the feature owns meaning, copy, iconography and the
 * resulting side effect.
 */
export interface PageCanvasSelectionAction {
  key: string;
  render: (position: SelectionActionPopoverPosition) => ReactNode;
  notifyCandidate?: () => void;
}

export interface PageCanvasSelectionExtension {
  createAction: (source: PageCanvasSelectionSource) => PageCanvasSelectionAction | null;
  clearCandidate?: () => void;
  retainCandidateOnTextSelectionClear?: boolean;
}

/** 紙面へドロップされた場所。紙面の座標へ直せない場所 (余白の外など) では `pagePoint` が null。 */
export interface PageCanvasDropLocation {
  clientX: number;
  clientY: number;
  /** ホワイトボードはカメラ (パン・ズーム) を引いた座標、紙は用紙上の座標。 */
  pagePoint: OverlayPoint | null;
}

/**
 * 紙面の外 (ポケットなど) から運ばれてきたドラッグを受ける、機能側の受け口。
 * 紙面は座標の変換だけを持ち、何をドロップとみなすか・何が起きるかは機能が決める。
 */
export interface PageCanvasExternalDrop {
  accepts: (dataTransfer: DataTransfer) => boolean;
  drop: (dataTransfer: DataTransfer, location: PageCanvasDropLocation) => void;
}

export interface PageCanvasLayerContext {
  document: SigmaDocument;
  blockRects: Map<string, MeasuredBlock>;
  inlineContentTargetIds: ReadonlySet<string>;
  canvasElement: HTMLElement | null;
}

export interface PageCanvasEditorExtension {
  inlineContentByTargetId?: ReadonlyMap<string, readonly PageCanvasInlineContent[]>;
  textFlowChangeDecorationState?: TextFlowChangeDecorationState;
  overlayShapeClassNames?: ReadonlyMap<string, string>;
  resolveOverlayPresentation?: (
    context: PageCanvasOverlayPresentationContext,
  ) => PageCanvasOverlayPresentation;
  columnAnchor?: {
    className?: string;
    keyPrefix?: string;
    getDataAttributes?: (targetId: string) => Record<`data-${string}`, string>;
  };
  selection?: PageCanvasSelectionExtension;
  renderCanvasLayer?: (context: PageCanvasLayerContext) => ReactNode;
  portal?: {
    className?: string;
    onReady?: (element: HTMLElement | null) => void;
  };
}
