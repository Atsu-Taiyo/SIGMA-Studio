"use client";
import { MaterialLibraryDialogs } from "./editor-shell/material-library-dialogs";
import { useMaterialLibraryController } from "./editor-shell/use-material-library-controller";
import { useWorkspaceDocumentCommands } from "./editor-shell/use-workspace-document-commands";
import { useDocumentFileCommands } from "./editor-shell/use-document-file-commands";
import { useExternalDocumentOpen } from "./editor-shell/use-external-document-open";
import { useDesktopMenuActions } from "./editor-shell/use-desktop-menu-actions";
import { useEditorCommandRouting } from "./editor-shell/use-editor-command-routing";
import { useCommandPalette } from "./editor-shell/use-command-palette";
import { registerDocumentStorageSynchronization } from "./editor-shell/document-storage-sync";
import { useCommentActions } from "./editor-shell/use-comment-actions";
import type { DocumentStorageChangeEvent, EmbeddedEditorHost } from "./editor-shell/document-lifecycle-types";
import { registerEditorClipboardEvents } from "./editor-shell/clipboard-events";
import { type DocumentTabOpenOptions } from "./editor-shell/document-tab-commands";
import { useDocumentSaveBoundary } from "./editor-shell/use-document-save-boundary";
export type { EmbeddedEditorHost } from "./editor-shell/document-lifecycle-types";

import  {
  Loader2,
  PanelLeft,
  RotateCcw,
  X,
} from "lucide-react";
import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent, SetStateAction } from "react";
import  {
  startTransition,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { APP_READY_EVENT } from "@/components/StartupSplash";
import { AiEditPanel } from "@/components/editor/AiEditPanel";
import { AiSettingsDialog } from "@/components/editor/AiSettingsDialog";
import { AiTaskDock } from "@/components/editor/AiTaskDock";
import { ChartSettingsPanel } from "@/components/editor/ChartSettingsPanel";
import { CommandPalette } from "@/components/editor/CommandPalette";
import { CommandSettingsDialog } from "@/components/editor/CommandSettingsDialog";
import { CommentDock } from "@/components/editor/CommentDock";
import type { CommentPanelAuthor } from "@/components/editor/CommentThreadsPanel";
import { DesktopSettingsModal } from "@/components/editor/DesktopSettingsModal";
import { DocumentLibraryDialog } from "@/components/editor/DocumentLibraryDialog";
import { DocumentOpenFailurePanel } from "@/components/editor/DocumentOpenFailurePanel";
import { DocumentTextCopyDialog, DocumentTextImportDialog } from "@/components/editor/DocumentTextTransferDialog";
import  {
  OPEN_OVERLAY_CHART_SETTINGS_EVENT,
  OPEN_OVERLAY_GRAPH_SETTINGS_EVENT,
  SELECT_OVERLAY_CHART_EVENT,
  SELECT_OVERLAY_GRAPH_EVENT,
  type SelectedInlineMath,
  type SelectedOverlayChart,
  type SelectedOverlayGraph,
} from "@/components/editor/EditorSettings";
import { Graph3DSettingsPanelHost, OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT } from "@/components/editor/Graph3DSettingsPanel";
import { GraphSettingsPanel } from "@/components/editor/GraphSettingsPanel";
import { viewportToCanvasAnchor } from "@/components/editor/PageCanvasEditor";
import { PageSettingsDialog } from "@/components/editor/PageSettingsDialog";
import { TexCommandReferenceDialog } from "@/components/editor/TexCommandReferenceDialog";
import { TexEnvironmentSettingsDialog } from "@/components/editor/TexEnvironmentSettingsDialog";
import { VersionHistoryPanel } from "@/components/editor/VersionHistoryPanel";
import { WindowCloseSaveDialog } from "@/components/editor/WindowCloseSaveDialog";
import  {
  AI_INLINE_ANCHOR_OFFSET_Y,
} from "@/components/editor/ai-inline-placement";
import { HeldBodySelectionOverlay } from "@/components/editor/editor-shell/HeldBodySelectionOverlay";
import type { EditorChromeValue } from "@/components/editor/editor-shell/chrome/chrome-types";
import { renderEditorChrome } from "@/components/editor/editor-shell/chrome/editor-chrome";
import { NO_COLUMN_COMMAND, resolveColumnCommandState } from "@/components/editor/editor-shell/chrome/layout-commands";
import type { BackstageSectionId } from "@/components/editor/editor-shell/chrome/ribbon-backstage";
import  {
  closeBackstage as closeBackstageState,
  DEFAULT_BACKSTAGE_STATE,
  resolveBackstageStateForLayout,
  ribbonBackstagePanelId,
  selectBackstageSection as selectBackstageSectionState,
  toggleBackstage as toggleBackstageState,
} from "@/components/editor/editor-shell/chrome/ribbon-backstage";
import type { RibbonCollapseState, RibbonPanelTabId } from "@/components/editor/editor-shell/chrome/ribbon-tabs";
import  {
  closeRibbonOverlay,
  DEFAULT_RIBBON_TAB_STATE,
  resolveRibbonTabState,
  resolveTabClickWhileCollapsed,
  ribbonTabElementId,
  selectRibbonTab as selectRibbonTabState,
  toggleRibbonCollapse as toggleRibbonCollapseState,
} from "@/components/editor/editor-shell/chrome/ribbon-tabs";
import  {
  BASE_EDITOR_FONT_SIZE,
  BASE_EDITOR_LINE_HEIGHT,
  BASE_EDITOR_TEXT_COLOR,
  DEFAULT_FONT_FAMILY_VALUE,
  DEFAULT_OUTLINE_WIDTH,
  EMPTY_OVERLAY_SELECTION,
  filterFontFamilyGroups,
  FONT_FAMILY_OPTION_VALUES,
  FONT_FAMILY_OPTIONS,
  FORMAT_TEXT_EVENT,
  INSERT_INLINE_MATH_EVENT,
  MAX_DOCUMENT_HISTORY,
  MAX_OUTLINE_WIDTH,
  MIN_EDITOR_WIDTH_WHILE_RESIZING_OUTLINE,
  MIN_OUTLINE_WIDTH,
  PAGE_NAVIGATOR_MAX_SCALE,
  PAGE_NAVIGATOR_MIN_SCALE,
  PAGE_NAVIGATOR_PRINT_PAGE_HEIGHT_PX,
  PAGE_NAVIGATOR_PRINT_PAGE_WIDTH_PX,
  PAGE_NAVIGATOR_SCALE_GUTTER_PX,
  REPORT_ISSUE_FORM_URL,
  SEARCH_QUERY_EVENT,
  TEXT_ALIGN_OPTIONS,
  TEXT_FORMAT_STATE_EVENT,
  ZOOM_PRESETS,
} from "@/components/editor/editor-shell/constants";
import { toDocumentOpenFailure, type DocumentOpenFailure } from "@/components/editor/editor-shell/document-open-failure";
import { formatDocumentRecoveryStatus } from "@/components/editor/editor-shell/recovery-status";
import type { ColorStylePanel, DocumentChange, DocumentChangeOptions, EditorMenu } from "@/components/editor/editor-shell/types";
import { buildLineToolItems, buildShapeGallerySections, isLineToolCommand } from "@/components/editor/overlay-canvas/shape-gallery";
import type { OverlayPoint, OverlayTool } from "@/components/editor/overlay-canvas/types";
import  {
  FLUSH_OVERLAY_CHANGES_EVENT,
  type OverlayActionRequest,
  type OverlayActionRequestInput,
  type OverlayArrangeAction,
  type OverlayChangeOptions,
  type OverlayCommand,
  type OverlayCommandRequest,
  type OverlayImageRequest,
  type OverlayModeStatus,
  type OverlaySelectionStylePatch,
  type OverlaySelectionSummary,
  type PageLayoutChangeOptions,
} from "@/components/editor/page-overlay-types";
import  {
  BODY_SELECTION_SHAPES_REQUEST_EVENT,
  type BodySelectionShapesRequestDetail,
} from "@/components/editor/text-flow/body-shape-selection";
import { TEXT_FLOW_CHANGE_START_EVENT, TEXT_FLOW_SELECTION_BOOKMARK_EVENT } from "@/components/editor/text-flow/caret-bookmark-events";
import { deliverCaret, requestCaret } from "@/components/editor/text-flow/caret-router";
import { scrollElementIntoCanvasView } from "@/components/editor/text-flow/caret-scroll";
import { OVERLAY_SHAPES_PASTE_REQUEST_EVENT, type OverlayShapesPasteRequestDetail } from "@/components/editor/text-flow/text-and-shapes-clipboard";
import { isMultiEditorTextRunSpan, subscribeTextRunSpan } from "@/components/editor/text-flow/text-run-span";
import type { TextFlowChangeContext, TextFlowReplaceOptions } from "@/components/editor/text-flow/types";
import { WebMcpBridge, type WebMcpBridgeHandle } from "@/components/editor/webmcp/WebMcpBridge";
import type { WebMcpHistoryEntry } from "@/components/editor/webmcp/webmcp-history";
import { LedgerSchemaFailurePanel } from "@/components/ledger/LedgerSchemaFailurePanel";
import { PdfExportSuccessDialog } from "@/components/print/PdfExportSuccessDialog";
import { PrintPreviewPageNavigator } from "@/components/print/PrintPreview";
import  {
  PrintPreviewToolbar,
  resolveDrawerExportUnavailableReason,
  shouldOfferExternalPrintWindow,
} from "@/components/print/PrintPreviewToolbar";
import { PagedRenderSurface, type PagedRenderStateSnapshot } from "@/components/print/paged-render/PagedRenderSurface";
import { TemplateGallery } from "@/components/templates/TemplateGallery";
import { SELECT_INLINE_MATH_EVENT, updateInlineMathDraft } from "@/components/tiptap/inline-math-extension";
import { NATIVE_HISTORY_COMMAND_EVENT, type NativeHistoryCommandDetail } from "@/components/tiptap/native-history-guard";
import { resolveTextToolbarTarget } from "./editor-shell/text-toolbar-target";
import { isTextFormatTargetNodeType, type TextFormatStateContext } from "@/components/tiptap/text-format-controller";
import { QR_CODE_REQUEST_EVENT, type QrCodeRequestDetail } from "@/components/tiptap/url-detection-extension";
import { Tooltip } from "@/components/ui/Tooltip";
import  {
  AiEditorHost,
  AI_REFERENCE_TEXT_RANGE_EVENT,
  AI_SIDEBAR_WIDTH,
  aiDocumentWriteInProgressMessage,
  AiPageCanvasEditor,
  buildAppliedTurnChangesByTurnId,
  buildInsertedShapePreviewsByTurnId,
  buildRestorableProposalsByTurnId,
  buildSourceReferencesByTurnId,
  deriveAiProposalPresentation,
  deriveAiReferenceRequestPlan,
  deriveAiRunStartTransition,
  describeAiLockedTargets,
  findAiLockedTargetsTouched,
  groupMcpProposalsForPreview,
  hasAiLockedTargetsTouched,
  isAiLockedBlock,
  isAiLockedShapeSelection,
  useAiLockedTargets,
  useAiPinnedReferences,
  useAiProposalActions,
  useCommentAiRun,
  type AiEditPreviewState,
  type AiEditReference,
  type AiEditShapeOnlyPreview,
  type AiProposalApplyOutcome,
} from "@/features/ai-edit";
import  {
  diffDeletedContentIds,
  DocumentHistoryController,
  ensurePageLayout,
  expandMarginsForRunningRegions,
  getPageLayoutIssues,
  inlineNodesToPlainText,
  insertTopLevelDocumentBlocks,
  insertTopLevelDocumentBlocksBefore,
  isWhiteboardPageLayout,
  MAX_LINE_HEIGHT,
  MIN_LINE_HEIGHT,
  MIN_PAGE_BODY_HEIGHT_MM,
  normalizeLineHeight,
  normalizePageLayout,
  repairDuplicateTopLevelIds,
  stepLineHeight,
  type BoxedVariant,
  type CommentMutationPorts,
  type DocumentBlockClock,
  type DocumentBlockIdFactory,
  type InlineNode,
  type LineHeight,
  type OverlayShape,
  type PageLayout,
  type PageOverlay,
  type ProblemAreaKind,
  type RichBlock,
  type SigmaBlock,
  type SigmaCommentAnchor,
  type SigmaCommentThread,
  type SigmaDocument,
  type SigmaTextRangeCommentAnchor,
  type TextAlign,
} from "@/features/document";
import { readRenderedTextFontSize, type SelectionFontSize } from "@/components/tiptap/text-format-font-size";
import { getTextShapeFontSizePt, type MeasuredBlock } from "@/features/drawing";
import { DocumentTitleText, MathEnvironmentProvider } from "@/features/rendering/adapters/react";
import { parseDocumentTitleInlineNodes } from "@/features/rendering/core";
import  {
  convertBlockStyle,
  countTextMatches,
  findFirstBlockWithText,
  getLayoutSectionColumns,
  getLayoutSectionColumnWidths,
  insertTopLevelTextFlowBlocks,
  replaceInDocument,
  replaceTopLevelTextFlowBlocks,
  removeLeadingEmptyPageBreaks,
  setBlockSpaceAfter,
  setLayoutSectionColumnCount,
  setLayoutSectionColumns,
  updateInlineMathTexInDocument,
  type TextFlowBlock,
  type TextFlowSelectionBookmark,
} from "@/features/text-editing";
import  {
  decideAiApprovedDocument,
  trackInFlightSave,
} from "@/lib/ai-run-applier";
import { useAiConnection, useClaudeConnection, useGeminiConnection } from "@/lib/ai/ai-connection";
import { DEFAULT_CLAUDE_AI_EDIT_MODEL, DEFAULT_GEMINI_AI_EDIT_MODEL } from "@/lib/ai/ai-providers";
import { isAiRunStatusActive, useAiRunSessions } from "@/lib/ai/ai-run-session-store";
import { focusSourceReferenceInDocument, resolveSourceReferenceNavigationTarget } from "@/lib/ai/ai-source-reference-navigation";
import  {
  closeSurface,
  isInlineToggleShortcut,
  openInline,
  promoteToSidebar,
  resolveAiSurface,
  toggleSurface,
  type AiDisplayMode,
  type AiSurfaceState,
} from "@/lib/ai/ai-surface";
import { runAiEditViaDesktopRuntime } from "@/lib/ai/codex-ai-edit-client";
import { DEFAULT_AI_EDIT_MODEL, DEFAULT_AI_EDIT_REASONING_EFFORT } from "@/lib/ai/sigma-doc-edit-schema";
import { getAppRouteHref } from "@/lib/app-navigation";
import { createEmptyEditorDocument } from "@/lib/blank-document";
import { availableDocumentTitle } from "@/lib/library-ledger";
import { isPristineUntitledDocument, isUntouchedNewDocument } from "@/components/editor/editor-shell/new-document-draft";
import { moveBlocksByDrag, moveUnitsByStep, type BlockDragMoveRequest } from "@/lib/block-drag-move";
import  {
  DEFAULT_COMMENT_COLOR,
  visibleCommentThreads,
} from "@/lib/comments";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { areSigmaDocumentsEquivalent, comparableDocumentValue } from "@/lib/document-equivalence";
import  {
  DEFAULT_DOCUMENT_TITLE,
  documentTitleInputValue,
  isDocumentTitleExplicit,
  resolveDocumentTitle,
  resolveDocumentTitleContent,
} from "@/lib/document-title";
import  {
  addRichBlockToProblem,
  collectOutline,
  createBlock,
  createParagraph,
  deleteBlocksFromDocument,
  duplicateTopLevelBlock,
  ensureBodyBlockAfterProblem,
  ensureEditableBody,
  findBlock,
  findContainingLayoutSection,
  insertBlockAtSelection,
  isEmptyTopLevelTextFlowBlock,
  moveTopLevelBlock,
  removeBlockFromDocument,
  unwrapLayoutSection,
  updateBlockInDocument,
  wrapTextFlowBlocksInLayoutSection,
  type EditableBlock,
} from "@/lib/document-tree";
import type { DocumentVersion } from "@/lib/document-version-history";
import  {
  cloneDocumentBlocksForPaste,
  createDocumentBlocksClipboardPayload,
  getLocalEditorClipboardPayload,
  writeEditorPayloadToSystemClipboard,
} from "@/lib/editor-clipboard";
import  {
  detectEditorShortcutPlatform,
  findCommandByShortcut,
  loadEditorCustomCommands,
  loadEditorShortcutOverrides,
  parseEditorCustomCommands,
  parseEditorShortcutOverrides,
  saveEditorCustomCommands,
  saveEditorShortcutOverrides,
  type EditorCommandId,
  type EditorCustomCommandDefinition,
  type EditorShortcutOverrides,
} from "@/lib/editor-command-shortcuts";
import { DEFAULT_FILL_OPACITY } from "@/lib/fill-opacity";
import type { Graph2DPreset } from "@/lib/graph2d";
import { getHeadingNumberMap } from "@/lib/heading-numbering";
import  {
  createCurrentLocaleTranslator,
  createTranslator,
  getAppLocale,
  normalizeLocale,
  setAppLocale,
  type AppLocale,
  type Translate,
} from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import { createId } from "@/lib/id";
import type { LedgerSchemaFailure } from "@/lib/library-schema";
import { getSupportedOverlayImageFiles } from "@/lib/overlay-image-files";
import { countPerformanceEvent, measurePerformance } from "@/lib/performance";
import { generateQrPngFile } from "@/lib/qr-code";
import { isPersistentRuntime } from "@/lib/runtime";
import type { SigmaDocumentRecoveryIssue } from "@/lib/sigma-doc-schema";
import  {
  captureDocumentVersion,
  createDocumentFromSigmaDocument,
  createNewDocument,
  createObservedDocumentWrite,
  initializeDocumentWorkspace,
  listSavedDocuments,
  loadDocumentByFileIdWithRecovery,
  saveDocumentRecord,
  saveWorkspaceState,
  type DocumentLoadResult,
  type DocumentMetadata,
} from "@/lib/storage";
import { templateInsertContent } from "@/lib/templates";
import { useUiLayoutPreference } from "@/lib/ui-layout-preference";
import { useCustomFonts } from "@/lib/use-custom-fonts";
import { formatSigmaValidationCode } from "@/lib/validation-text";
import type { DesktopMcpEditProposalSummary, DesktopUpdateState } from "@/types/desktop";
import type { TemplateItem } from "@/types/template";
import { useStore } from "zustand";

import  {
  deliverHistoryShortcutToFocusedSurface,
  isCompositionStillActive,
  shouldEndCompositionForEvent,
} from "@/components/editor/editor-shell/command-shortcut-targets";
import  {
  areGraphSpecsEqual,
  areSelectedOverlayChartsEqual,
  areSelectedOverlayGraphsEqual,
  getDefaultDocumentSelectionId,
  sameDocumentMetadatas,
  sameOverlaySelectionSummary,
} from "@/components/editor/editor-shell/document-helpers";
import  {
  queueLatestDocumentChange,
  recordSuccessfulDocumentSave,
  syncDocumentRefWhenStateIsCurrent,
  takeLatestDocumentChange,
  type SuccessfulDocumentSave,
} from "@/components/editor/editor-shell/document-state-sync";
import  {
  isDocumentVersionRestoreContextCurrent,
  runDocumentVersionRestore,
  type DocumentVersionRestoreResult,
} from "@/components/editor/editor-shell/document-version-restore";
import  {
  captureEditorTabViewState,
  resolveEditorTabViewState,
  scheduleEditorTabViewRestore,
  type EditorTabViewState,
  type ResolvedEditorTabViewState,
} from "@/components/editor/editor-shell/editor-tab-view-state";
import { suggestedPdfFileName } from "@/components/editor/editor-shell/formatting-icons";
import { handleHeadingCommandAutoNumbering } from "@/components/editor/editor-shell/heading-command";
import { beginTablePlacementFeedback, cancelTablePlacementFeedback, trackTablePlacementPointer } from "./overlay-canvas/table-placement-feedback";
import  {
  applyOverlayGraphAxisLabelEdit,
  mergeOverlayGraphDetailWithPending,
  recordPendingOverlayGraphAxisLabelEdit,
  recordPendingOverlayGraphSpecEdit,
  type PendingOverlayGraphEdits,
} from "@/components/editor/editor-shell/overlay-graph-pending-edits";
import  {
  convertOverlayToWhiteboard,
  createOverlaySelectionCommentAnchor,
  ensureOverlayAnchorOffsets,
  getSharedOverlayLineDash,
  getSharedOverlayLineSize,
} from "@/components/editor/editor-shell/overlay-helpers";
import { getVisibleEditorPageNumber, scrollEditorCanvasToPage } from "@/components/editor/editor-shell/page-navigation";
import  {
  clampBoxedTextPaddingY,
  EMPTY_BLOCK_STYLE_TOOLBAR_STATE,
  getFontFamilyLabel,
  nextBlockStyleToolbarState,
  normalizeBoxedTextVariant,
  normalizeToolbarFontFamily,
  type BlockStyleCommandValue,
  type BlockStyleToolbarState,
} from "@/components/editor/editor-shell/toolbar-formatting";
import  {
  getScrollForZoomAnchor,
  panCamera,
  resetCamera,
  resolveNextZoom,
  resolveWheelIntent,
  WHEEL_LINE_HEIGHT_PX,
  zoomCameraAt,
} from "@/components/editor/editor-shell/whiteboard-camera";
import  {
  describeWindowCloseSkipReason,
  resolveWindowCloseOutcome,
  shouldUsePageVisibilityBoundaryEvents,
} from "@/components/editor/editor-shell/window-close-save";
import  {
  clearRequestedFileId,
  createUnsavedEditBackupTitle,
  getRequestedFileId,
  uniqueStringIds,
  type DegradedWatcherScope,
} from "@/components/editor/editor-shell/workspace-request";
import { createBlockCommentAnchor } from "@/components/editor/page-canvas/popover-anchors";
import { shouldDispatchSearchQuery } from "@/components/editor/search-query-dispatch";
import type  {
  TextFlowBodyBlockCommandRequest,
  TextFlowHeadingCommandRequest,
  TextFlowMaterialInsertRequest,
  TextFlowProblemCommandRequest,
} from "@/components/editor/text-flow/types";
import { setLatestSearchQuery } from "@/components/tiptap/search-highlight-extension";
import { createEditorStore, EditorStoreProvider, type EditorStore } from "@/features/editor-state";
import { useStableCallback } from "@/lib/react/use-stable-callback";
import { applyRememberedBoxFrame } from "@/lib/remembered-box-style";
/**
 * コメントの既定の作者。
 *
 * **参照が毎描画で変わってはいけない** — この値を依存に持つメモ化 (コメント追加・
 * 返信・リアクション・パネル props) が軒並み崩れるため。一方で表示名は言語で
 * 変わるので、`name` は getter にして**読むたびに**現在の言語で解決する。
 * 言語切り替え時に画面へ反映させるのは `commentPanelProps` の依存に入れた
 * `uiLocale` の役目。
 */
const COMMENT_AUTHOR: CommentPanelAuthor = {
  avatarUrl: null,
  get name() {
    return tEditor("shell.guest");
  },
};

/**
 * 本文編集面の文言 (`editor` namespace)。
 *
 * **`useT` ではなく呼び出し時にロケールを読む。** ステータス文言のほとんどは
 * `useCallback` の中から出るので、hook で受け取ると 40 本以上の依存配列に
 * 翻訳関数が載り、React Compiler の手動メモ化保持と噛み合わなくなる
 * (実測: lint エラーが 109 → 124 に増えた)。呼び出し時解決なら依存が増えず、
 * しかもイベント発火時点の言語で解決するので、こちらの方が意味的にも正しい。
 *
 * 画面 (JSX) から呼んだ場合も正しい言語になる: `EditorShell` は `useT` を
 * 経由してロケールストアを購読しているので、言語を切り替えれば再描画される。
 */
const editorTextCache: { locale: AppLocale | null; translate: Translate<"editor"> | null } = {
  locale: null,
  translate: null,
};

function resolveEditorTranslate(): Translate<"editor"> {
  const locale = getAppLocale();
  if (editorTextCache.locale !== locale || !editorTextCache.translate) {
    editorTextCache.locale = locale;
    editorTextCache.translate = createTranslator(locale, "editor");
  }
  return editorTextCache.translate;
}

// `TFunction` は補間の型を鍵ごとに推論するオーバーロードの塊で、可変長引数を
// そのまま通すと型が合わない。ここは「同じ引数をそのまま渡す」だけなので
// 二段キャストで包む (キーと補間の検査は呼び出し側で効いたままになる)。
const tEditor = ((key: string, options?: Record<string, unknown>) =>
  resolveEditorTranslate()(key as never, options as never)) as unknown as Translate<"editor">;

/** ワークスペース / 素材面の文言 (`workspace` namespace)。解決の仕方は `tEditor` と同じ。 */
const tWorkspace = createCurrentLocaleTranslator("workspace");

/**
 * 起動時の状態表示。**保存先がこのセッション限りのときは、その事実を先に出す。**
 * ブラウザがサイトデータを拒む (プライベートウィンドウ等) と編集自体はできてしまうので、
 * 「準備完了」とだけ出すとタブを閉じた時に黙って消える。
 */
const storageWarningOrStatus = (status: string): string =>
  isPersistentRuntime() ? status : tWorkspace("error.browserStorageUnavailable");

/** 図形 / グラフ面の文言 (`shape` namespace)。解決の仕方は `tEditor` と同じ。 */
const shapeTextCache: { locale: AppLocale | null; translate: Translate<"shape"> | null } = {
  locale: null,
  translate: null,
};

const tShape = ((key: string, options?: Record<string, unknown>) => {
  const locale = getAppLocale();
  if (shapeTextCache.locale !== locale || !shapeTextCache.translate) {
    shapeTextCache.locale = locale;
    shapeTextCache.translate = createTranslator(locale, "shape");
  }
  return shapeTextCache.translate(key as never, options as never);
}) as unknown as Translate<"shape">;
/**
 * AI 編集面の文言 (`ai` namespace)。**フックではなく module 直下**なのは、ここから
 * 呼ぶ AI ヘルパが `useMemo` / `useCallback` の中にいて、フック値を足すと依存配列が
 * 軒並み動くため (`tEditor` / `tShape` と同じ理由)。解決は呼び出し時のロケール。
 */
const tAi = createCurrentLocaleTranslator("ai");

const LINE_HEIGHT_LONG_PRESS_DELAY_MS = 400;
const LINE_HEIGHT_LONG_PRESS_INTERVAL_MS = 120;
const MCP_PROPOSAL_REFRESH_DEBOUNCE_MS = 75;
type McpProposalRefreshBatch = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
};
const COMMENT_MUTATION_PORTS: CommentMutationPorts = {
  now: () => new Date().toISOString(),
  createId,
};
const DOCUMENT_BLOCK_OPERATION_PORTS: DocumentBlockClock & DocumentBlockIdFactory = {
  now: () => new Date().toISOString(),
  createId,
};
/** 図形の無い文書でも参照が変わらないよう固定 (memo依存の無駄な再計算を避ける)。 */
const EMPTY_OVERLAY_SHAPES: OverlayShape[] = [];
/** コメントの無い文書でも参照が変わらないよう固定 (装飾更新の再 dispatch を避ける)。 */
const EMPTY_COMMENT_THREADS: SigmaCommentThread[] = [];

export interface EditorShellProps {
  embeddedHost?: EmbeddedEditorHost;
}

interface EditorHistorySelection {
  selectedId: string | null;
  textSelection: TextFlowSelectionBookmark | null;
}

/**
 * 画面 1 つ分の状態ストアを作って配るだけの薄い外側。
 *
 * **モジュール singleton にしない** — 同時に複数の文書 (別ウィンドウ・埋め込み) を開けるので、
 * ストアの寿命はこの画面の寿命に一致させる。React の外から `getState()` で同期的に読めるため、
 * 保存や CAS のように「今この瞬間の値」が要る経路も ref の二重管理なしに書ける。
 */
export function EditorShell({ embeddedHost }: EditorShellProps = {}) {
  // **毎レンダーで呼ばない。** `createEmptyEditorDocument()` は文書 1 個分を
  // 組み立てる (旧 `emptyEditorDocument` は module 定数だった)。打鍵のたびに
  // 走ると perf 予算 `typing.longTasksPerChar` を割る。
  const [editorStore] = useState(() => {
    const initialDocument = embeddedHost?.document ?? createEmptyEditorDocument();
    return createEditorStore({
      selectedId: getDefaultDocumentSelectionId(initialDocument),
      // ストアの初期値は 1 回きり (言語を切り替えたときは次のステータス更新で追いつく)。
      statusMessage: tEditor("status.ready"),
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
    });
  });

  return (
    <EditorStoreProvider store={editorStore}>
      <EditorShellBody embeddedHost={embeddedHost} editorStore={editorStore} />
    </EditorStoreProvider>
  );
}

/**
 * `target` から `boundary` までの祖先に、このホイールを実際に消化できるスクロール要素があるか。
 *
 * ホワイトボードのホイールは capture で受けて `stopPropagation()` するので、これを見ないと
 * 盤面の中に置いた `overflow: auto` の中身 (数式の TeX 入力欄など) が二度とスクロールできない。
 * 「スクロールできる」だけでなく「その向きにまだ余地がある」まで見ないと、端まで来た要素に
 * ホイールを吸われて盤面が動かせなくなる。
 */
/**
 * overlay の変更を `commitDocumentChange` のオプションへ翻訳する。
 *
 * `coalesce` は「直前へマージ」ではなく **record を丸ごとスキップ**するので、
 * 本文編集に必ず後続する従属変更 (削除後の自動再アンカー) だけに使う。単独でも起こりうる
 * クリップボード操作は `historyGroup` (コアレスキー) を共有する形にする —— キーが違えば
 * 必ず record されるので、図形だけの操作が取りこぼされない
 * (`text-flow/clipboard-history-group.ts` の宣言コメント)。
 */
export function resolveOverlayCommitOptions(
  options?: OverlayChangeOptions,
): DocumentChangeOptions | undefined {
  // **キーが優先**。両方来たときに `coalesce` を採ると `record` が丸ごとスキップされ、
  // その変更を単独では戻せなくなる —— この設計が排除しようとしている唯一の消失形そのもの。
  // 今日の混在経路はすべて `history: "record"` を要求するのでここは通らないが、
  // 順序を逆にした瞬間に静かに壊れるので、優先順位をコードで固定しておく。
  if (options?.historyGroup) {
    return { historyGroup: options.historyGroup };
  }
  return options?.history === "coalesce" ? { coalesce: true } : undefined;
}

function canScrollWithin(
  target: EventTarget | null,
  boundary: HTMLElement,
  dx: number,
  dy: number,
): boolean {
  let node = target instanceof Element ? target : null;

  while (node && node !== boundary) {
    // 先に「はみ出しているか」だけを見る。何も置いていない盤面の上をパンしている間は
    // ここで全部弾けるので、ホイール 1 発ごとに `getComputedStyle` を呼ばずに済む。
    const overflowsY = node.scrollHeight > node.clientHeight;
    const overflowsX = node.scrollWidth > node.clientWidth;
    if (!overflowsY && !overflowsX) {
      node = node.parentElement;
      continue;
    }

    const style = window.getComputedStyle(node);
    const scrollsY = overflowsY && (style.overflowY === "auto" || style.overflowY === "scroll");
    const scrollsX = overflowsX && (style.overflowX === "auto" || style.overflowX === "scroll");

    if (dy !== 0 && scrollsY && (
      dy < 0
        ? node.scrollTop > 0
        : node.scrollTop + node.clientHeight < node.scrollHeight
    )) {
      return true;
    }
    if (dx !== 0 && scrollsX && (
      dx < 0
        ? node.scrollLeft > 0
        : node.scrollLeft + node.clientWidth < node.scrollWidth
    )) {
      return true;
    }

    node = node.parentElement;
  }

  return false;
}

function EditorShellBody({ embeddedHost, editorStore }: EditorShellProps & { editorStore: EditorStore }) {
  countPerformanceEvent("EditorShell.render");
  // クロームの文言。`renderEditorChrome` は hook を呼べないので、ここで解決して
  // `chrome.shared.t` から配る。同一ロケール内では参照が変わらない。
  const t = useT("chrome");
  /**
   * **描画 (JSX) 用の翻訳関数。** イベントから出るステータス文言は `tEditor`
   * (呼び出し時にロケールを読む module 関数) を使うが、描画には使えない:
   * 静的 export の HTML は日本語で焼かれるので、最初のクライアント描画も
   * 日本語でなければハイドレーションがずれる。`useT` は `getServerAppLocale()`
   * を経由してそれを守っている (`lib/i18n/react.ts` の理由コメント参照)。
   */
  const tE = useT("editor");
  /** 図形の呼び名 (描画用)。クロームのツールバーにも出るのでハイドレーション安全な hook 版。 */
  const tShapeChrome = useT("shape");
  const tCommand = useT("command");
  const tSettings = useT("settings");
  // 同上。埋め込みホストが変わったときだけ作り直す。
  const initialDocument = useMemo(
    () => embeddedHost?.document ?? createEmptyEditorDocument(),
    [embeddedHost],
  );
  const isEmbedded = Boolean(embeddedHost);
  const embeddedHostRef = useRef(embeddedHost);
  useEffect(() => {
    embeddedHostRef.current = embeddedHost;
  }, [embeddedHost]);
  // 埋め込みホストから本文が空の文書を渡されても、最初の描画から入力できる状態で始める。
  const [document, setDocument] = useState<SigmaDocument>(() => ensureEditableBody(initialDocument).document);
  const isWhiteboardDocument = isWhiteboardPageLayout(normalizePageLayout(document.pageLayout));
  const [documentStateStamp, setDocumentStateStamp] = useState(0);
  // action だけを購読する。通常の state 更新では識別子が変わらないので再描画せず、
  // store が差し替わったときは新しい action を使う。可変 snapshot を hooks へ持ち込まない。
  const clearCommentReplyDrafts = useStore(editorStore, (state) => state.clearCommentReplyDrafts);
  const setActiveCommentThreadId = useStore(editorStore, (state) => state.setActiveCommentThreadId);
  const setCommentAnchorCandidate = useStore(editorStore, (state) => state.setCommentAnchorCandidate);
  const setCommentReplyDraft = useStore(editorStore, (state) => state.setCommentReplyDraft);
  const setHighlightedCommentThreadId = useStore(editorStore, (state) => state.setHighlightedCommentThreadId);
  const setOutlineOpen = useStore(editorStore, (state) => state.setOutlineOpen);
  const setOutlineWidth = useStore(editorStore, (state) => state.setOutlineWidth);
  const setPendingCommentAnchor = useStore(editorStore, (state) => state.setPendingCommentAnchor);
  const setSaveState = useStore(editorStore, (state) => state.setSaveState);
  const setSelectedId = useStore(editorStore, (state) => state.setSelectedId);
  const setSelectedInlineMath = useStore(editorStore, (state) => state.setSelectedInlineMath);
  const setStatusMessage = useStore(editorStore, (state) => state.setStatusMessage);
  const selectedId = useStore(editorStore, (state) => state.selectedId);
  const [degradedWatcherScopes, setDegradedWatcherScopes] = useState<DegradedWatcherScope[]>([]);
  const announceRecovery = useCallback((
    issues: SigmaDocumentRecoveryIssue[],
    recoveryBackupPath?: string,
  ) => {
    const message = formatDocumentRecoveryStatus(issues, Boolean(recoveryBackupPath), tE);
    if (!message) {
      return;
    }
    setSaveState("warning");
    setStatusMessage(message);
  }, [setSaveState, setStatusMessage, tE]);
  /** `null` = run 自身の指定なし。ツールバーは「自動」と出し、見出しの大きさを潰さない。 */
  const [textFontSize, setTextFontSize] = useState<number | null>(BASE_EDITOR_FONT_SIZE);
  const [textFontSizeMixed, setTextFontSizeMixed] = useState(false);
  const [fontSizeInput, setFontSizeInput] = useState(String(BASE_EDITOR_FONT_SIZE));
  const [boxedTextPaddingY, setBoxedTextPaddingY] = useState(0);
  const [boxedTextActive, setBoxedTextActive] = useState(false);
  // B/I/U mirror the caret: the editors publish isActive() for each mark on every
  // transaction, so the buttons light up while the caret sits inside a bold run.
  const [boldActive, setBoldActive] = useState(false);
  const [italicActive, setItalicActive] = useState(false);
  const [underlineActive, setUnderlineActive] = useState(false);
  // ブロック種別のトグル (箇条書き / 番号付き / 引用 / コード)。B/I/U と同じで、キャレットが
  // そのブロックの中にいる間ボタンが点く。
  const [blockStyleState, setBlockStyleState] = useState<BlockStyleToolbarState>(
    EMPTY_BLOCK_STYLE_TOOLBAR_STATE,
  );
  const [documentTextFormatTarget, setDocumentTextFormatTarget] = useState<TextFormatStateContext | null>(null);
  // チャンクを跨ぐ本文選択 (text-run-span) の有無。跨ぎドラッグは mousedown/mouseup の
  // ターゲットが別エディタになるため、selectedId だけではリボンの書式ボタンの enable を
  // 表しきれない場面がある (⌘A 直後など)。span が生きている間は書式適用先が確実にあるので、
  // enable 判定へ直接効かせる。同値 setState は React が bail するので、ドラッグ中の
  // span 通知が毎フレーム来ても再レンダーは跨ぎ選択の開始/終了時しか起きない。
  const [hasMultiEditorTextRunSpan, setHasMultiEditorTextRunSpan] = useState(false);
  useEffect(() => subscribeTextRunSpan(() => {
    setHasMultiEditorTextRunSpan(isMultiEditorTextRunSpan());
  }), []);
  const [boxedTextVariant, setBoxedTextVariant] = useState<BoxedVariant>("frame");
  // The toolbar variant/padding state mirrors the current selection (reset to
  // frame/0 when an unboxed range is selected), so it can't carry "last used".
  // This ref persists the last format the user applied and seeds the next insert.
  const lastBoxedFormatRef = useRef<{ paddingY: number; variant: BoxedVariant }>({ paddingY: 0, variant: "frame" });
  const zoom = useStore(editorStore, (state) => state.zoom);
  // パンは倍率と同じストアに置く (理由は EditorToolbarSlice の宣言のコメント)。
  const whiteboardPan = useStore(editorStore, (state) => state.whiteboardPan);
  // 錨の基準になるビューポート要素。PageCanvasEditor から ref 経由で受け取る。
  const whiteboardViewportRef = useRef<HTMLDivElement | null>(null);
  const handleWhiteboardViewportChange = useCallback((element: HTMLDivElement | null) => {
    whiteboardViewportRef.current = element;
  }, []);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pdfExporting, setPdfExporting] = useState(false);
  const [exportedPdfPath, setExportedPdfPath] = useState<string | null>(null);
  const [printPreviewRenderState, setPrintPreviewRenderState] = useState<PagedRenderStateSnapshot>({
    state: "pending",
    surfaceId: "",
    revision: 0,
    pageCount: 0,
    pageWidthMm: 0,
    pageHeightMm: 0,
  });
  const [pageSettingsOpen, setPageSettingsOpen] = useState(false);
  const [commandSettingsOpen, setCommandSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // パレットから設定項目を選んだとき、開いたダイアログのどこを見せるか
  // (`settings-catalog.ts` の id)。ダイアログを閉じたら捨てる。
  const [settingsFocusEntryId, setSettingsFocusEntryId] = useState<string | undefined>(undefined);
  const [texCommandReferenceOpen, setTexCommandReferenceOpen] = useState(false);
  const [texEnvironmentSettingsOpen, setTexEnvironmentSettingsOpen] = useState(false);
  const [documentListOpen, setDocumentListOpen] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(isEmbedded);
  const [ledgerFailure, setLedgerFailure] = useState<LedgerSchemaFailure | null>(null);
  const [workspaceReloadNonce, setWorkspaceReloadNonce] = useState(0);
  const [loadingFileId, setLoadingFileId] = useState<string | null>(null);
  // 教材の中身 (壊れたJSON / スキーマ違反) が原因で本文を組み立てられなかった教材。
  // その教材がアクティブな間だけ、編集キャンバスの代わりに原因と修復プロンプトを出す。
  const [documentOpenFailure, setDocumentOpenFailure] = useState<DocumentOpenFailure | null>(null);
  const documentOpenFailureRef = useRef<DocumentOpenFailure | null>(null);
  // 直前の読み込みで観測した失敗の一時置き場。開く判断をした呼び出し側だけが
  // showRecordedDocumentOpenFailure で受け取る (候補を読み飛ばす経路では捨てる)。
  const pendingDocumentOpenFailureRef = useRef<DocumentOpenFailure | null>(null);
  const [documentMetadatas, setDocumentMetadatas] = useState<DocumentMetadata[]>([]);
  const [mcpEditProposals, setMcpEditProposals] = useState<DesktopMcpEditProposalSummary[]>([]);
  // チャット turn の参照元チップ・挿入図形サムネイル用。pending プレビューとは別に
  // 全 status の proposal を保持し、適用/却下後も派生表示を turn 下に残す。
  const [mcpProposalCitations, setMcpProposalCitations] = useState<DesktopMcpEditProposalSummary[]>([]);
  const [appUpdateState, setAppUpdateState] = useState<DesktopUpdateState | null>(null);
  const [appUpdateActionBusy, setAppUpdateActionBusy] = useState(false);
  const [openFileIds, setOpenFileIds] = useState<string[]>(() => [initialDocument.docId]);
  const [activeFileId, setActiveFileId] = useState(initialDocument.docId);
  const [shortcutOverrides, setShortcutOverrides] = useState<EditorShortcutOverrides>(() => (
    getDesktopBridge()?.settings ? {} : loadEditorShortcutOverrides()
  ));
  const [customCommands, setCustomCommands] = useState<EditorCustomCommandDefinition[]>(() => (
    getDesktopBridge()?.settings ? [] : loadEditorCustomCommands()
  ));
  const [commandSettingsLoaded, setCommandSettingsLoaded] = useState(() => !getDesktopBridge()?.settings);
  const [commandSettingsError, setCommandSettingsError] = useState<string | null>(null);
  const [textColor, setTextColor] = useState("#111111");
  const [textBackgroundColor, setTextBackgroundColor] = useState<string | null>("#fff3c2");
  const [strokeColor, setStrokeColor] = useState<string | null>("#000000");
  const [fontFamily, setFontFamily] = useState(DEFAULT_FONT_FAMILY_VALUE);
  const { customFonts, reloadCustomFonts } = useCustomFonts();
  const preferredFontFamilyRef = useRef(DEFAULT_FONT_FAMILY_VALUE);
  const [lineHeight, setLineHeight] = useState<LineHeight>("1.75");
  const [lineHeightInput, setLineHeightInput] = useState("1.75");
  const [lineHeightInputError, setLineHeightInputError] = useState<string | null>(null);
  const lineHeightStepDelayTimerRef = useRef<number | null>(null);
  const lineHeightStepRepeatTimerRef = useRef<number | null>(null);
  const lineHeightStepCurrentRef = useRef<LineHeight | null>(null);
  const [lineHeightCustomOpen, setLineHeightCustomOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [templateGalleryOpen, setTemplateGalleryOpen] = useState(false);
  const [canPasteProblem, setCanPasteProblem] = useState(false);
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  const [lineToolMenuOpen, setLineToolMenuOpen] = useState(false);
  const [inlineMathMenuOpen, setInlineMathMenuOpen] = useState(false);
  const [fontFamilyMenuOpen, setFontFamilyMenuOpen] = useState(false);
  const [fontFamilyQuery, setFontFamilyQuery] = useState("");
  const [blockStyleMenuOpen, setBlockStyleMenuOpen] = useState(false);
  const [boxedTextMenuOpen, setBoxedTextMenuOpen] = useState(false);
  const [lineHeightMenuOpen, setLineHeightMenuOpen] = useState(false);
  const [textAlignMenuOpen, setTextAlignMenuOpen] = useState(false);
  const [orderedListMenuOpen, setOrderedListMenuOpen] = useState(false);
  const [moreBlocksMenuOpen, setMoreBlocksMenuOpen] = useState(false);
  const [lineDashMenuOpen, setLineDashMenuOpen] = useState(false);
  const [lineWidthMenuOpen, setLineWidthMenuOpen] = useState(false);
  const [colorStylePanel, setColorStylePanel] = useState<ColorStylePanel>(null);
  const [lineEndpointMenu, setLineEndpointMenu] = useState<"start" | "end" | null>(null);
  const [activeMenu, setActiveMenu] = useState<EditorMenu>(null);
  const [newDocMenuOpen, setNewDocMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  /** 直近に検索ハイライトへ通知した検索語 (未通知なら null)。 */
  const lastDispatchedSearchQueryRef = useRef<string | null>(null);
  const [replaceText, setReplaceText] = useState("");
  const outlineOpen = useStore(editorStore, (state) => state.outlineOpen);
  const outlineWidth = useStore(editorStore, (state) => state.outlineWidth);
  // 一旦、左側の印刷プレビュー（ページナビゲータ）は非表示にする。true に戻せば復活する。
  const [showPageNavigator] = useState(false);
  const [outlineDialogOpen, setOutlineDialogOpen] = useState(false);
  const [activePageNumber, setActivePageNumber] = useState(1);
  // 描画されたページ総数。真値は PageCanvasEditor の layoutViewState.pageCount だけなので
  // prop で上げてもらう（DOM の data-page-count から読み戻すのは派生の逆流）。
  const [editorPageCount, setEditorPageCount] = useState(1);
  const selectedInlineMath = useStore(editorStore, (state) => state.selectedInlineMath);
  const [selectedOverlayGraph, setSelectedOverlayGraph] = useState<SelectedOverlayGraph | null>(null);
  const [selectedOverlayChart, setSelectedOverlayChart] = useState<SelectedOverlayChart | null>(null);
  const pendingOverlayGraphEditsRef = useRef<PendingOverlayGraphEdits | null>(null);
  const recordPendingAxisLabelEdit = useCallback((
    shapeId: string,
    key: Parameters<typeof recordPendingOverlayGraphAxisLabelEdit>[2],
    edit: Parameters<typeof recordPendingOverlayGraphAxisLabelEdit>[3],
  ) => {
    pendingOverlayGraphEditsRef.current = recordPendingOverlayGraphAxisLabelEdit(
      pendingOverlayGraphEditsRef.current,
      shapeId,
      key,
      edit,
    );
  }, []);
  const recordPendingSpecEdit = useCallback((
    shapeId: string,
    spec: Parameters<typeof recordPendingOverlayGraphSpecEdit>[2],
  ) => {
    pendingOverlayGraphEditsRef.current = recordPendingOverlayGraphSpecEdit(
      pendingOverlayGraphEditsRef.current,
      shapeId,
      spec,
    );
  }, []);
  const [graphSettingsShapeId, setGraphSettingsShapeId] = useState<string | null>(null);
  const [graph3DSettingsShapeId, setGraph3DSettingsShapeId] = useState<string | null>(null);
  const graphSettingsShapeIdRef = useRef<string | null>(null);
  const [chartSettingsShapeId, setChartSettingsShapeId] = useState<string | null>(null);
  const chartSettingsShapeIdRef = useRef<string | null>(null);
  const graphSettingsShapeWasInDocumentRef = useRef(false);
  const [aiEditReference, setAiEditReference] = useState<AiEditReference | null>(null);
  // ワンドボタン「AIに追加」で明示的に積んだ参照 (複数)。本文選択だけの暗黙候補
  // (aiEditReference) とは別管理で、ブロック選択が移っても消えない。
  const {
    references: aiEditPinnedReferences,
    previews: aiEditPinnedReferencePreviews,
    clear: clearAiEditPinnedReferences,
    pin: pinAiEditPinnedReference,
    remove: removeAiPinnedReference,
    reconcileTextRanges: reconcileAiEditPinnedReferenceTextRanges,
  } = useAiPinnedReferences();
  const [aiSidebarOpen, setAiSidebarOpen] = useState(false);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [versionHistoryPreviewState, setVersionHistoryPreviewState] = useState<{
    fileId: string;
    version: DocumentVersion;
  } | null>(null);
  const versionHistoryPreview = versionHistoryPreviewState?.fileId === activeFileId
    ? versionHistoryPreviewState.version
    : null;
  const versionHistoryPreviewActive = versionHistoryPreview !== null;
  const [versionHistoryRestoreError, setVersionHistoryRestoreError] = useState<string | null>(null);
  const [versionHistoryRestoring, setVersionHistoryRestoring] = useState(false);
  const [versionHistoryWarnings, setVersionHistoryWarnings] = useState<Record<string, string>>({});
  const [windowCloseSaveDialog, setWindowCloseSaveDialog] = useState<{
    error: string;
    saving: boolean;
  } | null>(null);
  const windowCloseAttemptGenerationRef = useRef(0);
  const windowCloseResolvedRef = useRef(false);

  const versionHistoryWarning = versionHistoryWarnings[activeFileId] ?? null;
  const [aiDisplayMode, setAiDisplayMode] = useState<AiDisplayMode>("inline");
  const [aiInlineOpen, setAiInlineOpen] = useState(false);
  const [aiInlineAnchor, setAiInlineAnchor] = useState<{ left: number; top: number } | null>(null);
  const [aiInlineRunAnchor, setAiInlineRunAnchor] = useState<{ left: number; top: number } | null>(null);
  const [aiInlineRunAnchorCanvas, setAiInlineRunAnchorCanvas] = useState<{ left: number; top: number } | null>(null);
  const [aiInlineRunPortal, setAiInlineRunPortal] = useState<HTMLElement | null>(null);
  const pageCanvasRef = useRef<HTMLElement | null>(null);
  const measuredBodyBlockRectsRef = useRef<ReadonlyMap<string, MeasuredBlock>>(new Map());
  const captureMeasuredBodyBlockRects = useCallback((blockRects: ReadonlyMap<string, MeasuredBlock>) => {
    measuredBodyBlockRectsRef.current = blockRects;
  }, []);
  const aiInlineRunAnchorRef = useRef<{ left: number; top: number } | null>(null);
  useEffect(() => {
    aiInlineRunAnchorRef.current = aiInlineRunAnchor;
  }, [aiInlineRunAnchor]);

  const syncInlineRunAnchorCanvas = useCallback((viewportAnchor: { left: number; top: number } | null) => {
    if (!viewportAnchor || !pageCanvasRef.current) {
      setAiInlineRunAnchorCanvas(null);
      return;
    }
    setAiInlineRunAnchorCanvas(viewportToCanvasAnchor({
      left: viewportAnchor.left,
      top: viewportAnchor.top + AI_INLINE_ANCHOR_OFFSET_Y,
    }, pageCanvasRef.current));
  }, []);

  const handleInlineRunAnchorChange = useCallback((anchor: { left: number; top: number } | null) => {
    setAiInlineRunAnchor(anchor);
    syncInlineRunAnchorCanvas(anchor);
  }, [syncInlineRunAnchorCanvas]);

  useEffect(() => {
    syncInlineRunAnchorCanvas(aiInlineRunAnchor);
  }, [aiInlineRunAnchor, syncInlineRunAnchorCanvas, zoom]);

  useEffect(() => {
    if (!aiInlineRunAnchor) {
      return;
    }
    const handleViewportChange = () => syncInlineRunAnchorCanvas(aiInlineRunAnchor);
    window.addEventListener("resize", handleViewportChange);
    return () => window.removeEventListener("resize", handleViewportChange);
  }, [aiInlineRunAnchor, syncInlineRunAnchorCanvas]);

  // Stable identity so PageCanvasEditor's portal-ready effect (which fires this
  // as a cleanup/setup pair keyed on this callback) doesn't re-run on every
  // EditorShell render — an inline arrow here previously caused an infinite
  // setState(null)/setState(portal) render loop once an inline run started.
  const handleInlineRunPortalReady = useCallback((portal: HTMLElement | null) => {
    setAiInlineRunPortal(portal);
    if (portal) {
      pageCanvasRef.current = portal.closest<HTMLElement>(".page-canvas");
    } else {
      pageCanvasRef.current = null;
    }
    syncInlineRunAnchorCanvas(aiInlineRunAnchorRef.current);
  }, [syncInlineRunAnchorCanvas]);
  const [aiInlineSessionId, setAiInlineSessionId] = useState(0);
  const [aiInlineClosing, setAiInlineClosing] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const metadataByFileId = useMemo(() => {
    return new Map(documentMetadatas.map((metadata) => [metadata.fileId, metadata]));
  }, [documentMetadatas]);
  const activeDocumentMetadata = metadataByFileId.get(activeFileId);
  // useMemo (not a plain derived const) so the compiler can prove this primitive is
  // stable across renders where activeDocumentMetadata's revision didn't change;
  // otherwise the mcpProposalPreview useMemo below can't preserve its memoization.
  const activeDocumentRevision = useMemo(
    () => activeDocumentMetadata?.revision ?? null,
    [activeDocumentMetadata],
  );
  const mcpProposalPreview = useMemo(
    () => groupMcpProposalsForPreview(mcpEditProposals, activeFileId, activeDocumentRevision, tAi),
    [mcpEditProposals, activeFileId, activeDocumentRevision],
  );
  const aiRunSessions = useAiRunSessions();
  const aiProposalPresentation = useMemo(
    () => deriveAiProposalPresentation(
      mcpProposalPreview.groups,
      aiRunSessions,
      activeFileId,
      isAiRunStatusActive,
    ),
    [activeFileId, aiRunSessions, mcpProposalPreview.groups],
  );
  // AI編集のロックは対象単位。live run が握っている anchor (ユーザーが依頼時に明示的に
  // 渡したブロック/図形) と、pending提案が実際に書き換える対象だけが読み取り専用になり、
  // それ以外は人間が編集できる。他の場所への人手編集は per-block の内容ハッシュ鮮度判定で
  // 吸収されるため、提案をstaleにしない。
  // グラフのラベルはグラフの兄弟図形なので、ロック集合はラベルまで広げる (locked-targets.ts)。
  const aiLockedTargets = useAiLockedTargets(
    activeFileId,
    aiProposalPresentation.previewGroups,
    document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? EMPTY_OVERLAY_SHAPES,
  );
  // MCP プレビューの apply/dismiss の二重実行を防ぐ (承認済み提案への再実行で error 表示に
  // なるのを回避)。承認は文書を丸ごと差し替えるので、この窓だけは唯一の文書全体ロックも兼ねる
  // (途中の打鍵が黙って失われるため)。commitDocumentChange から参照するのでここで宣言する。
  const mcpPreviewBusyRef = useRef(false);
  const [mcpPreviewBusy, setMcpPreviewBusy] = useState(false);
  const aiDocumentWriteInProgress = mcpPreviewBusy;
  // AI ロック集合の最新値。`commitDocumentChange` の deps に入れると、保存のたびに動く
  // 提案プレビュー由来でその識別子が変わり、ぶら下がる全コールバック → memo 済み本文ユニット
  // 全部が描き直される。**イベント処理から呼ばれる前提**の choke point なので ref で足りる
  // (書き込み中フラグは同期更新の `mcpPreviewBusyRef` をそのまま読む)。
  const aiLockedTargetsRef = useRef(aiLockedTargets);
  useLayoutEffect(() => {
    aiLockedTargetsRef.current = aiLockedTargets;
  }, [aiLockedTargets]);
  const seenActiveAiRunIdsRef = useRef(new Set<string>());
  const seededActiveAiRunIdsRef = useRef(false);
  useEffect(() => {
    const transition = deriveAiRunStartTransition({
      sessions: aiRunSessions.values(),
      activeDocumentId: activeFileId,
      seenRunIds: seenActiveAiRunIdsRef.current,
      initialized: seededActiveAiRunIdsRef.current,
      isRunActive: isAiRunStatusActive,
    });
    seenActiveAiRunIdsRef.current = transition.seenRunIds;

    if (!seededActiveAiRunIdsRef.current) {
      // マウント時点ですでに active の run は先に記録し、以前開始した run で再マウント時の選択解除が起きないようにする。
      seededActiveAiRunIdsRef.current = true;
      return;
    }

    if (!transition.shouldClearActiveDocumentReference) {
      return;
    }

    // A microtask runs before the browser can deliver another user-input event,
    // so this still clears only the selection that existed when the run appeared.
    window.queueMicrotask(() => {
      // startRun receives a snapshot of turnReferences before publishing this
      // active session. Replacing the UI arrays cannot mutate that run payload.
      setAiEditReference(null);
      clearAiEditPinnedReferences();

      // Remove only a native selection owned by the body editor. Selection API
      // changes neither focus nor scroll, so the AI composer keeps its input focus.
      const selection = window.getSelection();
      const selectionTouchesTextFlow = [selection?.anchorNode, selection?.focusNode].some((node) => {
        const element = node instanceof Element ? node : node?.parentElement;
        return Boolean(element?.closest(".text-flow-editor"));
      });
      if (selectionTouchesTextFlow) {
        selection?.removeAllRanges();
      }
    });
  }, [activeFileId, aiRunSessions, clearAiEditPinnedReferences]);
  // 決定B: baseRevision一致の pending proposal は runId (帰属不明なら "unattributed")
  // ごとに独立したプレビュー単位になる。各グループが自分の apply/dismiss を持つ。
  // AI run が書き込みtoolを複数回呼ぶ途中では、proposal watcherが同じカードを何度も
  // 増補して見せてしまう。roomに紐づくrunが完了するまではcanvas/本文プレビューだけを
  // 抑止し、完了後に集約済みグループを一度表示する。room帰属のない外部MCP提案は、
  // 対応するrun状態を特定できないため従来どおり即時表示する。
  const aiEditPreviewGroups = aiProposalPresentation.previewGroups;
  const staleProposalGroups = mcpProposalPreview.stale;
  const resolvedMcpEditProposals = useMemo(
    () => mcpProposalCitations.filter(
      (proposal) => proposal.fileId === activeFileId && proposal.status !== "pending",
    ),
    [activeFileId, mcpProposalCitations],
  );
  // Phase 1: Agentic RAG。チャットサイドバーの各 assistant turn の下に「参照したドキュメント」
  // を出すため、turnId ごとに proposal (pending / approved / rejected / reverted すべて)
  // の sourceReferences を集約・重複排除する。適用後もチップを残すため pending 専用にしない。
  const sourceReferencesByTurnId = useMemo(
    () => buildSourceReferencesByTurnId(mcpProposalCitations),
    [mcpProposalCitations],
  );
  const insertedShapePreviewsByTurnId = useMemo(
    () => buildInsertedShapePreviewsByTurnId(
      mcpProposalCitations.filter((proposal) => proposal.fileId === activeFileId),
    ),
    [activeFileId, mcpProposalCitations],
  );
  // AIチャット履歴の各 assistant turn に「復元」ボタンを出すかどうかの判定。turnId ごとに
  // 最新の提案が rejected/reverted のときだけ復元可能 (pending/approvedのターンは対象外)。
  // 全件を渡さず最小限のMapだけをAiEditPanelへ渡す (不要な情報は表示せず、必要になった時
  // だけ追加する)。
  const restorableProposalsByTurnId = useMemo(
    () => buildRestorableProposalsByTurnId(mcpProposalCitations),
    [mcpProposalCitations],
  );
  const appliedChangesByTurnId = useMemo(
    () => buildAppliedTurnChangesByTurnId(
      mcpProposalCitations,
      activeFileId,
      activeDocumentRevision,
      document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [],
      tAi,
    ),
    [activeDocumentRevision, activeFileId, document.pageLayout?.overlay?.overlaySnapshot?.shapes, mcpProposalCitations],
  );
  const commentAnchorCandidate = useStore(editorStore, (state) => state.commentAnchorCandidate);
  const pendingCommentAnchor = useStore(editorStore, (state) => state.pendingCommentAnchor);
  const [pendingCommentDraft, setPendingCommentDraft] = useState<InlineNode[]>([]);
  const commentReplyDrafts = useStore(editorStore, (state) => state.commentReplyDrafts);
  const activeCommentThreadId = useStore(editorStore, (state) => state.activeCommentThreadId);
  const highlightedCommentThreadId = useStore(editorStore, (state) => state.highlightedCommentThreadId);
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(() => !isWhiteboardDocument);
  const [showResolvedComments, setShowResolvedComments] = useState(false);
  const commentAuthor = COMMENT_AUTHOR;
  const [overlayEditing, setOverlayEditing] = useState(false);
  const [overlayModeStatus, setOverlayModeStatus] = useState<OverlayModeStatus | null>(null);
  const [runningRegionEditingKind, setRunningRegionEditingKind] = useState<"header" | "footer" | null>(null);
  const [overlayCommandRequest, setOverlayCommandRequest] = useState<OverlayCommandRequest | null>(null);
  useEffect(trackTablePlacementPointer, []);
  useEffect(() => () => cancelTablePlacementFeedback(), [document.docId]);
  const [overlayImageRequest, setOverlayImageRequest] = useState<OverlayImageRequest | null>(null);
  const [overlayActionRequest, setOverlayActionRequest] = useState<OverlayActionRequest | null>(null);
  const [overlaySelection, setOverlaySelection] = useState<OverlaySelectionSummary>(EMPTY_OVERLAY_SELECTION);
  const [webMcpPreviewGroups, setWebMcpPreviewGroups] = useState<AiEditPreviewState[]>([]);
  const [webMcpHistory, setWebMcpHistory] = useState<WebMcpHistoryEntry[]>([]);
  const webMcpBridgeRef = useRef<WebMcpBridgeHandle | null>(null);
  const visibleAiEditPreviewGroups = useMemo(
    () => [...aiEditPreviewGroups, ...webMcpPreviewGroups],
    [aiEditPreviewGroups, webMcpPreviewGroups],
  );
  /** 常に最新の選択。state 側はシェルの見た目に関わる差分でしか進まない。 */
  const overlaySelectionRef = useRef<OverlaySelectionSummary>(EMPTY_OVERLAY_SELECTION);
  const [activeOverlayTool, setActiveOverlayTool] = useState<OverlayTool>({ kind: "select" });
  const [historyRevision, setHistoryRevision] = useState(0);
  const [documentInstanceRevision, setDocumentInstanceRevision] = useState(0);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fontFamilyButtonRef = useRef<HTMLButtonElement | null>(null);
  const blockStyleButtonRef = useRef<HTMLButtonElement | null>(null);
  const fontSizeInputRef = useRef<HTMLInputElement | null>(null);
  const textColorButtonRef = useRef<HTMLButtonElement | null>(null);
  const textBackgroundColorButtonRef = useRef<HTMLButtonElement | null>(null);
  const strokeColorButtonRef = useRef<HTMLButtonElement | null>(null);
  const fillColorButtonRef = useRef<HTMLButtonElement | null>(null);
  const lineDashButtonRef = useRef<HTMLButtonElement | null>(null);
  const lineWidthButtonRef = useRef<HTMLButtonElement | null>(null);
  const shapeMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const lineToolMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const inlineMathButtonRef = useRef<HTMLButtonElement | null>(null);
  const inlineMathMenuCloseTimeoutRef = useRef<number | null>(null);
  const searchButtonRef = useRef<HTMLButtonElement | null>(null);
  const boxedTextButtonRef = useRef<HTMLButtonElement | null>(null);
  const lineHeightButtonRef = useRef<HTMLButtonElement | null>(null);
  const textAlignButtonRef = useRef<HTMLButtonElement | null>(null);
  const orderedListMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreBlocksMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const fileMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const insertMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const aiMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const newDocButtonRef = useRef<HTMLButtonElement | null>(null);
  const newDocMenuCloseTimerRef = useRef<number | null>(null);
  const settingsMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const editorCanvasRef = useRef<HTMLElement | null>(null);
  const overlayCommandRequestIdRef = useRef(0);
  const overlayImageRequestIdRef = useRef(0);
  const overlayActionRequestIdRef = useRef(0);
  const [documentHistory] = useState(
    () => new DocumentHistoryController<SigmaDocument, EditorHistorySelection>(MAX_DOCUMENT_HISTORY),
  );
  const runShortcutCommandRef = useRef<(commandId: EditorCommandId) => void>(() => undefined);
  // Ctrl+F1 のリスナーは毎レンダー張り替えたくないので、ハンドラは ref 越しに読む
  // (runShortcutCommandRef と同じ手)。
  const toggleRibbonCollapseRef = useRef<() => void>(() => undefined);
  const documentRef = useRef(document);
  // Revision observed at the boundary where documentRef.current was adopted.
  // Metadata refreshes deliberately never mutate this value: a newer catalog
  // revision must not be attached to an older in-memory payload.
  const documentObservedRevisionRef = useRef<number | null>(null);
  const selectedIdRef = useRef(selectedId);
  const textSelectionBookmarkRef = useRef<TextFlowSelectionBookmark | null>(null);
  const pendingTextHistorySelectionRef = useRef<TextFlowSelectionBookmark | null | undefined>(undefined);
  const materialBlockSelectionRef = useRef<string | null>(null);
  // 教材タブごとの選択・キャレット・スクロール。切替で document を差し替えても戻せるようにする。
  const editorTabViewStateByFileIdRef = useRef(new Map<string, EditorTabViewState>());
  const untouchedNewDocumentsRef = useRef(new Map<string, SigmaDocument>());
  const pendingEditorTabViewRestoreRef = useRef<ResolvedEditorTabViewState | null>(null);
  const activeFileIdRef = useRef(activeFileId);
  const openFileIdsRef = useRef(openFileIds);
  const workspaceReadyRef = useRef(workspaceReady);
  const lastSavedDocumentRef = useRef<SigmaDocument>(document);
  // 「rendererが最後にディスクと同期した時点の文書」全体。lastSavedDocumentRef はdirty判定用、
  // lastSyncedDocumentRefは3-wayマージ(mergeExternalDocumentChange)のbaseとして使う実体。
  // 初回ロード・resetEditorDocument (ファイル切替/revert/外部変更の従来フォールバック)・自動保存
  // 成功・外部変更のマージ成功、のいずれの時点でも「今ディスク上にある内容」に更新する。
  const lastSyncedDocumentRef = useRef<SigmaDocument>(document);
  const documentDirtyRevisionRef = useRef(0);
  const lastSavedDirtyRevisionRef = useRef(0);
  const inFlightSavePromiseRef = useRef<Promise<unknown> | null>(null);
  const successfulDocumentSavesRef = useRef(new Map<string, SuccessfulDocumentSave<SigmaDocument>>());
  const externalChangeFileIdsRef = useRef(new Set<string>());
  const pendingActiveDocumentChangeRef = useRef<DocumentStorageChangeEvent | null>(null);
  // mainの自動承認通知の直後には、同じ保存を見たfs watcherの一般通知も届く。後者が先の
  // 非同期loadを追い越してもAI適用の履歴情報を失わないよう、active file分だけ別に保持する。
  const pendingAutoAppliedProposalIdsByFileRef = useRef(new Map<string, string[]>());
  const documentStorageChangeProcessorRef = useRef<((event: DocumentStorageChangeEvent) => void) | null>(null);
  const [autosaveRetry, setAutosaveRetry] = useState(0);
  const autosaveRetryTimerRef = useRef<number | null>(null);
  const cancelPendingAutosaveRef = useRef<() => void>(() => undefined);

  const finishMcpPreviewBusy = useCallback(() => {
    mcpPreviewBusyRef.current = false;
    setMcpPreviewBusy(false);
    const pending = takeLatestDocumentChange(pendingActiveDocumentChangeRef);
    if (pending) {
      documentStorageChangeProcessorRef.current?.(pending);
    }
  }, []);

  const dispatchDocumentStorageChange = useCallback((event: DocumentStorageChangeEvent) => {
    if (event.fileId === activeFileIdRef.current && event.autoAppliedProposalIds?.length) {
      const existing = pendingAutoAppliedProposalIdsByFileRef.current.get(event.fileId) ?? [];
      pendingAutoAppliedProposalIdsByFileRef.current.set(
        event.fileId,
        uniqueStringIds([...existing, ...event.autoAppliedProposalIds]),
      );
    }
    if (
      event.fileId === activeFileIdRef.current
      && mcpPreviewBusyRef.current
    ) {
      queueLatestDocumentChange(pendingActiveDocumentChangeRef, event);
      return;
    }
    documentStorageChangeProcessorRef.current?.(event);
  }, []);

  useEffect(() => {
    const updateSelectionBookmark = (event: Event) => {
      if (event instanceof CustomEvent) {
        textSelectionBookmarkRef.current = event.detail as TextFlowSelectionBookmark;
      }
    };
    const captureChangeStart = (event: Event) => {
      pendingTextHistorySelectionRef.current = event instanceof CustomEvent
        ? event.detail as TextFlowSelectionBookmark | null
        : null;
    };

    window.addEventListener(TEXT_FLOW_SELECTION_BOOKMARK_EVENT, updateSelectionBookmark);
    window.addEventListener(TEXT_FLOW_CHANGE_START_EVENT, captureChangeStart);
    return () => {
      window.removeEventListener(TEXT_FLOW_SELECTION_BOOKMARK_EVENT, updateSelectionBookmark);
      window.removeEventListener(TEXT_FLOW_CHANGE_START_EVENT, captureChangeStart);
    };
  }, []);
  const closeGraphSettings = useCallback(() => {
    pendingOverlayGraphEditsRef.current = null;
    graphSettingsShapeIdRef.current = null;
    graphSettingsShapeWasInDocumentRef.current = false;
    setGraphSettingsShapeId(null);
  }, []);
  const openGraphSettings = useCallback((shapeId: string) => {
    graphSettingsShapeIdRef.current = shapeId;
    graphSettingsShapeWasInDocumentRef.current = Boolean(
      documentRef.current.pageLayout?.overlay?.overlaySnapshot?.shapes.some(
        (shape) => shape.id === shapeId && shape.type === "graph2dShape",
      ),
    );
    setGraphSettingsShapeId(shapeId);
  }, []);
  const closeChartSettings = useCallback(() => {
    chartSettingsShapeIdRef.current = null;
    setChartSettingsShapeId(null);
  }, []);
  const openChartSettings = useCallback((shapeId: string) => {
    chartSettingsShapeIdRef.current = shapeId;
    setChartSettingsShapeId(shapeId);
  }, []);
  const closeGraph3DSettings = useCallback(() => {
    setGraph3DSettingsShapeId(null);
  }, []);
  const openGraph3DSettings = useCallback((shapeId: string) => {
    setGraph3DSettingsShapeId(shapeId);
  }, []);

  useEffect(() => {
    if (!graphSettingsShapeId) {
      return;
    }

    const shapeExists = Boolean(
      document.pageLayout?.overlay?.overlaySnapshot?.shapes.some(
        (shape) => shape.id === graphSettingsShapeId && shape.type === "graph2dShape",
      ),
    );
    if (shapeExists) {
      graphSettingsShapeWasInDocumentRef.current = true;
      return;
    }
    if (!graphSettingsShapeWasInDocumentRef.current) {
      return;
    }

    closeGraphSettings();
    setSelectedOverlayGraph((current) => (
      current?.shapeId === graphSettingsShapeId ? null : current
    ));
  }, [closeGraphSettings, document.pageLayout?.overlay?.overlaySnapshot?.shapes, graphSettingsShapeId]);

  const scheduleAutosaveRetry = useCallback(() => {
    if (autosaveRetryTimerRef.current !== null) {
      return;
    }
    autosaveRetryTimerRef.current = window.setTimeout(() => {
      autosaveRetryTimerRef.current = null;
      setAutosaveRetry((current) => current + 1);
    }, 300);
  }, []);
  useEffect(() => () => {
    if (autosaveRetryTimerRef.current !== null) {
      window.clearTimeout(autosaveRetryTimerRef.current);
      autosaveRetryTimerRef.current = null;
    }
  }, []);
  const [pendingDeletion, setPendingDeletion] = useState<{ revision: number; deletedIds: string[] } | null>(null);
  const deletionSeqRef = useRef(0);
  const appUpdateAutoCheckStartedRef = useRef(false);
  const isDesktopApp = useSyncExternalStore(
    useCallback(() => () => undefined, []),
    useCallback(() => Boolean(getDesktopBridge()), []),
    useCallback(() => false, []),
  );
  /** Web版 = ブラウザで直接開かれたアプリ。Electronでも埋め込みSDKでもないときだけ
   * WebMCPのツール登録とAI面 (キャンバス左上のdock) を出す。 */
  const webMcpEnabled = !isDesktopApp && !isEmbedded;
  const [desktopSettingsOpen, setDesktopSettingsOpen] = useState(false);
  const [desktopSettingsUpdateCheckRequest, setDesktopSettingsUpdateCheckRequest] = useState(0);
  /**
   * クロームのメニュー/ツールバーから「アプリ設定」を開く経路。素の setter を渡すと、
   * Help > Check for Updates… 由来の更新チェック要求が残ったままになり、普通に設定を
   * 開いただけで更新チェックが走ってしまう。開閉のたびに要求を落としておく。
   */
  const openDesktopSettingsFromChrome = useCallback((value: SetStateAction<boolean>) => {
    setDesktopSettingsUpdateCheckRequest(0);
    setDesktopSettingsOpen(value);
  }, []);
  const [storedUiLayoutPreference, updateUiLayoutPreference] = useUiLayoutPreference();
  // Word風リボンは再検討まで露出しない。保存済み設定は消さず、表示時だけ既定UIへ倒す。
  const uiLayoutPreference = useMemo(() => (
    storedUiLayoutPreference.mode === "docs"
      ? storedUiLayoutPreference
      : { ...storedUiLayoutPreference, mode: "docs" as const }
  ), [storedUiLayoutPreference]);
  const [ribbonTabState, setRibbonTabState] = useState(DEFAULT_RIBBON_TAB_STATE);
  // ファイルタブ = Backstage（編集画面を覆う全画面）。リボンのタブ状態とは混ぜない
  // ので、閉じれば自動的に「直前に自分で選んだタブ」へ戻る。
  const [ribbonBackstage, setRibbonBackstage] = useState(DEFAULT_BACKSTAGE_STATE);
  // 折りたたみは永続 (ui-layout-preference)、浮かせている状態は一時。
  // 2つを1つの純関数へ渡すために、レンダーのたびに組で作る。
  const [ribbonOverlayOpen, setRibbonOverlayOpen] = useState(false);
  const ribbonContextualWasVisibleRef = useRef(false);
  // SDK は EditorShell を埋め込むので、1ページに2つ載っても id が衝突しないようにする。
  const ribbonIdPrefix = useId();
  const saveEditorFontFamilyPreference = useCallback((nextFontFamily: string) => {
    preferredFontFamilyRef.current = nextFontFamily;
    const bridge = getDesktopBridge();
    if (!bridge?.app.saveEditorPreferences) {
      return;
    }
    bridge.app.saveEditorPreferences({ fontFamily: nextFontFamily }).catch((error) => {
      console.warn("Failed to save editor font preference", error);
    });
  }, []);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.app.getEditorPreferences) {
      return;
    }

    let canceled = false;
    bridge.app.getEditorPreferences()
      .then((preferences) => {
        if (!canceled && typeof preferences.fontFamily === "string") {
          const nextFontFamily = normalizeToolbarFontFamily(preferences.fontFamily);
          preferredFontFamilyRef.current = nextFontFamily;
          setFontFamily(nextFontFamily);
        }
      })
      .catch((error) => {
        console.warn("Failed to load editor font preference", error);
      });

    return () => {
      canceled = true;
    };
  }, []);

  const shortcutPlatform = useMemo(() => detectEditorShortcutPlatform(), []);
  const visibleCommentThreadsForPanel = useMemo(
    () => visibleCommentThreads(document.comments, {
      activeThreadId: activeCommentThreadId,
      showResolved: showResolvedComments,
    }),
    [activeCommentThreadId, document.comments, showResolvedComments],
  );
  const currentOverlayCommentAnchor = useMemo(
    () => createOverlaySelectionCommentAnchor(overlaySelection, tE),
    [overlaySelection, tE],
  );
  const currentCommentAnchor = useMemo((): SigmaCommentAnchor | null => {
    if (currentOverlayCommentAnchor) {
      return currentOverlayCommentAnchor;
    }
    return commentAnchorCandidate;
  }, [commentAnchorCandidate, currentOverlayCommentAnchor]);

  const openCommentComposer = useCallback((anchor: SigmaCommentAnchor | null) => {
    if (!anchor) {
      setStatusMessage(tEditor("status.selectCommentTarget"));
      return;
    }
    // 候補アンカーは「場所」で持ち回しているので、引用文は最後に選択された時点のもの。
    // コメントを作る瞬間にいまの本文から取り直す (打鍵ごとに候補を作り直さないための対価)。
    const anchoredAtNow = anchor.type === "block"
      ? createBlockCommentAnchor(documentRef.current, anchor.blockId) ?? anchor
      : anchor;
    setPendingCommentAnchor(anchoredAtNow);
    setPendingCommentDraft([]);
    setActiveCommentThreadId(null);
    setCommentsPanelOpen(true);
    setStatusMessage(tEditor("status.commentReady"));
  }, [setCommentsPanelOpen, setActiveCommentThreadId, setPendingCommentAnchor, setStatusMessage]);

  const focusCommentLocation = useCallback((threadId?: string | null) => {
    if (typeof window === "undefined") {
      return;
    }

    const targetThreadId = threadId ?? activeCommentThreadId ?? visibleCommentThreadsForPanel[0]?.id ?? null;
    if (!targetThreadId) {
      return;
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const escaped = CSS.escape(targetThreadId);
        const element = window.document.querySelector<HTMLElement>(
          `[data-comment-thread-id="${escaped}"], [data-comment-thread-ids~="${escaped}"]`,
        );
        if (!element) {
          return;
        }

        const thread = documentRef.current.comments?.find((item) => item.id === targetThreadId);
        const viewport = window.document.querySelector<HTMLElement>(".whiteboard-page-canvas");
        if (viewport && thread?.anchor.type === "canvasRegion") {
          const { bounds } = thread.anchor;
          const store = editorStore.getState();
          const scale = store.zoom / 100;
          store.setWhiteboardPan({
            panX: viewport.clientWidth / 2 - (bounds.x + bounds.w / 2) * scale,
            panY: viewport.clientHeight / 2 - (bounds.y + bounds.h / 2) * scale,
          });
        } else {
          element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        }
        element.classList.add("comment-focus-pulse");
        window.setTimeout(() => element.classList.remove("comment-focus-pulse"), 1000);
      });
    });
  }, [activeCommentThreadId, editorStore, visibleCommentThreadsForPanel]);

  const toggleCommentsPanel = useCallback(() => {
    setHighlightedCommentThreadId(null);
    setCommentsPanelOpen((current) => {
      const next = !current;
      if (next) {
        setVersionHistoryOpen(false);
        focusCommentLocation();
      }
      return next;
    });
  }, [setCommentsPanelOpen, focusCommentLocation, setHighlightedCommentThreadId, setVersionHistoryOpen]);

  const selectCommentThread = useCallback((threadId: string) => {
    setActiveCommentThreadId(threadId);
    setCommentsPanelOpen(true);
    focusCommentLocation(threadId);
  }, [setCommentsPanelOpen, focusCommentLocation, setActiveCommentThreadId]);

  const resetEditorDocument = useCallback((
    incomingDocument: SigmaDocument,
    nextSelectedId?: string | null,
    nextObservedRevision?: number | null,
  ) => {
    // 本文が空の文書 (この不具合で空のまま保存されたファイル、埋め込みホストからの差し替え、
    // AI が全消しした正本) はここで直る — 開き直せば必ず入力できる状態から始まる。
    const nextDocument = ensureEditableBody(incomingDocument).document;
    const selected = nextSelectedId ?? getDefaultDocumentSelectionId(nextDocument);
    // **履歴は必ず消す。** 「後始末はするが履歴は残す」形も試したが、undo は文書を丸ごと
    // 差し替えるので、採用前のスナップショットがスタックに残っている限り ⌘Z 1 回で外部の
    // 変更がメモリから消え、dirty 判定になった autosave が採用済み revision (CAS 通過) で
    // 書き戻して**ディスク上の他者の変更を消す**。ここで消しておくと ⌘Z が空振りしてその
    // 事故が起きない。undo が外部同期をまたぐときの安全性は独立した設計課題。
    documentHistory.clear();
    documentRef.current = nextDocument;
    if (nextObservedRevision !== undefined) {
      documentObservedRevisionRef.current = nextObservedRevision;
    }
    selectedIdRef.current = selected;
    textSelectionBookmarkRef.current = null;
    pendingTextHistorySelectionRef.current = undefined;
    materialBlockSelectionRef.current = null;
    measuredBodyBlockRectsRef.current = new Map();
    documentDirtyRevisionRef.current += 1;
    const nextDocumentStateStamp = documentDirtyRevisionRef.current;
    lastSavedDirtyRevisionRef.current = documentDirtyRevisionRef.current;
    lastSavedDocumentRef.current = nextDocument;
    lastSyncedDocumentRef.current = nextDocument;
    setDocument(nextDocument);
    setDocumentStateStamp(nextDocumentStateStamp);
    setSelectedId(selected);
    setSelectedInlineMath(null);
    // 文書まるごとの差し替えは documentInstanceRevision を進めて overlay ごと再マウントする。
    // 再マウント後は図形の選択が空へ戻り、パネルが握っているコールバックは破棄済み
    // インスタンスを指す (押しても何も起きないパネルが浮いたままになる)。開いたまま
    // 残す価値は無いので必ず閉じる。
    closeGraphSettings();
    setSelectedOverlayGraph(null);
    closeChartSettings();
    setSelectedOverlayChart(null);
    closeGraph3DSettings();
    setCommentAnchorCandidate(null);
    setPendingCommentAnchor(null);
    setPendingCommentDraft([]);
    clearCommentReplyDrafts();
    setActiveCommentThreadId(null);
    setHighlightedCommentThreadId(null);
    setCommentsPanelOpen(!isWhiteboardPageLayout(normalizePageLayout(nextDocument.pageLayout)));
    setHistoryRevision((current) => current + 1);
    // A full authoritative replacement (tab switch, external reload, AI
    // revert) must also discard editor-engine state. Reusing a focused Tiptap
    // instance can otherwise retain the previous content even though SigmaDoc
    // state has already changed.
    setDocumentInstanceRevision((current) => current + 1);
    // ドキュメント切替(別ファイルを開く/revert/外部変更の全文リロード)ではAI編集の
    // 参照状態も引き継がない — pin済み参照はブロックIDありきなので、別ドキュメントの
    // 同名IDに誤って解決したり、存在しないブロックを指したまま残ったりする。
    setAiEditReference(null);
    clearAiEditPinnedReferences();
    setVersionHistoryPreviewState(null);
    setVersionHistoryRestoreError(null);
  }, [setCommentsPanelOpen, clearAiEditPinnedReferences, closeChartSettings, closeGraph3DSettings, closeGraphSettings, documentHistory, clearCommentReplyDrafts, setActiveCommentThreadId, setCommentAnchorCandidate, setHighlightedCommentThreadId, setPendingCommentAnchor, setSelectedId, setSelectedInlineMath, setVersionHistoryPreviewState, setVersionHistoryRestoreError]);

  const rememberLeavingEditorTabViewState = useCallback((leavingFileId: string | null, nextFileId: string) => {
    if (!leavingFileId || leavingFileId === nextFileId) {
      return;
    }
    editorTabViewStateByFileIdRef.current.set(
      leavingFileId,
      captureEditorTabViewState({
        selectedId: selectedIdRef.current,
        textSelection: textSelectionBookmarkRef.current,
        scroller: editorCanvasRef.current,
      }),
    );
  }, []);

  const prepareIncomingEditorTabViewState = useCallback((
    nextDocument: SigmaDocument,
    nextFileId: string,
  ): ResolvedEditorTabViewState => {
    const resolved = resolveEditorTabViewState(
      nextDocument,
      editorTabViewStateByFileIdRef.current.get(nextFileId),
    );
    pendingEditorTabViewRestoreRef.current = resolved;
    return resolved;
  }, []);

  useEffect(() => {
    const pending = pendingEditorTabViewRestoreRef.current;
    if (!pending || !workspaceReady) {
      return;
    }
    pendingEditorTabViewRestoreRef.current = null;
    scheduleEditorTabViewRestore({
      getScroller: () => editorCanvasRef.current,
      scrollTop: pending.scrollTop,
      scrollLeft: pending.scrollLeft,
      textSelection: pending.textSelection,
      restoreTextSelection: deliverCaret,
    });
  }, [activeFileId, documentInstanceRevision, workspaceReady]);

  // 外部変更 (AI提案の自動承認などによる保存) を mergeExternalDocumentChange で人間の未保存編集と
  // 3-wayマージできた場合に使う、resetEditorDocument より軽量な反映経路。全文リロードではないため
  // undo/redoスタックや選択中ブロック以外のUI状態(コメント選択中アンカー等)は保持する — 通常の
  // commitDocumentChangeによる編集と同様、document状態だけを差し替える。マージ結果には人間の
  // 未保存編集がそのまま含まれているため、lastSavedDocumentRef は更新しない (=ドキュメントは
  // 保存前の状態と異なる「dirty」のままになり、既存の自動保存(450msデバウンス)がこの後で自然に
  // ディスクへ書き戻す)。lastSyncedDocumentRef だけは「ディスク上の最新状態」に合わせて更新し、
  // 次に外部変更が来たときの3-wayマージの base として使えるようにする。
  const applyMergedExternalDocument = useCallback((
    incomingMergedDocument: SigmaDocument,
    syncedDocument: SigmaDocument,
    syncedRevision: number,
  ) => {
    // 外部側が本文を空にしていても、こちらの画面はキャレットを置ける状態を保つ。
    // id 重複の修復も通す — マージ結果は mine と theirs の継ぎ合わせなので、重複が残ると
    // 次回リロードで id が振り直され、等価判定を落として全文リロード (履歴全消し) の種になる。
    // 無変更なら同一参照が返るので余計な再描画は増えない。
    const mergedDocument = ensureEditableBody(repairDuplicateTopLevelIds(
      incomingMergedDocument,
      DOCUMENT_BLOCK_OPERATION_PORTS,
    )).document;
    const currentSelectedId = selectedIdRef.current;
    const nextSelectedId = currentSelectedId && findBlock(mergedDocument, currentSelectedId)
      ? currentSelectedId
      : getDefaultDocumentSelectionId(mergedDocument);
    documentRef.current = mergedDocument;
    documentObservedRevisionRef.current = syncedRevision;
    selectedIdRef.current = nextSelectedId;
    documentDirtyRevisionRef.current += 1;
    const nextDocumentStateStamp = documentDirtyRevisionRef.current;
    lastSyncedDocumentRef.current = syncedDocument;
    setDocument(mergedDocument);
    setDocumentStateStamp(nextDocumentStateStamp);
    setSelectedId(nextSelectedId);
    // Tiptap keeps its own document state. An authoritative external update can
    // replace a block's content without changing its id, so a React prop update
    // alone is intentionally ignored while that editor is focused. Advance the
    // shared revision to force every mounted text-flow editor to consume the
    // merged SigmaDoc immediately instead of waiting for a tab remount.
    setHistoryRevision((current) => current + 1);
  }, [setDocument, setSelectedId]);

  // main側で自動承認されたAI提案は、一般の外部ファイル更新とは異なりユーザー操作として
  // undo可能でなければならない。resetEditorDocumentを通すと、それ以前の人手編集を含む履歴を
  // 全消去してしまうため、現在の文書を1手として積んでから承認済み正本（またはそのmerge結果）
  // を採用する。external canvas editorsの履歴境界の設計を参考に、外部処理の完了を明示的な履歴境界にする。
  const applyAutoApprovedExternalDocument = useCallback((params: {
    nextDocument: SigmaDocument;
    syncedDocument: SigmaDocument;
    syncedRevision: number;
    proposalIds: string[];
  }) => {
    const currentDocument = documentRef.current;
    const currentSelectedId = selectedIdRef.current;
    // AI が本文を全消しした正本を採用しても、入力できる場所は残す。
    //
    // id 重複の修復も通す。マージ結果は mine と theirs を継ぎ合わせたもので、重複が残ると
    // 次回リロードで id が振り直され、外部変更の等価判定を落として**履歴の全消しを再発
    // させる種**になる。無変更なら同一参照が返るので余計な再描画は増えない。
    const nextDocument = ensureEditableBody(repairDuplicateTopLevelIds(
      params.nextDocument,
      DOCUMENT_BLOCK_OPERATION_PORTS,
    )).document;
    const nextSelectedId = currentSelectedId && findBlock(nextDocument, currentSelectedId)
      ? currentSelectedId
      : getDefaultDocumentSelectionId(nextDocument);
    documentHistory.record({
      document: currentDocument,
      selection: {
        selectedId: currentSelectedId,
        textSelection: textSelectionBookmarkRef.current,
      },
      metadata: {
        origin: "automation",
        // 外部由来の採用はすべてここを通る。AI 提案に紐づかない (autosave 由来の) 採用では
        // 相関 id が無いので、空配列を残さず省く。
        ...(params.proposalIds.length > 0 ? { correlationIds: params.proposalIds } : {}),
      },
    });
    documentRef.current = nextDocument;
    documentObservedRevisionRef.current = params.syncedRevision;
    selectedIdRef.current = nextSelectedId;
    materialBlockSelectionRef.current = null;
    documentDirtyRevisionRef.current += 1;
    const nextDocumentStateStamp = documentDirtyRevisionRef.current;
    lastSavedDocumentRef.current = params.syncedDocument;
    lastSyncedDocumentRef.current = params.syncedDocument;
    if (areSigmaDocumentsEquivalent(nextDocument, params.syncedDocument)) {
      lastSavedDirtyRevisionRef.current = documentDirtyRevisionRef.current;
    }
    setDocument(nextDocument);
    setDocumentStateStamp(nextDocumentStateStamp);
    setSelectedId(nextSelectedId);
    setSelectedInlineMath(null);
    setHistoryRevision((current) => current + 1);
  }, [documentHistory, setSelectedId, setSelectedInlineMath]);

  // AI承認待ち中の打鍵があれば、承認開始時点をbaseにAI結果と3-way mergeする。diskDocumentは
  // repair前の「実際にmainが保存した正本」で、保存済み判定と次回外部mergeのbaseは必ずこちらを
  // 使う。repair/normalize差分や人手編集を含む採用結果まで保存済み扱いにはしない。
  const applyAiApprovedDocument = useCallback((params: {
    diskDocument: SigmaDocument;
    normalizedApprovedDocument: SigmaDocument;
    documentAtApprovalStart: SigmaDocument;
    appliedProposalIds: string[];
    approvedRevision: number;
  }) => {
    const currentDocument = documentRef.current;
    const decision = decideAiApprovedDocument({
      documentAtApprovalStart: params.documentAtApprovalStart,
      currentDocument,
      diskDocument: params.diskDocument,
      normalizedApprovedDocument: params.normalizedApprovedDocument,
    });
    lastSavedDocumentRef.current = params.diskDocument;
    lastSyncedDocumentRef.current = params.diskDocument;

    // 採用する正本が本文を持たないときも、画面側はキャレットを置ける状態を保つ
    // (差分はディスク正本 = `params.diskDocument` 側の判定には混ぜない)。
    const nextDocument = ensureEditableBody(decision.document).document;
    const currentSelectedId = selectedIdRef.current;
    const nextSelectedId = currentSelectedId && findBlock(nextDocument, currentSelectedId)
      ? currentSelectedId
      : getDefaultDocumentSelectionId(nextDocument);
    documentHistory.record({
      // Ctrl+ZではAI適用だけを戻し、承認待ち中に入力された人手編集は残す。
      document: currentDocument,
      selection: {
        selectedId: currentSelectedId,
        textSelection: textSelectionBookmarkRef.current,
      },
      metadata: {
        origin: "automation",
        ...(params.appliedProposalIds.length > 0 ? { correlationIds: params.appliedProposalIds } : {}),
      },
    });
    documentRef.current = nextDocument;
    documentObservedRevisionRef.current = params.approvedRevision;
    selectedIdRef.current = nextSelectedId;
    materialBlockSelectionRef.current = null;
    documentDirtyRevisionRef.current += 1;
    const nextDocumentStateStamp = documentDirtyRevisionRef.current;
    if (decision.adoptedDocumentMatchesDisk) {
      lastSavedDirtyRevisionRef.current = documentDirtyRevisionRef.current;
    }
    setDocument(nextDocument);
    setDocumentStateStamp(nextDocumentStateStamp);
    setSelectedId(nextSelectedId);
    setSelectedInlineMath(null);
    setHistoryRevision((current) => current + 1);
    return decision;
  }, [documentHistory, setSelectedId, setSelectedInlineMath]);

  const refreshDocumentMetadatas = useCallback(async () => {
    // 一覧の取り直しは補助的な更新。ここで投げっぱなしにすると、保存先が使えない
    // 環境で unhandled rejection になって画面全体が落ちる。
    const metadatas = await listSavedDocuments().catch(() => null);
    if (!metadatas) {
      return;
    }
    // 保存のたびに読み直すので毎回新しい配列になる。中身が同じなら state を動かさない
    // (動かすと打鍵 1 回ごとに画面全体が再描画される)。
    setDocumentMetadatas((current) => sameDocumentMetadatas(current, metadatas) ? current : metadatas);
  }, []);

  // 承認/却下IPCが成功した proposalId の楽観的確定集合。IPC成功後も、watcher経由で遅れて届く
  // 再取得が (書き込み完了前に読んだ) 「まだ pending」のリストを返すことがあり、確定済みの
  // 提案カードが一瞬 pending に戻って見えるレースがあった。ここに載っているIDはプレビュー
  // 集合へ戻さず、ディスク上で pending でなくなったことを確認できた時点で自動的に掃除する。
  const locallyResolvedProposalIdsRef = useRef(new Set<string>());
  const mcpProposalRefreshTimerRef = useRef<number | null>(null);
  const mcpProposalRefreshBatchRef = useRef<McpProposalRefreshBatch | null>(null);
  const mcpProposalRefreshInFlightRef = useRef<Promise<void> | null>(null);

  const performMcpEditProposalsRefresh = useCallback(async () => {
    const storage = getDesktopBridge()?.storage;
    // pendingは全教材分を維持し、解決済み履歴だけ現在の教材に絞って一度に取得する。
    const all = await storage?.listMcpEditProposals({
      status: "all",
      fileId: activeFileIdRef.current,
    });
    const allList = all ?? [];
    const pendingList = allList.filter((proposal) => proposal.status === "pending");
    const locallyResolved = locallyResolvedProposalIdsRef.current;
    if (locallyResolved.size > 0) {
      for (const proposalId of [...locallyResolved]) {
        if (!pendingList.some((proposal) => proposal.proposalId === proposalId)) {
          locallyResolved.delete(proposalId);
        }
      }
    }
    setMcpEditProposals(
      locallyResolved.size > 0
        ? pendingList.filter((proposal) => !locallyResolved.has(proposal.proposalId))
        : pendingList,
    );
    setMcpProposalCitations(allList);
  }, []);

  // proposal書き込みはwatcher通知と明示refreshが近接して届く。75msのtrailing debounceで
  // 1回へまとめ、すでに取得中ならその完了後に最大1回だけ追従取得する。各呼び出しは自分を
  // 含むbatchの完了Promiseを共有するため、承認後のawaitも最新一覧の反映まで待機できる。
  const refreshMcpEditProposals = useCallback((): Promise<void> => {
    let batch = mcpProposalRefreshBatchRef.current;
    if (!batch) {
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      batch = { promise, resolve, reject };
      mcpProposalRefreshBatchRef.current = batch;
    }

    if (mcpProposalRefreshTimerRef.current !== null) {
      window.clearTimeout(mcpProposalRefreshTimerRef.current);
    }
    mcpProposalRefreshTimerRef.current = window.setTimeout(() => {
      mcpProposalRefreshTimerRef.current = null;
      const scheduledBatch = mcpProposalRefreshBatchRef.current;
      mcpProposalRefreshBatchRef.current = null;
      if (!scheduledBatch) {
        return;
      }

      const precedingRefresh = mcpProposalRefreshInFlightRef.current;
      const refresh = (async () => {
        await precedingRefresh?.catch(() => undefined);
        await performMcpEditProposalsRefresh();
      })();
      mcpProposalRefreshInFlightRef.current = refresh;
      void refresh.then(scheduledBatch.resolve, scheduledBatch.reject).finally(() => {
        if (mcpProposalRefreshInFlightRef.current === refresh) {
          mcpProposalRefreshInFlightRef.current = null;
        }
      });
    }, MCP_PROPOSAL_REFRESH_DEBOUNCE_MS);

    return batch.promise;
  }, [performMcpEditProposalsRefresh]);

  useEffect(() => () => {
    if (mcpProposalRefreshTimerRef.current !== null) {
      window.clearTimeout(mcpProposalRefreshTimerRef.current);
      mcpProposalRefreshTimerRef.current = null;
    }
    mcpProposalRefreshBatchRef.current?.resolve();
    mcpProposalRefreshBatchRef.current = null;
  }, []);

  const applyDocumentOpenFailure = useCallback((failure: DocumentOpenFailure | null) => {
    documentOpenFailureRef.current = failure;
    setDocumentOpenFailure(failure);
  }, []);

  /** 直前に記録した失敗を破棄する。同じ教材が読めるようになった時だけ呼ぶ。 */
  const clearDocumentOpenFailure = useCallback((fileId: string) => {
    if (documentOpenFailureRef.current?.fileId === fileId) {
      applyDocumentOpenFailure(null);
    }
    pendingDocumentOpenFailureRef.current = null;
  }, [applyDocumentOpenFailure]);

  /**
   * 読み込み失敗のうち「教材の中身が原因」のものだけを保留に置く。実際に画面へ
   * 出すかは呼び出し側 (その教材をアクティブにするかどうか) が決める。
   */
  const recordDocumentOpenFailure = useCallback((
    fileId: string,
    result: Extract<DocumentLoadResult, { ok: false }>,
    fallbackTitle?: string,
  ) => {
    pendingDocumentOpenFailureRef.current = toDocumentOpenFailure(
      fileId,
      result,
      fallbackTitle?.trim() || DEFAULT_DOCUMENT_TITLE,
    );
  }, []);

  /** 直前の読み込みで記録された失敗を、その教材のものに限り画面へ出す。 */
  const showRecordedDocumentOpenFailure = useCallback((fileId: string): DocumentOpenFailure | null => {
    const pending = pendingDocumentOpenFailureRef.current;
    if (!pending || pending.fileId !== fileId) {
      return null;
    }
    pendingDocumentOpenFailureRef.current = null;
    applyDocumentOpenFailure(pending);
    return pending;
  }, [applyDocumentOpenFailure]);

  /**
   * 開けなかった教材を「タブは開いたまま、本文の代わりに原因を中央へ出す」状態にする。
   * 本文は空の下書きへ差し替えるが resetEditorDocument が clean 扱いにするため
   * 自動保存は走らない。加えて documentOpenFailureRef を見る保存側のガードで、
   * この空の下書きが壊れた教材へ書き戻ることを二重に防いでいる。
   */
  const enterDocumentOpenFailureState = useCallback(async (
    failure: DocumentOpenFailure,
    nextOpenFileIds: string[],
  ) => {
    const blank = createEmptyEditorDocument();
    resetEditorDocument({
      ...blank,
      docId: `doc_open_failed_${failure.fileId}`,
      metadata: { ...blank.metadata, title: failure.title },
    }, undefined, null);
    setOpenFileIds(nextOpenFileIds);
    setActiveFileId(failure.fileId);
    await saveWorkspaceState({ openFileIds: nextOpenFileIds, activeFileId: failure.fileId });
    await refreshDocumentMetadatas();
    setSaveState("error");
    setStatusMessage(tEditor("status.openFailedWithReason"));
  }, [refreshDocumentMetadatas, resetEditorDocument, setSaveState, setStatusMessage]);

  const loadWorkspaceDocument = useCallback(async (fileId: string): Promise<{
    document: SigmaDocument;
    observedRevision: number;
  } | null> => {
    const localResult = await loadDocumentByFileIdWithRecovery(fileId);
    if (localResult.ok) {
      if (isPristineUntitledDocument(localResult.document, localResult.revision)) {
        untouchedNewDocumentsRef.current.set(fileId, localResult.document);
      }
      clearDocumentOpenFailure(fileId);
      if (localResult.recoveryIssues.length > 0) {
        window.setTimeout(() => announceRecovery(localResult.recoveryIssues, localResult.recoveryBackupPath), 0);
      }
      return { document: localResult.document, observedRevision: localResult.revision };
    }

    const metadata = await listSavedDocuments();
    const target = metadata.find((item) => item.fileId === fileId);
    // 教材の中身が原因で組み立てられなかった場合は、黙って別教材へ切り替えず
    // 「開いたまま原因を出す」ために失敗内容を記録しておく (呼び出し側が
    // openDocumentOpenFailure で拾う)。
    recordDocumentOpenFailure(fileId, localResult, target?.title);
    return null;
  }, [announceRecovery, clearDocumentOpenFailure, recordDocumentOpenFailure]);

  const isCurrentDocumentDirty = useCallback(() => {
    return !areSigmaDocumentsEquivalent(documentRef.current, lastSavedDocumentRef.current);
  }, []);
  const {
    updateVersionHistoryCaptureStatus,
    saveCurrentDocumentRecord,
    saveCurrentDocumentBeforeReplacement,
    attemptBoundarySave,
  } = useDocumentSaveBoundary({
    setVersionHistoryWarnings,
    t,
    documentOpenFailureRef,
    activeFileIdRef,
    documentDirtyRevisionRef,
    embeddedHostRef,
    documentRef,
    lastSavedDocumentRef,
    lastSavedDirtyRevisionRef,
    lastSyncedDocumentRef,
    tEditor,
    documentObservedRevisionRef,
    inFlightSavePromiseRef,
    successfulDocumentSavesRef,
    workspaceReadyRef,
    externalChangeFileIdsRef,
    mcpPreviewBusyRef,
    isCurrentDocumentDirty,
    isEmbedded,
    setSaveState,
    setStatusMessage,
    dispatchDocumentStorageChange,
  });

  const createUnsavedEditBackup = useCallback(async (source: SigmaDocument) => {
    const backup = repairDuplicateTopLevelIds(ensurePageLayout({
      ...structuredClone(source),
      docId: createId("doc"),
      metadata: {
        ...source.metadata,
        title: createUnsavedEditBackupTitle(resolveDocumentTitle(source), tE),
      },
      updatedAt: new Date().toISOString(),
    }), DOCUMENT_BLOCK_OPERATION_PORTS);
    return createDocumentFromSigmaDocument(backup);
  }, [tE]);

  const saveUnsavedEditBackup = useCallback(async () => {
    if (!isCurrentDocumentDirty()) {
      return null;
    }
    return createUnsavedEditBackup(documentRef.current);
  }, [createUnsavedEditBackup, isCurrentDocumentDirty]);

  const finishWindowCloseSave = useCallback(async (action: "ready" | "cancel") => {
    const desktopApp = getDesktopBridge()?.app;
    windowCloseAttemptGenerationRef.current += 1;
    windowCloseResolvedRef.current = action === "ready";
    const request = action === "ready"
      ? desktopApp?.notifyCloseReady?.()
      : desktopApp?.cancelCloseRequest?.();
    try {
      const succeeded = await request;
      if (succeeded) {
        setWindowCloseSaveDialog(null);
        return;
      }
    } catch (error) {
      console.warn(`Failed to report app-close ${action}.`, error);
    }
    setWindowCloseSaveDialog({
      error: tE("windowCloseSave.responseFailed"),
      saving: false,
    });
  }, [tE]);

  const attemptWindowCloseSave = useCallback(async () => {
    const attemptGeneration = ++windowCloseAttemptGenerationRef.current;
    setWindowCloseSaveDialog((current) => current ? { ...current, saving: true } : current);
    let timeoutId: number | undefined;
    let timedOut = false;
    let saveResult: Awaited<ReturnType<typeof attemptBoundarySave>> = { ok: false };
    try {
      saveResult = await Promise.race([
        attemptBoundarySave("app-close"),
        new Promise<Awaited<ReturnType<typeof attemptBoundarySave>>>((resolve) => {
          timeoutId = window.setTimeout(() => {
            timedOut = true;
            resolve({ ok: false, error: tE("windowCloseSave.timedOut") });
          }, 15_000);
        }),
      ]);
    } catch (error) {
      saveResult = {
        ok: false,
        error: error instanceof Error ? error.message : tE("windowCloseSave.unknownError"),
      };
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    }
    if (attemptGeneration !== windowCloseAttemptGenerationRef.current) return;

    const outcome = resolveWindowCloseOutcome({
      saveOk: saveResult.ok,
      saveError: saveResult.error,
      timedOut,
      dirty: isCurrentDocumentDirty(),
      skipped: saveResult.skipped === true,
      skippedReason: saveResult.skippedReason,
    });
    if (outcome === "ready") {
      await finishWindowCloseSave("ready");
      return;
    }
    const skippedReasonKey = describeWindowCloseSkipReason(saveResult.skippedReason);
    setWindowCloseSaveDialog({
      error: saveResult.error
        ?? (skippedReasonKey ? tE(skippedReasonKey) : tE("windowCloseSave.unknownError")),
      saving: false,
    });
  }, [attemptBoundarySave, finishWindowCloseSave, isCurrentDocumentDirty, tE]);

  const attemptWindowClose = useCallback(() => {
    const desktopApp = getDesktopBridge()?.app;
    if (!desktopApp?.notifyCloseReady) return;
    const acknowledgement = desktopApp.acknowledgeCloseRequest?.();
    void acknowledgement?.catch((error) => {
      console.warn("Failed to acknowledge the app-close request.", error);
    });
    void attemptWindowCloseSave();
  }, [attemptWindowCloseSave]);

  useEffect(() => {
    const desktopApp = getDesktopBridge()?.app;
    const handleVisibilityChange = () => {
      if (windowCloseResolvedRef.current) return;
      if (window.document.visibilityState === "hidden") {
        void attemptBoundarySave("tab-switch").catch(() => undefined);
      }
    };
    const handlePageHide = () => {
      if (windowCloseResolvedRef.current) return;
      void attemptBoundarySave("app-close").catch(() => undefined);
    };
    if (shouldUsePageVisibilityBoundaryEvents(Boolean(desktopApp))) {
      window.document.addEventListener("visibilitychange", handleVisibilityChange);
      window.addEventListener("pagehide", handlePageHide);
    }

    const unsubscribeClose = desktopApp?.onCloseRequested?.(() => {
      void attemptWindowClose();
    });
    return () => {
      window.document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      unsubscribeClose?.();
    };
  }, [attemptBoundarySave, attemptWindowClose]);

  const switchAwayFromDeletedFile = useCallback(async (deletedFileId: string) => {
    const backup = await saveUnsavedEditBackup();
    const metadata = await listSavedDocuments();
    const availableFileIds = new Set(metadata.map((item) => item.fileId));
    let nextOpenFileIds = uniqueStringIds([
      ...openFileIdsRef.current.filter((fileId) => fileId !== deletedFileId && availableFileIds.has(fileId)),
      ...(backup ? [backup.fileId] : []),
    ]);
    let nextActiveFileId = backup?.fileId ?? nextOpenFileIds[0] ?? metadata[0]?.fileId;
    const loaded = nextActiveFileId ? await loadWorkspaceDocument(nextActiveFileId) : null;
    let nextDocument = loaded?.document ?? null;
    let nextObservedRevision = loaded?.observedRevision ?? null;

    if (!nextDocument) {
      const created = await createNewDocument();
      nextDocument = created.document;
      nextActiveFileId = created.fileId;
      nextOpenFileIds = [nextActiveFileId];
      nextObservedRevision = created.metadata.revision;
    } else if (nextActiveFileId && !nextOpenFileIds.includes(nextActiveFileId)) {
      nextOpenFileIds = uniqueStringIds([...nextOpenFileIds, nextActiveFileId]);
    }

    const migrated = repairDuplicateTopLevelIds(
      ensurePageLayout(nextDocument),
      DOCUMENT_BLOCK_OPERATION_PORTS,
    );
    resetEditorDocument(migrated, undefined, nextObservedRevision);
    setOpenFileIds(nextOpenFileIds);
    setActiveFileId(nextActiveFileId);
    await saveWorkspaceState({ openFileIds: nextOpenFileIds, activeFileId: nextActiveFileId });
    await refreshDocumentMetadatas();
    setSaveState("saved");
    setStatusMessage(backup
      ? tEditor("status.deletedDocSetAside")
      : tEditor("status.deletedDocSwitched"));
  }, [loadWorkspaceDocument, refreshDocumentMetadatas, resetEditorDocument, saveUnsavedEditBackup, setSaveState, setStatusMessage]);

  const openDocumentInWorkspace = useCallback(async (
    fileId: string,
    options?: DocumentTabOpenOptions,
  ) => {
    const nextOpenFileIds = uniqueStringIds([...(options?.nextOpenFileIds ?? openFileIds), fileId]);

    setLoadingFileId(fileId);
    try {
      if (workspaceReady && options?.saveCurrent !== false) {
        if (!(await saveCurrentDocumentBeforeReplacement())) {
          return;
        }
      }

      // 読み込み成否に関わらず、今の教材から離れる直前の位置を残す。
      rememberLeavingEditorTabViewState(activeFileIdRef.current, fileId);

      const loaded = await loadWorkspaceDocument(fileId);
      if (!loaded) {
        // 教材の中身が原因なら、別教材へ切り替えずタブを開いて原因を表示する。
        const failure = showRecordedDocumentOpenFailure(fileId);
        if (failure) {
          await enterDocumentOpenFailureState(failure, nextOpenFileIds);
          return;
        }
        setSaveState("error");
        setStatusMessage(tEditor("status.loadFailed"));
        await refreshDocumentMetadatas();
        return;
      }

      const migrated = repairDuplicateTopLevelIds(
        ensurePageLayout(loaded.document),
        DOCUMENT_BLOCK_OPERATION_PORTS,
      );
      const restoredView = prepareIncomingEditorTabViewState(migrated, fileId);
      resetEditorDocument(migrated, restoredView.selectedId, loaded.observedRevision);
      if (restoredView.textSelection) {
        textSelectionBookmarkRef.current = restoredView.textSelection;
      }
      setOpenFileIds(nextOpenFileIds);
      setActiveFileId(fileId);
      await saveWorkspaceState({ openFileIds: nextOpenFileIds, activeFileId: fileId });
      await refreshDocumentMetadatas();
      setSaveState("saved");
      setStatusMessage(options?.status ?? tEditor("status.opened"));
    } finally {
      setLoadingFileId(null);
    }
  }, [
    enterDocumentOpenFailureState,
    loadWorkspaceDocument,
    openFileIds,
    prepareIncomingEditorTabViewState,
    refreshDocumentMetadatas,
    rememberLeavingEditorTabViewState,
    resetEditorDocument,
    saveCurrentDocumentBeforeReplacement,
    setSaveState,
    setStatusMessage,
    showRecordedDocumentOpenFailure,
    workspaceReady,
  ]);

  const openSourceReferenceDocument = useCallback(async (params: { fileId: string; blockId?: string }) => {
    const { fileId, blockId } = params;

    const revealReferencedLocation = (doc: SigmaDocument) => {
      focusSourceReferenceInDocument(doc, blockId, {
        selectBlock: (selectionId) => {
          setSelectedInlineMath(null);
          selectedIdRef.current = selectionId;
          setSelectedId(selectionId);
        },
        focusEditableBlock: scheduleEditorBlockFocus,
      });
    };

    if (fileId === activeFileIdRef.current) {
      revealReferencedLocation(documentRef.current);
      setStatusMessage(blockId?.trim() ? tEditor("status.showingSourceSpot") : tEditor("status.showingSourceDoc"));
      return;
    }

    const nextOpenFileIds = uniqueStringIds([...openFileIds, fileId]);
    setLoadingFileId(fileId);
    try {
      if (workspaceReady) {
        if (!(await saveCurrentDocumentBeforeReplacement())) {
          return;
        }
      }

      rememberLeavingEditorTabViewState(activeFileIdRef.current, fileId);

      const loaded = await loadWorkspaceDocument(fileId);
      if (!loaded) {
        const failure = showRecordedDocumentOpenFailure(fileId);
        if (failure) {
          await enterDocumentOpenFailureState(failure, nextOpenFileIds);
          return;
        }
        setSaveState("error");
        setStatusMessage(tEditor("status.openSourceFailed"));
        await refreshDocumentMetadatas();
        return;
      }

      const migrated = repairDuplicateTopLevelIds(
        ensurePageLayout(loaded.document),
        DOCUMENT_BLOCK_OPERATION_PORTS,
      );
      const selectionId = resolveSourceReferenceNavigationTarget(migrated, blockId).selectionId;
      // 参照ジャンプ先は revealReferencedLocation が決める。保存済みビューは使わない。
      resetEditorDocument(
        migrated,
        selectionId ?? undefined,
        loaded.observedRevision,
      );
      setOpenFileIds(nextOpenFileIds);
      setActiveFileId(fileId);
      await saveWorkspaceState({ openFileIds: nextOpenFileIds, activeFileId: fileId });
      await refreshDocumentMetadatas();
      setSaveState("saved");
      setStatusMessage(blockId?.trim() ? tEditor("status.openedSourceSpot") : tEditor("status.openedSourceDoc"));
      revealReferencedLocation(migrated);
    } finally {
      setLoadingFileId(null);
    }
  }, [
    enterDocumentOpenFailureState,
    loadWorkspaceDocument,
    openFileIds,
    refreshDocumentMetadatas,
    rememberLeavingEditorTabViewState,
    resetEditorDocument,
    saveCurrentDocumentBeforeReplacement,
    setSaveState,
    setSelectedId,
    setSelectedInlineMath,
    setStatusMessage,
    showRecordedDocumentOpenFailure,
    workspaceReady,
  ]);

  /**
   * ズームの唯一の入口。リボンの ±/選択、⌘+/⌘-、ホイール、右下コントロールが全部ここを通る。
   *
   * ホワイトボードは transform のカメラ、紙はスクロール位置で錨を取る。「どちらの錨か」の分岐は
   * この 1 箇所だけに置く。入口ごとに実装を持つと、片方だけ左上原点で拡大する破綻に戻る。
   */
  const applyZoom = useCallback((
    nextZoomInput: number | ((current: number) => number),
    anchor?: { clientX: number; clientY: number },
  ) => {
    // ホイールは再レンダーより速く連続するので、render 時の値を読むと 1 発ぶん古い。
    // ストアから直接引く (set は同期反映なので、連打でも常に最新)。
    const store = editorStore.getState();
    const currentZoom = store.zoom;
    const nextZoom = resolveNextZoom(
      currentZoom,
      typeof nextZoomInput === "function" ? nextZoomInput(currentZoom) : nextZoomInput,
    );

    if (nextZoom === currentZoom) {
      return;
    }

    if (isWhiteboardDocument) {
      const viewportRect = whiteboardViewportRef.current?.getBoundingClientRect();
      if (!viewportRect || viewportRect.width <= 0 || viewportRect.height <= 0) {
        // 錨が測れないなら倍率も動かさない。倍率だけ変えると左上原点で拡大され、
        // 「錨の下のワールド点は動かない」という唯一の約束が破れる。
        return;
      }

      const anchorPoint = anchor
        ? { x: anchor.clientX - viewportRect.left, y: anchor.clientY - viewportRect.top }
        : { x: viewportRect.width / 2, y: viewportRect.height / 2 };
      const next = zoomCameraAt(
        { zoom: currentZoom, ...store.whiteboardPan },
        nextZoom,
        anchorPoint,
      );
      // 倍率とパンは 1 回の set で当てる。分けると commit が割れて 1 フレーム絵が飛ぶ。
      store.setWhiteboardCamera(next.zoom, { panX: next.panX, panY: next.panY });
      return;
    }

    const scroller = editorCanvasRef.current;
    if (scroller && anchor) {
      const rect = scroller.getBoundingClientRect();
      const nextScroll = getScrollForZoomAnchor({
        scrollLeft: scroller.scrollLeft,
        scrollTop: scroller.scrollTop,
        offsetX: anchor.clientX - rect.left,
        offsetY: anchor.clientY - rect.top,
        currentZoom,
        nextZoom,
      });

      window.requestAnimationFrame(() => {
        scroller.scrollLeft = nextScroll.scrollLeft;
        scroller.scrollTop = nextScroll.scrollTop;
      });
    }

    store.setZoom(nextZoom);
  }, [editorStore, isWhiteboardDocument]);

  /** ⌘0 / 右下「リセット」。ホワイトボードでは倍率だけでなくパンも原点へ戻す。 */
  const resetZoom = useCallback(() => {
    if (isWhiteboardDocument) {
      const camera = resetCamera();
      editorStore.getState().setWhiteboardCamera(camera.zoom, {
        panX: camera.panX,
        panY: camera.panY,
      });
      return;
    }

    applyZoom(100);
  }, [applyZoom, editorStore, isWhiteboardDocument]);

  /**
   * パンは常に「差分」で受ける。中ボタンドラッグは 1 フレームに何度も動くので、
   * 絶対値で受けると render 時の古いパンに毎回足し込んで最後の 1 回だけが残り、
   * 速いドラッグが置いていかれる。
   */
  const panWhiteboardBy = useCallback((dx: number, dy: number) => {
    if (dx === 0 && dy === 0) {
      return;
    }

    const store = editorStore.getState();
    store.setWhiteboardPan((currentPan) => {
      const next = panCamera({ zoom: store.zoom, ...currentPan }, dx, dy);
      return { panX: next.panX, panY: next.panY };
    });
  }, [editorStore]);

  useEffect(() => {
    const handleTextFormatState = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      if (!detail) {
        return;
      }

      if (detail.target === "document") {
        const nodeType = detail.nodeType;
        const blockId = typeof detail.blockId === "string" ? detail.blockId : null;
        const nextTarget =
          detail.enabled === true &&
          isTextFormatTargetNodeType(nodeType)
            ? { enabled: true as const, nodeType, blockId }
            : null;
        setDocumentTextFormatTarget((current) => (
          current?.enabled === nextTarget?.enabled &&
          current?.nodeType === nextTarget?.nodeType &&
          current?.blockId === nextTarget?.blockId
            ? current
            : nextTarget
        ));
      }
      setBoldActive(detail.bold === true);
      setItalicActive(detail.italic === true);
      setUnderlineActive(detail.underline === true);
      setBoxedTextActive(detail.boxed === true);
      setBoldActive(detail.bold === true);
      setItalicActive(detail.italic === true);
      setUnderlineActive(detail.underline === true);
      if (typeof detail.boxedPaddingY === "number" && Number.isFinite(detail.boxedPaddingY)) {
        setBoxedTextPaddingY(detail.boxedPaddingY);
      }
      setBoxedTextVariant(normalizeBoxedTextVariant(detail.boxedVariant) ?? "frame");
      setBlockStyleState((current) => nextBlockStyleToolbarState(current, detail));
      // The toolbar shows the font this position is actually drawn with. It used to fall back to
      // `preferredFontFamilyRef` — the last font picked from the dropdown, persisted in settings —
      // which is a different thing entirely the moment the caret moves somewhere the user did not
      // set by hand. That preference is still kept, just no longer used as the displayed value.
      if (detail.fontFamilyMixed === true) {
        setFontFamily("");
      } else if (typeof detail.fontFamily === "string") {
        setFontFamily(normalizeToolbarFontFamily(detail.fontFamily));
      }
      setTextFontSizeMixed(detail.fontSizeMixed === true);
      if (typeof detail.fontSize === "number" && Number.isFinite(detail.fontSize)) {
        setTextFontSize(detail.fontSize);
      } else if (detail.fontSize === null) {
        setTextFontSize(null);
      }
      if (typeof detail.color === "string") {
        setTextColor(detail.color);
      } else if (detail.color === null) {
        setTextColor(BASE_EDITOR_TEXT_COLOR);
      }
      if (typeof detail.backgroundColor === "string") {
        setTextBackgroundColor(detail.backgroundColor);
      } else if (detail.backgroundColor === null) {
        setTextBackgroundColor(null);
      }
      const nextLineHeight = normalizeLineHeight(detail.lineHeight);
      if (nextLineHeight) {
        setLineHeight(nextLineHeight);
      } else if (detail.lineHeight === null) {
        setLineHeight(BASE_EDITOR_LINE_HEIGHT);
      }
    };

    window.addEventListener(TEXT_FORMAT_STATE_EVENT, handleTextFormatState);
    return () => window.removeEventListener(TEXT_FORMAT_STATE_EVENT, handleTextFormatState);
  }, []);

  useEffect(() => {
    const scroller = editorCanvasRef.current;
    if (!scroller) {
      return;
    }

    /**
     * ホイールの唯一の受け口。React の `onWheel` には載せられない — React は `wheel` を
     * ルートコンテナへ **passive** で張るので `preventDefault()` が効かず、そもそもこの
     * capture リスナの `stopPropagation()` で bubble 段階まで届かない。
     */
    const handleNativeWheel = (event: WheelEvent) => {
      if (isWhiteboardDocument) {
        const viewport = whiteboardViewportRef.current;
        const target = event.target;
        // ビューポートの外 (AIタスクDock・コメントパネル) のホイールは自前で処理しない。
        if (!viewport || !(target instanceof Node) || !viewport.contains(target)) {
          return;
        }

        const rect = viewport.getBoundingClientRect();
        const scale = {
          lineHeightPx: WHEEL_LINE_HEIGHT_PX,
          pageWidthPx: rect.width,
          pageHeightPx: rect.height,
        };
        const intent = resolveWheelIntent(event, scale);

        if (intent.kind === "pan") {
          // 盤面の中にスクロールできるもの (数式のTeX入力欄など) があればそちらに譲る。
          // capture で全部止めると、それらが二度とスクロールできなくなる。
          // 見る軸は **intent の軸** (パン量の符号を戻したもの)。生の delta で見ると
          // shift 単独 (縦 delta を横パンへ振り替える) のとき、横だけスクロールできる
          // 要素に届かない。
          if (canScrollWithin(target, viewport, -intent.dx, -intent.dy)) {
            return;
          }
        }

        event.preventDefault();
        event.stopPropagation();

        if (intent.kind === "zoom") {
          applyZoom(
            (current) => current * intent.factor,
            { clientX: event.clientX, clientY: event.clientY },
          );
          return;
        }

        panWhiteboardBy(intent.dx, intent.dy);
        return;
      }

      if (!event.ctrlKey && !event.metaKey) {
        return;
      }

      const intent = resolveWheelIntent(event, {
        lineHeightPx: WHEEL_LINE_HEIGHT_PX,
        pageWidthPx: scroller.clientWidth,
        pageHeightPx: scroller.clientHeight,
      });
      if (intent.kind !== "zoom") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      applyZoom(
        (current) => current * intent.factor,
        { clientX: event.clientX, clientY: event.clientY },
      );
    };

    scroller.addEventListener("wheel", handleNativeWheel, { capture: true, passive: false });
    return () => scroller.removeEventListener("wheel", handleNativeWheel, { capture: true });
  }, [applyZoom, isWhiteboardDocument, panWhiteboardBy]);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.settings) {
      return;
    }

    let canceled = false;
    void bridge.settings.get().then((settings) => {
      if (canceled) {
        return;
      }
      // settings.json が表示言語の正本。未設定 (null) の初回起動だけは、ストア側の
      // OSロケール検出結果を採用したうえで settings.json へ書き戻す。書き戻さないと
      // main / MCP プロセスが日本語、画面だけ英語という食い違いが残り続ける。
      const desktopLocale = normalizeLocale(settings.uiLocale ?? null);
      setAppLocale(desktopLocale ?? getAppLocale());
      if (!desktopLocale) {
        void bridge.settings?.setUiLocale?.(getAppLocale());
      }
      const storedShortcutOverrides = parseEditorShortcutOverrides(JSON.stringify(settings.commandShortcuts ?? {}));
      const storedCustomCommands = parseEditorCustomCommands(JSON.stringify(settings.customCommands ?? []));
      const legacyShortcutOverrides = settings.hasCommandShortcuts ? {} : loadEditorShortcutOverrides();
      const legacyCustomCommands = settings.hasCustomCommands ? [] : loadEditorCustomCommands();
      setShortcutOverrides(Object.keys(storedShortcutOverrides).length > 0 ? storedShortcutOverrides : legacyShortcutOverrides);
      setCustomCommands(storedCustomCommands.length > 0 ? storedCustomCommands : legacyCustomCommands);
      setCommandSettingsError(null);
      setCommandSettingsLoaded(true);
    }).catch(() => {
      if (!canceled) {
        setCommandSettingsError(tEditor("status.shortcutsLoadFailed"));
      }
    });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!commandSettingsLoaded || commandSettingsError) {
      return;
    }

    const bridge = getDesktopBridge();
    if (bridge?.settings) {
      void bridge.settings.setCommandConfig({
        commandShortcuts: Object.keys(shortcutOverrides).length > 0 ? shortcutOverrides : null,
        customCommands,
      }).then((result) => {
        if (!result.ok) {
          setCommandSettingsError(result.error ?? tEditor("status.shortcutsSaveFailed"));
        }
      }).catch(() => {
        setCommandSettingsError(tEditor("status.shortcutsSaveFailed"));
      });
      return;
    }

    saveEditorShortcutOverrides(shortcutOverrides);
    saveEditorCustomCommands(customCommands);
  }, [commandSettingsError, commandSettingsLoaded, customCommands, shortcutOverrides]);

  useEffect(() => {
    if (workspaceReady) {
      window.dispatchEvent(new Event(APP_READY_EVENT));
    }
  }, [workspaceReady]);

  /** 開けたら true。パレットは開けたときだけ focus 対象を覚える。 */
  const openCommandSettings = useCallback(() => {
    if (!commandSettingsLoaded) {
      setStatusMessage(commandSettingsError ?? tEditor("status.shortcutsLoading"));
      return false;
    }
    if (commandSettingsError) {
      setStatusMessage(commandSettingsError);
      return false;
    }
    setCommandSettingsOpen(true);
    return true;
  }, [commandSettingsError, commandSettingsLoaded, setStatusMessage, setCommandSettingsOpen]);

  const commitDocumentChange = useCallback((change: DocumentChange, options?: DocumentChangeOptions) => measurePerformance("EditorShell.commitDocumentChange", () => {
    // AI 側の状態は ref から読む (上の `aiLockedTargetsRef` のコメント参照)。書き込み中は
    // state のミラーではなく、書き込み開始と同時に立つ `mcpPreviewBusyRef` を直接見る。
    const aiDocumentWriteInProgress = mcpPreviewBusyRef.current;
    const aiLockedTargets = aiLockedTargetsRef.current;
    if (aiDocumentWriteInProgress) {
      setStatusMessage(aiDocumentWriteInProgressMessage());
      return false;
    }
    const current = documentRef.current;
    const proposed = typeof change === "function" ? change(current) : change;
    // 本文を空のままにはしない。ブロック削除・切り取り・AI 適用のどれで空になっても、
    // ここで空段落が 1 つ残るので「消したら二度と入力できない」状態にはならない。
    const next = ensureEditableBody(repairDuplicateTopLevelIds(
      proposed,
      DOCUMENT_BLOCK_OPERATION_PORTS,
    )).document;

    if (next === current) {
      pendingTextHistorySelectionRef.current = undefined;
      return false;
    }

    // The single mutation choke point, and therefore the backstop for every
    // surface the ProseMirror edit guard cannot see (overlay drags, block moves
    // and deletions, table/graph edits): refuse exactly the changes that would
    // alter what AI is holding, and let everything else through.
    const touchedAiTargets = findAiLockedTargetsTouched(current, next, aiLockedTargets);
    if (hasAiLockedTargetsTouched(touchedAiTargets)) {
      setStatusMessage(describeAiLockedTargets(aiLockedTargets, touchedAiTargets));
      return false;
    }

    // `coalesce` folds derived overlay geometry into the preceding user edit.
    // This keeps automatic re-anchors and text auto-size corrections in the
    // same undo step as the deletion or text edit that caused them.
    if (!options?.coalesce) {
      const pendingTextSelection = pendingTextHistorySelectionRef.current;
      documentHistory.record({
        document: current,
        selection: {
          selectedId: selectedIdRef.current,
          textSelection: pendingTextSelection === undefined
            ? textSelectionBookmarkRef.current
            : pendingTextSelection,
        },
        metadata: { origin: "user" },
      }, options?.historyGroup ? { coalescingKey: options.historyGroup } : undefined);
    }
    pendingTextHistorySelectionRef.current = undefined;
    const initialDraft = untouchedNewDocumentsRef.current.get(activeFileIdRef.current);
    if (initialDraft && !isUntouchedNewDocument(initialDraft, next)) {
      untouchedNewDocumentsRef.current.delete(activeFileIdRef.current);
    }
    documentRef.current = next;
    documentDirtyRevisionRef.current += 1;
    const nextDocumentStateStamp = documentDirtyRevisionRef.current;
    if (options?.deferRender) {
      startTransition(() => {
        setDocument(next);
        setDocumentStateStamp(nextDocumentStateStamp);
      });
    } else {
      setDocument(next);
      setDocumentStateStamp(nextDocumentStateStamp);
    }

    const deletedIds = diffDeletedContentIds(current, next);
    if (deletedIds.length > 0) {
      deletionSeqRef.current += 1;
      setPendingDeletion({ revision: deletionSeqRef.current, deletedIds });
    }
    return true;
  }), [documentHistory, setStatusMessage]);

  const materialLibrary = useMaterialLibraryController({
    documentRef,
    selectedIdRef,
    overlaySelectionRef,
    materialBlockSelectionRef,
    commitDocumentChange,
    setSelectedId,
    setSelectedInlineMath,
    setStatusMessage,
    blockMutationPorts: DOCUMENT_BLOCK_OPERATION_PORTS,
    tEditor,
    tWorkspace,
  });
  const {
    materialLibraryOpen,
    setMaterialLibraryOpen,
    materials,
    materialEditingOpenRef,
    materialAddDialogOpen,
    setMaterialActionMenu,
    captureMaterialBlockSelectionFromDom,
    openMaterialAddDialog,
    insertContentAt,
    insertMaterialAt,
  } = materialLibrary;

  const restoreDocumentVersion = async (version: DocumentVersion): Promise<DocumentVersionRestoreResult> => {
    const fileId = activeFileIdRef.current;
    const observedRevision = documentObservedRevisionRef.current;
    const dirtyRevision = documentDirtyRevisionRef.current;
    const documentAtStart = documentRef.current;
    if (observedRevision === null) {
      const result = { ok: false as const, error: t("versionHistory.restoreFailed") };
      setStatusMessage(result.error);
      return result;
    }
    const result = await runDocumentVersionRestore({
      captureBackup: () => captureDocumentVersion(createObservedDocumentWrite({
        fileId,
        document: documentRef.current,
        observedRevision,
      })),
      isContextCurrent: () => isDocumentVersionRestoreContextCurrent(
        { fileId, observedRevision, dirtyRevision, document: documentAtStart },
        {
          fileId: activeFileIdRef.current,
          observedRevision: documentObservedRevisionRef.current ?? -1,
          dirtyRevision: documentDirtyRevisionRef.current,
          document: documentRef.current,
        },
      ),
      applyVersion: () => commitDocumentChange(structuredClone(version.document)),
      saveRestoredDocument: saveCurrentDocumentRecord,
      applyRejectedError: t("versionHistory.restoreApplyRejected"),
      saveAppliedError: t("versionHistory.restoreAppliedSaveFailed"),
      fallbackError: t("versionHistory.restoreFailed"),
    });
    setStatusMessage(result.ok ? t("versionHistory.restored") : result.error);
    return result;
  };

  const aiConnection = useAiConnection();
  const claudeConnection = useClaudeConnection();
  const geminiConnection = useGeminiConnection();
  const maybeTriggerCommentAiRunRef = useRef<(threadId: string, body: InlineNode[], anchor: SigmaCommentAnchor) => void>(() => {});
  const {
    addPendingCommentThread,
    replyToCommentThread,
    updateCommentResolved,
    editCommentThread,
    editCommentMessage,
    appendReplyMessage,
    toggleCommentReaction,
    deleteCommentThread,
    deleteCommentMessage,
  } = useCommentActions({
    documentRef,
    commentAuthor,
    pendingCommentAnchor,
    pendingCommentDraft,
    commentReplyDrafts,
    commitDocumentChange,
    setPendingCommentAnchor,
    setPendingCommentDraft,
    setActiveCommentThreadId,
    setCommentsPanelOpen,
    setCommentReplyDraft,
    setStatusMessage,
    onCommentSubmittedRef: maybeTriggerCommentAiRunRef,
    mutationPorts: COMMENT_MUTATION_PORTS,
    defaultCommentColor: DEFAULT_COMMENT_COLOR,
    tEditor,
  });
  useCommentAiRun({
    documentRef,
    activeFileIdRef,
    connectedProviders: {
      chatgpt: aiConnection.state.kind === "loggedIn",
      claude: claudeConnection.state.kind === "loggedIn",
      antigravity: geminiConnection.state.kind === "loggedIn",
    },
    appendReplyMessage,
    editCommentMessage,
    refreshMcpEditProposals,
    onCommentSubmittedRef: maybeTriggerCommentAiRunRef,
    models: {
      chatgpt: DEFAULT_AI_EDIT_MODEL,
      claude: DEFAULT_CLAUDE_AI_EDIT_MODEL,
      antigravity: DEFAULT_GEMINI_AI_EDIT_MODEL,
    },
    reasoningEffort: DEFAULT_AI_EDIT_REASONING_EFFORT,
    runAiEdit: runAiEditViaDesktopRuntime,
    tEditor,
    tAi,
  });

  const restoreDocumentHistory = useCallback((direction: "undo" | "redo") => {
    // AI 側の状態は ref から読む (`aiLockedTargetsRef` の宣言のコメント参照)。書き込み中は
    // state のミラーではなく、書き込み開始と同時に立つ `mcpPreviewBusyRef` を直接見る。
    //
    // **`commitDocumentChange` と対称にしておく。** 文書を書き換える choke point は 2 つ
    // (通常の編集と履歴の巻き戻し) で、AI が握っている対象を守る条件は同じでなければならない。
    // 片方だけ state のミラーを読むと、書き込みが始まった直後の 1 手 —— つまり**いちばん
    // 危ない瞬間の ⌘Z** —— だけがすり抜ける。state はレンダー 1 回ぶん遅れて届く。
    const aiDocumentWriteInProgress = mcpPreviewBusyRef.current;
    const aiLockedTargets = aiLockedTargetsRef.current;
    if (aiDocumentWriteInProgress) {
      setStatusMessage(aiDocumentWriteInProgressMessage());
      return;
    }
    // Overlay edits reach the document on a short debounce. Undo pressed inside that window would
    // otherwise skip straight past the edit the user just made and swallow the previous one, so the
    // pending overlay change is committed first and becomes the step this undo takes back.
    window.dispatchEvent(new CustomEvent(FLUSH_OVERLAY_CHANGES_EVENT));
    // A restore swaps the whole document, so peek before either stack moves and
    // refuse only when the entry would alter what AI is holding. Undoing edits
    // elsewhere stays available during a run.
    const candidate = documentHistory.peek(direction);
    if (candidate) {
      const touchedAiTargets = findAiLockedTargetsTouched(
        documentRef.current,
        candidate.document,
        aiLockedTargets,
      );
      if (hasAiLockedTargetsTouched(touchedAiTargets)) {
        setStatusMessage(describeAiLockedTargets(aiLockedTargets, touchedAiTargets));
        return;
      }
    }
    const entry = direction === "undo"
      ? documentHistory.undo({
          document: documentRef.current,
          selection: {
            selectedId: selectedIdRef.current,
            textSelection: textSelectionBookmarkRef.current,
          },
        })
      : documentHistory.redo({
          document: documentRef.current,
          selection: {
            selectedId: selectedIdRef.current,
            textSelection: textSelectionBookmarkRef.current,
          },
        });

    if (!entry) {
      setStatusMessage(direction === "undo" ? tEditor("status.nothingToUndo") : tEditor("status.nothingToRedo"));
      return;
    }

    documentRef.current = entry.document;
    documentDirtyRevisionRef.current += 1;
    const nextDocumentStateStamp = documentDirtyRevisionRef.current;
    selectedIdRef.current = entry.selection.selectedId;
    textSelectionBookmarkRef.current = entry.selection.textSelection;
    pendingTextHistorySelectionRef.current = undefined;
    setDocument(entry.document);
    setDocumentStateStamp(nextDocumentStateStamp);
    setSelectedId(entry.selection.selectedId);
    setSelectedInlineMath(null);
    setCommentAnchorCandidate(null);
    setPendingCommentAnchor(null);
    setActiveCommentThreadId(null);
    setHistoryRevision((current) => current + 1);
    if (entry.selection.textSelection) {
      // 予約にする。同期で配ると `setDocument` が反映される前の ProseMirror doc に当たり、
      // 巻き戻し後の長さで clamp された選択がそのまま保存される。
      requestCaret(entry.selection.textSelection);
    }

    // AI適用エントリ: document の巻き戻し/やり直しに合わせて提案ストアの status も遷移させる
    // (undo: approved→reverted / redo: reverted→approved)。document 自体は上の通常undoと同じく
    // ローカル状態の差し替え + 既存の自動保存で永続化されるため、ここではstatus整合だけを取る。
    // ベストエフォート: IPCが失敗しても document の undo/redo 自体は成立させたままにする。
    const appliedProposalIds = entry.metadata?.correlationIds
      ? [...entry.metadata.correlationIds]
      : [];
    if (appliedProposalIds.length > 0) {
      const storage = getDesktopBridge()?.storage;
      const sync = direction === "undo"
        ? storage?.markMcpEditProposalsReverted
        : storage?.markMcpEditProposalsReapplied;
      if (sync) {
        sync(appliedProposalIds)
          .then(() => refreshMcpEditProposals())
          .catch((error) => {
            console.warn(tEditor("status.aiUndoStoreFailed"), error);
          });
      }
      setStatusMessage(direction === "undo" ? tEditor("status.aiUndone") : tEditor("status.aiRedone"));
      return;
    }
    setStatusMessage(direction === "undo" ? tEditor("status.undone") : tEditor("status.redone"));
  }, [documentHistory, refreshMcpEditProposals, setActiveCommentThreadId, setCommentAnchorCandidate, setPendingCommentAnchor, setSelectedId, setSelectedInlineMath, setStatusMessage]);

  const undoDocumentChange = useCallback(() => {
    restoreDocumentHistory("undo");
  }, [restoreDocumentHistory]);

  const redoDocumentChange = useCallback(() => {
    restoreDocumentHistory("redo");
  }, [restoreDocumentHistory]);

  useEffect(() => {
    // A deferred document render can lag behind documentRef. Only let state write
    // back after its paired revision has caught up to the latest committed change.
    syncDocumentRefWhenStateIsCurrent(
      documentRef,
      document,
      documentStateStamp,
      documentDirtyRevisionRef.current,
    );
    selectedIdRef.current = selectedId;
    activeFileIdRef.current = activeFileId;
    openFileIdsRef.current = openFileIds;
    workspaceReadyRef.current = workspaceReady;
  }, [activeFileId, document, documentStateStamp, openFileIds, selectedId, workspaceReady]);

  const lastEmbeddedInputRef = useRef(embeddedHost?.document);
  const lastEmittedEmbeddedDocumentRef = useRef(document);
  // ホストのonSaveがawait後に古いスナップショットをonChange経由で送り返す(エコー)
  // ことがある。それを外部更新と誤認してresetEditorDocumentを呼ぶと、再度dirty化
  // →自動保存→再エコー…と自走するループになる(スピナーが止まらない/入力が
  // フリッカーする不具合の原因)。ここではエディタ自身がembeddedHost.onChangeへ
  // 渡した文書のdocumentHistoryKeyを直近MAX_EMBEDDED_ECHO_KEYS件だけ覚えておき、
  // 同じdocId内でそのキーが戻ってきたらエコーとして無視する。docIdが変わる本物の
  // ドキュメント切替はこの記録に関わらず常に受け入れる。
  const MAX_EMBEDDED_ECHO_KEYS = 50;
  const emittedEchoKeysRef = useRef<Set<string>>(
    new Set(embeddedHost ? [documentHistoryKey(initialDocument)] : []),
  );
  const rememberEmittedEchoKey = useCallback((key: string) => {
    const seen = emittedEchoKeysRef.current;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    if (seen.size > MAX_EMBEDDED_ECHO_KEYS) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) {
        seen.delete(oldest);
      }
    }
  }, []);

  useEffect(() => {
    const nextInput = embeddedHost?.document;
    if (!nextInput || nextInput === lastEmbeddedInputRef.current) {
      return;
    }
    lastEmbeddedInputRef.current = nextInput;

    // ホストが本文の空な文書を送り続けても往復しないよう、比較は「直したあと」で行う
    // (`ensureEditableBody` は冪等・id 固定なので、直した結果は毎回同じ値になる)。
    const nextDocument = ensureEditableBody(nextInput).document;
    if (
      nextDocument === documentRef.current
      || areSigmaDocumentsEquivalent(nextDocument, documentRef.current)
    ) {
      return;
    }

    const isGenuineDocumentSwitch = nextInput.docId !== documentRef.current.docId;
    if (!isGenuineDocumentSwitch && emittedEchoKeysRef.current.has(documentHistoryKey(nextInput))) {
      return;
    }

    lastEmittedEmbeddedDocumentRef.current = nextInput;
    resetEditorDocument(nextDocument, undefined, null);
    setOpenFileIds([nextDocument.docId]);
    setActiveFileId(nextDocument.docId);
    setStatusMessage(tEditor("status.hostUpdated"));
  }, [embeddedHost?.document, resetEditorDocument, setStatusMessage]);

  useEffect(() => {
    if (!embeddedHost || document === lastEmittedEmbeddedDocumentRef.current) {
      return;
    }
    lastEmittedEmbeddedDocumentRef.current = document;
    rememberEmittedEchoKey(documentHistoryKey(document));
    embeddedHost.onChange(document);
  }, [document, embeddedHost, rememberEmittedEchoKey]);

  useEffect(() => {
    if (isEmbedded) {
      return;
    }

    let cancelled = false;

    const timeoutId = window.setTimeout(() => {
      initializeDocumentWorkspace()
        .then(async (workspace) => {
          if (cancelled) {
            return;
          }
          if (!workspace.ok) {
            setLedgerFailure(workspace.ledgerError);
            setWorkspaceReady(true);
            return;
          }

          const metadata = await listSavedDocuments();
          const requestedFileId = getRequestedFileId();
          const availableFileIds = new Set(metadata.map((item) => item.fileId));
          const firstLocalFileId = metadata[0]?.fileId;
          const candidateFileIds = uniqueStringIds([
            ...(requestedFileId ? [requestedFileId] : []),
            ...(availableFileIds.has(workspace.state.activeFileId) ? [workspace.state.activeFileId] : []),
            ...(metadata[0] ? [metadata[0].fileId] : []),
            ...(firstLocalFileId ? [firstLocalFileId] : []),
          ]);
          if (candidateFileIds.length === 0) {
            throw new Error(tEditor("status.noSavedDocuments"));
          }

          // ローカルの候補を順に開き、読み込めない候補は読み飛ばす。
          let nextActiveFileId: string | null = null;
          let activeDocument: { document: SigmaDocument; observedRevision: number } | null = null;
          let openFailure: DocumentOpenFailure | null = null;
          for (const candidateFileId of candidateFileIds) {
            const candidate = await loadWorkspaceDocument(candidateFileId);
            if (cancelled) {
              return;
            }
            if (candidate) {
              nextActiveFileId = candidateFileId;
              activeDocument = candidate;
              break;
            }
            // 教材の中身 (壊れたJSON / スキーマ違反) が原因の失敗は読み飛ばさない。
            // 黙って別教材が開くと「Sigma Studioが開けない」ように見えるため、
            // その教材を開いたまま原因と修復プロンプトを出す。
            openFailure = showRecordedDocumentOpenFailure(candidateFileId);
            if (openFailure) {
              break;
            }
          }

          if (openFailure) {
            const nextOpenFileIds = uniqueStringIds([
              ...workspace.state.openFileIds.filter((fileId) => availableFileIds.has(fileId)),
              openFailure.fileId,
            ]);
            await refreshDocumentMetadatas();
            setWorkspaceReady(true);
            await enterDocumentOpenFailureState(openFailure, nextOpenFileIds);
            if (requestedFileId) {
              clearRequestedFileId();
            }
            return;
          }

          if (activeDocument && nextActiveFileId) {
            const migrated = repairDuplicateTopLevelIds(
              ensurePageLayout(activeDocument.document),
              DOCUMENT_BLOCK_OPERATION_PORTS,
            );
            const nextOpenFileIds = uniqueStringIds([
              ...workspace.state.openFileIds.filter((fileId) => availableFileIds.has(fileId)),
              nextActiveFileId,
            ]);
            resetEditorDocument(
              migrated,
              undefined,
              activeDocument.observedRevision,
            );
            setOpenFileIds(nextOpenFileIds);
            setActiveFileId(nextActiveFileId);
            await refreshDocumentMetadatas();
            setWorkspaceReady(true);
            await saveWorkspaceState({ openFileIds: nextOpenFileIds, activeFileId: nextActiveFileId });
            if (requestedFileId) {
              clearRequestedFileId();
            }
            setStatusMessage(storageWarningOrStatus(requestedFileId && nextActiveFileId !== requestedFileId
              ? tEditor("status.fallbackDocument")
              : tEditor("status.ready")));
            return;
          }

          const fallback = await createNewDocument();
          if (cancelled) {
            return;
          }

          resetEditorDocument(fallback.document, undefined, fallback.metadata.revision);
          setOpenFileIds([fallback.fileId]);
          setActiveFileId(fallback.fileId);
          await refreshDocumentMetadatas();
          setWorkspaceReady(true);
          if (requestedFileId) {
            clearRequestedFileId();
          }
          setStatusMessage(storageWarningOrStatus(tEditor("status.documentCreated")));
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          setSaveState("error");
          setStatusMessage(error instanceof Error ? error.message : tEditor("status.restoreFailed"));
          setWorkspaceReady(true);
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    enterDocumentOpenFailureState,
    isEmbedded,
    loadWorkspaceDocument,
    refreshDocumentMetadatas,
    resetEditorDocument,
    setSaveState,
    setStatusMessage,
    showRecordedDocumentOpenFailure,
    workspaceReloadNonce,
  ]);

  useEffect(() => {
    if (!isDesktopApp || !workspaceReady) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void refreshMcpEditProposals();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [activeFileId, isDesktopApp, refreshMcpEditProposals, workspaceReady]);

  useEffect(() => {
    if (!workspaceReady || ledgerFailure) {
      return;
    }

    // 開けなかった教材がアクティブな間は自動保存しない (saveCurrentDocumentRecord と同じ理由)。
    if (documentOpenFailureRef.current?.fileId === activeFileId) {
      return;
    }

    // documentはeffectのデバウンス起点。保存時点ではdocumentRefから最新内容を取り直し、
    // 承認後に古いrender snapshotをIPCへ渡さない。
    void document;
    const saveRevision = documentDirtyRevisionRef.current;
    // A clean document has nothing to persist; skipping keeps the save indicator
    // quiet (no saving→saved flicker) when switching tabs or opening documents.
    // Use a numeric dirty revision here so typing does not stringify the whole
    // SigmaDoc on every document state update.
    if (saveRevision <= lastSavedDirtyRevisionRef.current) {
      return;
    }

    if (isEmbedded) {
      let cancelled = false;
      const timeoutId = window.setTimeout(() => {
        const host = embeddedHostRef.current;
        setSaveState("saving");
        Promise.resolve(host?.onSave?.(document))
          .then(() => {
            if (cancelled) {
              return;
            }
            lastSavedDocumentRef.current = document;
            lastSavedDirtyRevisionRef.current = saveRevision;
            lastSyncedDocumentRef.current = document;
            setSaveState("saved");
            setStatusMessage(host?.onSave ? tEditor("status.hostAutosaved") : tEditor("status.hostSynced"));
          })
          .catch((error) => {
            if (cancelled) {
              return;
            }
            setSaveState("error");
            setStatusMessage(error instanceof Error ? error.message : tEditor("status.saveFailed"));
          });
      }, 450);

      const cancelAutosave = () => {
        cancelled = true;
        window.clearTimeout(timeoutId);
      };
      cancelPendingAutosaveRef.current = cancelAutosave;
      return () => {
        cancelAutosave();
        if (cancelPendingAutosaveRef.current === cancelAutosave) {
          cancelPendingAutosaveRef.current = () => undefined;
        }
      };
    }

    let cancelled = false;
    const savingTimeoutId = window.setTimeout(() => {
      if (
        externalChangeFileIdsRef.current.has(activeFileId)
        || mcpPreviewBusyRef.current
      ) {
        scheduleAutosaveRetry();
        return;
      }
      setSaveState("saving");
    }, 0);
    const timeoutId = window.setTimeout(async () => {
      // 直列化: 進行中の保存が終わるまで次を送らない。
      //
      // 重ねて投げると 2 本目は 1 本目が確定させる前の observedRevision で CAS に入るため、
      // 中身が競合していなくても revision-mismatch になり「他の変更を読み込んでいます」に落ちる。
      // 待ってから下の判定と snapshot を作ることが重要 — 待った後に revision だけ取り直すと、
      // 古い document に新しい revision を貸すことになり `ObservedDocumentWrite` が
      // 防いでいる lost update そのものになる。ここでは本文も revision も待機後に読む。
      // 1 回待つだけでは足りない: 待っている間に明示保存 (AI 承認前の flush 等) が
      // 始まると `.current` が差し替わり、結局それと重なって走ってしまう。
      while (inFlightSavePromiseRef.current) {
        await inFlightSavePromiseRef.current.catch(() => undefined);
        if (cancelled) {
          return;
        }
      }
      // 明示save（AI提案承認前のflush/save等）がこのtimerより先に同revisionを保存した
      // 場合、古いdocument snapshotで後から上書きしない。timer作成時の判定だけでは、
      // 承認IPC中に450msを跨いだときstale autosaveがAI適用結果の後へ並ぶraceが残る。
      if (saveRevision <= lastSavedDirtyRevisionRef.current) {
        return;
      }
      if (
        externalChangeFileIdsRef.current.has(activeFileId)
        || mcpPreviewBusyRef.current
      ) {
        scheduleAutosaveRetry();
        return;
      }
      const revisionToSave = documentDirtyRevisionRef.current;
      if (revisionToSave <= lastSavedDirtyRevisionRef.current) {
        return;
      }
      const nextDocument = {
        ...documentRef.current,
        updatedAt: new Date().toISOString(),
      };
      const observedRevision = documentObservedRevisionRef.current;
      if (observedRevision === null) {
        setSaveState("error");
        setStatusMessage(tEditor("status.saveRevisionUnknown"));
        return;
      }
      const write = createObservedDocumentWrite({
        fileId: activeFileId,
        document: nextDocument,
        observedRevision,
      });
      const saveTask = saveDocumentRecord(write)
        .then(async (result) => {
          updateVersionHistoryCaptureStatus(activeFileId, result);
          if (result.ok) {
            const savedFileIsActive = recordSuccessfulDocumentSave({
              savedByFileId: successfulDocumentSavesRef.current,
              save: {
                fileId: activeFileId,
                document: nextDocument,
                revision: result.revision ?? observedRevision + 1,
                dirtyRevision: revisionToSave,
              },
              activeFileId: activeFileIdRef.current,
              observedRevisionRef: documentObservedRevisionRef,
              lastSavedDocumentRef,
              lastSavedDirtyRevisionRef,
              lastSyncedDocumentRef,
            });
            // Effect cleanup means its UI snapshot is stale, not that the completed
            // write did not happen. Same-file refs above must advance even when a
            // newer keystroke has already created the next autosave effect.
            if (cancelled || !savedFileIsActive) {
              return;
            }
            if (!openFileIds.includes(activeFileId)) {
              const nextOpenFileIds = uniqueStringIds([...openFileIds, activeFileId]);
              setOpenFileIds(nextOpenFileIds);
              await saveWorkspaceState({ openFileIds: nextOpenFileIds, activeFileId });
            }
            await refreshDocumentMetadatas();
            if (cancelled) {
              return;
            }
            setSaveState(result.versionCaptureError ? "warning" : "saved");
            setStatusMessage(result.versionCaptureError
              ? t("versionHistory.captureWarning")
              : result.error
                ? tEditor("status.localAutosavedWith", { reason: result.error })
                : isDesktopApp
                  ? tEditor("status.localAutosavedThisPc")
                  : tEditor("status.localAutosaved"));
          } else if (result.code === "revision-mismatch") {
            // queued済みの古いpayloadは一切mergeせず破棄する。metadataだけを読み直して
            // revisionを進めると同じstale payloadがCASを通るため、documentRefを外部変更
            // 取り込みで更新できるまでは再保存しない。
            if (activeFileIdRef.current === activeFileId) {
              dispatchDocumentStorageChange({
                type: "document",
                fileId: activeFileId,
                change: "changed",
                timestamp: Date.now(),
              });
              if (!cancelled) {
                setSaveState("error");
                setStatusMessage(tEditor("status.reloadingOtherChanges"));
              }
            }
          } else {
            if (!cancelled && activeFileIdRef.current === activeFileId) {
              setSaveState("error");
              setStatusMessage(result.error ?? tEditor("status.saveFailedShort"));
            }
          }
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          setSaveState("error");
          setStatusMessage(error instanceof Error ? error.message : tEditor("status.saveFailedShort"));
        });
      void trackInFlightSave(inFlightSavePromiseRef, saveTask);
    }, 450);

    const cancelAutosave = () => {
      cancelled = true;
      window.clearTimeout(savingTimeoutId);
      window.clearTimeout(timeoutId);
    };
    cancelPendingAutosaveRef.current = cancelAutosave;
    return () => {
      cancelAutosave();
      if (cancelPendingAutosaveRef.current === cancelAutosave) {
        cancelPendingAutosaveRef.current = () => undefined;
      }
    };
  }, [
    activeFileId,
    autosaveRetry,
    dispatchDocumentStorageChange,
    document,
    isDesktopApp,
    isEmbedded,
    ledgerFailure,
    openFileIds,
    refreshDocumentMetadatas,
    scheduleAutosaveRetry,
    setSaveState,
    setStatusMessage,
    t,
    updateVersionHistoryCaptureStatus,
    workspaceReady,
  ]);

  useEffect(() => {
    // これから生まれるエディタが初期 state に使う「現在の検索語」はシェルが宣言する
    // (マウント時の空文字も含めて必ず通るので、前のシェルの検索語を引きずらない)。
    setLatestSearchQuery(searchQuery);

    // 通知は検索語が変わった時だけ。文書は deps に入れない — ハイライトは各エディタの
    // プラグイン state に入った検索語と doc から毎回導出されるので、打鍵のたびに通知し直すと
    // 本文ユニット数だけ ProseMirror の transaction が増えるだけで表示は変わらない。
    if (!shouldDispatchSearchQuery(lastDispatchedSearchQueryRef.current, searchQuery)) {
      return;
    }

    // Debounced so per-keystroke highlight updates don't re-render the document.
    const timeoutId = window.setTimeout(() => {
      lastDispatchedSearchQueryRef.current = searchQuery;
      window.dispatchEvent(new CustomEvent(SEARCH_QUERY_EVENT, { detail: { query: searchQuery } }));
    }, searchQuery ? 150 : 0);
    return () => window.clearTimeout(timeoutId);
  }, [searchQuery]);

  useEffect(() => {
    const selectInlineMath = (event: Event) => {
      if (!(event instanceof CustomEvent)) {
        return;
      }

      const detail = event.detail as Partial<SelectedInlineMath> | null;
      if (!detail || typeof detail.id !== "string" || typeof detail.tex !== "string" || typeof detail.updateTex !== "function") {
        return;
      }

      const id = detail.id;
      const updateTex = detail.updateTex;
      const setCursor = typeof detail.setCursor === "function" ? detail.setCursor : undefined;
      const cursor = typeof detail.cursor === "number" ? detail.cursor : detail.tex.length;
      const blockId =
        typeof detail.blockId === "string"
          ? detail.blockId
          : getInlineMathBlockIdFromDom(id);

      setSelectedInlineMath({
        id,
        tex: detail.tex,
        cursor,
        blockId,
        setCursor: setCursor
          ? (nextCursor) => {
              setCursor(nextCursor);
              setSelectedInlineMath((current) => (current?.id === id ? { ...current, cursor: nextCursor } : current));
            }
          : undefined,
        updateTex: (tex, nextCursor) => {
          updateTex(tex);
          if (typeof nextCursor === "number") {
            setCursor?.(nextCursor);
          }
          setSelectedInlineMath((current) => (
            current?.id === id
              ? { ...current, tex, cursor: typeof nextCursor === "number" ? nextCursor : current.cursor }
              : current
          ));
        },
      });
      if (blockId) {
        selectedIdRef.current = blockId;
        setSelectedId(blockId);
      }
    };

    window.addEventListener(SELECT_INLINE_MATH_EVENT, selectInlineMath);
    return () => window.removeEventListener(SELECT_INLINE_MATH_EVENT, selectInlineMath);
  }, [setSelectedId, setSelectedInlineMath]);

  useEffect(() => {
    const handleOverlayGraphSelect = (event: Event) => {
      const detail = event instanceof CustomEvent ? (event.detail as SelectedOverlayGraph | null) : null;
      if (!detail) {
        pendingOverlayGraphEditsRef.current = null;
      }
      if (!detail && graphSettingsShapeIdRef.current) {
        // パネル自体は非モーダルなので、その内部を操作してもグラフ選択は維持される。
        // 本文・空白・別図形へ選択が移り detail が null になった時だけ閉じる。
        closeGraphSettings();
      }
      if (detail && graphSettingsShapeIdRef.current && detail.shapeId !== graphSettingsShapeIdRef.current) {
        // 別のグラフへ選択が移ったら閉じる。閉じないと state だけ残り、
        // 元のグラフを選び直したときにパネルが独りでに復活する。
        closeGraphSettings();
      }

      const merged = detail
        ? mergeOverlayGraphDetailWithPending(detail, pendingOverlayGraphEditsRef.current)
        : { detail: null, pending: null };
      pendingOverlayGraphEditsRef.current = merged.pending;
      setSelectedOverlayGraph((current) => (
        areSelectedOverlayGraphsEqual(current, merged.detail) ? current : merged.detail
      ));
    };

    window.addEventListener(SELECT_OVERLAY_GRAPH_EVENT, handleOverlayGraphSelect);
    return () => window.removeEventListener(SELECT_OVERLAY_GRAPH_EVENT, handleOverlayGraphSelect);
  }, [closeGraphSettings]);

  useEffect(() => {
    const handleOverlayChartSelect = (event: Event) => {
      const detail = event instanceof CustomEvent ? (event.detail as SelectedOverlayChart | null) : null;
      if (chartSettingsShapeIdRef.current && (!detail || detail.shapeId !== chartSettingsShapeIdRef.current)) {
        // Selection left this chart: close, or the panel state lingers and the panel reappears by
        // itself the next time the same chart is selected.
        closeChartSettings();
      }
      // The canvas re-dispatches on every commit, so an equal payload must not call `setState` —
      // that is the shell/canvas re-render loop the graph panel already guards against.
      setSelectedOverlayChart((current) => (
        areSelectedOverlayChartsEqual(current, detail) ? current : detail
      ));
    };

    window.addEventListener(SELECT_OVERLAY_CHART_EVENT, handleOverlayChartSelect);
    return () => window.removeEventListener(SELECT_OVERLAY_CHART_EVENT, handleOverlayChartSelect);
  }, [closeChartSettings]);

  useEffect(() => {
    const handleOpenOverlayChartSettings = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as { shapeId?: unknown } | null : null;
      if (typeof detail?.shapeId === "string") {
        openChartSettings(detail.shapeId);
      }
    };

    window.addEventListener(OPEN_OVERLAY_CHART_SETTINGS_EVENT, handleOpenOverlayChartSettings);
    return () => window.removeEventListener(OPEN_OVERLAY_CHART_SETTINGS_EVENT, handleOpenOverlayChartSettings);
  }, [openChartSettings]);

  useEffect(() => {
    const handleOpenOverlayGraphSettings = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as { shapeId?: unknown } | null : null;
      if (typeof detail?.shapeId === "string") {
        openGraphSettings(detail.shapeId);
      }
    };

    window.addEventListener(OPEN_OVERLAY_GRAPH_SETTINGS_EVENT, handleOpenOverlayGraphSettings);
    return () => window.removeEventListener(OPEN_OVERLAY_GRAPH_SETTINGS_EVENT, handleOpenOverlayGraphSettings);
  }, [openGraphSettings]);

  useEffect(() => {
    const handleOpenOverlayGraph3DSettings = (event: Event) => {
      const detail = event instanceof CustomEvent
        ? event.detail as { shapeId?: unknown } | null
        : null;
      if (typeof detail?.shapeId === "string") openGraph3DSettings(detail.shapeId);
    };
    window.addEventListener(OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT, handleOpenOverlayGraph3DSettings);
    return () => window.removeEventListener(OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT, handleOpenOverlayGraph3DSettings);
  }, [openGraph3DSettings]);

  useEffect(() => {
    const closeTransientUi = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      setActiveMenu(null);
      setExportMenuOpen(false);
      setShapeMenuOpen(false);
      setLineToolMenuOpen(false);
      setFontFamilyMenuOpen(false);
      setBlockStyleMenuOpen(false);
      setBoxedTextMenuOpen(false);
      setLineHeightMenuOpen(false);
      setTextAlignMenuOpen(false);
      setLineDashMenuOpen(false);
      setLineWidthMenuOpen(false);
      setLineEndpointMenu(null);
      setColorStylePanel(null);
      setSearchOpen(false);
      setMaterialActionMenu(null);
      // Word風の Backstage も Esc で閉じる（capture ガードは Escape だけ通す）。
      setRibbonBackstage((current) => closeBackstageState(current));
      // 折りたたみ中に浮かせているリボン本体も畳む（折りたたみ自体は解除しない）。
      setRibbonOverlayOpen(false);
    };

    window.addEventListener("keydown", closeTransientUi);
    return () => window.removeEventListener("keydown", closeTransientUi);
  }, [setMaterialActionMenu]);

  useEffect(() => registerEditorClipboardEvents({
    overlayEditing,
    selectedInlineMath,
    getSelectedBlock: () => selectedIdRef.current
      ? documentRef.current.content.find((block) => block.id === selectedIdRef.current) ?? null
      : null,
    isMaterialEditing: () => materialEditingOpenRef.current,
    insertBlocks: (paste) => {
      commitDocumentChange((current) => paste.kind === "documentBlocks"
        ? insertTopLevelDocumentBlocks(current, selectedIdRef.current, paste.blocks, DOCUMENT_BLOCK_OPERATION_PORTS)
        : insertTopLevelTextFlowBlocks(current, selectedIdRef.current, paste.blocks));
      const nextSelectedId = paste.blocks[paste.blocks.length - 1]?.id ?? null;
      selectedIdRef.current = nextSelectedId;
      setSelectedId(nextSelectedId);
      setSelectedInlineMath(null);
    },
    pasteShapes: (payload) => {
      overlayActionRequestIdRef.current += 1;
      setOverlayActionRequest({ id: overlayActionRequestIdRef.current, type: "pasteShapes", payload });
    },
    setCanPasteProblem,
    setStatusMessage,
    translate: tEditor,
  }), [materialEditingOpenRef, commitDocumentChange, overlayEditing, selectedInlineMath, setSelectedId, setSelectedInlineMath, setStatusMessage]);

  // 画面のアウトラインは表示言語で引く (`t` を省略すると `collectOutline` の既定 =
  // 日本語になる。既定が日本語なのは AI / MCP の呼び出しを固定するため)。
  // 画面のアウトラインは表示言語で引く (`t` を省略すると `collectOutline` の既定 =
  // 日本語になる。既定が日本語なのは AI / MCP の呼び出しを固定するため)。
  const outline = useMemo(
    () => collectOutline(document, { t: tE, includeLayoutHeadings: true }),
    [document, tE],
  );
  const outlineHeadingNumbers = useMemo(
    () => getHeadingNumberMap(document.content, document.metadata.headingNumbering),
    [document.content, document.metadata.headingNumbering],
  );
  // コメント装飾は本文ユニットごとの effect で更新されるので、コメントの無い文書で
  // 毎回新しい空配列を渡すと打鍵のたびにユニット数だけ無駄な更新が走る。
  const commentThreads = document.comments ?? EMPTY_COMMENT_THREADS;
  const updateActivePageFromScroll = useCallback(() => {
    const nextPageNumber = getVisibleEditorPageNumber(editorCanvasRef.current, documentRef.current, zoom);
    if (!nextPageNumber) {
      return;
    }

    setActivePageNumber((current) => current === nextPageNumber ? current : nextPageNumber);
  }, [zoom]);
  const scrollToPage = useCallback((pageNumber: number) => {
    if (!scrollEditorCanvasToPage(editorCanvasRef.current, documentRef.current, zoom, pageNumber)) {
      return;
    }

    setActivePageNumber(pageNumber);
  }, [zoom]);
  const selectOutlineItem = useCallback((blockId: string) => {
    setSelectedInlineMath(null);
    if (blockId !== selectedIdRef.current) {
      setAiEditReference(null);
    }
    selectedIdRef.current = blockId;
    materialBlockSelectionRef.current = blockId;
    setSelectedId(blockId);
    setOutlineDialogOpen(false);
    window.document.getElementById(blockId)?.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }, [setSelectedId, setSelectedInlineMath, setOutlineDialogOpen]);

  useEffect(() => {
    if (!workspaceReady) {
      return;
    }

    const scroller = editorCanvasRef.current;
    if (!scroller) {
      return;
    }

    let frame = 0;
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateActivePageFromScroll);
    };

    scheduleUpdate();
    scroller.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [
    activeFileId,
    document.content.length,
    document.pageLayout,
    updateActivePageFromScroll,
    workspaceReady,
  ]);

  const selectedBlock = useMemo(() => {
    return selectedId ? findBlock(document, selectedId) : null;
  }, [document, selectedId]);
  const aiLockedBodySelection = isAiLockedBlock(aiLockedTargets, selectedId);
  const aiLockedOverlaySelection = isAiLockedShapeSelection(aiLockedTargets, overlaySelection.selectedShapeIds);
  const bodyToolbarLockedByAi = aiDocumentWriteInProgress || aiLockedBodySelection;
  const overlayToolbarLockedByAi = aiDocumentWriteInProgress || aiLockedOverlaySelection;
  const textToolbar = resolveTextToolbarTarget({
    selectedBlock,
    documentTextTarget: documentTextFormatTarget,
    hasTextRunSpan: hasMultiEditorTextRunSpan,
    runningRegionEditing: !!runningRegionEditingKind,
    overlayEditing,
    overlaySelection,
    bodyLocked: bodyToolbarLockedByAi,
    overlayLocked: overlayToolbarLockedByAi,
  });
  const canFormatSelectedText = textToolbar.canFormatSelectedText;
  const selectedTextStyle =
    selectedBlock?.type === "section"
      ? "h1"
      : selectedBlock?.type === "heading"
      ? `h${selectedBlock.level}`
      : selectedBlock?.type === "paragraph" || selectedBlock?.type === "listItem"
        ? "paragraph"
        : "";
  const canAlignSelectedText =
    selectedBlock?.type === "section" ||
    selectedBlock?.type === "paragraph" ||
    selectedBlock?.type === "heading" ||
    selectedBlock?.type === "listItem";
  const selectedTextAlign = canAlignSelectedText ? selectedBlock.align ?? "left" : "left";
  const activeTextAlignOption = TEXT_ALIGN_OPTIONS.find((option) => option.value === selectedTextAlign) ?? TEXT_ALIGN_OPTIONS[0];
  const ActiveTextAlignIcon = activeTextAlignOption.icon;
  const customFontOptions = useMemo(
    () => customFonts.map((font) => ({ label: font.displayName, value: font.cssFamily })),
    [customFonts],
  );
  const visibleFontFamilyGroups = useMemo(
    () => filterFontFamilyGroups(fontFamilyQuery, (group) => t(`format.font.group.${group.id}`)),
    [fontFamilyQuery, t],
  );
  const visibleCustomFontOptions = useMemo(() => {
    const query = fontFamilyQuery.trim().toLocaleLowerCase("ja");
    if (!query) {
      return customFontOptions;
    }
    return customFontOptions.filter((option) => (
      `${option.label} ${option.value}`.toLocaleLowerCase("ja").includes(query)
    ));
  }, [customFontOptions, fontFamilyQuery]);
  const activeFontFamilyLabel = getFontFamilyLabel(fontFamily, customFontOptions);
  // Empty = the selection mixes fonts, so there is no "current font" to show. Without this the
  // dropdown would render a nameless row marked as the checked option.
  const fontFamilyIsMixed = fontFamily === "";
  const fontFamilyIsKnownOption = fontFamilyIsMixed
    || FONT_FAMILY_OPTION_VALUES.has(fontFamily)
    || customFontOptions.some((option) => option.value === fontFamily);
  const hasOverlaySelection = overlaySelection.selectedCount > 0;
  const canUseTextToolbar = textToolbar.enabled;
  const canUseLineHeight = textToolbar.canUseLineHeight;
  const wholeTextShape = textToolbar.wholeTextShape;
  const [wholeTextShapeMeasurement, setWholeTextShapeMeasurement] = useState<{
    shape: NonNullable<typeof wholeTextShape>;
    size: SelectionFontSize | null;
  } | null>(null);
  useLayoutEffect(() => {
    if (!wholeTextShape) return;
    // Measure after the overlay's derived DOM has committed its new marks and typography.
    const frame = window.requestAnimationFrame(() => {
      const root = editorCanvasRef.current?.querySelector<HTMLElement>(
        `[data-overlay-shape-id="${CSS.escape(wholeTextShape.id)}"] .overlay-text-shape-content`,
      );
      setWholeTextShapeMeasurement({ shape: wholeTextShape, size: root ? readRenderedTextFontSize(root) : null });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [wholeTextShape]);
  // A measurement belongs to this exact shape revision, never the previously selected shape.
  const wholeTextShapeSize = wholeTextShapeMeasurement?.shape === wholeTextShape
    ? wholeTextShapeMeasurement?.size : null;
  const activeTextFontSize = wholeTextShape
    ? wholeTextShapeSize?.fontSize ?? getTextShapeFontSizePt(wholeTextShape)
    : textFontSize ?? BASE_EDITOR_FONT_SIZE;
  const activeTextFontSizeMixed = wholeTextShape ? wholeTextShapeSize?.fontSizeMixed === true : textFontSizeMixed;
  useLayoutEffect(() => {
    // Sync before paint so a newly selected shape never displays the old size.
    // Keep the inline field in sync with the selection without replacing a value
    // while the user is in the middle of editing it.
    if (fontSizeInputRef.current === window.document.activeElement) return;
    setFontSizeInput(String(activeTextFontSize));
  }, [activeTextFontSize]);
  const canUseTextBlockStyle = textToolbar.canUseTextBlockStyle;
  /**
   * ブロックのボタン (箇条書き・番号付き・引用・コード・区切り線) を押せるか。
   *
   * **いま居るブロックを解除するのも、このボタンの仕事**。だから「文章の書式が使える対象か」
   * (`canUseTextBlockStyle`) だけで閉じてはいけない — 区切り線そのものを選んでいるときのように、
   * 文字書式の対象ではないが解除はしたい状態がある。ブロックの中に居ることが分かっていれば通す。
   */
  const canUseBlockStructure = textToolbar.canUseOverlayBlockStructure
    || canUseTextBlockStyle
    || (!overlayEditing && !bodyToolbarLockedByAi && (
      blockStyleState.onDivider
      || blockStyleState.inQuoteBlock
      || blockStyleState.inCodeBlock
      || blockStyleState.listType !== null
    ));
  const canUseTextAlign = textToolbar.canUseTextAlign;
  const canUseStrokeStyleControls = !overlayToolbarLockedByAi && hasOverlaySelection && overlaySelection.canStyleStroke;
  const canArrangeOverlayShapes = !overlayToolbarLockedByAi && hasOverlaySelection && !overlaySelection.locked;
  const canUseFillStyleControls = !overlayToolbarLockedByAi && hasOverlaySelection && overlaySelection.canStyleFill;
  // The selection's own fill, not the last value the toolbar applied: reopening the palette on a
  // saved figure has to show what that figure stores, and a disagreeing selection has to show
  // nothing rather than one shape's value.
  const selectionFill = overlaySelection.fill;
  const selectionFillColor = selectionFill.kind === "solid" ? selectionFill.fillColor : null;
  const selectionFillOpacity = selectionFill.kind === "solid" ? selectionFill.fillOpacity : DEFAULT_FILL_OPACITY;
  /**
   * A colour-only change (a swatch, a shortcut, a custom command).
   *
   * `fillOpacity` is deliberately omitted so the figure keeps the transparency it already has —
   * except when that transparency is 0, where keeping it would answer a colour choice with no
   * visible change at all and no way to find out why.
   */
  const fillColorPatch = (color: string): OverlaySelectionStylePatch => (
    selectionFill.kind === "solid" && selectionFill.fillOpacity === 0
      ? { fill: "solid", fillColor: color, fillOpacity: DEFAULT_FILL_OPACITY }
      : { fill: "solid", fillColor: color }
  );
  const canUseLineStyleControls = !overlayToolbarLockedByAi && hasOverlaySelection && overlaySelection.canStyleLine;
  const canUseLineEndpointControls = !overlayToolbarLockedByAi && hasOverlaySelection && overlaySelection.canStyleLineEndpoints;

  const selectedOverlayLineDash = useMemo(
    () => getSharedOverlayLineDash(overlaySelection.selectedShapes),
    [overlaySelection.selectedShapes],
  );
  const selectedOverlayLineSize = useMemo(
    () => getSharedOverlayLineSize(overlaySelection.selectedShapes),
    [overlaySelection.selectedShapes],
  );
  // 打鍵ごとに走る `renderEditorChrome` へ渡るので、言語が変わったときだけ組み直す。
  const lineToolItems = useMemo(() => buildLineToolItems(tShapeChrome), [tShapeChrome]);
  const shapeGallerySections = useMemo(() => buildShapeGallerySections(tShapeChrome), [tShapeChrome]);
  const activeLineToolItem =
    activeOverlayTool.kind === "insert" && isLineToolCommand(activeOverlayTool.command)
      ? lineToolItems.find((item) => item.command === activeOverlayTool.command) ?? lineToolItems[0]
      : lineToolItems[0];
  const ActiveLineToolIcon = activeLineToolItem.icon;
  const zoomOptions = useMemo(() => {
    return ZOOM_PRESETS.includes(zoom as (typeof ZOOM_PRESETS)[number])
      ? ZOOM_PRESETS
      : [...ZOOM_PRESETS, zoom].sort((a, b) => a - b);
  }, [zoom]);

  const effectiveLineEndpointMenu = canUseLineEndpointControls ? lineEndpointMenu : null;
  const effectiveLineDashMenuOpen = canUseLineStyleControls && lineDashMenuOpen;
  const effectiveLineWidthMenuOpen = canUseLineStyleControls && lineWidthMenuOpen;
  const updateInlineMathTexFromDetails = useCallback((mathInlineId: string, tex: string, cursor?: number) => {
    if (!mathInlineId) {
      return;
    }

    commitDocumentChange((current) => updateInlineMathTexInDocument(current, mathInlineId, tex));
    setSelectedInlineMath((current) => (
      current?.id === mathInlineId
        ? { ...current, tex, cursor: typeof cursor === "number" ? cursor : current.cursor }
        : current
    ));
  }, [commitDocumentChange, setSelectedInlineMath]);
  const selectedInlineMathDetails = useMemo((): SelectedInlineMath | null => {
    if (!selectedInlineMath) {
      return null;
    }

    return {
      ...selectedInlineMath,
      updateTex: (tex, cursor) => {
        const restoredSelection: SelectedInlineMath = {
          ...selectedInlineMath,
          tex,
          cursor: typeof cursor === "number" ? cursor : selectedInlineMath.cursor,
        };
        updateInlineMathDraft(selectedInlineMath.id, tex, cursor);
        updateInlineMathTexFromDetails(selectedInlineMath.id, tex, cursor);
        window.setTimeout(() => {
          setSelectedInlineMath((current) => (
            current?.id === selectedInlineMath.id
              ? { ...current, tex, cursor: typeof cursor === "number" ? cursor : current.cursor }
              : restoredSelection
          ));
        }, 0);
      },
    };
  }, [selectedInlineMath, setSelectedInlineMath, updateInlineMathTexFromDetails]);

  useEffect(() => {
    if (selectedInlineMath) {
      return;
    }

    const timeoutId = window.setTimeout(() => setInlineMathMenuOpen(false), 0);
    return () => window.clearTimeout(timeoutId);
  }, [selectedInlineMath]);
  const selectedOverlayGraphForSettings = useMemo((): SelectedOverlayGraph | null => {
    if (!selectedOverlayGraph) {
      return null;
    }

    return {
      ...selectedOverlayGraph,
      onAxisLabelChange: (key, visible) => {
        recordPendingAxisLabelEdit(
          selectedOverlayGraph.shapeId,
          key,
          { visible },
        );
        setSelectedOverlayGraph((current) => {
          if (!current || current.shapeId !== selectedOverlayGraph.shapeId) {
            return current;
          }

          return applyOverlayGraphAxisLabelEdit(current, key, { visible });
        });
        selectedOverlayGraph.onAxisLabelChange(key, visible);
      },
      onAxisLabelTextChange: (key, text) => {
        const edit = {
          visible: Boolean(text.trim()),
          text,
        };
        recordPendingAxisLabelEdit(
          selectedOverlayGraph.shapeId,
          key,
          edit,
        );
        setSelectedOverlayGraph((current) => {
          if (!current || current.shapeId !== selectedOverlayGraph.shapeId) {
            return current;
          }

          return applyOverlayGraphAxisLabelEdit(current, key, edit);
        });
        selectedOverlayGraph.onAxisLabelTextChange(key, text);
      },
      onSpecChange: (nextSpec) => {
        recordPendingSpecEdit(
          selectedOverlayGraph.shapeId,
          nextSpec,
        );
        setSelectedOverlayGraph((current) => {
          if (!current || current.shapeId !== selectedOverlayGraph.shapeId) {
            return current;
          }

          return areGraphSpecsEqual(current.spec, nextSpec) ? current : { ...current, spec: nextSpec };
        });
        selectedOverlayGraph.onSpecChange(nextSpec);
      },
    };
  }, [recordPendingAxisLabelEdit, recordPendingSpecEdit, selectedOverlayGraph]);
  // The ref-backed callbacks on this value run only from panel events, never while rendering.
  const overlayGraphSettingsDialog = graphSettingsShapeId
    // eslint-disable-next-line react-hooks/refs
    && selectedOverlayGraphForSettings?.shapeId === graphSettingsShapeId
    ? (
        <GraphSettingsPanel
          selectedOverlayGraph={selectedOverlayGraphForSettings}
          onClose={closeGraphSettings}
        />
      )
    : null;
  const overlayChartSettingsDialog = chartSettingsShapeId
    && selectedOverlayChart?.shapeId === chartSettingsShapeId
    ? (
        <ChartSettingsPanel
          chart={selectedOverlayChart}
          onClose={closeChartSettings}
          onSpecChange={(_shapeId, spec) => selectedOverlayChart.onSpecChange(spec)}
        />
      )
    : null;
  // spec の購読はホスト側に閉じている。ここで持つとリボンごと再レンダーされる。
  const overlayGraph3DSettingsDialog = (
    <Graph3DSettingsPanelHost
      shapeId={graph3DSettingsShapeId}
      onClose={closeGraph3DSettings}
      onUndo={undoDocumentChange}
      onRedo={redoDocumentChange}
    />
  );

  const writeOverlay = (overlay: PageOverlay, options?: OverlayChangeOptions) => {
    commitDocumentChange((current) => {
      const withLayout = ensurePageLayout(current);
      const layout = withLayout.pageLayout!;

      return {
        ...withLayout,
        pageLayout: {
          ...layout,
          overlay,
        },
        updatedAt: new Date().toISOString(),
      };
    }, resolveOverlayCommitOptions(options));
  };

  const updateOverlay = (overlay: PageOverlay, options?: OverlayChangeOptions) => writeOverlay(overlay, options);
  // Automatic re-anchor after a deletion: coalesce into the deletion's undo entry.
  const reanchorOverlay = (overlay: PageOverlay) => writeOverlay(overlay, { history: "coalesce" });

  const flushOverlayChanges = () => {
    window.dispatchEvent(new CustomEvent(FLUSH_OVERLAY_CHANGES_EVENT));
  };

  const openPrintPreview = () => {
    flushOverlayChanges();
    setPreviewOpen(true);
  };

  const printEmbeddedPreview = async () => {
    try {
      setSaveState("saving");
      setStatusMessage(tEditor("status.preparingPrint"));
      const saveResult = await saveCurrentDocumentRecord();
      if (!saveResult.ok) {
        setSaveState("error");
        setStatusMessage(saveResult.error ?? tEditor("status.saveFailed"));
        return;
      }
      setSaveState("saved");
      setStatusMessage(tEditor("status.browserPrintOpened"));
      window.print();
    } catch (error) {
      setSaveState("error");
      setStatusMessage(error instanceof Error ? error.message : tEditor("status.printOpenFailed"));
    }
  };

  const exportPdf = async () => {
    setPdfExporting(true);
    if (isEmbedded) {
      await printEmbeddedPreview();
      setPdfExporting(false);
      return;
    }

    const bridge = getDesktopBridge();
    if (!isDesktopApp || !bridge?.file.exportPdf) {
      openPrintPreview();
      setStatusMessage(tEditor("status.pdfDesktopOnly"));
      setPdfExporting(false);
      return;
    }

    try {
      if (printPreviewRenderState.state !== "ready") {
        setStatusMessage(tEditor("status.pdfPreviewNotReady"));
        return;
      }
      setSaveState("saving");
      setStatusMessage(tEditor("status.pdfExporting"));
      const saveResult = await saveCurrentDocumentRecord();
      if (!saveResult.ok) {
        setSaveState("error");
        setStatusMessage(saveResult.error ?? tEditor("status.saveFailed"));
        return;
      }

      const result = await bridge.file.exportPdf({
        suggestedName: suggestedPdfFileName(resolveDocumentTitle(documentRef.current)),
        surfaceId: printPreviewRenderState.surfaceId,
        revision: printPreviewRenderState.revision,
        pageCount: printPreviewRenderState.pageCount,
        pageWidthMm: printPreviewRenderState.pageWidthMm,
        pageHeightMm: printPreviewRenderState.pageHeightMm,
      });
      if (result) {
        setSaveState("saved");
        setStatusMessage(tEditor("status.pdfExported", { path: result.filePath }));
        setExportedPdfPath(result.filePath);
      } else {
        setSaveState("saved");
        setStatusMessage(tEditor("status.pdfExportCancelled"));
      }
    } catch (error) {
      setSaveState("error");
      setStatusMessage(error instanceof Error ? error.message : tEditor("status.pdfExportFailed"));
    } finally {
      setPdfExporting(false);
    }
  };

  const openPrintWindow = async () => {
    flushOverlayChanges();
    if (isEmbedded) {
      await printEmbeddedPreview();
      return;
    }

    if (isDesktopApp) {
      setPreviewOpen(true);
      setStatusMessage(tEditor("status.pdfPreviewOpened"));
      return;
    }
    await saveCurrentDocumentRecord();
    window.open(
      getAppRouteHref("/print", { fileId: activeFileIdRef.current, profile: "teacher" }),
      "_blank",
      "noopener,noreferrer",
    );
  };

  const addBlock = (type: SigmaBlock["type"]) => {
    // 箱は「前に決めた見た目」で入る (設定ダイアログで変えた色や罫がそのまま次にも効く)。
    const block = applyRememberedBoxFrame(createBlock(type, tEditor));
    let insertedBodyBlockId: string | null = null;
    commitDocumentChange((current) => {
      const next = insertBlockAtSelection(current, block, selectedId, { replaceEmpty: block.type === "problem" });
      if (block.type !== "problem") {
        return next;
      }

      const result = ensureBodyBlockAfterProblem(next, block.id);
      insertedBodyBlockId = result.bodyBlock?.id ?? null;
      return result.document;
    });
    setSelectedInlineMath(null);
    const nextSelectedId = insertedBodyBlockId ?? block.id;
    selectedIdRef.current = nextSelectedId;
    setSelectedId(nextSelectedId);
    if (insertedBodyBlockId) {
      scheduleEditorBlockFocus(insertedBodyBlockId);
      return;
    }
    if (block.type === "heading" || block.type === "paragraph" || block.type === "section") {
      scheduleEditorBlockFocus(block.id);
    }
  };

  // 本文の /problem コマンドから問題を差し込む。memo 済みユニットへ渡るコールバックの
  // 依存に入るので、識別子を安定させる (中身は documentRef / 安定コールバックしか読まない)。
  const insertProblemFromTextFlowCommand = useCallback((triggerBlockId: string): boolean => {
    if (!findBlock(documentRef.current, triggerBlockId)) {
      return false;
    }

    const problem = createBlock("problem", tEditor);
    window.setTimeout(() => {
      let insertedBodyBlockId: string | null = null;
      commitDocumentChange((current) => {
        if (!findBlock(current, triggerBlockId)) {
          return current;
        }
        const next = insertBlockAtSelection(current, problem, triggerBlockId, { replaceEmpty: true });
        const result = ensureBodyBlockAfterProblem(next, problem.id);
        insertedBodyBlockId = result.bodyBlock?.id ?? null;
        return result.document;
      });
      setSelectedInlineMath(null);
      const nextSelectedId = insertedBodyBlockId ?? problem.id;
      selectedIdRef.current = nextSelectedId;
      setSelectedId(nextSelectedId);
      if (insertedBodyBlockId) {
        scheduleEditorBlockFocus(insertedBodyBlockId);
      }
      setStatusMessage(tEditor("status.problemInserted"));
    }, 0);
    return true;
  }, [commitDocumentChange, setSelectedId, setSelectedInlineMath, setStatusMessage]);

  const wrapBlockInColumns = (blockIds: string[], columnCount: number) => {
    const focusBlockId = blockIds[0] ?? null;
    if (!focusBlockId) {
      return;
    }
    commitDocumentChange((current) => wrapTextFlowBlocksInLayoutSection(current, blockIds, columnCount));
    setSelectedInlineMath(null);
    selectedIdRef.current = focusBlockId;
    setSelectedId(focusBlockId);
    scheduleEditorBlockFocus(focusBlockId);
  };

  const unwrapColumns = (sectionId: string) => {
    const section = findContainingLayoutSection(documentRef.current, sectionId);
    const focusBlockId = section?.children[0]?.id ?? selectedIdRef.current;
    commitDocumentChange((current) => unwrapLayoutSection(current, sectionId));
    setSelectedInlineMath(null);
    selectedIdRef.current = focusBlockId;
    setSelectedId(focusBlockId);
    if (focusBlockId) {
      scheduleEditorBlockFocus(focusBlockId);
    }
  };

  const resizeLayoutColumns = (sectionId: string, dividerIndex: number, leftWidth: number, rightWidth: number) => {
    commitDocumentChange((current) => {
      let shouldUnwrap = false;
      const updated = updateBlockInDocument(current, sectionId, (block) => {
        if (block.type !== "layoutSection") return block;
        const columns = getLayoutSectionColumns(block);
        const widths = getLayoutSectionColumnWidths(block, columns.length);
        if (!columns[dividerIndex] || !columns[dividerIndex + 1]) return block;
        if (leftWidth <= 0 || rightWidth <= 0) {
          const merged = [...columns[dividerIndex], ...columns[dividerIndex + 1]];
          const nextColumns = [...columns.slice(0, dividerIndex), merged, ...columns.slice(dividerIndex + 2)];
          const nextWidths = [...widths.slice(0, dividerIndex), widths[dividerIndex] + widths[dividerIndex + 1], ...widths.slice(dividerIndex + 2)];
          shouldUnwrap = nextColumns.length === 1;
          return setLayoutSectionColumns(block, nextColumns, nextWidths);
        }
        const pairTotal = widths[dividerIndex] + widths[dividerIndex + 1];
        const pixelTotal = leftWidth + rightWidth;
        const nextWidths = [...widths];
        nextWidths[dividerIndex] = Math.round(pairTotal * leftWidth / pixelTotal);
        nextWidths[dividerIndex + 1] = pairTotal - nextWidths[dividerIndex];
        return setLayoutSectionColumns(block, columns, nextWidths);
      });
      return shouldUnwrap ? unwrapLayoutSection(updated, sectionId) : updated;
    });
  };

  const getActiveTextTarget = (): "document" | "overlay" | "comment" => {
    if (typeof window !== "undefined" && window.document.activeElement?.closest(".comment-thread-panel")) {
      return "comment";
    }
    return overlayEditing ? "overlay" : "document";
  };

  const insertInlineMath = (tex: string, target: "document" | "overlay" | "comment" = "document", edit = true) => {
    window.dispatchEvent(new CustomEvent(INSERT_INLINE_MATH_EVENT, { detail: { tex, target, edit } }));
  };

  const cancelInlineMathMenuClose = () => {
    if (inlineMathMenuCloseTimeoutRef.current !== null) {
      window.clearTimeout(inlineMathMenuCloseTimeoutRef.current);
      inlineMathMenuCloseTimeoutRef.current = null;
    }
  };

  const openInlineMathMenu = () => {
    cancelInlineMathMenuClose();
    setInlineMathMenuOpen(true);
  };

  const scheduleInlineMathMenuClose = () => {
    cancelInlineMathMenuClose();
    inlineMathMenuCloseTimeoutRef.current = window.setTimeout(() => {
      inlineMathMenuCloseTimeoutRef.current = null;
      setInlineMathMenuOpen(false);
    }, 120);
  };

  const startInlineMathFromToolbar = () => {
    cancelInlineMathMenuClose();
    setShapeMenuOpen(false);
    setLineToolMenuOpen(false);
    setFontFamilyMenuOpen(false);
    setBlockStyleMenuOpen(false);
    setBoxedTextMenuOpen(false);
    setLineHeightMenuOpen(false);
    setTextAlignMenuOpen(false);
    setLineDashMenuOpen(false);
    setLineWidthMenuOpen(false);
    setColorStylePanel(null);
    setLineEndpointMenu(null);

    setInlineMathMenuOpen(false);
    insertInlineMath("", getActiveTextTarget());
    setStatusMessage(tEditor("status.mathAdded"));
  };

  // memo 済みの本文ユニットへ渡るので識別子を固定する (中身は commitDocumentChange だけを読む)。
  const updateBlock = useCallback((
    blockId: string,
    updater: (block: SigmaBlock | RichBlock) => SigmaBlock | RichBlock,
    context?: TextFlowChangeContext,
  ) => {
    commitDocumentChange(
      (current) => updateBlockInDocument(
        current,
        blockId,
        (block: EditableBlock) => block.type === "listItem" ? block : updater(block),
      ),
      context?.historyGroup ? { historyGroup: context.historyGroup } : undefined,
    );
  }, [commitDocumentChange]);

  const updateBlockSpaceAfter = useCallback((blockId: string, spaceAfterPx: number) => {
    commitDocumentChange((current) => updateBlockInDocument(
      current,
      blockId,
      (block) => setBlockSpaceAfter(block, spaceAfterPx),
    ));
  }, [commitDocumentChange]);

  /**
   * 本文を空にした削除は、補われた空段落へキャレットを連れて行く。空段落があっても焦点が
   * 無ければ「消したら打っても何も出ない」ままなので、削除の続きにそのまま書ける Word と
   * 同じ手触りにする。書き込みが AI ロックで弾かれたときは補いも起きないので、実際に文書へ
   * 入ったことを確かめてから焦点を移す。
   */
  const focusBodyFallback = (fallbackBlockId: string | null) => {
    if (!fallbackBlockId || !findBlock(documentRef.current, fallbackBlockId)) {
      return;
    }
    selectedIdRef.current = fallbackBlockId;
    setSelectedId(fallbackBlockId);
    scheduleEditorBlockFocus(fallbackBlockId);
  };

  const removeBlock = (blockId: string) => {
    let fallbackBlockId: string | null = null;
    commitDocumentChange((current) => {
      const ensured = ensureEditableBody(removeBlockFromDocument(current, blockId));
      fallbackBlockId = ensured.bodyBlock?.id ?? null;
      return { ...ensured.document, content: removeLeadingEmptyPageBreaks(ensured.document.content) };
    });
    setSelectedId((current) => (current === blockId ? null : current));
    focusBodyFallback(fallbackBlockId);
  };

  /**
   * Deletes body blocks outright, without first emptying their text. Anything the user can
   * point at is fair game — top-level blocks, blocks inside a column section or a box, and
   * the blocks of a problem area — so the caller does not have to know where a block lives.
   */
  const removeBlocks = (blockIds: string[]) => {
    const removableIds = blockIds.filter((id) => !!findBlock(documentRef.current, id));
    if (removableIds.length === 0) {
      return;
    }

    let fallbackBlockId: string | null = null;
    commitDocumentChange((current) => {
      // リストの項目はブロック単位の一括削除が受け付けない (項目はリストの一部)。1 つずつ落とす —
      // 項目が全部消えたリストは `removeBlockFromDocument` が一緒に落とす。
      const itemIds = removableIds.filter((id) => findBlock(current, id)?.type === "listItem");
      const blockOnlyIds = removableIds.filter((id) => !itemIds.includes(id));
      let next = blockOnlyIds.length > 0 ? deleteBlocksFromDocument(current, blockOnlyIds) : current;
      for (const itemId of itemIds) {
        if (findBlock(next, itemId)) {
          next = removeBlockFromDocument(next, itemId);
        }
      }
      const ensured = ensureEditableBody(next);
      fallbackBlockId = ensured.bodyBlock?.id ?? null;
      return { ...ensured.document, content: removeLeadingEmptyPageBreaks(ensured.document.content) };
    });
    setSelectedInlineMath(null);
    setSelectedId((current) => (current && removableIds.includes(current) ? null : current));
    focusBodyFallback(fallbackBlockId);
    setStatusMessage(removableIds.length > 1 ? tEditor("status.bodyDeleted") : tEditor("status.blockDeleted"));
  };

  /**
   * グリップのドラッグで落とした結果を 1 手で書く。動かした先頭のブロックへ焦点を移す
   * (段組化・リストの分割でも、掴んだブロックの id は変わらない)。
   */
  const moveBlocksByDragRequest = (request: BlockDragMoveRequest) => {
    const before = documentRef.current;
    commitDocumentChange((current) => moveBlocksByDrag(current, request));
    if (documentRef.current === before) {
      return;
    }
    const focusBlockId = request.unitIds[0] ?? null;
    setSelectedInlineMath(null);
    if (focusBlockId && findBlock(documentRef.current, focusBlockId)) {
      selectedIdRef.current = focusBlockId;
      setSelectedId(focusBlockId);
      scheduleEditorBlockFocus(focusBlockId);
    }
    setStatusMessage(tEditor("status.blockMoved"));
  };

  /** ⌥⇧↑/↓。キャレットは同じブロック・同じ位置に留める (ブロックごと動くので id は同じ)。 */
  const moveBlocksByStepRequest = (unitIds: string[], direction: "up" | "down") => {
    const before = documentRef.current;
    const caret = textSelectionBookmarkRef.current;
    commitDocumentChange((current) => moveUnitsByStep(current, unitIds, direction));
    if (documentRef.current === before) {
      return;
    }
    setSelectedInlineMath(null);
    if (caret && unitIds.includes(caret.anchor.blockId)) {
      requestCaret(caret);
      return;
    }
    const focusBlockId = unitIds[0] ?? null;
    if (focusBlockId && findBlock(documentRef.current, focusBlockId)) {
      const hasFocus = window.document.activeElement instanceof HTMLElement
        && window.document.activeElement.isContentEditable;
      if (hasFocus) {
        selectedIdRef.current = focusBlockId;
        setSelectedId(focusBlockId);
        scheduleEditorBlockFocus(focusBlockId);
      }
    }
  };

  /** Adds an empty paragraph next to `anchorBlockId`, or at the end when it is null. */
  const insertBodyBlockAt = (anchorBlockId: string | null, position: "before" | "after") => {
    // Clicking the blank strip under the text repeatedly must not stack empty paragraphs:
    // if the document already ends in one, that is the spot the user is asking for.
    if (anchorBlockId === null && position === "after") {
      const lastBlock = documentRef.current.content.at(-1);
      if (lastBlock && isEmptyTopLevelTextFlowBlock(lastBlock)) {
        selectedIdRef.current = lastBlock.id;
        setSelectedId(lastBlock.id);
        scheduleEditorBlockFocus(lastBlock.id);
        return;
      }
    }

    const block = createBlock("paragraph", tEditor);
    commitDocumentChange((current) => (
      position === "before"
        ? insertTopLevelDocumentBlocksBefore(current, anchorBlockId, [block], DOCUMENT_BLOCK_OPERATION_PORTS)
        : insertTopLevelDocumentBlocks(current, anchorBlockId, [block], DOCUMENT_BLOCK_OPERATION_PORTS)
    ));
    setSelectedInlineMath(null);
    selectedIdRef.current = block.id;
    setSelectedId(block.id);
    scheduleEditorBlockFocus(block.id);
  };

  const copyBlockToClipboard = (blockId: string) => {
    const block = findBlock(documentRef.current, blockId);
    if (!block || block.type === "listItem") {
      return;
    }

    void writeEditorPayloadToSystemClipboard(createDocumentBlocksClipboardPayload([block])).then((copied) => {
      setCanPasteProblem(copied && block.type === "problem");
      setStatusMessage(copied
        ? block.type === "problem"
          ? tEditor("status.problemCopied")
          : block.type === "boxBlock" ? tEditor("status.boxCopied") : tEditor("status.blockCopied")
        : tEditor("status.copyFailed"));
    });
  };

  const pasteBlockFromClipboard = useCallback((blockId: string, position: "before" | "after") => {
    const payload = getLocalEditorClipboardPayload();
    if (payload?.kind !== "documentBlocks") {
      setStatusMessage(tEditor("status.nothingToPaste"));
      return;
    }

    const pastedBlocks = cloneDocumentBlocksForPaste(payload.blocks);
    if (pastedBlocks.length === 0) {
      setStatusMessage(tEditor("status.nothingToPaste"));
      return;
    }

    commitDocumentChange((current) => (
      position === "before"
        ? insertTopLevelDocumentBlocksBefore(
            current,
            blockId,
            pastedBlocks,
            DOCUMENT_BLOCK_OPERATION_PORTS,
          )
        : insertTopLevelDocumentBlocks(
            current,
            blockId,
            pastedBlocks,
            DOCUMENT_BLOCK_OPERATION_PORTS,
          )
    ));
    const nextSelectedId = pastedBlocks[pastedBlocks.length - 1]?.id ?? null;
    selectedIdRef.current = nextSelectedId;
    setSelectedId(nextSelectedId);
    setSelectedInlineMath(null);
    setStatusMessage(pastedBlocks.length === 1 && pastedBlocks[0]?.type === "problem"
      ? tEditor("status.problemPasted")
      : tEditor("status.blockPasted"));
  }, [commitDocumentChange, setSelectedId, setSelectedInlineMath, setStatusMessage]);

  const insertTemplate = useCallback((template: TemplateItem) => {
    insertContentAt(templateInsertContent(template), null, { x: 24, y: 24 }, tEditor("status.templateInserted"));
    setTemplateGalleryOpen(false);
  }, [insertContentAt, setTemplateGalleryOpen]);

  const openNewDocMenu = useCallback(() => {
    if (newDocMenuCloseTimerRef.current !== null) {
      window.clearTimeout(newDocMenuCloseTimerRef.current);
      newDocMenuCloseTimerRef.current = null;
    }
    setNewDocMenuOpen(true);
  }, []);

  const scheduleCloseNewDocMenu = useCallback(() => {
    if (newDocMenuCloseTimerRef.current !== null) {
      window.clearTimeout(newDocMenuCloseTimerRef.current);
    }
    newDocMenuCloseTimerRef.current = window.setTimeout(() => {
      setNewDocMenuOpen(false);
      newDocMenuCloseTimerRef.current = null;
    }, 140);
  }, []);

  const applyTextStyle = (style: string) => {
    if (!canUseTextBlockStyle) {
      return;
    }

    if (runningRegionEditingKind) {
      window.dispatchEvent(new CustomEvent(FORMAT_TEXT_EVENT, {
        detail: { command: "blockStyle", value: style, target: "document" },
      }));
      return;
    }

    if (!selectedId || !canFormatSelectedText) {
      return;
    }

    commitDocumentChange((current) =>
      updateBlockInDocument(current, selectedId, (node) => convertBlockStyle(node, style)),
    );
  };

  const blockStructureCommandRef = useRef<{
    canUse: boolean;
    apply: (value: BlockStyleCommandValue) => void;
  }>({ canUse: false, apply: () => undefined });

  /**
   * リスト化・引用・コード・区切り線。段落スタイル (`applyTextStyle`) と違って ProseMirror
   * 経由で送る。入れ子・分割・結合の規則を SigmaDoc 側で書き直すと、PM のコマンドが既に
   * 持っているものを二重に持つことになるため。
   *
   * ボタンを押した後にキャレットがどこに居るかは、**どのボタンでも同じ規則**で決める:
   *
   *   1. PM のコマンドが置いた位置がそのまま正しい (コードの中・引用の中・線の次の段落)。
   *   2. その位置のブロック id をエディタが `detail.focusBlockId` で返す。
   *   3. 焦点が失われていたときだけ、その id へ当て直す。
   *
   * 3 が要るのは、入れ物を作る操作 (引用・リスト) が本文ランの **先頭ブロック id** を変え、
   * ランの React キーがその id なので (`render-units.ts` の `id: chunk[0].id`) エディタごと
   * unmount → remount されるから。逆に失われていないときに触ってはいけない — `setNode` で
   * 済むコマンドで焦点をいじったら、打っている最中にキャレットを奪って文字が落ちた。
   */
  const applyBlockStructure = (value: BlockStyleCommandValue) => {
    if (!canUseBlockStructure) {
      return;
    }
    const target = textToolbar.target;
    const detail: { command: string; value: string; target: string; focusBlockId?: string | null } = {
      command: "blockStyle",
      value,
      target,
    };
    window.dispatchEvent(new CustomEvent(FORMAT_TEXT_EVENT, { detail }));

    // Overlay text stays inside one editor when its block structure changes, so the body-only
    // block-id handoff below would target an unrelated SigmaDoc block and steal focus.
    if (target === "overlay") {
      return;
    }

    const focusBlockId = detail.focusBlockId ?? selectedIdRef.current;
    if (focusBlockId) {
      selectedIdRef.current = focusBlockId;
      setSelectedId(focusBlockId);
      scheduleEditorBlockFocus(focusBlockId, { collapseToEnd: true, onlyIfLost: true });
    }
  };

  // `/` から来るブロック要求へ渡すための最新値。**毎レンダー**書き換える (依存配列を持たない
  // effect) ので、キャンバスへ渡すハンドラは識別子を変えずに最新の可否と関数を読める。
  useEffect(() => {
    blockStructureCommandRef.current = { canUse: canUseBlockStructure, apply: applyBlockStructure };
  });

  const applyTextAlign = (align: TextAlign) => {
    if (!canUseTextAlign) {
      return;
    }

    const target = textToolbar.target;
    window.dispatchEvent(new CustomEvent(FORMAT_TEXT_EVENT, { detail: { command: "textAlign", value: align, target } }));
  };

  const runEditCommand = (command: "bold" | "italic" | "underline" | "boxed" | "undo" | "redo") => {
    if (command === "undo") {
      undoDocumentChange();
      return;
    }

    if (command === "redo") {
      redoDocumentChange();
      return;
    }

    if (!canUseTextToolbar) {
      return;
    }

    window.dispatchEvent(new CustomEvent(FORMAT_TEXT_EVENT, { detail: { command, target: textToolbar.target } }));
  };

  const toggleMenu = (menu: NonNullable<EditorMenu>) => {
    setExportMenuOpen(false);
    setShapeMenuOpen(false);
    setLineToolMenuOpen(false);
    setFontFamilyMenuOpen(false);
    setBlockStyleMenuOpen(false);
    setBoxedTextMenuOpen(false);
    setLineHeightMenuOpen(false);
    setTextAlignMenuOpen(false);
    setOrderedListMenuOpen(false);
    setMoreBlocksMenuOpen(false);
    setLineDashMenuOpen(false);
    setLineWidthMenuOpen(false);
    setColorStylePanel(null);
    setLineEndpointMenu(null);
    setActiveMenu((current) => (current === menu ? null : menu));
  };

  // --- Word風リボン ---------------------------------------------------------
  // 状態の所有者は変えない。リボンは EditorShell が持つこの state と既存ハンドラを読むだけ。

  // 図形が「選択されている」ことだけを条件にする。overlayEditing まで含めると、
  // 図形ツールを選んだ瞬間 (まだ図形が無い) にタブを奪われ、しかもそのタブは
  // 全コントロールが disabled (canUseStrokeStyleControls 等はすべて
  // hasOverlaySelection を要求する) という行き止まりになる。選択解除で消えて
  // 直前のタブへ戻る、という仕様ともこちらの条件でしか両立しない。
  const ribbonContextualTabVisible = hasOverlaySelection;

  useEffect(() => {
    const justAppeared = ribbonContextualTabVisible && !ribbonContextualWasVisibleRef.current;
    ribbonContextualWasVisibleRef.current = ribbonContextualTabVisible;
    // resolveRibbonTabState は変化が無ければ同じオブジェクトを返すので、ここで
    // 無駄な再レンダーは起きない（アイドル時のループ防止）。
    setRibbonTabState((current) => resolveRibbonTabState(current, {
      contextualVisible: ribbonContextualTabVisible,
      contextualJustAppeared: justAppeared,
    }));
  }, [ribbonContextualTabVisible]);

  // タブを切り替えるとポップオーバーのアンカーになっているボタンが unmount し、
  // ToolbarPopover は anchorRef.current === null で top:-9999px へ飛んで見えなくなる。
  // 先に全部閉じる。閉じる集合は toggleMenu と揃え、リボンのタブ内にしか
  // アンカーが無いもの（検索置換・数式・新規教材）も含める。Backstage の開閉でも
  // リボン本体ごと unmount するので、同じ集合を閉じる。
  const closeRibbonAnchoredPopovers = () => {
    setExportMenuOpen(false);
    setShapeMenuOpen(false);
    setLineToolMenuOpen(false);
    setFontFamilyMenuOpen(false);
    setBlockStyleMenuOpen(false);
    setBoxedTextMenuOpen(false);
    setLineHeightMenuOpen(false);
    setTextAlignMenuOpen(false);
    setOrderedListMenuOpen(false);
    setMoreBlocksMenuOpen(false);
    setLineDashMenuOpen(false);
    setLineWidthMenuOpen(false);
    setColorStylePanel(null);
    setLineEndpointMenu(null);
    setActiveMenu(null);
    setSearchOpen(false);
    setInlineMathMenuOpen(false);
    setNewDocMenuOpen(false);
  };

  // collapsed は永続 (ui-layout-preference)、overlayOpen は一時。純関数へ渡すために組で作る。
  // docs では折りたたみの概念が無いので必ず展開扱いにする。
  const ribbonCollapsed = uiLayoutPreference.mode === "word" && uiLayoutPreference.ribbonCollapsed;
  // 浮かせた本体は折りたたみ中にしか存在しない。展開したり docs へ移ったりしたら
  // 一時状態を畳む — 残しておくと「docs へ行って word に戻ったら、何も押していないのに
  // 本体が浮いている」になる。effect ではなくレンダー中に補正する (Backstage と同じ形)。
  const resolvedRibbonOverlayOpen = ribbonCollapsed && ribbonOverlayOpen;
  if (resolvedRibbonOverlayOpen !== ribbonOverlayOpen) {
    setRibbonOverlayOpen(resolvedRibbonOverlayOpen);
  }
  const ribbonCollapse: RibbonCollapseState = {
    collapsed: ribbonCollapsed,
    overlayOpen: resolvedRibbonOverlayOpen,
  };

  const selectRibbonTab = (tab: RibbonPanelTabId) => {
    closeRibbonAnchoredPopovers();
    // Backstage を開いたままタブを押したら、そのタブを開いて Backstage を閉じる
    // （Word と同じ）。閉じないとタブ行だけが反応しない行き止まりになる。
    setRibbonBackstage((current) => closeBackstageState(current));
    // 折りたたみ中は本体を «浮かせて» 出す。同じタブをもう一度押したら閉じる。
    // 比較先は «実際に選択として描かれているタブ»。コンテキストタブが消えた直後の
    // 1レンダーだけ state の active は不可視の shapeFormat のままで、クロームは
    // lastExplicit を選択として描いている（editor-chrome.tsx の activeRibbonTab と同じ導出）。
    const renderedActiveTab = ribbonTabState.active === "shapeFormat" && !ribbonContextualTabVisible
      ? ribbonTabState.lastExplicit
      : ribbonTabState.active;
    const nextCollapse = resolveTabClickWhileCollapsed(ribbonCollapse, {
      sameTab: renderedActiveTab === tab,
    });
    setRibbonOverlayOpen(nextCollapse.overlayOpen);
    setRibbonTabState((current) => selectRibbonTabState(current, tab));
  };

  const toggleRibbonCollapse = () => {
    closeRibbonAnchoredPopovers();
    const next = toggleRibbonCollapseState(ribbonCollapse);
    // collapsed だけ永続する。overlayOpen を永続すると、次回起動時に本体が
    // 浮いたまま出てしまう。
    updateUiLayoutPreference({ ribbonCollapsed: next.collapsed });
    setRibbonOverlayOpen(next.overlayOpen);
  };

  const closeRibbonOverlayNow = () => {
    setRibbonOverlayOpen((current) => closeRibbonOverlay({
      collapsed: true,
      overlayOpen: current,
    }).overlayOpen);
  };

  const toggleRibbonBackstage = () => {
    closeRibbonAnchoredPopovers();
    // Backstage は本文もリボンも覆うので、浮かせた本体は畳んでおく。残すと
    // Backstage を閉じた先に、誰も呼んでいない本体が浮いたまま出てくる
    // （キーボードだけで操作すると pointerdown が出ないのでこの経路に入る）。
    setRibbonOverlayOpen(false);
    setRibbonBackstage((current) => toggleBackstageState(current));
  };

  const closeRibbonBackstage = () => {
    setRibbonBackstage((current) => closeBackstageState(current));
  };

  const selectRibbonBackstageSection = (section: BackstageSectionId) => {
    setRibbonBackstage((current) => selectBackstageSectionState(current, section));
  };

  // レイアウトが Word風を離れたら Backstage を畳む。これが無いと docs へ切り替えて
  // 戻ってきた瞬間に全画面が残ったまま出る。
  // effect ではなくレンダー中に補正する（React 公式の「変化に合わせて state を調整する」形）。
  // resolveBackstageStateForLayout は変化が無ければ同じ参照を返すので、通常のレンダーでは
  // 何も起きない。以降は補正後の値だけを読む。
  const ribbonBackstageState = resolveBackstageStateForLayout(ribbonBackstage, uiLayoutPreference.mode);
  if (ribbonBackstageState !== ribbonBackstage) {
    setRibbonBackstage(ribbonBackstageState);
  }

  const ribbonBackstageOpen = ribbonBackstageState.open;

  // Backstage 表示中は本文・図形へキーを届かせない。
  // OverlayCanvasEditorClient の handleOverlayKeyboard は window の bubble リスナーで、
  // 「入力欄かどうか」しか見ない = Backstage のボタンにフォーカスがあると Delete や
  // 矢印キーが図形へ素通りする。window の capture で止めれば bubble まで降りない。
  // preventDefault はしないので Tab によるフォーカス移動は生きる。Escape だけは
  // 通して closeTransientUi に閉じさせる。
  useEffect(() => {
    if (!ribbonBackstageOpen) {
      return;
    }
    const guardBackstageKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        return;
      }
      event.stopPropagation();
    };
    window.addEventListener("keydown", guardBackstageKeys, true);
    return () => window.removeEventListener("keydown", guardBackstageKeys, true);
  }, [ribbonBackstageOpen]);

  // Ctrl+F1 のリスナーは毎レンダー張り替えたくないので、最新のハンドラを ref に写す
  // (runShortcutCommandRef と同じ手。レンダー中の ref 書き換えは禁止なので effect で)。
  useEffect(() => {
    toggleRibbonCollapseRef.current = toggleRibbonCollapse;
  });

  // 浮かせたリボン本体は外側クリックで閉じる（ToolbarPopover と同じ形: document の
  // pointerdown + contains 判定）。タブ行の中は「外側」に含めない — タブを押したときの
  // 開閉は resolveTabClickWhileCollapsed が決めるので、ここで先に閉じると打ち消し合う。
  useEffect(() => {
    if (!ribbonOverlayOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      // SDK は1ページに EditorShell を2つ載せうるので、querySelector(".app-shell") で
      // «最初の» シェルを掴まない。自分のタブ行 (useId 由来の id) から辿る。
      const root = window.document
        .getElementById(ribbonTabElementId(ribbonIdPrefix, "file"))
        ?.closest(".app-shell");
      if (!root?.contains(target)) {
        return;
      }
      // 「外側」から外すのはタブそのものだけ。タブ行右端のコメント / AIチャット /
      // 展開ボタンを押したら、その結果が浮いた本体に隠れないよう畳む。
      if (target instanceof Element && target.closest(".ribbon-body, .ribbon-tabs")) {
        return;
      }
      closeRibbonOverlayNow();
    };
    window.document.addEventListener("pointerdown", handlePointerDown);
    return () => window.document.removeEventListener("pointerdown", handlePointerDown);
    // closeRibbonOverlayNow は setter しか呼ばないので、識別子が毎レンダー変わっても
    // 張り替える必要が無い（張り替えると pointerdown を取りこぼす）。
  }, [ribbonOverlayOpen, ribbonIdPrefix]);

  // 開いたら Backstage の先頭要素へ、閉じたらファイルタブへフォーカスを戻す。
  // クロームの JSX は1関数・1 render pass で作る規約なので ref を配れない。
  // id は ribbon-tabs.ts / ribbon-backstage.ts が組み立てを持っている（useId 由来の
  // 接頭辞なので、SDK が1ページに2つ埋め込んでも他方を掴まない）。
  useEffect(() => {
    if (!ribbonBackstageOpen) {
      return;
    }
    const panel = window.document.getElementById(ribbonBackstagePanelId(ribbonIdPrefix));
    panel?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => {
      window.document.getElementById(ribbonTabElementId(ribbonIdPrefix, "file"))?.focus();
    };
  }, [ribbonBackstageOpen, ribbonIdPrefix]);

  // 文書を1本走査するので、実際にボタンが描かれるレイアウトタブを開いている
  // ときだけ計算する。docs では段組みコマンドが画面に無く、word でも他のタブでは
  // 読まれないため、毎キーストロークの走査を丸ごと省ける。
  const ribbonRibbonBodyVisible = !ribbonCollapse.collapsed || ribbonCollapse.overlayOpen;
  const ribbonColumnCommand = uiLayoutPreference.mode === "word" && ribbonTabState.active === "layout" && !ribbonBackstageOpen && ribbonRibbonBodyVisible
    ? resolveColumnCommandState(document, selectedId)
    : NO_COLUMN_COMMAND;

  /**
   * 選択ブロックを columnCount 段にする。すでに段組の中なら段数を変え、
   * columnCount が 1 なら段組を解除する（どちらも右クリックメニューにある操作）。
   */
  const applyColumnCommand = (columnCount: number) => {
    if (!selectedId) {
      return;
    }
    // 描画用の値は開いているタブによって計算を省いているので、押された時点で取り直す。
    const state = resolveColumnCommandState(documentRef.current, selectedId);
    if (!state.enabled) {
      return;
    }
    if (!state.sectionId) {
      if (columnCount > 1) {
        wrapBlockInColumns([selectedId], columnCount);
      }
      return;
    }
    if (columnCount <= 1) {
      unwrapColumns(state.sectionId);
      return;
    }
    if (state.currentColumnCount === columnCount) {
      // 押されている段数をもう一度押しても文書は変わらない。setLayoutSectionColumnCount は
      // 常に新しいオブジェクトを返すので、素通しすると空の更新履歴と保存が積まれる。
      return;
    }
    updateBlock(state.sectionId, (block) => setLayoutSectionColumnCount(block, columnCount, () => createParagraph("")));
  };

  // AI実行中でも図形の新規挿入・整列などは通す。ロック図形そのものへの変更は overlay canvas の
  // transitionMode (lockedShapeIds) と commitDocumentChange の対象判定で弾かれるため、ここで
  // 選択内容まで見て一律禁止する必要はない。
  const runOverlayCommand = (command: OverlayCommand, graphPreset?: Graph2DPreset) => {
    if (aiDocumentWriteInProgress) {
      setStatusMessage(aiDocumentWriteInProgressMessage());
      return;
    }
    captureMaterialBlockSelectionFromDom();
    overlayCommandRequestIdRef.current += 1;
    setShapeMenuOpen(false);
    setLineToolMenuOpen(false);
    setFontFamilyMenuOpen(false);
    setBlockStyleMenuOpen(false);
    setBoxedTextMenuOpen(false);
    setLineHeightMenuOpen(false);
    setTextAlignMenuOpen(false);
    setLineDashMenuOpen(false);
    setLineWidthMenuOpen(false);
    setColorStylePanel(null);
    setLineEndpointMenu(null);
    const request = { id: overlayCommandRequestIdRef.current, command, graphPreset };
    if (command === "table") {
      beginTablePlacementFeedback(request.id, tShapeChrome("table.dragHint"),
        () => setOverlayCommandRequest((current) => current?.id === request.id ? null : current),
        () => setOverlayCommandRequest(request));
    } else {
      cancelTablePlacementFeedback();
      setOverlayCommandRequest(request);
    }
    if (command !== "select") {
      setStatusMessage(command === "table"
        ? tShapeChrome("table.placeHint")
        : command === "graph"
        ? tEditor("status.graphDragHint")
        : command === "graph3d"
          ? tEditor("status.graph3dDragHint")
          : command === "circle" || command === "arc" || command === "sector"
            ? tEditor("status.centerDragHint")
            : tEditor("status.shapeDragHint"));
    }
  };

  const requestOverlayImages = useCallback((files: ArrayLike<File> | Iterable<File>, point?: OverlayPoint) => {
    captureMaterialBlockSelectionFromDom();
    const imageFiles = getSupportedOverlayImageFiles(files);
    if (imageFiles.length === 0) {
      setStatusMessage(tEditor("status.imageFormatsOnly"));
      setSaveState("error");
      return;
    }

    overlayImageRequestIdRef.current += 1;
    setShapeMenuOpen(false);
    setLineToolMenuOpen(false);
    setLineDashMenuOpen(false);
    setLineWidthMenuOpen(false);
    setOverlayImageRequest({
      id: overlayImageRequestIdRef.current,
      files: imageFiles,
      point,
    });
    setStatusMessage(imageFiles.length === 1
      ? tEditor("status.addImageToPage")
      : tEditor("status.addImagesToPage", { images: imageFiles.length }));
  }, [captureMaterialBlockSelectionFromDom, setSaveState, setStatusMessage]);

  // Turn a URL detected in the flow editor into a QR code, inserted on the page
  // as an overlay image (the same pipeline as pasted/imported images).
  useEffect(() => {
    const handleQrCodeRequest = (event: Event) => {
      const detail = event instanceof CustomEvent ? (event.detail as QrCodeRequestDetail | null) : null;
      const url = detail?.url?.trim();
      if (!url) {
        return;
      }
      void (async () => {
        try {
          const file = await generateQrPngFile(url);
          requestOverlayImages([file]);
          setStatusMessage(tEditor("status.qrAdded"));
        } catch {
          setStatusMessage(tEditor("status.qrFailed"));
          setSaveState("error");
        }
      })();
    };

    window.addEventListener(QR_CODE_REQUEST_EVENT, handleQrCodeRequest);
    return () => window.removeEventListener(QR_CODE_REQUEST_EVENT, handleQrCodeRequest);
  }, [requestOverlayImages, setSaveState, setStatusMessage]);

  const requestOverlayAction = useCallback((request: OverlayActionRequestInput) => {
    overlayActionRequestIdRef.current += 1;
    setOverlayActionRequest({
      id: overlayActionRequestIdRef.current,
      ...request,
    } as OverlayActionRequest);
  }, []);

  /**
   * コマンドを走らせる前の後始末。開いているメニュー・ポップオーバーを閉じる。
   *
   * **入口が 2 つあるので関数として共有する** — キーボード / コマンドパレット /
   * ネイティブメニューが通る `runShortcutCommandRef` と、ネイティブ undo を
   * `beforeinput` で受け止める経路。ここが割れていると、フォントサイズやブロック
   * スタイルのポップオーバーが「消えた内容の状態」を表示したまま残る。
   */
  const closeTransientCommandSurfaces = useCallback(() => {
    setActiveMenu(null);
    setExportMenuOpen(false);
    setShapeMenuOpen(false);
    setLineToolMenuOpen(false);
    setFontFamilyMenuOpen(false);
    setBlockStyleMenuOpen(false);
    setBoxedTextMenuOpen(false);
    setLineHeightMenuOpen(false);
    setTextAlignMenuOpen(false);
    setColorStylePanel(null);
    setLineEndpointMenu(null);
  }, []);

  /**
   * IME 変換中か。**メニュー経路には `event.isComposing` が無い**ので自前で追う。
   *
   * 変換中に文書を差し替えると未確定の文字列ごと壊れるため、キーボード経路と同じく
   * メニュー経路でも抑止する。
   *
   * **真偽値ではなく合成中の要素を持ち、しかも「立ちっぱなしになり得ない」形にする。**
   * `compositionend` は取りこぼす経路がいくつもある —— 合成中の要素が DOM から引き剥がされる
   * (AI 適用時の PM `setContent`・ページ割りのリフロー・インライン数式ノードビューの破棄)、
   * Escape で変換をキャンセルする、アプリを切り替える、プログラムから blur する。真偽値で
   * 持つと**そのままセッション中ずっと立ちっぱなしになり、メニュー ⌘Z が永久に死ぬ** ——
   * いま直している不具合と同じクラスの穴を自分で作ることになる。
   *
   * そこで失効の道を 4 本用意する。どれか 1 本でも通れば解ける:
   * 1. 要素が DOM から外れた (`isConnected`)
   * 2. その要素がもうフォーカスを持っていない (読むたびに `activeElement` と突き合わせる)
   * 3. 合成を伴わないキー入力・ポインタ操作が来た (`isComposing === false`)
   * 4. ウィンドウがフォーカスを失った (`blur`)
   */
  const imeCompositionElementRef = useRef<Element | null>(null);
  const isImeCompositionActive = useCallback(() => {
    const element = imeCompositionElementRef.current;
    if (isCompositionStillActive(element)) {
      return true;
    }
    imeCompositionElementRef.current = null;
    return false;
  }, []);
  useEffect(() => {
    const begin = (event: Event) => {
      imeCompositionElementRef.current = event.target instanceof Element ? event.target : null;
    };
    const end = () => {
      imeCompositionElementRef.current = null;
    };
    // 合成を伴わない入力が来たら、そこで合成は終わっている。`compositionend` が来ない
    // 経路 (Escape でのキャンセルなど) の唯一の出口なので、キーもポインタも見る。
    const endIfNotComposing = (event: Event) => {
      if (shouldEndCompositionForEvent(event)) {
        end();
      }
    };
    window.addEventListener("compositionstart", begin, true);
    window.addEventListener("compositionend", end, true);
    // フォーカスが外れた時点で合成は終わっている。`compositionend` を取りこぼす経路の保険。
    window.addEventListener("focusout", end, true);
    window.addEventListener("keydown", endIfNotComposing, true);
    window.addEventListener("keyup", endIfNotComposing, true);
    window.addEventListener("pointerdown", end, true);
    // アプリ・ブラウザの切り替え。戻ってきたときに立ちっぱなしにしない。
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("compositionstart", begin, true);
      window.removeEventListener("compositionend", end, true);
      window.removeEventListener("focusout", end, true);
      window.removeEventListener("keydown", endIfNotComposing, true);
      window.removeEventListener("keyup", endIfNotComposing, true);
      window.removeEventListener("pointerdown", end, true);
      window.removeEventListener("blur", end);
    };
  }, []);

  /**
   * 「いま他の面が前に出ているか」。**キーボード経路とメニュー経路で同じ抑止を使う。**
   * 片方だけに書くと、メニューがダイアログを飛び越えて背後の文書を戻す。
   */
  const isModalSurfaceOpen = commandSettingsOpen
    || texCommandReferenceOpen
    || pageSettingsOpen
    || documentListOpen
    || previewOpen
    || aiSettingsOpen
    || desktopSettingsOpen
    || materialLibraryOpen
    || templateGalleryOpen
    || materialAddDialogOpen
    || ribbonBackstageOpen
    || commandPaletteOpen
    || versionHistoryPreviewActive
    || windowCloseSaveDialog !== null;

  useEffect(() => {
    // ネイティブ undo / redo (右クリックメニュー・3 本指スワイプ・支援技術など) を
    // 本文エディタが `beforeinput` で止めて、こちらへ振り向けてくる。
    // 送り手は `components/tiptap/native-history-guard.ts` (逆流を避けて window イベント)。
    //
    // **これが 3 本目の入口。** キーボード・ネイティブメニューと同じフォーカスポリシーを
    // 通す —— 通さないと、モーダルの上でも IME 変換中でも、右クリック Undo が背後の文書を
    // 巻き戻す。
    //
    // `deliverToFocusedSurface: false` にしているのは、この経路では**面ごとの振り分けを
    // 既にガード側が済ませている**ため。shell に届いた時点で「文書で戻してほしい」の意味
    // しかなく、ここで下書き面へ `beforeinput` を投げ返すと同じ合図が往復する。
    // **IME の抑止はこの経路だけ二重に掛かる。どちらが効いているかを明記しておく。**
    // 1 段目はガード側の `view.composing` —— 本文 PM で変換中なら、ガードは
    //    `preventDefault()` だけして**この window イベントを投げない**。だからここには来ない。
    // 2 段目がこの `isComposing` —— ガードを経由しない面 (数式欄・下書き面) から来た合図と、
    //    `view.composing` が非同期にクリアされる約 20ms の窓を受け止める。
    // どちらで止まってもユーザーに見えるのは**静かな no-op** (合成した `beforeinput` は
    // untrusted なのでブラウザの既定 undo を起こさない = PM 所有 DOM は書き換わらない)。
    // 変換中に文書を差し替えて未確定の文字列ごと壊すより、この 1 回を飲むほうがよい。
    const handleNativeHistoryCommand = (event: Event) => {
      const detail = (event as CustomEvent<NativeHistoryCommandDetail>).detail;
      if (detail?.direction !== "undo" && detail?.direction !== "redo") {
        return;
      }
      const outcome = deliverHistoryShortcutToFocusedSurface({
        activeElement: window.document.activeElement,
        direction: detail.direction,
        isComposing: isImeCompositionActive(),
        ownerDocument: window.document,
        isModalSurfaceOpen,
        deliverToFocusedSurface: false,
      });
      if (outcome !== "document") {
        return;
      }
      // 後始末 (`closeTransientCommandSurfaces`) はキーボード / コマンドパレット /
      // ネイティブメニューが通る `runShortcutCommandRef` と**同じ関数を共有する**。
      // ここだけ後始末を飛ばすと、フォントサイズやブロックスタイルのポップオーバーが
      // 「消えた内容の状態」を表示したまま残る。
      closeTransientCommandSurfaces();
      if (detail.direction === "undo") {
        undoDocumentChange();
      } else {
        redoDocumentChange();
      }
    };
    window.addEventListener(NATIVE_HISTORY_COMMAND_EVENT, handleNativeHistoryCommand);
    return () => window.removeEventListener(NATIVE_HISTORY_COMMAND_EVENT, handleNativeHistoryCommand);
  }, [closeTransientCommandSurfaces, isImeCompositionActive, isModalSurfaceOpen,
    redoDocumentChange, undoDocumentChange]);

  useEffect(() => {
    const handleOverlayShapesPasteRequest = (event: Event) => {
      const detail = (event as CustomEvent<OverlayShapesPasteRequestDetail>).detail;
      if (
        materialEditingOpenRef.current
        || !detail?.source.closest(".page-flow")
        || detail.payload.shapes.length === 0
      ) {
        return;
      }
      requestOverlayAction({
        type: "pasteShapes",
        payload: detail.payload,
        anchorBlockIdMap: detail.anchorBlockIdMap,
        historyGroup: detail.historyGroup,
      });
      setStatusMessage(tEditor("status.bodyAndShapesPasted"));
    };
    window.addEventListener(OVERLAY_SHAPES_PASTE_REQUEST_EVENT, handleOverlayShapesPasteRequest);
    return () => window.removeEventListener(OVERLAY_SHAPES_PASTE_REQUEST_EVENT, handleOverlayShapesPasteRequest);
  }, [materialEditingOpenRef, requestOverlayAction, setStatusMessage]);

  useEffect(() => {
    const handleBodySelectionShapesRequest = (event: Event) => {
      const detail = (event as CustomEvent<BodySelectionShapesRequestDetail>).detail;
      if (materialEditingOpenRef.current || !detail?.source.closest(".page-flow")) {
        return;
      }
      requestOverlayAction({
        type: "selectShapesForBlocks",
        blockIds: detail.blockIds,
        allShapes: detail.wholeDocument === true,
      });
    };
    window.addEventListener(BODY_SELECTION_SHAPES_REQUEST_EVENT, handleBodySelectionShapesRequest);
    return () => window.removeEventListener(BODY_SELECTION_SHAPES_REQUEST_EVENT, handleBodySelectionShapesRequest);
  }, [materialEditingOpenRef, requestOverlayAction]);

  const applyOverlayStyle = (style: OverlaySelectionStylePatch) => {
    if (!hasOverlaySelection) {
      return;
    }

    requestOverlayAction({ type: "style", style });
  };
  const arrangeOverlayShapes = (action: OverlayArrangeAction) => {
    if (canArrangeOverlayShapes) {
      requestOverlayAction({ type: "arrange", action });
    }
  };

  const handleOverlaySelectionSummaryChange = useCallback((summary: OverlaySelectionSummary) => {
    // state はシェルの見た目が変わるときだけ進める。図形そのものが要る素材化は ref を読む。
    overlaySelectionRef.current = summary;
    setOverlaySelection((current) => sameOverlaySelectionSummary(current, summary) ? current : summary);
    if (summary.selectedCount === 0 || !summary.canStyleLine) {
      setLineDashMenuOpen(false);
      setLineWidthMenuOpen(false);
    }
    if (summary.selectedCount === 0 || !summary.canStyleFill) {
      // Closing the panel unmounts the palette, and the palette drops its own preview on unmount —
      // so this is also what stops an unconfirmed preview from outliving the selection it was
      // started on.
      setColorStylePanel((current) => (current === "fill" ? null : current));
    }
  }, []);

  const applyInlineFormat = (command: "color" | "backgroundColor" | "fontFamily" | "fontSize" | "lineHeight" | "boxedPaddingY" | "boxedVariant", value: string) => {
    if (!canUseTextToolbar) {
      return;
    }

    window.dispatchEvent(new CustomEvent(FORMAT_TEXT_EVENT, { detail: { command, value, target: textToolbar.target } }));
  };

  const applyLineHeight = (nextLineHeightValue: string, options: { updateInput?: boolean } = {}): boolean => {
    if (!canUseLineHeight) {
      return false;
    }

    const nextLineHeight = normalizeLineHeight(nextLineHeightValue);
    if (!nextLineHeight) {
      setLineHeightInputError(t("format.lineHeight.inputError", { min: MIN_LINE_HEIGHT, max: MAX_LINE_HEIGHT }));
      return false;
    }

    setLineHeight(nextLineHeight);
    if (options.updateInput !== false) {
      setLineHeightInput(nextLineHeight);
    }
    setLineHeightInputError(null);
    applyInlineFormat("lineHeight", nextLineHeight);
    return true;
  };

  const stopLineHeightStepping = useCallback(() => {
    if (lineHeightStepDelayTimerRef.current !== null) {
      window.clearTimeout(lineHeightStepDelayTimerRef.current);
      lineHeightStepDelayTimerRef.current = null;
    }
    if (lineHeightStepRepeatTimerRef.current !== null) {
      window.clearInterval(lineHeightStepRepeatTimerRef.current);
      lineHeightStepRepeatTimerRef.current = null;
    }
    lineHeightStepCurrentRef.current = null;
  }, []);

  const applyLineHeightStep = (direction: "increase" | "decrease"): boolean => {
    const currentLineHeight = lineHeightStepCurrentRef.current ?? lineHeight;
    const nextLineHeight = stepLineHeight(currentLineHeight, direction);
    if (nextLineHeight === currentLineHeight) {
      stopLineHeightStepping();
      return false;
    }
    lineHeightStepCurrentRef.current = nextLineHeight;
    return applyLineHeight(nextLineHeight);
  };

  const startLineHeightStepping = (event: ReactPointerEvent<HTMLButtonElement>, direction: "increase" | "decrease") => {
    if (!event.isPrimary || event.button !== 0) {
      return;
    }
    event.preventDefault();
    stopLineHeightStepping();
    if (!applyLineHeightStep(direction)) {
      return;
    }
    lineHeightStepDelayTimerRef.current = window.setTimeout(() => {
      lineHeightStepDelayTimerRef.current = null;
      if (!applyLineHeightStep(direction)) {
        return;
      }
      lineHeightStepRepeatTimerRef.current = window.setInterval(() => {
        applyLineHeightStep(direction);
      }, LINE_HEIGHT_LONG_PRESS_INTERVAL_MS);
    }, LINE_HEIGHT_LONG_PRESS_DELAY_MS);
  };

  const handleLineHeightStepClick = (event: MouseEvent<HTMLButtonElement>, direction: "increase" | "decrease") => {
    if (event.detail === 0) {
      applyLineHeightStep(direction);
    }
  };

  useEffect(() => stopLineHeightStepping, [stopLineHeightStepping]);

  useEffect(() => {
    if (!lineHeightMenuOpen || !lineHeightCustomOpen) {
      stopLineHeightStepping();
    }
  }, [lineHeightCustomOpen, lineHeightMenuOpen, stopLineHeightStepping]);

  const applyBoxedTextPaddingY = (paddingY: number) => {
    const nextPaddingY = clampBoxedTextPaddingY(paddingY);
    setBoxedTextPaddingY(nextPaddingY);
    lastBoxedFormatRef.current = { ...lastBoxedFormatRef.current, paddingY: nextPaddingY };
    applyInlineFormat("boxedPaddingY", String(nextPaddingY));
  };

  const toggleBoxedText = () => {
    if (!canUseTextToolbar) {
      return;
    }

    if (boxedTextActive) {
      runEditCommand("boxed");
    } else {
      // Insert reusing the last applied format + padding (not a reset to a plain 0pt
      // frame). boxedVariant/boxedPaddingY both use "set" mode, which adds the boxed
      // mark and merges the attrs, so the new box matches the previous insert.
      const variant = normalizeBoxedTextVariant(lastBoxedFormatRef.current.variant) ?? "frame";
      if (variant !== "frame") {
        applyInlineFormat("boxedVariant", variant);
      }
      applyInlineFormat("boxedPaddingY", String(clampBoxedTextPaddingY(lastBoxedFormatRef.current.paddingY)));
    }
    setBoxedTextMenuOpen(false);
  };

  const selectBoxedTextVariant = (variant: BoxedVariant) => {
    if (!canUseTextToolbar) {
      return;
    }

    const nextVariant = normalizeBoxedTextVariant(variant) ?? "frame";
    setBoxedTextVariant(nextVariant);
    if (boxedTextActive && boxedTextVariant === nextVariant) {
      runEditCommand("boxed");
      setBoxedTextMenuOpen(false);
      return;
    }

    lastBoxedFormatRef.current = { ...lastBoxedFormatRef.current, variant: nextVariant };
    applyInlineFormat("boxedVariant", nextVariant);
  };

  const findNext = () => {
    const match = findFirstBlockWithText(document.content, searchQuery, selectedId, "next");
    if (!match) {
      setStatusMessage(tEditor("status.noSearchResults"));
      return;
    }

    setSelectedId(match.id);
    window.document.getElementById(match.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setStatusMessage(tEditor("status.searchResultSelected"));
  };

  const findPrevious = () => {
    const match = findFirstBlockWithText(document.content, searchQuery, selectedId, "previous");
    if (!match) {
      setStatusMessage(tEditor("status.noSearchResults"));
      return;
    }

    setSelectedId(match.id);
    window.document.getElementById(match.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setStatusMessage(tEditor("status.searchResultSelected"));
  };

  const replaceNext = () => {
    const match = findFirstBlockWithText(document.content, searchQuery, selectedId, "next");
    if (!match) {
      setStatusMessage(tEditor("status.nothingToReplace"));
      return;
    }

    commitDocumentChange((current) => replaceInDocument(current, searchQuery, replaceText, false));
    setSelectedId(match.id);
    setStatusMessage(tEditor("status.replacedOne"));
  };

  const replaceAll = () => {
    const count = countTextMatches(document.content, searchQuery);
    if (count === 0) {
      setStatusMessage(tEditor("status.nothingToReplace"));
      return;
    }

    commitDocumentChange((current) => replaceInDocument(current, searchQuery, replaceText, true));
    setStatusMessage(tEditor("status.replacedMany", { matches: count }));
  };

  const searchMatchCount = useMemo(() => countTextMatches(document.content, searchQuery), [document.content, searchQuery]);

  const replaceTextFlow = useCallback((
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    context?: TextFlowChangeContext,
    options?: TextFlowReplaceOptions,
  ) => {
    commitDocumentChange((current) => {
      const content = replaceTopLevelTextFlowBlocks(current.content, previousIds, nextBlocks);
      if (content === current.content) {
        return current;
      }

      return {
        ...current,
        content,
        updatedAt: new Date().toISOString(),
      };
    }, {
      // ページを跨いで分割されたブロックへの編集だけは遅らせない (`PageCanvasEditor` が
      // 同じタスクの中でページ割りを取り直す)。
      deferRender: options?.immediateRender !== true,
      ...(context?.historyGroup ? { historyGroup: context.historyGroup } : {}),
    });
  }, [commitDocumentChange]);

  const reportIssue = () => {
    window.open(REPORT_ISSUE_FORM_URL, "_blank", "noopener,noreferrer");
  };

  const {
    openWorkspaceScreen,
    openDocumentAsTab,
    createDocumentTab,
    createWhiteboardDocumentTab,
    duplicateActiveDocument,
    openDocumentListDialog,
    closeDocumentTab,
    openDocumentFromList,
    duplicateDocumentFromList,
    deleteDocumentFromList,
    deleteActiveDocument
  } = useWorkspaceDocumentCommands({
    openFileIds,
    activeFileId,
    documentMetadatas,
    workspaceReady,
    embeddedHostRef,
    documentRef,
    activeFileIdRef,
    openFileIdsRef,
    untouchedNewDocumentsRef,
    mcpPreviewBusyRef,
    workspaceReadyRef,
    editorTabViewStateByFileIdRef,
    textSelectionBookmarkRef,
    cancelPendingAutosaveRef,
    flushOverlayChanges,
    saveCurrentDocumentBeforeReplacement,
    saveCurrentDocumentRecord,
    rememberLeavingEditorTabViewState,
    prepareIncomingEditorTabViewState,
    resetEditorDocument,
    openDocumentInWorkspace,
    refreshDocumentMetadatas,
    setOpenFileIds,
    setActiveFileId,
    setWorkspaceReady,
    setActiveMenu,
    setDocumentListOpen,
    setSaveState,
    setStatusMessage,
    t,
    tEditor
  });

  const {
    importInputRef,
    otherImportInputRef,
    textImportOpen,
    setTextImportOpen,
    documentTextCopyFallback,
    setDocumentTextCopyFallback,
    exportJson,
    copyDocumentText,
    openTextImportDialog,
    openDocumentViaDesktop,
    openExternalDocument,
    importDocumentFile,
    openImportDialog,
    openOtherImportDialog,
  } = useDocumentFileCommands({
    documentRef,
    embeddedHostRef,
    workspaceReady,
    isDesktopApp,
    flushOverlayChanges,
    saveCurrentDocumentBeforeReplacement,
    openDocumentAsTab,
    resetEditorDocument,
    setOpenFileIds,
    setActiveFileId,
    setActiveMenu,
    setSaveState,
    setStatusMessage,
    announceRecovery,
    DOCUMENT_BLOCK_OPERATION_PORTS,
    tEditor
  });

  useExternalDocumentOpen(isDesktopApp && workspaceReady, openExternalDocument, (error) => {
    setStatusMessage(error instanceof Error ? error.message : tEditor("status.fileOpenFailed"));
  });

  useDesktopMenuActions({
    isDesktopApp,
    isModalSurfaceOpen,
    isImeCompositionActive,
    runShortcutCommandRef,
    createDocumentTab,
    openDocumentViaDesktop,
    exportJson,
    openPrintPreview,
    setDesktopSettingsUpdateCheckRequest,
    setDesktopSettingsOpen
  });

  useEffect(() => {
    if (!isDesktopApp) {
      return;
    }

    const bridge = getDesktopBridge();
    if (!bridge?.updater) {
      return;
    }
    const { updater } = bridge;

    let cancelled = false;
    const applyUpdateState = (state: DesktopUpdateState) => {
      if (!cancelled) {
        setAppUpdateState(state);
      }
    };

    updater.getStatus().then((state) => {
      applyUpdateState(state);
      if (!state.supported || state.phase !== "idle" || appUpdateAutoCheckStartedRef.current) {
        return;
      }

      appUpdateAutoCheckStartedRef.current = true;
      void updater.checkForUpdates().then(applyUpdateState).catch(() => undefined);
    }).catch(() => undefined);

    const unsubscribe = updater.onStatusChange(applyUpdateState);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isDesktopApp]);

  useEffect(() => {
    if (isEmbedded) {
      return;
    }

    return registerDocumentStorageSynchronization({
      activeFileIdRef,
      documentRef,
      lastSyncedDocumentRef,
      documentObservedRevisionRef,
      selectedIdRef,
      openFileIdsRef,
      workspaceReadyRef,
      externalChangeFileIdsRef,
      pendingAutoAppliedProposalIdsByFileRef,
      inFlightSavePromiseRef,
      successfulDocumentSavesRef,
      documentStorageChangeProcessorRef,
      blockOperationPorts: DOCUMENT_BLOCK_OPERATION_PORTS,
      refreshDocumentMetadatas,
      refreshMcpEditProposals,
      switchAwayFromDeletedFile,
      loadWorkspaceDocument,
      isCurrentDocumentDirty,
      saveUnsavedEditBackup,
      applyAutoApprovedExternalDocument,
      applyMergedExternalDocument,
      resetEditorDocument,
      setOpenFileIds,
      setActiveFileId,
      setSaveState,
      setStatusMessage,
      setDegradedWatcherScopes,
      dispatchDocumentStorageChange,
      tEditor,
    });
  }, [
    applyAutoApprovedExternalDocument,
    applyMergedExternalDocument,
    dispatchDocumentStorageChange,
    isCurrentDocumentDirty,
    isEmbedded,
    loadWorkspaceDocument,
    refreshDocumentMetadatas,
    refreshMcpEditProposals,
    resetEditorDocument,
    saveUnsavedEditBackup,
    setSaveState,
    setStatusMessage,
    switchAwayFromDeletedFile,
  ]);

  const updateMetadata = (metadata: SigmaDocument["metadata"]) => {
    commitDocumentChange((current) => ({
      ...current,
      metadata,
      updatedAt: new Date().toISOString(),
    }));
  };

  const commitDocumentTitle = async () => {
    const fileId = activeFileIdRef.current;
    const current = documentRef.current;
    const file = documentMetadatas.find((item) => item.fileId === fileId);
    if (file && isDocumentTitleExplicit(current.metadata.title)) {
      const title = availableDocumentTitle(current.metadata.title, documentMetadatas, { ...file, excludeFileId: fileId });
      if (title !== current.metadata.title) updateMetadata({ ...current.metadata, title });
    }
    // Renaming is a completed user action. Persist it, including any in-flight
    // autosave, before a workspace refresh can display the previous ledger title.
    if (workspaceReady && await saveCurrentDocumentBeforeReplacement()) {
      await refreshDocumentMetadatas();
    }
  };

  const updatePageLayoutAndMetadata = (pageLayout: PageLayout, metadata: SigmaDocument["metadata"]) => {
    const normalizedLayout = expandMarginsForRunningRegions(normalizePageLayout(pageLayout));
    const issues = getPageLayoutIssues(normalizedLayout);
    if (issues.length > 0) {
      // コードで返るので、表示は `shape` 辞書で行う。
      setStatusMessage(formatSigmaValidationCode(issues[0], { min: MIN_PAGE_BODY_HEIGHT_MM }, tShape));
      return;
    }

    commitDocumentChange((current) => {
      const withLayout = ensurePageLayout(current);
      const switchingToWhiteboard = isWhiteboardPageLayout(normalizedLayout)
        && !isWhiteboardPageLayout(withLayout.pageLayout);
      const preparedDocument = switchingToWhiteboard
        ? convertOverlayToWhiteboard(withLayout, measuredBodyBlockRectsRef.current)
        : ensureOverlayAnchorOffsets(withLayout);
      const overlay = preparedDocument.pageLayout?.overlay ?? normalizedLayout.overlay;
      return {
        ...preparedDocument,
        pageLayout: {
          ...normalizedLayout,
          overlay,
        },
        metadata,
        updatedAt: new Date().toISOString(),
      };
    });
    if (isWhiteboardPageLayout(normalizedLayout) && !isWhiteboardDocument) {
      setCommentsPanelOpen(false);
    }
  };

  const handleCanvasHeadingCommand = useStableCallback((request: TextFlowHeadingCommandRequest): boolean =>
    handleHeadingCommandAutoNumbering(documentRef.current, updatePageLayoutAndMetadata, request));

  const {
    aiApplyAnimation,
    aiEditPreviewClearRequest,
    clearAiEditPreview,
    applyAiEditPreviewGroup,
    forceApplyStaleProposals,
    applyAllAiEditPreviewGroups,
    dismissAiEditPreviewGroup,
    discardStaleProposals,
    rebaseStaleProposals,
    restoreProposalFromHistory,
    revertAppliedProposals,
  } = useAiProposalActions({
    document,
    activeFileId,
    activeDocumentRevision,
    activeFileIdRef,
    selectedIdRef,
    lastSyncedDocumentRef,
    metadataByFileId,
    aiEditPreviewGroups,
    staleProposalGroups,
    aiProposalPresentation,
    mcpProposalCitations,
    locallyResolvedProposalIdsRef,
    mcpPreviewBusyRef,
    setMcpPreviewBusy,
    finishMcpPreviewBusy,
    flushOverlayChanges,
    inFlightSavePromiseRef,
    isCurrentDocumentDirty,
    saveCurrentDocumentRecord,
    setSaveState,
    setStatusMessage,
    refreshDocumentMetadatas,
    refreshMcpEditProposals,
    dispatchDocumentStorageChange,
    updateVersionHistoryCaptureStatus,
    applyAiApprovedDocument,
    resetEditorDocument,
    scheduleAutosaveRetry,
    announceRecovery,
    t,
  });

  const applyAiSurface = useCallback((next: AiSurfaceState) => {
    setAiDisplayMode(next.displayMode);
    setAiSidebarOpen(next.aiSidebarOpen);
    setAiInlineOpen(next.aiInlineOpen);
  }, []);

  const openAiInline = useCallback((anchor: { left: number; top: number } | null) => {
    // Web版にAIチャット面は無い (AI面はキャンバス左上のAiTaskDock一本)。⌘Kや
    // コマンドパレットからこの経路に入っても、空のパネルを開かせない。
    if (!isDesktopApp) {
      return;
    }
    setVersionHistoryOpen(false);
    // Reset the anchor unconditionally: a null anchor (⌘K with no selection) must
    // fall back to the CSS default position rather than reuse a stale selection rect.
    setAiInlineAnchor(anchor);
    // Bump the session id so the inline editor starts on a fresh input (rather than
    // re-showing a prior turn's result) each time it is opened.
    setAiInlineSessionId((current) => current + 1);
    applyAiSurface(openInline());
  }, [applyAiSurface, isDesktopApp, setVersionHistoryOpen]);

  const promoteAiToSidebar = useCallback(() => {
    if (!isDesktopApp) {
      return;
    }
    setVersionHistoryOpen(false);
    setAiInlineRunAnchor(null);
    setAiInlineRunAnchorCanvas(null);
    applyAiSurface(promoteToSidebar());
  }, [applyAiSurface, isDesktopApp, setVersionHistoryOpen]);

  const openVersionHistory = () => {
    if (versionHistoryRestoring) return;
    if (versionHistoryOpen) {
      setVersionHistoryOpen(false);
      setVersionHistoryPreviewState(null);
      return;
    }
    applyAiSurface({ displayMode: "sidebar", aiSidebarOpen: false, aiInlineOpen: false });
    setCommentsPanelOpen(false);
    setVersionHistoryOpen(true);
  };

  const handleVersionHistoryPreviewChange = useCallback((version: DocumentVersion | null) => {
    setVersionHistoryRestoreError(null);
    setVersionHistoryPreviewState(version
      ? { fileId: activeFileIdRef.current, version }
      : null);
  }, [setVersionHistoryRestoreError, setVersionHistoryPreviewState]);

  // R2: clicking an in-body AI run-anchor widget for a background room should
  // bring that room's log into view — promote to the docked sidebar (works
  // regardless of whichever surface/room is currently showing) and tell
  // AiEditPanel which room to select once it (re)mounts in sidebar mode.
  const [aiFocusRoomRequest, setAiFocusRoomRequest] = useState<{ roomId: string; seq: number } | null>(null);
  const focusAiSession = useCallback((roomId: string) => {
    setVersionHistoryOpen(false);
    setAiFocusRoomRequest({ roomId, seq: Date.now() });
    applyAiSurface(promoteToSidebar());
  }, [applyAiSurface, setVersionHistoryOpen]);

  const closeAiSurface = useCallback(() => {
    // Closing the inline editor discards a single-shot result, so drop the floating
    // body preview it left behind (clearAiEditPreview also dismisses the pending
    // turn) and the references pinned during that inline session. Closing the
    // docked sidebar must stay non-destructive: just hide the panel and leave any
    // unapplied proposal AND pinned references recoverable on reopen.
    if (aiDisplayMode === "inline" && aiInlineOpen) {
      setAiInlineClosing(true);
      window.setTimeout(() => {
        const closingInline = aiDisplayMode === "inline";
        applyAiSurface(closeSurface());
        setAiInlineClosing(false);
        if (closingInline) {
          clearAiEditPinnedReferences();
          if (!aiInlineRunAnchorRef.current) {
            clearAiEditPreview();
          }
        }
      }, 140);
      return;
    }

    const closingInline = aiDisplayMode === "inline";
    applyAiSurface(closeSurface());
    if (closingInline) {
      clearAiEditPinnedReferences();
      if (!aiInlineRunAnchorRef.current) {
        clearAiEditPreview();
      }
    }
  }, [aiDisplayMode, aiInlineOpen, applyAiSurface, clearAiEditPinnedReferences, clearAiEditPreview]);

  // AIパネル(inline/sidebar)が参照ハイライトを表示すべき状態か。
  const aiReferenceHighlightActive = useMemo(
    () =>
      (aiDisplayMode === "inline" && (aiInlineOpen || aiInlineRunAnchor !== null)) ||
      (aiDisplayMode === "sidebar" && aiSidebarOpen),
    [aiDisplayMode, aiInlineOpen, aiInlineRunAnchor, aiSidebarOpen],
  );

  const pinAiTextSelectionReference = useMemo(
    () => aiEditReference?.kind === "textSelection" &&
      !!aiEditReference.textRange &&
      aiReferenceHighlightActive,
    [aiEditReference, aiReferenceHighlightActive],
  );

  useEffect(() => {
    // 永続ハイライトが必要な pinned textSelection だけを通知する。暗黙のライブ選択は
    // ブラウザの通常の青い selection が示すため、Decoration を重ねない。
    const anchors: SigmaTextRangeCommentAnchor[] = [];
    if (aiReferenceHighlightActive) {
      for (const pinned of aiEditPinnedReferences) {
        if (pinned.kind === "textSelection" && pinned.textRange) {
          anchors.push(pinned.textRange);
        }
      }
    }
    window.dispatchEvent(new CustomEvent(AI_REFERENCE_TEXT_RANGE_EVENT, { detail: { anchors } }));
    return () => {
      window.dispatchEvent(new CustomEvent(AI_REFERENCE_TEXT_RANGE_EVENT, { detail: { anchors: [] } }));
    };
  }, [aiEditPinnedReferences, aiReferenceHighlightActive]);

  // ピン留めした textSelection の textRange は、pinした時点のブロック内容に対する文字
  // オフセットのスナップショット。このコードベースには、編集トランザクションに合わせて
  // コメントの textRange オフセットを追従させる仕組みは存在しない (コメント自体も
  // isCommentAnchorOrphan でブロックの有無だけを見ており、オフセットのズレは検出しない
  // — 再利用できる「リマップ機構」はない)。そのため、pin後にブロック内容が変わって
  // オフセットの意味が変わってしまった場合は、ハイライト/送信内容がズレたまま古い
  // textRange を使い続けるより安全側に倒し、その textRange だけを破棄する
  // (selectedText/mathTexはpin時点の内容としてそのまま送り続けられる)。
  useEffect(() => {
    reconcileAiEditPinnedReferenceTextRanges(document, aiEditPinnedReferences);
  }, [
    aiEditPinnedReferences,
    document,
    reconcileAiEditPinnedReferenceTextRanges,
  ]);

  // useCallback 必須。素の関数だと毎描画で identity が変わり、PageCanvasEditor へ渡る
  // selection 拡張が作り直され、その選択 effect の state 更新がまた EditorShell を描画する
  // — 何もしていなくても回り続けるループの起点になる (WI-2)。
  const requestAiEditWithReference = useCallback((
    reference: AiEditReference,
    anchor?: { left: number; top: number } | null,
    overlayPreview?: AiEditShapeOnlyPreview,
  ) => {
    const pinResult = pinAiEditPinnedReference(reference, overlayPreview);
    const requestPlan = deriveAiReferenceRequestPlan({
      reference,
      pinOutcome: pinResult.outcome,
      displayMode: aiDisplayMode,
      inlineOpen: aiInlineOpen,
      sidebarOpen: aiSidebarOpen,
      anchor,
      selectedId: selectedIdRef.current,
      t: tAi,
    });
    // 既にAI面 (inline/sidebarのどちらか) が開いていれば、そこへ追加pinするだけに留める。
    // openAiInline は毎回 aiInlineSessionId をbumpしてAiEditPanelを作り直す(=composerが
    // 消える)ため、2件目以降のピン留めでこれを呼ぶと「入力中の指示文が消える」事故になる。
    // 面がまだ何も開いていないときだけ、新規セッションとして inline を開く。
    if (requestPlan.surfaceAction === "openInline") {
      openAiInline(requestPlan.inlineAnchor);
    }
    // 図形参照をpinしたときはoverlay選択を維持する。本文ブロックを選択し直すと
    // overlay snapshotの元になった図形選択が解除され、直後の追加操作も失われる。
    if (requestPlan.selectionAction.type === "selectBlock") {
      selectedIdRef.current = requestPlan.selectionAction.targetId;
      setSelectedId(requestPlan.selectionAction.targetId);
    }
    setStatusMessage(requestPlan.statusMessage);
  }, [aiDisplayMode, aiInlineOpen, aiSidebarOpen, openAiInline, pinAiEditPinnedReference, setSelectedId, setStatusMessage]);

  const updateAiEditReferenceCandidate = useCallback((reference: AiEditReference | null) => {
    if (!reference && pinAiTextSelectionReference) {
      return;
    }
    setAiEditReference(reference);
  }, [pinAiTextSelectionReference]);

  const updatePageLayout = (pageLayout: PageLayout, options?: PageLayoutChangeOptions) => {
    const normalizedLayout = expandMarginsForRunningRegions(normalizePageLayout(pageLayout));
    const issues = getPageLayoutIssues(normalizedLayout);
    if (issues.length > 0) {
      // コードで返るので、表示は `shape` 辞書で行う。
      setStatusMessage(formatSigmaValidationCode(issues[0], { min: MIN_PAGE_BODY_HEIGHT_MM }, tShape));
      return;
    }

    commitDocumentChange((current) => {
      const withLayout = ensurePageLayout(current);
      const switchingToWhiteboard = isWhiteboardPageLayout(normalizedLayout) && !isWhiteboardPageLayout(normalizePageLayout(withLayout.pageLayout));
      const preparedDocument = switchingToWhiteboard
        ? convertOverlayToWhiteboard(withLayout, measuredBodyBlockRectsRef.current)
        : ensureOverlayAnchorOffsets(withLayout);
      const overlay = preparedDocument.pageLayout?.overlay ?? normalizedLayout.overlay;
      return {
        ...preparedDocument,
        pageLayout: {
          ...normalizedLayout,
          overlay,
        },
        updatedAt: new Date().toISOString(),
      };
      // running region (ヘッダ / フッタ) の overlay もここを通る。`writeOverlay` と
      // 同じ解決を使わないと、そちらに属する図形を含む混在操作だけ 2 エントリになる。
    }, resolveOverlayCommitOptions(options));
    if (isWhiteboardPageLayout(normalizedLayout) && !isWhiteboardDocument) {
      setCommentsPanelOpen(false);
    }
    if (options?.silent) {
      return;
    }
    setStatusMessage(tEditor("status.pageSetupUpdated"));
  };

  const resizeOutline = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setOutlineOpen(true);

    const startX = event.clientX;
    const startWidth = outlineWidth;

    const clampWidth = (width: number) => {
      const reservedWidth = MIN_EDITOR_WIDTH_WHILE_RESIZING_OUTLINE
        + (aiSidebarOpen ? AI_SIDEBAR_WIDTH : 0);
      const availableWidth = window.innerWidth - reservedWidth;
      const maxWidth = Math.min(MAX_OUTLINE_WIDTH, Math.max(MIN_OUTLINE_WIDTH, availableWidth));
      return Math.min(maxWidth, Math.max(MIN_OUTLINE_WIDTH, width));
    };

    const handleMouseMove = (moveEvent: globalThis.MouseEvent) => {
      setOutlineWidth(clampWidth(startWidth + moveEvent.clientX - startX));
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.document.body.classList.remove("is-resizing-outline");
    };

    window.document.body.classList.add("is-resizing-outline");
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  useEditorCommandRouting({
    configuration: { customCommands, shortcutOverrides, commandSettingsLoaded, commandSettingsError },
    keyboard: {
      isModalSurfaceOpen,
      uiLayoutMode: uiLayoutPreference.mode,
      hasOverlaySelection,
      overlaySelectionLocked: overlaySelection.locked,
      blockedOverlaySelection: aiLockedOverlaySelection,
      overlayModeStatus,
    },
    runShortcutCommandRef,
    toggleRibbonCollapseRef,
    actions: {
      text: {
        runEditCommand, toggleBoxedText, applyTextStyle, applyTextAlign, applyLineHeight,
        applyInlineFormat, getActiveTextTarget, insertInlineMath, setFontFamily,
        setTextFontSize, setTextColor, setTextBackgroundColor,
      },
      overlay: {
        runOverlayCommand, requestOverlayAction, applyOverlayStyle, fillColorPatch,
        setStrokeColor, imageInputRef,
      },
      menus: {
        closeTransientCommandSurfaces, setFontFamilyMenuOpen, setLineHeightMenuOpen,
        setLineHeightCustomOpen, setTextAlignMenuOpen, setLineDashMenuOpen,
        setLineWidthMenuOpen, setLineEndpointMenu,
      },
      application: {
        undoDocumentChange, redoDocumentChange, createDocumentTab, openDocumentListDialog,
        duplicateActiveDocument, addBlock, setSearchOpen, setOutlineOpen, applyZoom,
        resetZoom, setSettingsFocusEntryId, setCommandPaletteOpen, openPrintPreview,
        toggleCommentsPanel, setOutlineDialogOpen, promoteAiToSidebar, setAiSettingsOpen,
        setPageSettingsOpen, openCommandSettings, setMaterialLibraryOpen, setStatusMessage,
        tEditor,
      },
    },
  });

  useEffect(() => {
    const handleInlineShortcut = (event: KeyboardEvent) => {
      if (!isInlineToggleShortcut(event) || event.repeat) {
        return;
      }
      if (
        commandSettingsOpen ||
        texCommandReferenceOpen ||
        !commandSettingsLoaded ||
        commandSettingsError ||
        pageSettingsOpen ||
        documentListOpen ||
        previewOpen ||
        aiSettingsOpen ||
        desktopSettingsOpen ||
        materialLibraryOpen ||
        ribbonBackstageOpen ||
        commandPaletteOpen
      ) {
        return;
      }
      // Defer to a user-rebound command on ⌘K/Ctrl+K: the command-shortcut listener
      // shares this capture phase and stopPropagation won't stop a sibling listener,
      // so without this the same keystroke would both run the command and toggle.
      if (findCommandByShortcut(event, shortcutOverrides, customCommands)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const next = toggleSurface({ displayMode: aiDisplayMode, aiSidebarOpen, aiInlineOpen });
      if (!next.aiInlineOpen && !next.aiSidebarOpen) {
        closeAiSurface();
      } else if (next.displayMode === "inline") {
        openAiInline(null);
      } else {
        setVersionHistoryOpen(false);
        applyAiSurface(next);
      }
    };
    window.addEventListener("keydown", handleInlineShortcut, true);
    return () => window.removeEventListener("keydown", handleInlineShortcut, true);
  }, [
    aiDisplayMode,
    aiSidebarOpen,
    aiInlineOpen,
    applyAiSurface,
    closeAiSurface,
    openAiInline,
    commandSettingsOpen,
    texCommandReferenceOpen,
    commandSettingsError,
    commandSettingsLoaded,
    pageSettingsOpen,
    documentListOpen,
    previewOpen,
    aiSettingsOpen,
    desktopSettingsOpen,
    materialLibraryOpen,
    ribbonBackstageOpen,
    commandPaletteOpen,
    customCommands,
    shortcutOverrides,
  ]);

  // 導出は毎回新しい配列を作るので、useMemo の中で 1 回だけ呼ぶ。裸で呼ぶと本文と無関係な
  // 再レンダー (メニュー・選択・フォーカス) のたびに nodes の参照が変わり、タイトル・タブ・
  // アウトラインの DocumentTitleText の memo が全部外れる。
  const documentTitle = useMemo(() => resolveDocumentTitleContent(document), [document]);
  const resolvedDocumentTitle = documentTitle.text;
  const titleInputValue = documentTitleInputValue(document.metadata.title) || resolvedDocumentTitle;
  // 数式を含むタイトルは、非フォーカス時だけリッチ表示を入力欄に重ねる。この state は JSX でしか
  // 読まない — effect の依存に入力まわりの state を置くと「1 文字しか打てない」事故を再発させる。
  const [titleInputFocused, setTitleInputFocused] = useState(false);
  // 明示タイトルの入力欄には保存値がそのまま出る (正規化前) ので、重ねる側も同じ文字列から
  // 読む。派生タイトルは入力欄の値が導出結果そのものなので、潰していないノード列を使う。
  // 条件を 2 箇所に書くと必ずずれるので 1 変数に畳んでいる。
  const titleRichNodes = isDocumentTitleExplicit(document.metadata.title)
    ? parseDocumentTitleInlineNodes(titleInputValue)
    : documentTitle.nodes;
  const showRichTitle = !titleInputFocused && titleRichNodes !== null;

  // 記録済みの失敗は、その教材がアクティブな間だけ画面に出す (他の教材を開いている
  // 間は残っていても無害。次にその教材を開こうとした時点で読み直して更新される)。
  const activeDocumentOpenFailure = documentOpenFailure?.fileId === activeFileId ? documentOpenFailure : null;
  // ページ編集面が実際に描かれる条件。ステータスバーのページ数もこれを見る
  // （描かれていないのに前の教材のページ数を出さないため。onPageCountChange は
  // アンマウントでは呼ばれない）。
  const pageEditorMounted = workspaceReady && !activeDocumentOpenFailure && !versionHistoryPreviewActive;

  const reloadFailedDocument = useCallback(async () => {
    const failure = documentOpenFailureRef.current;
    if (!failure) {
      return;
    }
    await openDocumentInWorkspace(failure.fileId, {
      saveCurrent: false,
      status: tEditor("status.reopened"),
    });
  }, [openDocumentInWorkspace]);

  const openDocumentTabs = useMemo(() => {
    return openFileIds.map((fileId) => {
      const metadata = metadataByFileId.get(fileId);
      if (fileId === activeFileId) {
        return {
          fileId,
          title: resolvedDocumentTitle,
          updatedAt: document.updatedAt ?? metadata?.updatedAt ?? "",
        };
      }

      return {
        fileId,
        title: metadata?.title || tE("shell.untitledDocument"),
        updatedAt: metadata?.updatedAt ?? "",
      };
    });
  }, [activeFileId, document, metadataByFileId, openFileIds, resolvedDocumentTitle, tE]);
  const pageNavigatorScale = Math.min(
    PAGE_NAVIGATOR_MAX_SCALE,
    Math.max(
      PAGE_NAVIGATOR_MIN_SCALE,
      (outlineWidth - PAGE_NAVIGATOR_SCALE_GUTTER_PX) / PAGE_NAVIGATOR_PRINT_PAGE_WIDTH_PX,
    ),
  );
  const pageNavigatorViewportHeight = Math.round(PAGE_NAVIGATOR_PRINT_PAGE_HEIGHT_PX * pageNavigatorScale) + 8;
  const pageNavigatorItemHeight = pageNavigatorViewportHeight + 4;
  const pageNavigatorStyle = {
    "--page-nav-thumbnail-scale": String(pageNavigatorScale),
    "--page-nav-viewport-height": `${pageNavigatorViewportHeight}px`,
    "--page-nav-item-height": `${pageNavigatorItemHeight}px`,
  } as CSSProperties;
  const aiSurface = resolveAiSurface({ displayMode: aiDisplayMode, aiSidebarOpen, aiInlineOpen });

  const workspaceClassName = [
    "workspace",
    showPageNavigator ? "" : "outline-hidden",
    outlineOpen ? "" : "outline-collapsed",
    aiSurface.gridHasAiColumn || versionHistoryOpen ? "ai-sidebar-open" : "",
  ].filter(Boolean).join(" ");

  const {
    renderMenuShortcut,
    paletteEntries,
    runPaletteEntry,
    commandTooltip,
    overlayArrangeShortcutLabels,
  } = useCommandPalette({
    commandPaletteOpen,
    catalog: { customCommands, shortcutOverrides, shortcutPlatform, isEmbedded, tCommand, tSettings },
    surfaces: {
      setCommandPaletteOpen, setSettingsFocusEntryId, setDesktopSettingsOpen, setAiSettingsOpen,
      setPageSettingsOpen, setTexEnvironmentSettingsOpen, openCommandSettings,
    },
    runShortcutCommandRef,
  });
  const titleUpdatePhase = appUpdateState?.phase;
  const showTitleUpdateButton = titleUpdatePhase === "available" || titleUpdatePhase === "downloading" || titleUpdatePhase === "downloaded";
  const titleUpdateButtonDisabled = appUpdateActionBusy || titleUpdatePhase === "downloading";
  const handleTitleUpdateAction = async () => {
    const bridge = getDesktopBridge();
    if (!bridge?.updater || !appUpdateState) {
      return;
    }

    setAppUpdateActionBusy(true);
    try {
      if (appUpdateState.phase === "downloaded") {
        const result = await bridge.updater.quitAndInstall();
        if (!result.ok) {
          setStatusMessage(result.error);
        }
        return;
      }

      setStatusMessage(tEditor("status.updateDownloading"));
      const result = await bridge.updater.downloadUpdate();
      setAppUpdateState(result);
      if (result.phase === "downloaded") {
        setStatusMessage(tEditor("status.updateReady"));
      } else if (result.phase === "error") {
        setStatusMessage(result.error ?? tEditor("status.updateDownloadFailed"));
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : tEditor("status.updateStartFailed"));
    } finally {
      setAppUpdateActionBusy(false);
    }
  };
  // AI 提案の適用/破棄は文書・提案・実行状態を跨いで書き換える処理なので、依存を全部
  // useCallback へ畳み込むのは現実的でない。呼び出し口だけ identity を固定する
  // (紙面の AI 拡張オブジェクトがこの 2 つを掴んでおり、動くと紙面が毎打鍵で描き直される)。
  // キャンバスへ渡すコールバックは全て安定させる。本文ユニット (memo 済み) の props に
  // そのまま流れるので、ここでインライン arrow を書くと打鍵のたびに全ユニットが描き直される。
  const applyVisibleAiEditPreviewGroup = async (proposalIds: string[]): Promise<AiProposalApplyOutcome> => {
    const webMcpOutcome = await webMcpBridgeRef.current?.applyProposalIds(proposalIds);
    if (webMcpOutcome) {
      return webMcpOutcome;
    }
    return applyAiEditPreviewGroup(proposalIds);
  };
  const dismissVisibleAiEditPreviewGroup = async (proposalIds: string[], reason?: string) => {
    if (webMcpBridgeRef.current?.dismissProposalIds(proposalIds)) {
      return;
    }
    await dismissAiEditPreviewGroup(proposalIds, reason);
  };
  const stableApplyVisibleAiEditPreviewGroup = useStableCallback(applyVisibleAiEditPreviewGroup);
  const stableDismissVisibleAiEditPreviewGroup = useStableCallback(dismissVisibleAiEditPreviewGroup);
  const handleCanvasSelect = useCallback((blockId: string | null) => {
    setSelectedInlineMath(null);
    if (blockId !== selectedIdRef.current) {
      setAiEditReference(null);
    }
    selectedIdRef.current = blockId;
    if (blockId) {
      materialBlockSelectionRef.current = blockId;
    }
    setSelectedId(blockId);
  }, [setAiEditReference, setSelectedId, setSelectedInlineMath]);
  const getWebMcpDocument = useCallback(() => documentRef.current, []);
  const getWebMcpRevision = useCallback(() => documentDirtyRevisionRef.current, []);
  const getWebMcpSelectedBlockId = useCallback(() => selectedIdRef.current, []);
  const webMcpSelectionRef = useRef({ selectedInlineMath, overlaySelection });
  useLayoutEffect(() => {
    webMcpSelectionRef.current = { selectedInlineMath, overlaySelection };
  }, [overlaySelection, selectedInlineMath]);
  const getWebMcpSelection = useCallback(() => {
    const selection = webMcpSelectionRef.current;
    const bookmark = textSelectionBookmarkRef.current;
    const textRange = bookmark
      && bookmark.anchor.kind === "text"
      && bookmark.head.kind === "text"
      && bookmark.anchor.blockId === bookmark.head.blockId
      ? (() => {
          const block = findBlock(documentRef.current, bookmark.anchor.blockId);
          if (!block || (block.type !== "paragraph" && block.type !== "heading")) {
            return null;
          }
          const from = Math.min(bookmark.anchor.offset, bookmark.head.offset);
          const to = Math.max(bookmark.anchor.offset, bookmark.head.offset);
          const text = inlineNodesToPlainText(block.children);
          if (to > text.length) {
            return null;
          }
          return { blockId: block.id, from, to, quote: text.slice(from, to) };
        })()
      : null;
    return {
      blockId: selectedIdRef.current,
      textRange,
      inlineMath: selection.selectedInlineMath
        ? {
            id: selection.selectedInlineMath.id,
            tex: selection.selectedInlineMath.tex,
            ...(selection.selectedInlineMath.blockId ? { blockId: selection.selectedInlineMath.blockId } : {}),
          }
        : null,
      overlayShapes: selection.overlaySelection.selectedShapes.map((shape) => ({
        id: shape.id,
        type: shape.type,
        shape,
      })),
    };
  }, []);
  const navigateToWebMcpTarget = useCallback((target: { kind: "block" | "shape"; id: string }) => {
    if (target.kind === "block") {
      handleCanvasSelect(target.id);
      scheduleEditorBlockFocus(target.id);
      return;
    }
    window.requestAnimationFrame(() => {
      const element = window.document.querySelector<HTMLElement>(
        `[data-overlay-shape-id="${CSS.escape(target.id)}"]`,
      );
      element?.scrollIntoView({ block: "center", inline: "center" });
    });
  }, [handleCanvasSelect]);
  const handleDuplicateBlock = useCallback((blockId: string) => {
    commitDocumentChange((current) => duplicateTopLevelBlock(current, blockId));
  }, [commitDocumentChange]);
  const handleMoveBlock = useCallback((blockId: string, direction: "up" | "down") => {
    commitDocumentChange((current) => moveTopLevelBlock(current, blockId, direction));
  }, [commitDocumentChange]);
  const handleAddProblemBlock = useCallback((
    problemId: string,
    area: ProblemAreaKind,
    blockToAdd: RichBlock,
  ) => {
    commitDocumentChange((current) => addRichBlockToProblem(current, problemId, area, blockToAdd));
  }, [commitDocumentChange]);
  const handleCanvasMaterialInsert = useCallback((request: TextFlowMaterialInsertRequest & { origin: OverlayPoint }) => {
    insertMaterialAt(request.material, request.triggerBlockId, request.origin);
  }, [insertMaterialAt]);
  const handleSelectionMaterialSaveRequest = useCallback((blockIds: string[]) => {
    openMaterialAddDialog(null, blockIds);
  }, [openMaterialAddDialog]);
  const handleCanvasProblemCommand = useCallback(({ triggerBlockId }: TextFlowProblemCommandRequest) => (
    insertProblemFromTextFlowCommand(triggerBlockId)
  ), [insertProblemFromTextFlowCommand]);
  /**
   * `/引用` `/コード` `/区切り線`。作るのは ProseMirror のコマンドなので、ここはツールバーの
   * ブロックボタンと**同じ関数**へ渡すだけ — 押した後にキャレットをどこへ戻すかの規則
   * (`applyBlockStructure`) を 1 箇所に保つ。
   *
   * ボタンが押せない状態 (`canUseBlockStructure` が false) では受けない。false を返すと
   * エディタが自分でコマンドだけ実行するので、`/` から何も起きないことにはならない。
   *
   * 識別子は memo 済みのキャンバスへ渡るので固定し、そのときの関数と可否は ref から読む。
   */
  const handleCanvasBodyBlockCommand = useCallback(({ kind }: TextFlowBodyBlockCommandRequest) => {
    const { canUse, apply } = blockStructureCommandRef.current;
    if (!canUse) {
      return false;
    }
    apply(kind === "quote" ? "quote" : kind === "codeBlock" ? "code" : "divider");
    return true;
  }, []);
  const handleOverlayCommandHandled = useCallback((requestId: number) => {
    setOverlayCommandRequest((current) => current?.id === requestId ? null : current);
  }, []);
  const handleOverlayImageHandled = useCallback((requestId: number) => {
    setOverlayImageRequest((current) => current?.id === requestId ? null : current);
  }, []);
  const handleOverlayActionHandled = useCallback((requestId: number) => {
    setOverlayActionRequest((current) => current?.id === requestId ? null : current);
  }, []);
  const handleOverlayEditingChange = useCallback((editing: boolean) => {
    setOverlayEditing(editing);
    if (!editing) {
      setOverlaySelection(EMPTY_OVERLAY_SELECTION);
      setLineDashMenuOpen(false);
      setLineWidthMenuOpen(false);
      setActiveOverlayTool({ kind: "select" });
    }
  }, [setOverlayEditing, setOverlaySelection, setLineDashMenuOpen, setLineWidthMenuOpen, setActiveOverlayTool]);
  const handleReloadFailedDocument = useCallback(() => {
    void reloadFailedDocument();
  }, [reloadFailedDocument]);

  const commentPanelProps = useMemo(() => ({
    activeThreadId: activeCommentThreadId,
    author: commentAuthor,
    candidateAnchor: currentCommentAnchor,
    pendingAnchor: pendingCommentAnchor,
    pendingDraft: pendingCommentDraft,
    replyDrafts: commentReplyDrafts,
    showResolved: showResolvedComments,
    threads: visibleCommentThreadsForPanel,
    onAddThread: addPendingCommentThread,
    onCancelPending: () => {
      setPendingCommentAnchor(null);
      setPendingCommentDraft([]);
    },
    onDeleteMessage: deleteCommentMessage,
    onDeleteThread: deleteCommentThread,
    onEditMessage: editCommentMessage,
    onEditThread: editCommentThread,
    onPendingDraftChange: setPendingCommentDraft,
    onReply: replyToCommentThread,
    onReplyDraftChange: setCommentReplyDraft,
    onResolveThread: (threadId: string) => updateCommentResolved(threadId, true),
    onReopenThread: (threadId: string) => updateCommentResolved(threadId, false),
    onSelectThread: selectCommentThread,
    onShowResolvedChange: setShowResolvedComments,
    onStartThread: openCommentComposer,
    onThreadHoverChange: setHighlightedCommentThreadId,
    onToggleReaction: toggleCommentReaction,
  }), [
    activeCommentThreadId,
    addPendingCommentThread,
    commentAuthor,
    commentReplyDrafts,
    currentCommentAnchor,
    deleteCommentMessage,
    deleteCommentThread,
    editCommentMessage,
    editCommentThread,
    openCommentComposer,
    pendingCommentAnchor,
    pendingCommentDraft,
    replyToCommentThread,
    selectCommentThread,
    setCommentReplyDraft,
    setHighlightedCommentThreadId,
    setPendingCommentAnchor,
    showResolvedComments,
    toggleCommentReaction,
    updateCommentResolved,
    visibleCommentThreadsForPanel,
  ]);

  if (ledgerFailure) {
    return (
      <div className="app-shell">
        <LedgerSchemaFailurePanel
          failure={ledgerFailure}
          onReload={() => {
            setLedgerFailure(null);
            setWorkspaceReady(false);
            setWorkspaceReloadNonce((current) => current + 1);
          }}
        />
      </div>
    );
  }

  // クロームへ渡す値。**useMemo は使わない**: 依存配列が200個近くになり、1つ漏らすだけで
  // 「押しても光らないボタン」という無音の腐敗になる。EditorShell はもともと毎レンダー全体が
  // 再構築されるので、素の object literal なら挙動は現行と厳密に同一。同じ理由でグループ部品に
  // React.memo も付けない（参照が毎回変わるので無意味なうえ、付け方次第で腐敗を招く）。
  const chrome: EditorChromeValue = {
    commands: {
      commandTooltip, renderMenuShortcut,
    },
    toolbarMenus: {
      setActiveMenu, setBoxedTextMenuOpen, setColorStylePanel, setFontFamilyMenuOpen,
      setBlockStyleMenuOpen,
      setLineDashMenuOpen, setLineEndpointMenu, setLineHeightMenuOpen, setLineToolMenuOpen,
      setLineWidthMenuOpen, setShapeMenuOpen, setTextAlignMenuOpen,
    },
    shared: {
      activeMenu, aiDocumentWriteInProgress, colorStylePanel, document, getActiveTextTarget,
      imageInputRef, insertInlineMath, isDesktopApp, isEmbedded, runEditCommand, runOverlayCommand,
      // `saveState` / `statusMessage` は渡さない。打鍵のたびに動く値なので、
      // 購読は葉 (`SaveStatusIndicators`) に閉じ込めてある。
      setStatusMessage, shapeGallerySections, lineToolItems, t, toggleMenu,
      versionHistoryPreviewActive,
    },
    editing: {
      setMaterialLibraryOpen,
    },
    format: {
      ActiveTextAlignIcon, activeFontFamilyLabel, activeTextAlignOption,
      activeTextFontSize, activeTextFontSizeMixed, applyBoxedTextPaddingY, applyInlineFormat, applyLineHeight,
      applyBlockStructure, applyTextAlign, applyTextStyle, blockStyleState, boldActive, boxedTextActive, boxedTextButtonRef,
      canUseBlockStructure,
      moreBlocksMenuButtonRef, moreBlocksMenuOpen, setMoreBlocksMenuOpen,
      orderedListMenuButtonRef, orderedListMenuOpen, setOrderedListMenuOpen,
      boxedTextMenuOpen, boxedTextPaddingY, boxedTextVariant, canUseLineHeight, canUseTextAlign,
      blockStyleButtonRef, blockStyleMenuOpen,
      canUseTextBlockStyle, canUseTextToolbar, fontFamily, fontFamilyButtonRef,
      fontFamilyIsKnownOption, fontFamilyIsMixed, fontFamilyMenuOpen, fontFamilyQuery,
      fontSizeInputRef, fontSizeInput, setFontSizeInput,
      handleLineHeightStepClick, italicActive, lineHeight, lineHeightButtonRef,
      lineHeightCustomOpen, lineHeightInput, lineHeightInputError, lineHeightMenuOpen,
      saveEditorFontFamilyPreference, selectBoxedTextVariant, selectedTextAlign, selectedTextStyle,
      setFontFamily, setFontFamilyQuery, setLineHeightCustomOpen, setLineHeightInput,
      setLineHeightInputError, setTextBackgroundColor, setTextColor, setTextFontSize,
      startLineHeightStepping, stopLineHeightStepping, textAlignButtonRef, textAlignMenuOpen,
      textBackgroundColor, textBackgroundColorButtonRef, textColor, textColorButtonRef,
      toggleBoxedText, underlineActive, visibleCustomFontOptions, visibleFontFamilyGroups,
    },
    insert: {
      ActiveLineToolIcon, activeLineToolItem, activeOverlayTool, bodyToolbarLockedByAi,
      cancelInlineMathMenuClose, inlineMathButtonRef, inlineMathMenuOpen, lineToolMenuButtonRef,
      lineToolMenuOpen, openInlineMathMenu, scheduleInlineMathMenuClose, selectedInlineMath,
      selectedInlineMathDetails, setInlineMathMenuOpen, shapeMenuButtonRef, shapeMenuOpen,
      startInlineMathFromToolbar,
    },
    shapeStyle: {
      applyOverlayStyle, arrangeOverlayShapes, canArrangeOverlayShapes, canUseFillStyleControls, canUseLineEndpointControls,
      canUseLineStyleControls, canUseStrokeStyleControls, effectiveLineDashMenuOpen,
      effectiveLineEndpointMenu, effectiveLineWidthMenuOpen, fillColorButtonRef, fillColorPatch,
      lineDashButtonRef, lineWidthButtonRef, overlaySelection, selectedOverlayLineDash,
      selectedOverlayLineSize, selectionFill, selectionFillColor, selectionFillOpacity,
      setStrokeColor, strokeColor, strokeColorButtonRef,
    },
    search: {
      findNext, findPrevious, overlayEditing, replaceAll, replaceNext, replaceOpen, replaceText,
      searchButtonRef, searchMatchCount, searchOpen, searchQuery, setReplaceOpen, setReplaceText,
      setSearchOpen, setSearchQuery,
    },
    view: {
      activePageNumber,
      applyZoom,
      // ページ編集面が描かれていない間 (ワークスペース再読込中・教材が開けなかったとき)
      // は、直前の教材のページ数が残らないようにする。onPageCountChange は
      // アンマウントでは呼ばれないので、ここで «描かれているか» を見て畳む。
      pageCount: pageEditorMounted ? editorPageCount : 1,
      zoom,
      zoomOptions,
    },
    appMenu: {
      activeDocumentOpenFailure, activeFileId, addBlock, aiMenuButtonRef, appUpdateState,
      closeDocumentTab, commentsPanelOpen, commitDocumentTitle, copyDocumentText, createDocumentTab, createWhiteboardDocumentTab, degradedWatcherScopes,
      deleteActiveDocument, documentMetadatas, documentTitle, duplicateActiveDocument, exportJson,
      exportMenuOpen, fileMenuButtonRef, handleTitleUpdateAction,
      importDocumentFile, importInputRef, insertMenuButtonRef, loadingFileId,
      newDocButtonRef, newDocMenuOpen, openCommandSettings, openDocumentInWorkspace,
      openDocumentListDialog, openDocumentTabs, openImportDialog, openNewDocMenu, openOtherImportDialog,
      openPrintPreview, openTextImportDialog, otherImportInputRef,
      openVersionHistory, openWorkspaceScreen, promoteAiToSidebar, reportIssue, requestOverlayImages,
      resolvedDocumentTitle, scheduleCloseNewDocMenu,
      setAiSettingsOpen, setDesktopSettingsOpen: openDesktopSettingsFromChrome, setExportMenuOpen, setNewDocMenuOpen,
      setOutlineDialogOpen, setOverlayEditing, setPageSettingsOpen, setTemplateGalleryOpen,
      setTexCommandReferenceOpen, setTexEnvironmentSettingsOpen, setTitleInputFocused,
      settingsMenuButtonRef, showRichTitle,
      showTitleUpdateButton, titleInputValue, titleRichNodes,
      titleUpdateButtonDisabled, toggleCommentsPanel, uiLayoutPreference, updateMetadata,
      updateUiLayoutPreference, versionHistoryOpen,
    },
    ribbon: {
      applyColumnCommand,
      backstage: ribbonBackstageState,
      closeBackstage: closeRibbonBackstage,
      columnCommand: ribbonColumnCommand,
      contextualTabVisible: ribbonContextualTabVisible,
      ribbonIdPrefix,
      ribbonTabState,
      ribbonCollapse,
      selectBackstageSection: selectRibbonBackstageSection,
      selectRibbonTab,
      toggleBackstage: toggleRibbonBackstage,
      toggleRibbonCollapse,
    },
  };

  return (
    <MathEnvironmentProvider
      mathFractionSizing={document.metadata.mathFractionSizing}
      preamble={document.metadata.texPreamble}
    >
    {/* ribbon-chrome.css のセレクタはすべてこの属性から始まる。docs では "docs"。 */}
    <div
      className="app-shell"
      data-ui-layout={uiLayoutPreference.mode}
      data-backstage-open={ribbonBackstageOpen ? "true" : undefined}
      data-ribbon-collapsed={ribbonCollapse.collapsed ? "true" : undefined}
      data-ai-sidebar-open={aiDisplayMode === "sidebar" && aiSidebarOpen ? "true" : undefined}
      style={{ "--ai-sidebar-width": `${AI_SIDEBAR_WIDTH}px` } as CSSProperties}
    >
      <WebMcpBridge
        ref={webMcpBridgeRef}
        enabled={webMcpEnabled}
        instructionScopeId={document.docId}
        getDocument={getWebMcpDocument}
        getRevision={getWebMcpRevision}
        getSelectedBlockId={getWebMcpSelectedBlockId}
        getSelection={getWebMcpSelection}
        commitDocumentChange={commitDocumentChange}
        navigateToTarget={navigateToWebMcpTarget}
        onPreviewGroupsChange={setWebMcpPreviewGroups}
        onHistoryChange={setWebMcpHistory}
      />
      {/* 図形を選んでいる間、フォーカスを失った本文の選択を描き直す帯。
          「本文も図形も同時に選ばれている」ことが画面から読めないと混在コピーは事故になる。 */}
      <HeldBodySelectionOverlay active={overlaySelection.selectedCount > 0} />
      <CommandPalette
        open={commandPaletteOpen}
        entries={paletteEntries}
        onClose={() => setCommandPaletteOpen(false)}
        onSelect={runPaletteEntry}
      />

      <DesktopSettingsModal
        open={desktopSettingsOpen}
        onClose={() => {
          setDesktopSettingsOpen(false);
          setDesktopSettingsUpdateCheckRequest(0);
          setSettingsFocusEntryId(undefined);
        }}
        onFontsChanged={reloadCustomFonts}
        requestUpdateCheck={desktopSettingsUpdateCheckRequest}
        focusEntryId={settingsFocusEntryId}
      />
      {!isEmbedded && (
        <AiSettingsDialog
          open={aiSettingsOpen}
          onClose={() => {
            setAiSettingsOpen(false);
            setSettingsFocusEntryId(undefined);
          }}
          activeWorkspaceId={documentMetadatas.find((meta) => meta.fileId === activeFileId)?.workspaceId ?? null}
          focusEntryId={settingsFocusEntryId}
        />
      )}
      {/* 複数runの編集案がたまっているとき、1操作でまとめて承認できる一括ボタン (Issue 4)。
          衝突するrunがあればそれだけ stale notice に残り、他は適用される。 */}
      {isDesktopApp && workspaceReady && aiEditPreviewGroups.length >= 2 && (
        <div className="ai-apply-all-bar" role="region" aria-label={tE("aria.applyAllAiEdits")}>
          <span className="ai-apply-all-count">{tE("aiApplyAll.count", { edits: aiEditPreviewGroups.length })}</span>
          <button
            type="button"
            className="ai-apply-all-button"
            disabled={mcpPreviewBusy}
            onClick={() => void applyAllAiEditPreviewGroups()}
          >
            {tE("aiApplyAll.applyAll")}
          </button>
        </div>
      )}
      {/* ヘッダーはリボン UI (`editor-shell/chrome`) が描く。保存状態のバッジとタブの点は
          リボンの中で葉が購読するので、ここで saveState を読む必要はない。 */}
      {renderEditorChrome(chrome)}

      <main
        className={workspaceClassName}
        // Backstage は本文を覆うので、覆っている間は本文を丸ごと不活性にする。
        // capture の keydown ガードだけでは Tab で裏へ抜けられ、beforeinput 経由で
        // 見えない本文を編集できてしまう（inert はフォーカスも入力もまとめて塞ぐ）。
        inert={ribbonBackstageOpen}
        style={{
          "--outline-width": `${outlineWidth}px`,
        } as CSSProperties}
      >
        {showPageNavigator && (
          <aside className="outline-panel page-navigator-panel" aria-label={tE("aria.pagePreview")}>
          <div className="panel-header page-navigator-panel-header">
            <Tooltip {...commandTooltip(outlineOpen ? tE("aria.closePageList") : tE("aria.openPageList"), "view.toggleOutline")}>
              <button
                type="button"
                className="panel-icon-button outline-rail-toggle"
                aria-label={outlineOpen ? tE("aria.closePagePreview") : tE("aria.openPagePreview")}
                aria-pressed={outlineOpen}
                onClick={() => setOutlineOpen((current) => !current)}
              >
                <PanelLeft size={16} />
              </button>
            </Tooltip>
            <button type="button" className="panel-icon-button outline-close-button" title={tE("common.close")} aria-label={tE("aria.closePagePreview")} onClick={() => setOutlineOpen(false)}>
              <X size={15} />
            </button>
          </div>
          <div className="page-navigator-body">
            {!workspaceReady && (
              <div className="page-navigator-skeleton" aria-hidden="true">
                {[1, 2, 3].map((item) => (
                  <div key={item} className="page-navigator-skeleton-item">
                    <span className="shimmer-line" />
                    <span className="shimmer-block" />
                  </div>
                ))}
              </div>
            )}
            {workspaceReady && (
              <PrintPreviewPageNavigator
                // ページナビゲータは常に非表示 (showPageNavigator)。復活させるときは、
                // 打鍵ごとの再描画を避けるためここでデバウンスし直すこと。
                document={document}
                profile="teacher"
                activePageNumber={activePageNumber}
                onPageSelect={scrollToPage}
                style={pageNavigatorStyle}
              />
            )}
          </div>
          {outlineOpen && (
            <button
              type="button"
              className="outline-resize-handle"
              aria-label={tE("aria.resizeLeftSidebar")}
              title={tE("aria.resizeLeftSidebar")}
              onMouseDown={resizeOutline}
              onDoubleClick={() => setOutlineWidth(DEFAULT_OUTLINE_WIDTH)}
            />
          )}
          </aside>
        )}

        <section
          className={`editor-canvas ${loadingFileId ? "is-switching" : ""}`}
          data-whiteboard={isWhiteboardDocument ? "true" : undefined}
          ref={editorCanvasRef}
          onClick={(event) => {
            if (versionHistoryPreviewActive) return;
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-sigma-doc-id], [data-overlay-shape-id], .overlay-canvas-bleed-surface, .overlay-canvas-editor, .page-overlay-preview, [data-problem-area]")) {
              return;
            }
            setSelectedInlineMath(null);
            selectedIdRef.current = null;
            materialBlockSelectionRef.current = null;
            setSelectedId(null);
          }}
        >
          {/* 「AIが今何をやっているか」を常時確認できるcockpitの入口。折りたたみ時は
              canvas左上のアイコン1つだけ (バッジで実行中/要対応を示す)。開閉はUIローカル
              stateなので、旧: メニューの開閉トグルは廃止した (redundant)。 */}
          {!versionHistoryPreviewActive && (isDesktopApp || webMcpEnabled) && workspaceReady && !activeDocumentOpenFailure && (
            <AiTaskDock
              documentIdentityKey={isDesktopApp ? activeFileId : document.docId}
              document={document}
              previewGroups={visibleAiEditPreviewGroups}
              staleGroups={staleProposalGroups}
              activeDocumentRevision={activeDocumentRevision}
              busy={mcpPreviewBusy}
              onApplyGroup={stableApplyVisibleAiEditPreviewGroup}
              onDismissGroup={stableDismissVisibleAiEditPreviewGroup}
              onRebaseGroup={rebaseStaleProposals}
              onForceApplyGroup={forceApplyStaleProposals}
              onRevertProposal={revertAppliedProposals}
              onRestoreProposal={restoreProposalFromHistory}
              onFocusSession={focusAiSession}
              resolvedProposals={resolvedMcpEditProposals}
              webMcpInstructionScopeId={webMcpEnabled ? document.docId : null}
              webMcpHistory={webMcpEnabled ? webMcpHistory : undefined}
            />
          )}
          {!versionHistoryPreviewActive && workspaceReady && isWhiteboardDocument && (
            <CommentDock
              document={document}
              open={commentsPanelOpen}
              panel={commentPanelProps}
              onOpenChange={setCommentsPanelOpen}
            />
          )}
          {!workspaceReady && (
            <div className="editor-canvas-skeleton" aria-hidden="true">
              <div className="editor-canvas-skeleton-page">
                <span className="shimmer-line" style={{ width: "42%", height: "18px" }} />
                {[88, 96, 72, 90, 64, 84, 92, 58].map((width, index) => (
                  <span key={index} className="shimmer-line" style={{ width: `${width}%` }} />
                ))}
              </div>
            </div>
          )}
          {workspaceReady && activeDocumentOpenFailure && (
            <DocumentOpenFailurePanel
              failure={activeDocumentOpenFailure}
              reloading={loadingFileId === activeDocumentOpenFailure.fileId}
              onReload={handleReloadFailedDocument}
            />
          )}
          {pageEditorMounted && <AiPageCanvasEditor
            key={`${activeFileId}:${documentInstanceRevision}`}
            aiEnabled={!isEmbedded}
            onPageCountChange={setEditorPageCount}
            onMeasuredBlockRectsChange={captureMeasuredBodyBlockRects}
            // Backstage は本文を覆うので、その間は本文側の window ショートカットも降ろす。
            // capture の stopPropagation も <main inert> も window リスナーには効かない
            // （どちらも「window より下」しか止められない）ので、フラグで渡すしかない。
            shortcutsSuppressed={ribbonBackstageOpen}
            document={document}
            selectedId={selectedId}
            selectedInlineMath={selectedInlineMath}
            commentThreads={commentThreads}
            activeCommentThreadId={activeCommentThreadId}
            highlightedCommentThreadId={highlightedCommentThreadId}
            showComments={commentsPanelOpen}
            commentPanel={isWhiteboardDocument ? undefined : commentPanelProps}
            overlaySelection={overlaySelection}
            overlayCommentAnchor={currentOverlayCommentAnchor}
            aiDocumentWriteInProgress={aiDocumentWriteInProgress}
            aiEditPreviewGroups={visibleAiEditPreviewGroups}
            aiEditPreviewApplying={mcpPreviewBusy}
            aiApplyAnimation={aiApplyAnimation}
            fontSize={BASE_EDITOR_FONT_SIZE}
            zoom={zoom}
            whiteboardPanX={whiteboardPan.panX}
            whiteboardPanY={whiteboardPan.panY}
            onWhiteboardViewportChange={handleWhiteboardViewportChange}
            onWhiteboardPanBy={panWhiteboardBy}
            onWhiteboardZoomRequest={applyZoom}
            onWhiteboardCameraReset={resetZoom}
            historyRevision={historyRevision}
            onSelect={handleCanvasSelect}
            onChange={updateBlock}
            onDelete={removeBlock}
            onDeleteBlocks={removeBlocks}
            onInsertBodyBlock={insertBodyBlockAt}
            onMoveBlocks={moveBlocksByDragRequest}
            onMoveBlocksByStep={moveBlocksByStepRequest}
            onCopyBlock={copyBlockToClipboard}
            onPasteBlock={pasteBlockFromClipboard}
            canPasteProblem={canPasteProblem}
            onWrapBlockInColumns={wrapBlockInColumns}
            onUnwrapColumns={unwrapColumns}
            onResizeLayoutColumns={resizeLayoutColumns}
            onBlockSpaceAfterChange={updateBlockSpaceAfter}
            onDuplicate={handleDuplicateBlock}
            onMove={handleMoveBlock}
            onAddProblemBlock={handleAddProblemBlock}
            onReplaceTextFlow={replaceTextFlow}
            onPageLayoutChange={updatePageLayout}
            onOverlayChange={updateOverlay}
            onOverlayImagesRequest={requestOverlayImages}
            materials={materials}
            onMaterialInsert={handleCanvasMaterialInsert}
            onMaterialSaveRequest={openMaterialAddDialog}
            onSelectionMaterialSaveRequest={handleSelectionMaterialSaveRequest}
            onProblemCommand={handleCanvasProblemCommand}
            onBodyBlockCommand={handleCanvasBodyBlockCommand}
            onHeadingCommand={handleCanvasHeadingCommand}
            pendingDeletion={pendingDeletion}
            onReanchorOverlay={reanchorOverlay}
            overlayCommandRequest={overlayCommandRequest}
            overlayImageRequest={overlayImageRequest}
            overlayActionRequest={overlayActionRequest}
            overlayArrangeShortcutLabels={overlayArrangeShortcutLabels}
            onOverlayCommandHandled={handleOverlayCommandHandled}
            onOverlayImageHandled={handleOverlayImageHandled}
            onOverlayActionHandled={handleOverlayActionHandled}
            onOverlayEditingChange={handleOverlayEditingChange}
            onOverlayModeStatusChange={setOverlayModeStatus}
            onOverlaySelectionSummaryChange={handleOverlaySelectionSummaryChange}
            onOverlayActiveToolChange={setActiveOverlayTool}
            onRunningRegionEditingChange={setRunningRegionEditingKind}
            onCommentAnchorRequest={openCommentComposer}
            onCommentAnchorCandidateChange={setCommentAnchorCandidate}
            onCommentThreadSelect={selectCommentThread}
            onAiReferenceRequest={isDesktopApp ? requestAiEditWithReference : undefined}
            onAiReferenceCandidateChange={isDesktopApp ? updateAiEditReferenceCandidate : undefined}
            onAiEditPreviewApply={stableApplyVisibleAiEditPreviewGroup}
            onAiEditPreviewDismiss={stableDismissVisibleAiEditPreviewGroup}
            onOpenSourceDocument={openSourceReferenceDocument}
            suppressSelectionActions={aiDisplayMode === "inline" && aiInlineOpen}
            pinAiTextSelectionReference={isDesktopApp && pinAiTextSelectionReference}
            onInlineRunPortalReady={handleInlineRunPortalReady}
            documentIdentityKey={activeFileId}
            documentWorkspaceId={activeDocumentMetadata?.workspaceId ?? null}
            onFocusAiSession={focusAiSession}
          />}
          {versionHistoryPreview && (
            <div className="version-history-preview" data-version-history-preview="true">
              <div className="version-history-preview-banner" role="status">
                <strong>{t("versionHistory.viewingVersion", {
                  date: new Intl.DateTimeFormat(getAppLocale(), {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }).format(new Date(versionHistoryPreview.capturedAt)),
                })}</strong>
                <div className="version-history-preview-actions">
                  <button
                    type="button"
                    className="button primary"
                    disabled={versionHistoryRestoring}
                    onClick={() => {
                      setVersionHistoryRestoring(true);
                      setVersionHistoryRestoreError(null);
                      void restoreDocumentVersion(versionHistoryPreview)
                        .then((result) => {
                          if (result.ok) setVersionHistoryPreviewState(null);
                          else setVersionHistoryRestoreError(result.error);
                        })
                        .catch(() => setVersionHistoryRestoreError(t("versionHistory.restoreFailed")))
                        .finally(() => setVersionHistoryRestoring(false));
                    }}
                  >
                    {versionHistoryRestoring ? <Loader2 className="save-state-spinner" size={14} aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
                    {t("versionHistory.restore")}
                  </button>
                  <button type="button" className="button" disabled={versionHistoryRestoring} onClick={() => handleVersionHistoryPreviewChange(null)}>
                    {t("versionHistory.returnToCurrent")}
                  </button>
                </div>
              </div>
              {versionHistoryRestoreError && <p className="version-history-preview-error" role="alert">{versionHistoryRestoreError}</p>}
              <div className="version-history-preview-scroll">
                <PagedRenderSurface document={versionHistoryPreview.document} profile="teacher" />
              </div>
            </div>
          )}
        </section>

        <AiEditorHost
          enabled={!isEmbedded && isDesktopApp}
          displayMode={aiDisplayMode}
          surface={aiSurface}
          inlineOpen={aiInlineOpen}
          inlineClosing={aiInlineClosing}
          inlineAnchor={aiInlineAnchor}
          inlineRunAnchor={aiInlineRunAnchor}
          inlineSessionId={aiInlineSessionId}
          editorCanvasRef={editorCanvasRef}
          closeLabel={tEditor("aria.closeAiChat")}
          onClose={closeAiSurface}
        >
          <AiEditPanel
            document={document}
            documentIdentityKey={activeFileId}
            documentWorkspaceId={activeDocumentMetadata?.workspaceId ?? null}
            selectedId={selectedId}
            selectedBlock={selectedBlock}
            reference={aiEditReference}
            pinnedReferences={aiEditPinnedReferences}
            pinnedReferencePreviews={aiEditPinnedReferencePreviews}
            onRemovePinnedReference={removeAiPinnedReference}
            overlaySelection={overlaySelection}
            variant={aiDisplayMode}
            inlineSessionId={aiInlineSessionId}
            inlineOpen={aiInlineOpen}
            inlineAnchor={aiInlineAnchor}
            inlineRunAnchor={aiInlineRunAnchor}
            inlineRunAnchorCanvas={aiInlineRunAnchorCanvas}
            inlineRunPortalTarget={aiInlineRunPortal}
            previewClearRequest={aiEditPreviewClearRequest}
            previewGroups={aiEditPreviewGroups}
            busy={mcpPreviewBusy}
            onApplyGroup={applyAiEditPreviewGroup}
            onDismissGroup={dismissAiEditPreviewGroup}
            staleProposalGroups={staleProposalGroups}
            sourceReferencesByTurnId={sourceReferencesByTurnId}
            insertedShapePreviewsByTurnId={insertedShapePreviewsByTurnId}
            appliedChangesByTurnId={appliedChangesByTurnId}
            onRevertAppliedChange={revertAppliedProposals}
            restorableProposalsByTurnId={restorableProposalsByTurnId}
            onRestoreProposal={restoreProposalFromHistory}
            onOpenSourceDocument={openSourceReferenceDocument}
            onDiscardStaleProposals={discardStaleProposals}
            onRebaseStaleProposals={rebaseStaleProposals}
            onForceApplyStaleProposals={forceApplyStaleProposals}
            onOpenAiSettings={() => setAiSettingsOpen(true)}
            onCloseInline={closeAiSurface}
            onPromoteToSidebar={promoteAiToSidebar}
            onInlineRunAnchorChange={handleInlineRunAnchorChange}
            focusRoomRequest={aiFocusRoomRequest}
          />
        </AiEditorHost>
        {versionHistoryOpen && (
          <VersionHistoryPanel
            key={activeFileId}
            busy={versionHistoryRestoring}
            fileId={activeFileId}
            historyWarning={versionHistoryWarning}
            onClose={() => {
              setVersionHistoryOpen(false);
              setVersionHistoryPreviewState(null);
              setVersionHistoryRestoreError(null);
            }}
            onPreviewChange={handleVersionHistoryPreviewChange}
            selectedVersionId={versionHistoryPreview?.versionId ?? null}
          />
        )}
      </main>

      {windowCloseSaveDialog && (
        <WindowCloseSaveDialog
          error={windowCloseSaveDialog.error}
          saving={windowCloseSaveDialog.saving}
          onRetry={() => void attemptWindowCloseSave()}
          onCloseWithoutSaving={() => void finishWindowCloseSave("ready")}
          onCancel={() => void finishWindowCloseSave("cancel")}
        />
      )}

      {overlayGraphSettingsDialog}
      {overlayChartSettingsDialog}
      {overlayGraph3DSettingsDialog}

      <MaterialLibraryDialogs controller={materialLibrary} />

      <TemplateGallery
        open={templateGalleryOpen}
        onClose={() => setTemplateGalleryOpen(false)}
        mode="insert"
        activeWorkspaceId={documentMetadatas.find((meta) => meta.fileId === activeFileId)?.workspaceId ?? null}
        currentDocument={document}
        onInsert={insertTemplate}
      />

      {textImportOpen && (
        <DocumentTextImportDialog
          onImport={(file) => importDocumentFile(file)}
          onClose={() => setTextImportOpen(false)}
        />
      )}

      {documentTextCopyFallback !== null && (
        <DocumentTextCopyDialog
          text={documentTextCopyFallback}
          onClose={() => setDocumentTextCopyFallback(null)}
        />
      )}

      {outlineDialogOpen && (
        <div className="outline-dialog-backdrop" data-modal-backdrop="" role="presentation" onPointerDown={() => setOutlineDialogOpen(false)}>
          <section
            className="outline-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={tE("outline.title")}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header className="outline-dialog-header">
              <div>
                <h2>{tE("outline.title")}</h2>
                <p title={resolvedDocumentTitle}><DocumentTitleText title={resolvedDocumentTitle} nodes={documentTitle.nodes} /></p>
              </div>
              <button type="button" className="icon-button" title={tE("common.close")} aria-label={tE("common.close")} onClick={() => setOutlineDialogOpen(false)}>
                <X size={16} />
              </button>
            </header>
            <nav className="outline-dialog-list">
              {outline.length === 0 ? (
                <p className="outline-dialog-empty">{tE("outline.empty")}</p>
              ) : outline.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={selectedId === item.id ? "selected" : ""}
                  onClick={() => selectOutlineItem(item.id)}
                >
                  <span>
                    {(item.type === "section" || item.type === "heading") && outlineHeadingNumbers.get(item.id) ? (
                      <span className="heading-number-prefix">
                        {outlineHeadingNumbers.get(item.id)}{" "}
                      </span>
                    ) : null}
                    {item.title}
                  </span>
                  <code>{item.type}</code>
                </button>
              ))}
            </nav>
          </section>
        </div>
      )}

      {previewOpen && (
        <div className="preview-drawer" role="dialog" aria-modal="true" aria-label={tE("aria.pdfPreview")}>
          <PrintPreviewToolbar
            renderState={printPreviewRenderState.state}
            pageCount={printPreviewRenderState.pageCount}
            isExporting={pdfExporting}
            exportUnavailableReason={resolveDrawerExportUnavailableReason({
              isDesktopApp,
              isEmbedded,
              hasDesktopExportBridge: Boolean(getDesktopBridge()?.file.exportPdf),
            })}
            onOpenExternal={shouldOfferExternalPrintWindow({ isDesktopApp, isEmbedded })
              ? () => void openPrintWindow()
              : undefined}
            onExport={() => void exportPdf()}
            onClose={() => setPreviewOpen(false)}
          />
          <div className="preview-scroll">
            <PagedRenderSurface
              document={document}
              profile="teacher"
              onRenderStateChange={setPrintPreviewRenderState}
            />
          </div>
        </div>
      )}

      {exportedPdfPath && <PdfExportSuccessDialog filePath={exportedPdfPath} onClose={() => setExportedPdfPath(null)} />}

      <DocumentLibraryDialog
        open={documentListOpen}
        documents={documentMetadatas}
        activeFileId={activeFileId}
        activeDocumentTitle={resolvedDocumentTitle}
        openFileIds={openFileIds}
        onClose={() => setDocumentListOpen(false)}
        onCreate={createDocumentTab}
        onOpen={openDocumentFromList}
        onDuplicate={duplicateDocumentFromList}
        onDelete={deleteDocumentFromList}
      />

      {pageSettingsOpen && (
        <PageSettingsDialog
          layout={document.pageLayout}
          mathFractionSizing={document.metadata.mathFractionSizing}
          headingNumbering={document.metadata.headingNumbering}
          focusEntryId={settingsFocusEntryId}
          hasContent={hasMeaningfulBodyContent(document.content)}
          onClose={() => {
            setPageSettingsOpen(false);
            setSettingsFocusEntryId(undefined);
          }}
          onChange={(layout, mathFractionSizing, headingNumbering) => {
            updatePageLayoutAndMetadata(layout, {
              ...document.metadata,
              mathFractionSizing,
              headingNumbering,
            });
          }}
        />
      )}

      {commandSettingsOpen && (
        <CommandSettingsDialog
          overrides={shortcutOverrides}
          customCommands={customCommands}
          fontFamilyOptions={FONT_FAMILY_OPTIONS}
          platform={shortcutPlatform}
          onChange={setShortcutOverrides}
          onCustomCommandsChange={setCustomCommands}
          onClose={() => {
            setCommandSettingsOpen(false);
            setSettingsFocusEntryId(undefined);
          }}
          focusEntryId={settingsFocusEntryId}
        />
      )}

      {texCommandReferenceOpen && (
        <TexCommandReferenceDialog onClose={() => setTexCommandReferenceOpen(false)} />
      )}
      {texEnvironmentSettingsOpen && (
        <TexEnvironmentSettingsDialog
          preamble={document.metadata.texPreamble}
          onChange={(texPreamble) => {
            updateMetadata({ ...document.metadata, texPreamble });
            setStatusMessage(tE("status.texEnvUpdated"));
          }}
          onClose={() => setTexEnvironmentSettingsOpen(false)}
        />
      )}
    </div>
    </MathEnvironmentProvider>
  );
}

interface EditorBlockFocusOptions {
  /**
   * ブロック全体を選ぶのではなく、末尾へキャレットを畳む。
   *
   * 既定 (false) は「いま作った空ブロックへ入る」向き。既にある文章のブロックへ焦点を戻す
   * ときに全選択のままにすると、次の 1 打鍵でその文章が消える (引用ボタンで実際に踏んだ)。
   */
  collapseToEnd?: boolean;
  /**
   * 焦点がどこにも無いときだけ当てる。
   *
   * ブロック操作の後始末に使う。remount で焦点が飛んだときは戻したいが、飛んでいないなら
   * PM のコマンドが置いたキャレットがそのまま正しいので、触ってはいけない。
   */
  onlyIfLost?: boolean;
}

function scheduleEditorBlockFocus(
  blockId: string,
  options: EditorBlockFocusOptions = {},
  attempt = 0,
) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (options.onlyIfLost && !hasLostEditorFocus()) {
        // まだどこかが焦点を持っている。remount は次のフレームには間に合わないことがあるので、
        // すぐ諦めずに「失われたか」をもう一度だけ見に行く。
        if (attempt < FOCUS_RESTORE_ATTEMPTS) {
          window.setTimeout(
            () => scheduleEditorBlockFocus(blockId, options, attempt + 1),
            FOCUS_RESTORE_VERIFY_MS,
          );
        }
        return;
      }

      const selector = `[data-sigma-doc-id="${CSS.escape(blockId)}"], #${CSS.escape(blockId)}`;
      const blockElement = window.document.querySelector<HTMLElement>(selector);
      const editorElement = blockElement?.closest<HTMLElement>("[contenteditable='true']");
      const selection = window.getSelection();
      if (!blockElement || !editorElement || !selection) {
        if (attempt < 8) {
          window.setTimeout(() => scheduleEditorBlockFocus(blockId, options, attempt + 1), 30);
        }
        return;
      }

      editorElement.focus({ preventScroll: true });
      const range = window.document.createRange();
      range.selectNodeContents(blockElement);
      // **畳んでから**張る。全選択のまま残すと、次に打った文字がブロックごと置き換わる
      // (`docs/caret-behavior-spec.md` が禁止する回帰そのもの)。`collapseToEnd` の指定が
      // 無ければ先頭へ畳む。
      range.collapse(!options.collapseToEnd);
      selection.removeAllRanges();
      selection.addRange(range);
      // `scrollIntoView` は祖先のスクロール可能な箱 (断片の viewport) まで動かしてしまう。
      // 動かすのは紙面のスクローラーだけにする。
      scrollElementIntoCanvasView(blockElement);

      // 当てた焦点が定着したかを、少し置いてから確かめる。
      //
      // ブロックの入れ物を作り替える操作 (引用でくるむ・段組にする・リストにする) は本文ランの
      // **先頭ブロック id** を変える。ランの React キーはその id なので (`render-units.ts` の
      // `id: chunk[0].id`)、React がランごと unmount → remount し、ここで当てた焦点はその
      // commit で外れる。実機では「引用ボタンを押した直後に打った文字が引用の外へ行く」という
      // 形で出た。remount は次のフレームには間に合わないことがあるので、rAF ではなく待つ。
      //
      // 焦点が **どこにも無い** ときだけ戻す。ユーザーが自分で別のコントロールへ移ったなら、
      // それを奪い返してはいけない。
      if (attempt < FOCUS_RESTORE_ATTEMPTS) {
        window.setTimeout(() => {
          if (hasLostEditorFocus()) {
            scheduleEditorBlockFocus(blockId, options, attempt + 1);
          }
        }, FOCUS_RESTORE_VERIFY_MS);
      }
    });
  });
}

/**
 * 本文ランの先頭ブロック id を変えうるコマンド。押した後に焦点を当て直す必要がある。
 * (`render-units.ts` がランの id を `chunk[0].id` にしているため、React キーが変わる)
 */
/**
 * 焦点が「どこにも無い」か。
 *
 * ユーザーが自分で別のコントロールへ移ったのなら、それを奪い返してはいけない。だから
 * body (＝誰も持っていない) のときだけを「失われた」とみなす。
 */
function hasLostEditorFocus(): boolean {
  const active = window.document.activeElement;
  return !active || active === window.document.body;
}

/** 焦点が外れていたら当て直す回数と間隔。remount 1 回ぶんを吸収できれば十分。 */
const FOCUS_RESTORE_ATTEMPTS = 3;
const FOCUS_RESTORE_VERIFY_MS = 120;

/**
 * 埋め込みホストのエコー判定用に「文書の内容そのもの」をキー化する。
 * (使い方は emittedEchoKeysRef のコメントを参照)
 *
 * sigma-doc-block-hash.ts の hashSigmaNode は使えない: あれは node:crypto 依存で
 * main process / mcp 専用であり、このファイルは renderer と npm SDK の両方で
 * ブラウザにバンドルされる。そのためハッシュではなく正規化JSON文字列をキーにする。
 *
 * キーを再帰的にソートし undefined を落とすのは hashSigmaNode と同じ規約。内容が
 * 同じでも Tiptap を往復するとキー順が入れ替わるため、素の JSON.stringify では
 * エコーを取り逃がし、無視したいはずのループが再発する。
 */
function documentHistoryKey(document: SigmaDocument): string {
  return JSON.stringify(canonicalizeDocumentValue(comparableDocumentValue(document)));
}

function canonicalizeDocumentValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeDocumentValue);
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalizeDocumentValue(record[key])]),
  );
}

function hasMeaningfulBodyContent(content: SigmaBlock[]): boolean {
  if (content.length !== 1) {
    return content.length > 0;
  }
  const only = content[0];
  return only.type !== "paragraph"
    || only.children.some((child) => child.type === "mathInline" || child.text.trim().length > 0);
}

function getInlineMathBlockIdFromDom(mathInlineId: string): string | undefined {
  if (typeof window === "undefined" || !mathInlineId) {
    return undefined;
  }

  const element = window.document.querySelector<HTMLElement>(
    `.inline-math-node[data-id="${CSS.escape(mathInlineId)}"]`,
  );
  const blockElement = element?.closest<HTMLElement>("[data-sigma-doc-id], .editor-block[id], [data-page-block]");
  const dataId = blockElement?.getAttribute("data-sigma-doc-id");
  return dataId || blockElement?.id || undefined;
}
