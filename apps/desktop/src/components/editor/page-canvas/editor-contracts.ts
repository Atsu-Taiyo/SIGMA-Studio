import { type CommentThreadsPanelProps } from "@/components/editor/CommentThreadsPanel";
import { type EditorExtensionContextValue } from "@/components/editor/editor-extension-context";
import {
  type TextFlowBodyBlockCommandRequest,
  type TextFlowChangeContext,
  type TextFlowHeadingCommandRequest,
  type TextFlowMaterialInsertRequest,
  type TextFlowProblemCommandRequest,
  type TextFlowReplaceOptions,
} from "@/components/editor/TextFlowEditor";
import {
  type PageLayout,
  type PageOverlay,
  type ProblemAreaBlock,
  type ProblemAreaKind,
  type RichBlock,
  type SigmaBlock,
  type SigmaCommentAnchor,
  type SigmaCommentThread,
  type SigmaDocument,
} from "@/features/document";
import { type TextFlowBlock } from "@/features/text-editing";
import { type BlockDragMoveRequest } from "@/lib/block-drag-move";
import type { MaterialItem } from "@/types/material";
import { type MeasuredBlock } from "../overlay-canvas/anchor";
import type { OverlayPoint,OverlayTool } from "../overlay-canvas/types";
import type {
  OverlayActionRequest,
  OverlayArrangeAction,
  OverlayChangeOptions,
  OverlayCommandRequest,
  OverlayImageRequest,
  OverlayModeStatus,
  OverlaySelectionSummary,
  PageLayoutChangeOptions,
} from "../page-overlay-types";
import { type TopLevelBlockBox } from "./block-affordances";
import type {
  PageCanvasEditorExtension,
  PageCanvasSelectionAction,
  PageCanvasSelectionExtension,
} from "./editor-extension";

