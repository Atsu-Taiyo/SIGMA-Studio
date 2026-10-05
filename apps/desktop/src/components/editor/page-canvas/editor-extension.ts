import type { ReactNode } from "react";

import type { TextFlowChangeDecorationState } from "@/components/tiptap/change-decoration";
import type { MeasuredBlock } from "@/components/editor/overlay-canvas/anchor";
import type { OverlayAsset, OverlayShape } from "@/components/editor/overlay-canvas/types";
import type { OverlaySelectionSummary } from "@/components/editor/page-overlay-types";
import type { OverlayPoint, SigmaCommentAnchor, SigmaDocument } from "@/features/document";

import type { SelectionActionPopoverPosition } from "./popover-anchors";

/**
 * A feature-owned element inserted immediately after a body block (a flow extension node).
 *
 * 紙面はこれを本文と同じ行としてページ割りに載せる: 段の幅で自然配置に置いて測り、ページ・段の
 * 境目に当たれば行の間で切って、続きを次のページに描く。
 * - 対象は境界の最上位ブロック。入れ子の対象 (箱・引用・リストの中) はそれを含む最上位ブロックの後ろ。
 *   問題の id を対象にすると、その問題の最後のエリアの後ろ。
 * - 矩形 (border box) は見える縁として最初と最後の行に付く。見えない余白は margin で取る
 *   (最上位の要素の外側の margin は矩形に入らない)。
 * - 続き (2 ページ目以降の帯) は同じ `content` をもう一度描いた複製で、`inert` かつ支援技術から隠す。
 *   操作は最初の帯にだけ置き、表示の状態は `content` の外 (props) に持つ。中身は
 *   `useIsFlowExtensionReplica()` (`flow-extension-replica.ts`) で複製として描かれているかを知る。
 */
export interface PageCanvasInlineContent {
  /** ページ全体で一意。拡張ノードの id (`getFlowExtensionNodeId`) と React の key になる。 */
  key: string;
  content: ReactNode;
  /**
   * 中身の版。高さが変わらない内容の変化 (行の位置だけが変わる) はこれを変えて知らせる。
   * 省略時は、高さが同じなら行を測り直さない。
   */
  measureRevision?: string;
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
  /** 1 ページの高さ。ページの無いホワイトボードでは図形の層の面全体の高さ。 */
  pageHeightPx: number;
  /**
   * 図形の選択の操作 (選択ポップオーバーと回転ハンドル) が占める矩形 (紙面の座標)。図形の選択
   * ポップオーバーが出ていないときは `null`。紙面に浮かべる部品はこれを覆わない
   * (`getOverlaySelectionControlsCanvasRect`)。
   */
  selectionControlsRect: { x: number; y: number; w: number; h: number } | null;
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
  selection?: PageCanvasSelectionExtension;
  renderCanvasLayer?: (context: PageCanvasLayerContext) => ReactNode;
  portal?: {
    className?: string;
    onReady?: (element: HTMLElement | null) => void;
  };
}