export interface PageCanvasEditorProps {
  document: SigmaDocument;
  selectedId: string | null;
  selectedInlineMath: { id: string; tex: string; blockId?: string } | null;
  commentThreads?: SigmaCommentThread[];
  activeCommentThreadId?: string | null;
  highlightedCommentThreadId?: string | null;
  showComments?: boolean;
  commentPanel?: Omit<CommentThreadsPanelProps, "document" | "candidateTop" | "panelHeight" | "pendingTop" | "threadPositions">;
  overlaySelection: OverlaySelectionSummary;
  overlayCommentAnchor?: SigmaCommentAnchor | null;
  /**
   * 描画されたページ総数が変わったときの通知。
   *
   * 真値は `layoutViewState.pageCount` だけで、EditorShell はこれを持っていない。
   * DOM の `data-page-count` から読み戻すのは派生の逆流なので prop で上げる。
   */
  onPageCountChange?: (pageCount: number) => void;
  /** Reports the current DOM-measured body geometry for destructive paper conversion. */
  onMeasuredBlockRectsChange?: (blockRects: ReadonlyMap<string, MeasuredBlock>) => void;
  /**
   * 本文を覆う面（Word風の Backstage など）が出ている間 true。
   *
   * ここが window の **capture** リスナーなのが効いていて、覆っている側が window
   * capture で stopPropagation() しても、同じ window に付いた別の capture リスナーは
   * 止まらない（止められるのは stopImmediatePropagation だけで、それは他人の
   * リスナーを巻き添えにする）。`inert` も window レベルのリスナーには効かない。
   * したがって EditorShell の handleCommandShortcut / handleInlineShortcut と同じく、
   * フラグを受け取って自分で降りる必要がある。
   */
  shortcutsSuppressed?: boolean;
  /** Optional desktop features composed around the reusable page editor. */
  editorExtensions?: EditorExtensionContextValue;
  /** Optional feature presentation layered into the reusable page editor. */
  pageExtension?: PageCanvasEditorExtension;
  fontSize: number;
  zoom: number;
  whiteboardPanX?: number;
  whiteboardPanY?: number;
  /** 錨の基準になる `.whiteboard-page-canvas` を EditorShell へ渡す。 */
  onWhiteboardViewportChange?: (element: HTMLDivElement | null) => void;
  /** パンは差分で渡す。絶対値だと 1 フレームに複数回動いたとき古い値へ足し込んでしまう。 */
  onWhiteboardPanBy?: (dx: number, dy: number) => void;
  /**
   * 倍率の変更を EditorShell へ委ねる。クランプも錨もあちらの `applyZoom` が持つので、
   * ここでは「いくつにしたいか」だけを渡す (二重にクランプしない)。リボンの ± と同じく
   * 更新関数で渡せるので、再レンダー前に 2 回押しても 1 段ぶん落ちない。
   */
  onWhiteboardZoomRequest?: (nextZoom: number | ((current: number) => number)) => void;
  onWhiteboardCameraReset?: () => void;
  historyRevision: number;
  onSelect: (blockId: string | null) => void;
  onChange: (
    blockId: string,
    updater: (block: SigmaBlock | ProblemAreaBlock) => SigmaBlock | ProblemAreaBlock,
    context?: TextFlowChangeContext,
  ) => void;
  onDelete: (blockId: string) => void;
  /** Removes body blocks wherever they live, without emptying their text first. */
  onDeleteBlocks?: (blockIds: string[]) => void;
  /** Adds an empty paragraph next to a top-level block, or at the end when the anchor is null. */
  onInsertBodyBlock?: (anchorBlockId: string | null, position: "before" | "after") => void;
  /** グリップのドラッグ (Notion 風のブロック移動・段組化)。 */
  onMoveBlocks?: (request: BlockDragMoveRequest) => void;
  /** ⌥⇧↑/↓ で前後の兄弟と入れ替える。 */
  onMoveBlocksByStep?: (unitIds: string[], direction: "up" | "down") => void;
  onCopyBlock: (blockId: string) => void;
  onPasteBlock?: (blockId: string, position: "before" | "after") => void;
  canPasteProblem?: boolean;
  onWrapBlockInColumns?: (blockIds: string[], columnCount: number) => void;
  onUnwrapColumns?: (sectionId: string) => void;
  onResizeLayoutColumns?: (sectionId: string, dividerIndex: number, leftWidth: number, rightWidth: number) => void;
  onBlockSpaceAfterChange?: (blockId: string, spaceAfterPx: number) => void;
  onDuplicate: (blockId: string) => void;
  onMove: (blockId: string, direction: "up" | "down") => void;
  onAddProblemBlock: (problemId: string, area: ProblemAreaKind, block: RichBlock) => void;
  onReplaceTextFlow: (
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    context?: TextFlowChangeContext,
    options?: TextFlowReplaceOptions,
  ) => void;
  onPageLayoutChange: (layout: PageLayout, options?: PageLayoutChangeOptions) => void;
  onOverlayChange: (overlay: PageOverlay, options?: OverlayChangeOptions) => void;
  onOverlayImagesRequest: (files: File[], point?: OverlayPoint) => void;
  materials?: MaterialItem[];
  onMaterialInsert?: (request: TextFlowMaterialInsertRequest & { origin: OverlayPoint }) => void;
  onMaterialSaveRequest?: (targetBlockId?: string | null) => void;
  onSelectionMaterialSaveRequest?: (blockIds: string[]) => void;
  onProblemCommand?: (request: TextFlowProblemCommandRequest) => boolean;
  onBodyBlockCommand?: (request: TextFlowBodyBlockCommandRequest) => boolean;
  onHeadingCommand?: (request: TextFlowHeadingCommandRequest) => boolean;
  /** Signals a content deletion so figures anchored to removed blocks can re-anchor and move up. */
  pendingDeletion: { revision: number; deletedIds: string[] } | null;
  /** Persists an automatic re-anchor without adding a separate undo entry (folds into the deletion). */
  onReanchorOverlay: (overlay: PageOverlay) => void;
  overlayCommandRequest: OverlayCommandRequest | null;
  overlayImageRequest: OverlayImageRequest | null;
  overlayActionRequest: OverlayActionRequest | null;
  overlayArrangeShortcutLabels?: Partial<Record<OverlayArrangeAction, string>>;
  onOverlayEditingChange?: (editing: boolean) => void;
  onOverlayCommandHandled: (requestId: number) => void;
  onOverlayImageHandled: (requestId: number) => void;
  onOverlayActionHandled: (requestId: number) => void;
  onOverlayModeStatusChange?: (status: OverlayModeStatus) => void;
  onOverlaySelectionSummaryChange?: (summary: OverlaySelectionSummary) => void;
  onOverlayActiveToolChange?: (tool: OverlayTool) => void;
  onRunningRegionEditingChange?: (kind: "header" | "footer" | null) => void;
  renderSelectionActions?: (anchor: SigmaCommentAnchor) => React.ReactNode;
  onCommentAnchorRequest?: (anchor: SigmaCommentAnchor) => void;
  onCommentAnchorCandidateChange?: (anchor: SigmaCommentAnchor | null) => void;
  onCommentThreadSelect?: (threadId: string) => void;
  suppressSelectionActions?: boolean;
  /**
   * 選択の近くに出す編集操作 (書式・図形の操作)。機能側の選択アクション (AI など) と並べて出す。
   * 何を並べるかは呼び出し側が決め、紙面は選択の測定と配置だけを持つ。
   */
  selectionTools?: PageCanvasSelectionExtension;
  /**
   * `"paged"` renders the canvas for output rather than for editing: every page is
   * materialized (no windowing) and the editing chrome is suppressed in CSS. The
   * geometry-producing code paths are deliberately untouched, because the PDF is a
   * clone of this DOM — see docs/pdf-parity-architecture.md.
   */
  presentation?: "edit" | "paged";
  /**
   * Whether this canvas announces the local selection to other participants of the
   * document session. Output surfaces never do; a read-only pane that only shows a
   * document next to the one being edited must not either (defaults to edit mode).
   */
  publishesSessionPresence?: boolean;
}

export interface BlockHandleSelection {
  ids: string[];
  boxes: TopLevelBlockBox[];
}

export interface ExtensionActionPopoverState {
  action: PageCanvasSelectionAction;
  position: { left: number; top: number };
}

/**
 * Measure every top-level flow block (paragraphs/headings inside text editors +
 * standalone block units) in unzoomed canvas coordinates (top includes the page
 * top margin, matching `measureBlockTops` / shape anchor resolution).
 */
/**
 * Per-block cache of intrinsic line boxes, keyed by block id. Line-box
 * measurement (`range.getClientRects()` in `measureElementLineBoxes`) is the
 * dominant per-keystroke cost on large documents — it runs for every top-level
 * block on every recompute. But a block's line layout only depends on its own
 * content, width, and zoom; typing in a sibling merely shifts its position. So
 * we store each block's line boxes RELATIVE to its own top/left and reuse them
 * whenever size and zoom are unchanged, re-offsetting by the current position
 * (which we read cheaply from `getBoundingClientRect` regardless).
 */
export interface ProblemContextMenuState {
  problemId: string;
  area: ProblemAreaKind;
  left: number;
  top: number;
  /** The clicked (or marker-owning) block id inside `area`; null in `lead` (a single block, so a manual break is meaningless there). */
  breakBlockId: string | null;
  /** Selection-aware sibling block ids for range operations, scoped to `breakBlockId`; empty when `breakBlockId` is null. */
  selectionBlockIds: string[];
  breakTargetBlockId: string | null;
  nextBreakBefore: boolean;
}

export interface BodyContextMenuState {
  blockId: string;
  /** Selection-aware sibling block ids used by range operations; always includes `blockId`. */
  selectionBlockIds: string[];
  breakTargetBlockId: string | null;
  nextBreakBefore: boolean;
  left: number;
  top: number;
}

export interface ProblemAreaResizeState {
  problemId: string;
  area: ProblemAreaKind;
  startClientY: number;
  startHeightMm: number;
}
