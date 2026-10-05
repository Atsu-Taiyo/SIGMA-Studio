"use client";
import type { DocumentSessionHost } from "@/features/document-session/contracts";
import { DocumentSessionContext,DocumentWritableContext } from "./document-session-context";
import { DOCUMENT_BLOCK_OPERATION_PORTS } from "./editor-shell/document-operation-ports";
import { scheduleEditorBlockFocus } from "./editor-shell/editor-focus";
import { useEditorHost } from "./editor-shell/editor-host";
import type { AiEditAttachment,AiEditPreviewState,AiEditReference,AiEditShapeOnlyPreview,AiProposalApplyOutcome } from "./editor-shell/editor-host-contracts";
import { EditorOutlineDialog } from "./editor-shell/editor-outline-dialog";
import { EditorPrintPreview } from "./editor-shell/editor-print-preview";
import { tAi,tEditor,tShape,tWorkspace } from "./editor-shell/editor-translations";
import { sessionReadOnlyExtensions } from "./editor-shell/session-read-only-extensions";
import { useAiInlineGeometry } from "./editor-shell/use-ai-inline-geometry";
import { useAiSurfaceController } from "./editor-shell/use-ai-surface-controller";
import { useCommandSettingsController } from "./editor-shell/use-command-settings-controller";
import { useCompactChrome } from "./editor-shell/use-compact-chrome";
import { useDesktopUpdateController } from "./editor-shell/use-desktop-update-controller";
import { useDocumentBodyCommands } from "./editor-shell/use-document-body-commands";
import { useDocumentPrintController } from "./editor-shell/use-document-print-controller";
import { useDocumentRecovery } from "./editor-shell/use-document-recovery";
import { useDocumentSearchCommands,useDocumentSearchState } from "./editor-shell/use-document-search";
import { useEditorChromeController } from "./editor-shell/use-editor-chrome-controller";
import { useEditorDialogState } from "./editor-shell/use-editor-dialog-state";
import { useEmbeddedDocumentSync } from "./editor-shell/use-embedded-document-sync";
import { useLineHeightControl } from "./editor-shell/use-line-height-control";
import { useMcpProposalController } from "./editor-shell/use-mcp-proposal-controller";
import { useOverlaySettingsController } from "./editor-shell/use-overlay-settings-controller";
import { useTextFormattingState } from "./editor-shell/use-text-formatting-state";
import { useWindowCloseBoundary } from "./editor-shell/use-window-close-boundary";
import { useWorkspaceDocumentNavigation } from "./editor-shell/use-workspace-document-navigation";
import { useWorkspaceInitialization } from "./editor-shell/use-workspace-initialization";
import { useWorkspaceTabCoordination } from "./editor-shell/use-workspace-tab-coordination";

import { registerEditorClipboardEvents } from "./editor-shell/clipboard-events";
import type { DocumentStorageChangeEvent,EmbeddedEditorHost } from "./editor-shell/document-lifecycle-types";
import { registerDocumentStorageSynchronization } from "./editor-shell/document-storage-sync";
import { type DocumentTabOpenOptions } from "./editor-shell/document-tab-commands";
import { MaterialLibraryDialogs } from "./editor-shell/material-library-dialogs";
import { useCommandPalette } from "./editor-shell/use-command-palette";
import { useCommentActions } from "./editor-shell/use-comment-actions";
import { useDesktopMenuActions } from "./editor-shell/use-desktop-menu-actions";
import { useDocumentFileCommands } from "./editor-shell/use-document-file-commands";
import { useDocumentSaveBoundary } from "./editor-shell/use-document-save-boundary";
import { useEditorCommandRouting } from "./editor-shell/use-editor-command-routing";
import { useExternalDocumentOpen } from "./editor-shell/use-external-document-open";
import { useMaterialLibraryController } from "./editor-shell/use-material-library-controller";
import { useWorkspaceDocumentCommands } from "./editor-shell/use-workspace-document-commands";
export type { EmbeddedEditorHost } from "./editor-shell/document-lifecycle-types";

import {
Loader2,
PanelLeft,
RotateCcw,
X,
} from "lucide-react";
import type { CSSProperties,MouseEvent,ReactNode,SetStateAction } from "react";
import {
startTransition,
useCallback,
useEffect,
useLayoutEffect,
useMemo,
useRef,
useState,
useSyncExternalStore
} from "react";

import { APP_READY_EVENT } from "@/components/StartupSplash";



import { CommandPalette } from "@/components/editor/CommandPalette";
import { CommandSettingsDialog } from "@/components/editor/CommandSettingsDialog";
import { CommentDock } from "@/components/editor/CommentDock";
import { CommentRail } from "@/components/editor/CommentRail";
import type { CommentPanelAuthor } from "@/components/editor/CommentThreadsPanel";
import { DesktopSettingsModal } from "@/components/editor/DesktopSettingsModal";
import { DocumentLibraryDialog } from "@/components/editor/DocumentLibraryDialog";
import { DocumentOpenFailurePanel } from "@/components/editor/DocumentOpenFailurePanel";
import { DocumentTextCopyDialog,DocumentTextImportDialog } from "@/components/editor/DocumentTextTransferDialog";
import {
type SelectedInlineMath
} from "@/components/editor/EditorSettings";
import { Graph3DSettingsPanelHost } from "@/components/editor/Graph3DSettingsPanel";
import { PageSettingsDialog } from "@/components/editor/PageSettingsDialog";
import { TexCommandReferenceDialog } from "@/components/editor/TexCommandReferenceDialog";
import { TexEnvironmentSettingsDialog } from "@/components/editor/TexEnvironmentSettingsDialog";
import { VersionHistoryPanel } from "@/components/editor/VersionHistoryPanel";
import { WindowCloseSaveDialog } from "@/components/editor/WindowCloseSaveDialog";
import { WorkspaceTabGroupGrid,type WorkspacePaneHandoff,type WorkspacePaneView } from "@/components/editor/WorkspaceTabGroupGrid";
import { WorkspaceTabStrip } from "@/components/editor/WorkspaceTabStrip";
import { OverlayImagePreviewContext } from "./overlay-canvas/image-preview-context";
import { useTikzEditor } from "./tikz/use-tikz-editor";

import { HeldBodySelectionOverlay } from "@/components/editor/editor-shell/HeldBodySelectionOverlay";
import type { EditorChromeValue } from "@/components/editor/editor-shell/chrome/chrome-types";
import { renderEditorChrome } from "@/components/editor/editor-shell/chrome/editor-chrome";
import { NO_COLUMN_COMMAND,resolveColumnCommandState } from "@/components/editor/editor-shell/chrome/layout-commands";
import {
BASE_EDITOR_FONT_SIZE,
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
TEXT_ALIGN_OPTIONS,
ZOOM_PRESETS
} from "@/components/editor/editor-shell/constants";
import { type DocumentOpenFailure } from "@/components/editor/editor-shell/document-open-failure";
import { formatDocumentRecoveryStatus } from "@/components/editor/editor-shell/recovery-status";
import { SelectionToolbarProvider,type SelectionToolbarBinding } from "@/components/editor/editor-shell/selection-toolbar/binding";
import { createSelectionToolbarExtension } from "@/components/editor/editor-shell/selection-toolbar/extension";
import { planShapeTools } from "@/components/editor/editor-shell/selection-toolbar/model";
import type { DocumentChange,DocumentChangeOptions } from "@/components/editor/editor-shell/types";
import { buildLineToolItems,buildShapeGallerySections,isLineToolCommand } from "@/components/editor/overlay-canvas/shape-gallery";
import type { ShapeTypeChangeCommand } from "@/components/editor/overlay-canvas/shape-type-change";
import type { OverlayPoint,OverlayTool } from "@/components/editor/overlay-canvas/types";
import {
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
import {
BODY_SELECTION_SHAPES_REQUEST_EVENT,
type BodySelectionShapesRequestDetail,
} from "@/components/editor/text-flow/body-shape-selection";
import { TEXT_FLOW_CHANGE_START_EVENT,TEXT_FLOW_SELECTION_BOOKMARK_EVENT } from "@/components/editor/text-flow/caret-bookmark-events";
import { deliverCaret,requestCaret } from "@/components/editor/text-flow/caret-router";
import { OVERLAY_SHAPES_PASTE_REQUEST_EVENT,type OverlayShapesPasteRequestDetail } from "@/components/editor/text-flow/text-and-shapes-clipboard";
import type { TextFlowChangeContext,TextFlowReplaceOptions } from "@/components/editor/text-flow/types";
import { WebMcpBridge,type WebMcpBridgeHandle } from "@/components/editor/webmcp/WebMcpBridge";
import type { WebMcpHistoryEntry } from "@/components/editor/webmcp/webmcp-history";
import { LedgerSchemaFailurePanel } from "@/components/ledger/LedgerSchemaFailurePanel";
import { PdfExportSuccessDialog } from "@/components/print/PdfExportSuccessDialog";
import { PrintPreviewPageNavigator } from "@/components/print/PrintPreview";
import { PagedRenderSurface } from "@/components/print/paged-render/PagedRenderSurface";
import { TemplateGallery } from "@/components/templates/TemplateGallery";
import { SELECT_INLINE_MATH_EVENT,updateInlineMathDraft } from "@/components/tiptap/inline-math-extension";
import { NATIVE_HISTORY_COMMAND_EVENT,type NativeHistoryCommandDetail } from "@/components/tiptap/native-history-guard";
import { QR_CODE_REQUEST_EVENT,type QrCodeRequestDetail } from "@/components/tiptap/url-detection-extension";
import { Tooltip } from "@/components/ui/Tooltip";
import {
closeRightDock
} from "@/features/right-dock/model/right-dock-state";
import { POCKET_PAGE_DROP, usePocketPageHost } from "@/components/editor/editor-shell/use-pocket-page-host";
import { PocketBar, usePocketPhase } from "@/features/pocket";
import { FilesPanel } from "@/features/right-dock/view/FilesPanel";
import { RightDockToggle } from "@/features/right-dock/view/RightDock";
import { RightDockHost } from "@/features/right-dock/view/RightDockHost";
import { resolveTextToolbarTarget } from "./editor-shell/text-toolbar-target";

import { readRenderedTextFontSize,type SelectionFontSize } from "@/components/tiptap/text-format-font-size";
import {
diffDeletedContentIds,
DocumentHistoryController,
ensurePageLayout,
expandMarginsForRunningRegions,
getPageLayoutIssues,
getPageMetrics,
inlineNodesToPlainText,
insertTopLevelDocumentBlocks,
isWhiteboardPageLayout,
MIN_PAGE_BODY_HEIGHT_MM,
MM_TO_PX,
normalizePageLayout,
repairDuplicateTopLevelIds,
type BoxedVariant,
type CommentMutationPorts,
type InlineNode,
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
type TextAlign
} from "@/features/document";
import type { MeasuredBlock } from "@/features/drawing";
import { MathEnvironmentProvider } from "@/features/rendering/adapters/react";
import { parseDocumentTitleInlineNodes } from "@/features/rendering/core";
import {
convertBlockStyle,
insertTopLevelTextFlowBlocks,
replaceTopLevelTextFlowBlocks,
setLayoutSectionColumnCount,
updateInlineMathTexInDocument,
type TextFlowBlock,
type TextFlowSelectionBookmark
} from "@/features/text-editing";
import {
decideAiApprovedDocument
} from "@/lib/ai-run-applier";







import { isUntouchedNewDocument } from "@/components/editor/editor-shell/new-document-draft";
import { DEFAULT_AI_EDIT_MODEL,DEFAULT_AI_EDIT_REASONING_EFFORT } from "@/lib/ai/sigma-doc-edit-schema";
import { createEmptyEditorDocument } from "@/lib/blank-document";
import {
DEFAULT_COMMENT_COLOR,
visibleCommentThreads,
} from "@/lib/comments";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { areSigmaDocumentsEquivalent } from "@/lib/document-equivalence";
import {
documentTitleInputValue,
isDocumentTitleExplicit,
resolveDocumentTitle,
resolveDocumentTitleContent
} from "@/lib/document-title";
import {
addRichBlockToProblem,
collectOutline,
createParagraph,
duplicateTopLevelBlock,
ensureEditableBody,
findBlock,
moveTopLevelBlock,
updateBlockInDocument
} from "@/lib/document-tree";
import type { DocumentVersion } from "@/lib/document-version-history";
import {
detectEditorShortcutPlatform,
findCommandByShortcut,
type EditorCommandId
} from "@/lib/editor-command-shortcuts";
import { DEFAULT_FILL_OPACITY } from "@/lib/fill-opacity";
import type { Graph2DPreset } from "@/lib/graph2d";
import { getHeadingNumberMap } from "@/lib/heading-numbering";
import {
getAppLocale
} from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import { createId } from "@/lib/id";
import { availableDocumentTitle } from "@/lib/library-ledger";
import type { LedgerSchemaFailure } from "@/lib/library-schema";
import { getSupportedOverlayImageFiles } from "@/lib/overlay-image-files";
import { countPerformanceEvent,measurePerformance } from "@/lib/performance";
import { generateQrPngFile } from "@/lib/qr-code";
import type { SigmaDocumentRecoveryIssue } from "@/lib/sigma-doc-schema";
import {
captureDocumentVersion,
createDocumentFromSigmaDocument,
createNewDocument,
createObservedDocumentWrite,
deleteDocument,
listSavedDocuments,
loadDocumentByFileIdWithRecovery,
saveWorkspaceState as persistWorkspaceState,
type DocumentMetadata
} from "@/lib/storage";
import { templateInsertContent } from "@/lib/templates";
import { useUiLayoutPreference } from "@/lib/ui-layout-preference";
import { useCustomFonts } from "@/lib/use-custom-fonts";
import { formatSigmaValidationCode } from "@/lib/validation-text";
import {
reconcileWorkspaceLayoutDocuments,
workspaceLayoutOpenFileIds
} from "@/lib/workspace-tab-groups";
import type { TemplateItem } from "@/types/template";
import { useStore } from "zustand";

import {
deliverHistoryShortcutToFocusedSurface,
isCompositionStillActive,
shouldEndCompositionForEvent,
} from "@/components/editor/editor-shell/command-shortcut-targets";
import {
getDefaultDocumentSelectionId,
sameDocumentMetadatas,
sameOverlaySelectionSummary
} from "@/components/editor/editor-shell/document-helpers";
import {
queueLatestDocumentChange,
syncDocumentRefWhenStateIsCurrent,
takeLatestDocumentChange,
type SuccessfulDocumentSave
} from "@/components/editor/editor-shell/document-state-sync";
import {
isDocumentVersionRestoreContextCurrent,
runDocumentVersionRestore,
type DocumentVersionRestoreResult,
} from "@/components/editor/editor-shell/document-version-restore";
import {
captureEditorTabViewState,
placeCaretAtPointWhenReady,
resolveEditorTabViewState,
scheduleEditorTabViewRestore,
type EditorTabViewState,
type ResolvedEditorTabViewState,
} from "@/components/editor/editor-shell/editor-tab-view-state";
import { handleHeadingCommandAutoNumbering } from "@/components/editor/editor-shell/heading-command";
import {
convertOverlayToWhiteboard,
createOverlaySelectionCommentAnchor,
ensureOverlayAnchorOffsets,
getSharedOverlayLineDash,
getSharedOverlayLineSize,
} from "@/components/editor/editor-shell/overlay-helpers";
import { getVisibleEditorPageNumber,scrollEditorCanvasToPage } from "@/components/editor/editor-shell/page-navigation";
import {
clampBoxedTextPaddingY,
getFontFamilyLabel,
normalizeBoxedTextVariant,
type BlockStyleCommandValue
} from "@/components/editor/editor-shell/toolbar-formatting";
import { useRequestedCommentThread } from "@/components/editor/editor-shell/use-requested-comment-thread";
import { useRequestedDocumentLocation } from "@/components/editor/editor-shell/use-requested-document-location";
import {
getScrollForZoomAnchor,
panCamera,
resetCamera,
resolveNextZoom,
resolveWheelIntent,
WHEEL_LINE_HEIGHT_PX,
zoomCameraAt,
} from "@/components/editor/editor-shell/whiteboard-camera";
import {
createUnsavedEditBackupTitle,
uniqueStringIds,
type DegradedWatcherScope
} from "@/components/editor/editor-shell/workspace-request";
import { createBlockCommentAnchor } from "@/components/editor/page-canvas/popover-anchors";
import type {
TextFlowBodyBlockCommandRequest,
TextFlowHeadingCommandRequest,
TextFlowMaterialInsertRequest,
TextFlowProblemCommandRequest,
} from "@/components/editor/text-flow/types";
import { createEditorStore,EditorStoreProvider,type EditorStore } from "@/features/editor-state";
import { useStableCallback } from "@/lib/react/use-stable-callback";
import { beginTablePlacementFeedback,cancelTablePlacementFeedback,trackTablePlacementPointer } from "./overlay-canvas/table-placement-feedback";
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
const COMMENT_MUTATION_PORTS: CommentMutationPorts = {
  now: () => new Date().toISOString(),
  createId,
};
/** 図形の無い文書でも参照が変わらないよう固定 (memo依存の無駄な再計算を避ける)。 */
const EMPTY_OVERLAY_SHAPES: OverlayShape[] = [];
/** コメントの無い文書でも参照が変わらないよう固定 (装飾更新の再 dispatch を避ける)。 */
const EMPTY_COMMENT_THREADS: SigmaCommentThread[] = [];

export interface EditorShellProps {
  /** Host-owned actions for a measured selection; no sharing implementation belongs to the editor. */
  renderSelectionActions?: (context: { fileId: string; document: SigmaDocument; metadata?: DocumentMetadata; anchor: SigmaCommentAnchor }) => ReactNode;
  commentIdentity?: CommentPanelAuthor & { userId: string };
  loadCommentMentionCandidates?: (fileId: string) => Promise<import("./comment-mentions").CommentMentionCandidate[]>;
  embeddedHost?: EmbeddedEditorHost;
  sessionHost?: DocumentSessionHost;
  renderDocumentActions?: (context: { fileId: string; document: SigmaDocument; getDocument: () => SigmaDocument; flush: () => Promise<unknown> }) => ReactNode;
  /** Host-owned account chrome; public Editor remains authentication agnostic. */
  accountAction?: ReactNode;
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
function DocumentActionsSlot({ render, context }: {
  render: NonNullable<EditorShellProps["renderDocumentActions"]>;
  context: Parameters<NonNullable<EditorShellProps["renderDocumentActions"]>>[0];
}) {
  return render(context);
}

export function EditorShell({ embeddedHost, sessionHost, renderDocumentActions, renderSelectionActions, accountAction, commentIdentity, loadCommentMentionCandidates }: EditorShellProps = {}) {
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
      <EditorShellBody embeddedHost={embeddedHost} sessionHost={sessionHost} renderDocumentActions={renderDocumentActions} renderSelectionActions={renderSelectionActions} accountAction={accountAction} commentIdentity={commentIdentity} loadCommentMentionCandidates={loadCommentMentionCandidates} editorStore={editorStore} />
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

function EditorShellBody({ embeddedHost, sessionHost, renderDocumentActions, renderSelectionActions, accountAction, commentIdentity, loadCommentMentionCandidates, editorStore }: EditorShellProps & { editorStore: EditorStore }) {
  const {
    EMPTY_AI_LOCKED_TARGETS,
    AiEditPanel,
    AiSettingsDialog,
    AiTaskDock,
    AI_INLINE_ANCHOR_OFFSET_Y,
    AiEditorHost,
    AI_REFERENCE_TEXT_RANGE_EVENT,
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
    useAiPendingAttachments,
    useAiWorkspaceTabTitles,
    useAiProposalActions,
    useCommentAiRun,
    useAiConnection,
    useClaudeConnection,
    useGeminiConnection,
    DEFAULT_CLAUDE_AI_EDIT_MODEL,
    DEFAULT_GEMINI_AI_EDIT_MODEL,
    isAiRunStatusActive,
    useAiRunSessions,
    deleteAiDataForDocument,
    focusSourceReferenceInDocument,
    resolveSourceReferenceNavigationTarget,
    closeSurface,
    isInlineToggleShortcut,
    openInline,
    promoteToSidebar,
    resolveAiSurface,
    toggleSurface,
    runAiEditViaDesktopRuntime
  } = useEditorHost().assistance;
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
  const isDesktopApp = useSyncExternalStore(
    useCallback(() => () => undefined, []),
    useCallback(() => Boolean(getDesktopBridge()), []),
    useCallback(() => false, []),
  );
  // コメントは、デスクトップ版では右上に浮かぶカードで見せる (本文の右横の欄・ホワイトボードのパネルは使わない)。
  // ホワイトボードも同じ並びで、通常の教材と同じく開いた状態から始まる。
  const commentsInRail = isDesktopApp && !isEmbedded;
  const embeddedHostRef = useRef(embeddedHost);
  useEffect(() => {
    embeddedHostRef.current = embeddedHost;
  }, [embeddedHost]);
  // 埋め込みホストから本文が空の文書を渡されても、最初の描画から入力できる状態で始める。
  const [document, setDocument] = useState<SigmaDocument>(() => ensureEditableBody(initialDocument).document);
  const documentRef = useRef(document);
  const getCurrentSessionDocument = useCallback(() => documentRef.current, []);
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
  const { textFontSize, setTextFontSize, textFontSizeMixed, setTextFontSizeMixed, fontSizeInput, setFontSizeInput, boxedTextPaddingY, setBoxedTextPaddingY, boxedTextActive, boldActive, italicActive, underlineActive, blockStyleState, documentTextFormatTarget, hasMultiEditorTextRunSpan, boxedTextVariant, setBoxedTextVariant, textColor, setTextColor, textBackgroundColor, setTextBackgroundColor, strokeColor, setStrokeColor, fontFamily, setFontFamily, lineHeight, setLineHeight, lineHeightInput, setLineHeightInput, lineHeightInputError, setLineHeightInputError, lineHeightCustomOpen, setLineHeightCustomOpen, getLastBoxedFormat, rememberBoxedFormat, saveEditorFontFamilyPreference } = useTextFormattingState();
  const zoom = useStore(editorStore, (state) => state.zoom);
  // パンは倍率と同じストアに置く (理由は EditorToolbarSlice の宣言のコメント)。
  const whiteboardPan = useStore(editorStore, (state) => state.whiteboardPan);
  // 錨の基準になるビューポート要素。PageCanvasEditor から ref 経由で受け取る。
  const whiteboardViewportRef = useRef<HTMLDivElement | null>(null);
  const handleWhiteboardViewportChange = useCallback((element: HTMLDivElement | null) => {
    whiteboardViewportRef.current = element;
  }, []);
  const { pageSettingsOpen, setPageSettingsOpen, commandSettingsOpen, setCommandSettingsOpen, commandPaletteOpen, setCommandPaletteOpen, settingsFocusEntryId, setSettingsFocusEntryId, texCommandReferenceOpen, setTexCommandReferenceOpen, texEnvironmentSettingsOpen, setTexEnvironmentSettingsOpen, documentListOpen, setDocumentListOpen, desktopSettingsOpen, setDesktopSettingsOpen, desktopSettingsUpdateCheckRequest, setDesktopSettingsUpdateCheckRequest, openDesktopSettingsFromChrome } = useEditorDialogState();
  const [workspaceReady, setWorkspaceReady] = useState(isEmbedded);
  const [ledgerFailure, setLedgerFailure] = useState<LedgerSchemaFailure | null>(null);
  const [workspaceReloadNonce, setWorkspaceReloadNonce] = useState(0);
  const [loadingFileId, setLoadingFileId] = useState<string | null>(null);
  // 教材の中身 (壊れたJSON / スキーマ違反) が原因で本文を組み立てられなかった教材。
  // その教材がアクティブな間だけ、編集キャンバスの代わりに原因と修復プロンプトを出す。
  const [documentMetadatas, setDocumentMetadatas] = useState<DocumentMetadata[]>([]);
  const [openFileIds, setOpenFileIds] = useState<string[]>(() => [initialDocument.docId]);
  const [activeFileId, setActiveFileId] = useState(initialDocument.docId);
  const cameraByFileIdRef = useRef(new Map<string, { zoom: number; panX: number; panY: number }>());
  const cameraFileIdRef = useRef(initialDocument.docId);
  useLayoutEffect(() => {
    if (cameraFileIdRef.current === activeFileId) return;
    const store = editorStore.getState();
    cameraByFileIdRef.current.set(cameraFileIdRef.current, { zoom: store.zoom, ...store.whiteboardPan });
    cameraFileIdRef.current = activeFileId;
    const camera = cameraByFileIdRef.current.get(activeFileId) ?? { zoom: 100, panX: 0, panY: 0 };
    store.setWhiteboardCamera(camera.zoom, { panX: camera.panX, panY: camera.panY });
  }, [activeFileId, editorStore]);
  const documentSession = sessionHost?.get(activeFileId);
  const documentSessionRef = useRef(documentSession);
  useLayoutEffect(() => { documentSessionRef.current = documentSession; }, [documentSession]);
  useEffect(() => {
    if (!sessionHost?.setActiveFile) return;
    void sessionHost.setActiveFile(workspaceReady ? activeFileId : null);
    return () => { void sessionHost.setActiveFile?.(null); };
  }, [activeFileId, sessionHost, workspaceReady]);
  const sessionWritable = useSyncExternalStore(
    listener => {
      const unsubscribeSession = documentSession?.subscribe(listener) ?? (() => {});
      const unsubscribeAuthority = sessionHost?.subscribeAuthority?.(listener) ?? (() => {});
      return () => { unsubscribeSession(); unsubscribeAuthority(); };
    },
    () => sessionHost?.get(activeFileId)?.writable ?? !(sessionHost?.isReadOnly?.(activeFileId) ?? false),
    () => sessionHost?.get(activeFileId)?.writable ?? !(sessionHost?.isReadOnly?.(activeFileId) ?? false),
  );
  const sessionWritableRef = useRef(sessionWritable);
  useLayoutEffect(() => { sessionWritableRef.current = sessionWritable; }, [sessionWritable]);
  const activeFileIdRef = useRef(activeFileId);
  const openFileIdsRef = useRef(openFileIds);
  const pendingPaneCaretRef = useRef<{ fileId: string; x: number; y: number } | null>(null);
  const editorTabViewStateByFileIdRef = useRef(new Map<string, EditorTabViewState>());
  const getActiveWorkspaceFileId = useCallback(() => activeFileIdRef.current, []);
  const installOpenWorkspaceFileIds = useCallback((ids: string[]) => { openFileIdsRef.current = ids; setOpenFileIds(ids); }, []);
  const workspaceDocumentActionsRef = useRef<{ open: (fileId: string, options?: DocumentTabOpenOptions) => Promise<void>; close: (fileId: string) => Promise<void> } | null>(null);
  const requestOpenWorkspaceDocument = useCallback((fileId: string, options?: DocumentTabOpenOptions) => workspaceDocumentActionsRef.current?.open(fileId, options) ?? Promise.resolve(), []);
  const requestCloseWorkspaceDocument = useCallback((fileId: string) => workspaceDocumentActionsRef.current?.close(fileId) ?? Promise.resolve(), []);
  const rememberWorkspacePaneHandoff = useCallback((fileId: string, handoff: WorkspacePaneHandoff) => {
    const saved = editorTabViewStateByFileIdRef.current.get(fileId);
    editorTabViewStateByFileIdRef.current.set(fileId, { selectedId: saved?.selectedId ?? null, textSelection: handoff.point ? null : saved?.textSelection ?? null, scrollTop: handoff.scrollTop, scrollLeft: handoff.scrollLeft });
    pendingPaneCaretRef.current = handoff.point ? { fileId, ...handoff.point } : null;
  }, []);
  const { workspaceLayout, getWorkspaceLayout, setWorkspaceLayout, activateWorkspaceGroupTab, moveWorkspaceGroupTab, splitWorkspaceGroupTab, closeWorkspaceGroupTab, resizeWorkspaceGroupSplit, focusWorkspaceGroup } = useWorkspaceTabCoordination({ initialDocumentId: initialDocument.docId, getActiveFileId: getActiveWorkspaceFileId, setOpenFileIds: installOpenWorkspaceFileIds, openDocumentInWorkspace: requestOpenWorkspaceDocument, closeDocumentTab: requestCloseWorkspaceDocument, rememberPaneHandoff: rememberWorkspacePaneHandoff });
  const { shortcutOverrides, setShortcutOverrides, customCommands, setCustomCommands, commandSettingsLoaded, commandSettingsError, openCommandSettings } = useCommandSettingsController(setCommandSettingsOpen, setStatusMessage);
  const { customFonts, reloadCustomFonts } = useCustomFonts();
  const { searchOpen, setSearchOpen, replaceOpen, setReplaceOpen, searchQuery, setSearchQuery, replaceText, setReplaceText } = useDocumentSearchState();
  const [templateGalleryOpen, setTemplateGalleryOpen] = useState(false);
  const [canPasteProblem, setCanPasteProblem] = useState(false);
  const [fontFamilyQuery, setFontFamilyQuery] = useState("");
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
  const { setSelectedOverlayGraph, setSelectedOverlayChart, closeGraphSettings, closeChartSettings, closeGraph3DSettings, graph3DSettingsShapeId, overlayGraphSettingsDialog, overlayChartSettingsDialog } = useOverlaySettingsController(document, getCurrentSessionDocument);
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
  // 範囲スクリーンショットの「AIに聞く」で撮った画像。入力欄の下書きとは別に持ち、
  // 送信するか外すか、インラインのAI面を閉じるまで入力欄へ差し込み続ける。
  const {
    attachments: aiPendingAttachments,
    add: addAiPendingAttachment,
    remove: removeAiPendingAttachment,
    clear: clearAiPendingAttachments,
  } = useAiPendingAttachments();
  const clearAiInlineSessionContext = useCallback(() => {
    clearAiEditPinnedReferences();
    clearAiPendingAttachments();
  }, [clearAiEditPinnedReferences, clearAiPendingAttachments]);
  // キャンバス右のサイドバー (開いているページのタブ列。ファイル / ブラウザ / サイドチャットは Hub から選ぶ)。
  // AIのサイドチャットが開いている状態は「ドックがチャットを見せている」ことそのもの (状態を二重に持たない)。
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
  const versionHistoryWarning = versionHistoryWarnings[activeFileId] ?? null;
  const measuredBodyBlockRectsRef = useRef<ReadonlyMap<string, MeasuredBlock>>(new Map());
  const captureMeasuredBodyBlockRects = useCallback((blockRects: ReadonlyMap<string, MeasuredBlock>) => {
    measuredBodyBlockRectsRef.current = blockRects;
  }, []);
  const { aiInlineRunAnchor, setAiInlineRunAnchor, aiInlineRunAnchorCanvas, setAiInlineRunAnchorCanvas, aiInlineRunPortal, aiInlineRunAnchorRef, handleInlineRunAnchorChange, handleInlineRunPortalReady } = useAiInlineGeometry(zoom, AI_INLINE_ANCHOR_OFFSET_Y);
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
  const { mcpEditProposals, mcpProposalCitations, aiRunSessions, aiProposalPresentation, aiEditPreviewGroups, staleProposalGroups, resolvedMcpEditProposals, sourceReferencesByTurnId, insertedShapePreviewsByTurnId, restorableProposalsByTurnId, appliedChangesByTurnId, refreshMcpEditProposals, locallyResolvedProposalIdsRef } = useMcpProposalController({ activeFileId, activeDocumentRevision, overlayShapes: document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? EMPTY_OVERLAY_SHAPES, getActiveFileId: getActiveWorkspaceFileId, services: { groupMcpProposalsForPreview, useAiRunSessions, deriveAiProposalPresentation, isAiRunStatusActive, buildSourceReferencesByTurnId, buildInsertedShapePreviewsByTurnId, buildRestorableProposalsByTurnId, buildAppliedTurnChangesByTurnId } });
  // AI編集のロックは対象単位。live run が握っている anchor (ユーザーが依頼時に明示的に
  // 渡したブロック/図形) と、pending提案が実際に書き換える対象だけが読み取り専用になり、
  // それ以外は人間が編集できる。他の場所への人手編集は per-block の内容ハッシュ鮮度判定で
  // 吸収されるため、提案をstaleにしない。
  // グラフのラベルはグラフの兄弟図形なので、ロック集合はラベルまで広げる (locked-targets.ts)。
  const localAiLockedTargets = useAiLockedTargets(
    activeFileId,
    aiProposalPresentation.previewGroups,
    document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? EMPTY_OVERLAY_SHAPES,
  );
  const aiLockedTargets = documentSession ? EMPTY_AI_LOCKED_TARGETS : localAiLockedTargets;
  // MCP プレビューの apply/dismiss の二重実行を防ぐ (承認済み提案への再実行で error 表示に
  // なるのを回避)。承認は文書を丸ごと差し替えるので、この窓だけは唯一の文書全体ロックも兼ねる
  // (途中の打鍵が黙って失われるため)。commitDocumentChange から参照するのでここで宣言する。
  const mcpPreviewBusyRef = useRef(false);
  const [mcpPreviewBusy, setMcpPreviewBusy] = useState(false);
  const aiDocumentWriteInProgress = mcpPreviewBusy || !sessionWritable;
  const sessionEditExtensions = useMemo(() => sessionWritable ? undefined
    : sessionReadOnlyExtensions(t("collaboration.readOnlyDocument")), [sessionWritable, t]);
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
  }, [activeFileId, aiRunSessions, clearAiEditPinnedReferences, deriveAiRunStartTransition, isAiRunStatusActive]);
  // 決定B: baseRevision一致の pending proposal は runId (帰属不明なら "unattributed")
  // ごとに独立したプレビュー単位になる。各グループが自分の apply/dismiss を持つ。
  // AI run が書き込みtoolを複数回呼ぶ途中では、proposal watcherが同じカードを何度も
  // 増補して見せてしまう。roomに紐づくrunが完了するまではcanvas/本文プレビューだけを
  // 抑止し、完了後に集約済みグループを一度表示する。room帰属のない外部MCP提案は、
  // 対応するrun状態を特定できないため従来どおり即時表示する。
  const commentAnchorCandidate = useStore(editorStore, (state) => state.commentAnchorCandidate);
  const pendingCommentAnchor = useStore(editorStore, (state) => state.pendingCommentAnchor);
  const [pendingCommentDraft, setPendingCommentDraft] = useState<InlineNode[]>([]);
  const commentReplyDrafts = useStore(editorStore, (state) => state.commentReplyDrafts);
  const activeCommentThreadId = useStore(editorStore, (state) => state.activeCommentThreadId);
  const highlightedCommentThreadId = useStore(editorStore, (state) => state.highlightedCommentThreadId);
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(() => !isWhiteboardDocument);
  const [showResolvedComments, setShowResolvedComments] = useState(false);
  const commentAuthor = commentIdentity ?? COMMENT_AUTHOR;
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
  const fontSizeSkipBlurRef = useRef(false);
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
  // A split re-parents the editor canvas. Track the node so native listeners follow it.
  const [editorCanvasElement, setEditorCanvasElement] = useState<HTMLElement | null>(null);
  const attachEditorCanvas = useCallback((element: HTMLElement | null) => {
    editorCanvasRef.current = element;
    setEditorCanvasElement(element);
  }, []);
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
  // Revision observed at the boundary where documentRef.current was adopted.
  // Metadata refreshes deliberately never mutate this value: a newer catalog
  // revision must not be attached to an older in-memory payload.
  const documentObservedRevisionRef = useRef<number | null>(null);
  const selectedIdRef = useRef(selectedId);
  const textSelectionBookmarkRef = useRef<TextFlowSelectionBookmark | null>(null);
  const pendingTextHistorySelectionRef = useRef<TextFlowSelectionBookmark | null | undefined>(undefined);
  const materialBlockSelectionRef = useRef<string | null>(null);
  // 教材タブごとの選択・キャレット・スクロール。切替で document を差し替えても戻せるようにする。
  const untouchedNewDocumentsRef = useRef(new Map<string, SigmaDocument>());
  const pendingEditorTabViewRestoreRef = useRef<ResolvedEditorTabViewState | null>(null);
  // 編集していなかったペインを押した点。その教材が編集面に載ったらキャレットを置く。
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
  const saveWorkspaceState = useCallback(async (state: { openFileIds: string[]; activeFileId: string }) => {
    const layout = reconcileWorkspaceLayoutDocuments(
      getWorkspaceLayout(),
      state.openFileIds,
      state.activeFileId,
    );
    setWorkspaceLayout(layout);
    return persistWorkspaceState({ ...state, layout });
  }, [getWorkspaceLayout, setWorkspaceLayout]);

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
  const [pendingDeletion, setPendingDeletion] = useState<{ revision: number; deletedIds: string[] } | null>(null);
  const deletionSeqRef = useRef(0);
  /** Web版 = ブラウザで直接開かれたアプリ。Electronでも埋め込みSDKでもないときだけ
   * WebMCPのツール登録とAI面 (キャンバス左上のdock) を出す。 */
  const { appUpdateState, showTitleUpdateButton, titleUpdateButtonDisabled, handleTitleUpdateAction } = useDesktopUpdateController(isDesktopApp, setStatusMessage);
  const webMcpEnabled = !isDesktopApp && !isEmbedded;
  const dismissVersionHistory = useCallback(() => setVersionHistoryOpen(false), []);
  const clearInlineRunAnchor = useCallback(() => { setAiInlineRunAnchor(null); setAiInlineRunAnchorCanvas(null); }, [setAiInlineRunAnchor, setAiInlineRunAnchorCanvas]);
  const hasInlineRunAnchor = useCallback(() => aiInlineRunAnchorRef.current !== null, [aiInlineRunAnchorRef]);
  const surfacePreviewClearRef = useRef<() => void>(() => {});
  const clearSurfacePreview = useCallback(() => surfacePreviewClearRef.current(), []);
  const { rightDock, setRightDock, rightDockWidth, setRightDockWidth, aiSidebarOpen, aiDisplayMode, aiInlineOpen, aiInlineAnchor, aiInlineSessionId, aiInlineClosing, aiSettingsOpen, setAiSettingsOpen, applyAiSurface, openAiInline, promoteAiToSidebar, openRightDockSurface, closeAiSurface, collapseRightDock, closeRightDockChat } = useAiSurfaceController({ isDesktopApp, transitions: { openInline, promoteToSidebar, closeSurface }, dismissVersionHistory, clearRunAnchor: clearInlineRunAnchor, hasRunAnchor: hasInlineRunAnchor, clearAiEditPinnedReferences: clearAiInlineSessionContext, clearAiEditPreview: clearSurfacePreview });
  const [storedUiLayoutPreference, updateUiLayoutPreference] = useUiLayoutPreference();
  // Word風リボンは再検討まで露出しない。保存済み設定は消さず、表示時だけ既定UIへ倒す。
  const uiLayoutPreference = useMemo(() => (
    storedUiLayoutPreference.mode === "docs"
      ? storedUiLayoutPreference
      : { ...storedUiLayoutPreference, mode: "docs" as const }
  ), [storedUiLayoutPreference]);
  const appShellRef = useRef<HTMLDivElement>(null);
  useCompactChrome(appShellRef, uiLayoutPreference.mode);
  // サイドバーの内容のカードを差し込む場所 (キャンバス右上に浮かぶカードの並びの先頭)。
  const [rightDockPeekHost, setRightDockPeekHost] = useState<HTMLElement | null>(null);
  // その並びが小さなアイコンだけのとき、サイドバーの内容のカードも同じ大きさに合わせる。
  const [commentRailCompact, setCommentRailCompact] = useState(false);
  const materialMenuCloseRef = useRef<() => void>(() => {});
  const closeMaterialMenu = useCallback(() => materialMenuCloseRef.current(), []);
  const { shapeMenuOpen, setShapeMenuOpen, lineToolMenuOpen, setLineToolMenuOpen, inlineMathMenuOpen, setInlineMathMenuOpen, fontFamilyMenuOpen, setFontFamilyMenuOpen, blockStyleMenuOpen, setBlockStyleMenuOpen, boxedTextMenuOpen, setBoxedTextMenuOpen, lineHeightMenuOpen, setLineHeightMenuOpen, textAlignMenuOpen, setTextAlignMenuOpen, orderedListMenuOpen, setOrderedListMenuOpen, moreBlocksMenuOpen, setMoreBlocksMenuOpen, lineDashMenuOpen, setLineDashMenuOpen, lineWidthMenuOpen, setLineWidthMenuOpen, colorStylePanel, setColorStylePanel, lineEndpointMenu, setLineEndpointMenu, activeMenu, setActiveMenu, newDocMenuOpen, setNewDocMenuOpen, exportMenuOpen, setExportMenuOpen, ribbonTabState, ribbonBackstageState, ribbonBackstageOpen, ribbonCollapse, ribbonContextualTabVisible, ribbonIdPrefix, selectRibbonTab, toggleRibbonCollapse, toggleRibbonBackstage, closeRibbonBackstage, selectRibbonBackstageSection, toggleMenu } = useEditorChromeController({ contextualVisible: overlaySelection.selectedCount > 0, uiLayoutPreference, updateUiLayoutPreference, closeMaterialMenu, setSearchOpen });
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

  const openCommentComposer = useCallback((requestedAnchor: SigmaCommentAnchor | null) => {
    // 対象が選ばれていなければ、場所を持たない文書全体へのコメントとして始める。
    const anchor: SigmaCommentAnchor = requestedAnchor ?? { type: "document" };
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
  // The workspace's comment list links here with `?commentThreadId=` to land on one thread.
  useRequestedCommentThread({ ready: workspaceReady, activeFileId, comments: document.comments, select: selectCommentThread });

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
    // Toolbar measurements belong to the outgoing editor, not the incoming document.
    // Leave the size unknown until its restored caret or a new selection reports it.
    setTextFontSize(null);
    setTextFontSizeMixed(false);
    setFontSizeInput("");
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
    setCommentsPanelOpen(commentsInRail || !isWhiteboardPageLayout(normalizePageLayout(nextDocument.pageLayout)));
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
  }, [documentHistory, setFontSizeInput, setTextFontSize, setTextFontSizeMixed, setSelectedId, setSelectedInlineMath, closeGraphSettings, setSelectedOverlayGraph, closeChartSettings, setSelectedOverlayChart, closeGraph3DSettings, setCommentAnchorCandidate, setPendingCommentAnchor, clearCommentReplyDrafts, setActiveCommentThreadId, setHighlightedCommentThreadId, clearAiEditPinnedReferences, commentsInRail, setCommentsPanelOpen]);

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
    const caret = pendingPaneCaretRef.current;
    pendingPaneCaretRef.current = null;
    if (caret && caret.fileId === activeFileId) {
      placeCaretAtPointWhenReady({
        getScroller: () => editorCanvasRef.current,
        point: caret,
        scrollTop: pending.scrollTop,
      });
    }
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
    const session = documentSessionRef.current;
    if (session) {
      // The server operation has already reached this replica through typed update IPC.
      // Never re-merge an approval response or record a second whole-document history step.
      const current = session.project();
      documentRef.current = current;
      setDocument(current);
      return { kind: "adopt" as const, document: current, adoptedDocumentMatchesDisk: true };
    }
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
  const activateFailedDocument = useCallback(async (
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
  }, [refreshDocumentMetadatas, resetEditorDocument, saveWorkspaceState, setSaveState, setStatusMessage]);

  const rememberPristineDraft = useCallback((fileId: string, initial: SigmaDocument) => { untouchedNewDocumentsRef.current.set(fileId, initial); }, []);
  const { documentOpenFailure, documentOpenFailureRef, showRecordedDocumentOpenFailure, enterDocumentOpenFailureState, loadWorkspaceDocument } = useDocumentRecovery({ announceRecovery, rememberPristineDraft, activateFailedDocument });

  const isCurrentDocumentDirty = useCallback(() => {
    return !areSigmaDocumentsEquivalent(documentRef.current, lastSavedDocumentRef.current);
  }, []);
  const {
    cancelPendingAutosaveRef,
    scheduleAutosaveRetry,
    updateVersionHistoryCaptureStatus,
    saveCurrentDocumentRecord,
    saveCurrentDocumentBeforeReplacement,
    attemptBoundarySave,
  } = useDocumentSaveBoundary({
    documentSessionRef,
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
    autosave: { activeFileId, document, documentSession, workspaceReady, blocked: Boolean(ledgerFailure), isDesktopApp, openFileIds, setOpenFileIds, saveWorkspaceState, refreshDocumentMetadatas },
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

  const cleanupUntouchedDraftsBeforeClose = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    const candidates = Array.from(untouchedNewDocumentsRef.current.entries());
    for (const [fileId, initialDraft] of candidates) {
      const loaded = await loadDocumentByFileIdWithRecovery(fileId);
      if (!loaded.ok || !isUntouchedNewDocument(initialDraft, loaded.document)) continue;
      if (fileId === activeFileIdRef.current && !isUntouchedNewDocument(initialDraft, documentRef.current)) continue;

      const metadata = (await listSavedDocuments()).find((item) => item.fileId === fileId);
      if (!metadata || metadata.sharing || metadata.sharingPending || sessionHost?.get(fileId) || sessionHost?.isReadOnly?.(fileId)) continue;
      try {
        await deleteAiDataForDocument(fileId);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : tEditor("status.deleteFailed") };
      }
      const result = await deleteDocument(fileId, { expectedRevision: loaded.revision });
      if (!result.ok) return { ok: false, error: result.error ?? tEditor("status.deleteFailed") };
      untouchedNewDocumentsRef.current.delete(fileId);
      editorTabViewStateByFileIdRef.current.delete(fileId);
    }
    return { ok: true };
  }, [deleteAiDataForDocument, sessionHost]);

  const { windowCloseSaveDialog, attemptWindowCloseSave, finishWindowCloseSave } = useWindowCloseBoundary({ attemptBoundarySave, isCurrentDocumentDirty, cleanupUntouchedDraftsBeforeClose, tE });

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
  }, [loadWorkspaceDocument, refreshDocumentMetadatas, resetEditorDocument, saveUnsavedEditBackup, saveWorkspaceState, setSaveState, setStatusMessage]);

  const restoreWorkspaceTextSelection = useCallback((selection: TextFlowSelectionBookmark) => { textSelectionBookmarkRef.current = selection; }, []);
  const openDocumentInWorkspace = useWorkspaceDocumentNavigation({ openFileIds, workspaceReady, getActiveFileId: getActiveWorkspaceFileId, setLoadingFileId, saveCurrentDocumentBeforeReplacement, rememberLeavingEditorTabViewState, loadWorkspaceDocument, showRecordedDocumentOpenFailure, enterDocumentOpenFailureState, prepareIncomingEditorTabViewState, resetEditorDocument, restoreTextSelection: restoreWorkspaceTextSelection, setOpenFileIds, setActiveFileId, saveWorkspaceState, refreshDocumentMetadatas, setSaveState, setStatusMessage });

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
  }, [openFileIds, focusSourceReferenceInDocument, setSelectedInlineMath, setSelectedId, setStatusMessage, workspaceReady, rememberLeavingEditorTabViewState, loadWorkspaceDocument, resolveSourceReferenceNavigationTarget, resetEditorDocument, saveWorkspaceState, refreshDocumentMetadatas, setSaveState, saveCurrentDocumentBeforeReplacement, showRecordedDocumentOpenFailure, enterDocumentOpenFailureState]);

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

  // A newly narrowed pane should keep the entire page visible. Only lower the
  // zoom here; manual zoom changes and splitter dragging remain under user control.
  useEffect(() => {
    if (!editorCanvasElement || workspaceLayout.groups.length < 2 || isWhiteboardDocument || cameraByFileIdRef.current.has(activeFileId)) return;
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        const scroller = editorCanvasRef.current;
        if (!scroller) return;
        const style = window.getComputedStyle(scroller);
        const available = scroller.clientWidth - Number.parseFloat(style.paddingLeft || "0")
          - Number.parseFloat(style.paddingRight || "0");
        const pageWidth = getPageMetrics(ensurePageLayout(documentRef.current).pageLayout!).page.widthMm * MM_TO_PX;
        if (available <= 0 || pageWidth <= 0) return;
        const fitted = Math.floor((available / pageWidth) * 100);
        if (fitted < editorStore.getState().zoom) applyZoom(Math.max(25, fitted));
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeFileId, applyZoom, editorCanvasElement, editorStore, isWhiteboardDocument, workspaceLayout.groups.length]);

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
    const scroller = editorCanvasElement;
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
  }, [applyZoom, editorCanvasElement, isWhiteboardDocument, panWhiteboardBy]);

  useEffect(() => {
    if (workspaceReady) {
      window.dispatchEvent(new Event(APP_READY_EVENT));
    }
  }, [workspaceReady]);

  useLayoutEffect(() => {
    if (!documentSession) return;
    const apply = () => {
      const next = documentSession.project();
      if (areSigmaDocumentsEquivalent(documentRef.current, next)) return;
      documentRef.current = next;
      lastSavedDocumentRef.current = next;
      lastSyncedDocumentRef.current = next;
      documentObservedRevisionRef.current = 1;
      documentDirtyRevisionRef.current += 1;
      lastSavedDirtyRevisionRef.current = documentDirtyRevisionRef.current;
      setDocument(next);
      setDocumentStateStamp(documentDirtyRevisionRef.current);
    };
    apply();
    return documentSession.subscribe(apply);
  }, [documentSession]);

  const commitDocumentChange = useCallback((change: DocumentChange, options?: DocumentChangeOptions) => measurePerformance("EditorShell.commitDocumentChange", () => {
    const session = documentSessionRef.current;
    if (!sessionWritableRef.current) return false;
    // AI 側の状態は ref から読む (上の `aiLockedTargetsRef` のコメント参照)。書き込み中は
    // state のミラーではなく、書き込み開始と同時に立つ `mcpPreviewBusyRef` を直接見る。
    const aiDocumentWriteInProgress = mcpPreviewBusyRef.current;
    const aiLockedTargets = aiLockedTargetsRef.current;
    if (aiDocumentWriteInProgress) {
      setStatusMessage(sessionWritableRef.current ? aiDocumentWriteInProgressMessage() : t("collaboration.readOnlyDocument"));
      return false;
    }
    const current = documentRef.current;
    const proposed = typeof change === "function" ? change(current) : change;
    // 本文を空のままにはしない。ブロック削除・切り取り・AI 適用のどれで空になっても、
    // ここで空段落が 1 つ残るので「消したら二度と入力できない」状態にはならない。
    let next = ensureEditableBody(repairDuplicateTopLevelIds(
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
    if (session) next = session.change(current, next);
    if (!session && !options?.coalesce) {
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
    // Shared views also project remote changes into the focused editor. A deferred
    // local render can otherwise land after another keystroke and replace its
    // newer ProseMirror content with the older projection.
    if (options?.deferRender && !session) {
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
  }), [aiDocumentWriteInProgressMessage, describeAiLockedTargets, documentHistory, findAiLockedTargetsTouched, hasAiLockedTargetsTouched, setStatusMessage, t]);

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

  useLayoutEffect(() => { materialMenuCloseRef.current = () => setMaterialActionMenu(null); }, [setMaterialActionMenu]);
  const restoreDocumentVersion = async (version: DocumentVersion): Promise<DocumentVersionRestoreResult> => {
    if (documentSessionRef.current) return { ok: false, error: t("collaboration.useSharedBackup") };
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
    const session = documentSessionRef.current;
    if (session) {
      window.dispatchEvent(new CustomEvent(FLUSH_OVERLAY_CHANGES_EVENT));
      const next = session.restore(direction);
      if (next) {
        documentRef.current = next;
        documentDirtyRevisionRef.current += 1;
        setDocument(next);
        setDocumentStateStamp(documentDirtyRevisionRef.current);
      }
      return;
    }
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
      setStatusMessage(sessionWritableRef.current ? aiDocumentWriteInProgressMessage() : t("collaboration.readOnlyDocument"));
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
  }, [aiDocumentWriteInProgressMessage, describeAiLockedTargets, documentHistory, findAiLockedTargetsTouched, hasAiLockedTargetsTouched, refreshMcpEditProposals, setActiveCommentThreadId, setCommentAnchorCandidate, setPendingCommentAnchor, setSelectedId, setSelectedInlineMath, setStatusMessage, t]);

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
  }, [activeFileId, document, documentStateStamp, openFileIds, selectedId, workspaceLayout, workspaceReady]);

  const acceptEmbeddedDocument = useCallback((nextDocument: SigmaDocument) => {
    resetEditorDocument(nextDocument, undefined, null);
    setOpenFileIds([nextDocument.docId]);
    setActiveFileId(nextDocument.docId);
    setStatusMessage(tEditor("status.hostUpdated"));
  }, [resetEditorDocument, setStatusMessage]);
  useEmbeddedDocumentSync({ embeddedHost, document, initialDocument, currentDocument: getCurrentSessionDocument, acceptDocument: acceptEmbeddedDocument });

  const installWorkspaceLayout = setWorkspaceLayout;
  const activateWorkspaceDocument = useCallback((nextDocument: SigmaDocument, fileId: string, fileIds: string[], revision: number) => {
    resetEditorDocument(nextDocument, undefined, revision);
    setOpenFileIds(fileIds);
    setActiveFileId(fileId);
  }, [resetEditorDocument]);
  useWorkspaceInitialization({ isEmbedded, workspaceReloadNonce, loadWorkspaceDocument, showRecordedDocumentOpenFailure, enterDocumentOpenFailureState, activateDocument: activateWorkspaceDocument, installLayout: installWorkspaceLayout, refreshDocumentMetadatas, saveWorkspaceState, setLedgerFailure, setWorkspaceReady, setSaveState, setStatusMessage });

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

  const tikzEditor = useTikzEditor({
    document, fileId: activeFileId, writable: sessionWritable, commit: commitDocumentChange,
    getPasteAnchor: () => selectedIdRef.current,
    insertDocument: (imported, afterBlockId) => {
      return commitDocumentChange((current) => {
        const next = insertTopLevelDocumentBlocks(current, afterBlockId, imported.content, DOCUMENT_BLOCK_OPERATION_PORTS);
        const incoming = imported.pageLayout!.overlay!.overlaySnapshot!;
        const layout = ensurePageLayout(next).pageLayout!;
        const existing = layout.overlay?.overlaySnapshot;
        return { ...next, pageLayout: { ...layout, overlay: { ...layout.overlay!, overlaySnapshot: {
          ...existing, version: 1,
          shapes: [...(existing?.shapes ?? []), ...incoming.shapes],
          assets: { ...existing?.assets, ...incoming.assets },
        } } } };
      });
    },
    insert: (payload) => {
      overlayActionRequestIdRef.current += 1;
      setOverlayActionRequest({ id: overlayActionRequestIdRef.current, type: "pasteShapes", payload });
    },
  });

  // ホワイトボードの見えている範囲の中央 (カメラを引いた座標)。ポケットのクリック挿入と、
  // ホワイトボードへの本文のコピーの貼り付けで、文章の図形を置く場所に使う。
  const getWhiteboardViewportCenter = useCallback(() => {
    const viewport = window.document.querySelector<HTMLElement>(".whiteboard-page-canvas");
    if (!viewport) {
      return null;
    }
    const { zoom: currentZoom, whiteboardPan: pan } = editorStore.getState();
    const scale = Math.max(0.01, currentZoom / 100);
    return { x: (viewport.clientWidth / 2 - pan.panX) / scale, y: (viewport.clientHeight / 2 - pan.panY) / scale };
  }, [editorStore]);

  useEffect(() => registerEditorClipboardEvents({
    pasteTikz: tikzEditor.pasteTikz,
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
    pasteShapes: (payload, options) => {
      overlayActionRequestIdRef.current += 1;
      setOverlayActionRequest({
        id: overlayActionRequestIdRef.current,
        type: "pasteShapes",
        payload,
        centerAt: options?.centerAt,
        unbounded: options?.unbounded,
      });
    },
    bodyless: isWhiteboardDocument,
    getBodylessPasteCenter: getWhiteboardViewportCenter,
    setCanPasteProblem,
    setStatusMessage,
    translate: tEditor,
  }), [tikzEditor.pasteTikz, materialEditingOpenRef, commitDocumentChange, overlayEditing, selectedInlineMath, setSelectedId, setSelectedInlineMath, setStatusMessage, isWhiteboardDocument, getWhiteboardViewportCenter]);

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

    const scroller = editorCanvasElement;
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
    editorCanvasElement,
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
  const activeTextFontSize = !canUseTextToolbar ? null : wholeTextShape
    ? wholeTextShapeSize?.fontSize ?? null
    : textFontSize;
  const activeTextFontSizeMixed = wholeTextShape ? wholeTextShapeSize?.fontSizeMixed === true : textFontSizeMixed;
  useLayoutEffect(() => {
    // Sync before paint so a newly selected shape never displays the old size.
    // Keep the inline field in sync with the selection without replacing a value
    // while the user is in the middle of editing it.
    if (fontSizeInputRef.current === window.document.activeElement) return;
    setFontSizeInput(activeTextFontSize === null ? "" : String(activeTextFontSize));
  }, [activeTextFontSize, setFontSizeInput]);
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
  // 図形の種類の変更は、種類を変えられる図形が 1 つだけ選ばれているときに限る。
  const canChangeOverlayShapeTypeNow = canArrangeOverlayShapes && planShapeTools(overlaySelection).shapeType;

  const canUseLineEndpointControls = !overlayToolbarLockedByAi && hasOverlaySelection && overlaySelection.canStyleLineEndpoints;

  const selectedOverlayLineDash = useMemo(
    () => getSharedOverlayLineDash(overlaySelection.selectedShapes, overlaySelection.solidEdge),
    [overlaySelection.selectedShapes, overlaySelection.solidEdge],
  );
  const selectedOverlayLineSize = useMemo(
    () => getSharedOverlayLineSize(overlaySelection.selectedShapes, overlaySelection.solidEdge),
    [overlaySelection.selectedShapes, overlaySelection.solidEdge],
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
  }, [selectedInlineMath, setInlineMathMenuOpen]);
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

  const { previewOpen, setPreviewOpen, pdfExporting, exportedPdfPath, setExportedPdfPath, printPreviewRenderState, setPrintPreviewRenderState, openPrintPreview, exportPdf, openPrintWindow } = useDocumentPrintController({ isDesktopApp, isEmbedded, getDocument: getCurrentSessionDocument, getActiveFileId: getActiveWorkspaceFileId, flushOverlayChanges, saveCurrentDocumentRecord, setSaveState, setStatusMessage });

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
  const getSelectedBlockId = useCallback(() => selectedIdRef.current, []);
  const getBodySelectionBookmark = useCallback(() => textSelectionBookmarkRef.current, []);
  const selectBodyBlock = useCallback((value: SetStateAction<string | null>) => {
    const next = typeof value === "function" ? value(selectedIdRef.current) : value;
    selectedIdRef.current = next;
    setSelectedId(next);
  }, [setSelectedId]);
  const { addBlock, insertProblemFromTextFlowCommand, wrapBlockInColumns, unwrapColumns, resizeLayoutColumns, updateBlock, updateBlockSpaceAfter, removeBlock, removeBlocks, moveBlocksByDragRequest, moveBlocksByStepRequest, insertBodyBlockAt, copyBlockToClipboard, pasteBlockFromClipboard } = useDocumentBodyCommands({ getDocument: getCurrentSessionDocument, selectedId, getSelectedId: getSelectedBlockId, setSelectedId: selectBodyBlock, setSelectedInlineMath, getSelectionBookmark: getBodySelectionBookmark, commitDocumentChange, setCanPasteProblem, setStatusMessage });

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
  }, [setNewDocMenuOpen]);

  const scheduleCloseNewDocMenu = useCallback(() => {
    if (newDocMenuCloseTimerRef.current !== null) {
      window.clearTimeout(newDocMenuCloseTimerRef.current);
    }
    newDocMenuCloseTimerRef.current = window.setTimeout(() => {
      setNewDocMenuOpen(false);
      newDocMenuCloseTimerRef.current = null;
    }, 140);
  }, [setNewDocMenuOpen]);

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

  // 文書を1本走査するので、実際にボタンが描かれるレイアウトタブを開いている
  // ときだけ計算する。docs では段組みコマンドが画面に無く、word でも他のタブでは
  // 読まれないため、毎キーストロークの走査を丸ごと省ける。
  useEffect(() => { toggleRibbonCollapseRef.current = toggleRibbonCollapse; });
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
      setStatusMessage(sessionWritableRef.current ? aiDocumentWriteInProgressMessage() : t("collaboration.readOnlyDocument"));
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
  }, [captureMaterialBlockSelectionFromDom, setLineDashMenuOpen, setLineToolMenuOpen, setLineWidthMenuOpen, setSaveState, setShapeMenuOpen, setStatusMessage]);

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
  // ポケットの項目を紙面へ置く窓口。ホワイトボードは本文が無いので、本文のコピーも文章の図形として置く。
  usePocketPageHost({
    bodyless: isWhiteboardDocument,
    getViewportCenter: getWhiteboardViewportCenter,
    requestOverlayAction,
  });
  // 選択の近くに出す編集操作。中身は SelectionToolbarProvider 越しに読むので identity は不変でよい。
  const selectionToolbarExtension = useMemo(() => createSelectionToolbarExtension(), []);

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
  }, [setActiveMenu, setBlockStyleMenuOpen, setBoxedTextMenuOpen, setColorStylePanel, setExportMenuOpen, setFontFamilyMenuOpen, setLineEndpointMenu, setLineHeightMenuOpen, setLineToolMenuOpen, setShapeMenuOpen, setTextAlignMenuOpen]);

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
  const changeOverlayShapeType = (command: ShapeTypeChangeCommand) => {
    if (canChangeOverlayShapeTypeNow) {
      requestOverlayAction({ type: "changeShapeType", command });
    }
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
  }, [setColorStylePanel, setLineDashMenuOpen, setLineWidthMenuOpen]);

  const applyInlineFormat = (command: "color" | "backgroundColor" | "fontFamily" | "fontSize" | "lineHeight" | "boxedPaddingY" | "boxedVariant", value: string) => {
    if (!canUseTextToolbar) {
      return;
    }

    window.dispatchEvent(new CustomEvent(FORMAT_TEXT_EVENT, { detail: { command, value, target: textToolbar.target } }));
  };

  const { applyLineHeight, startLineHeightStepping, handleLineHeightStepClick, stopLineHeightStepping } = useLineHeightControl({ enabled: canUseLineHeight, lineHeight, menuOpen: lineHeightMenuOpen, customOpen: lineHeightCustomOpen, setLineHeight, setLineHeightInput, setLineHeightInputError, applyFormat: applyInlineFormat, t });

  const applyBoxedTextPaddingY = (paddingY: number) => {
    const nextPaddingY = clampBoxedTextPaddingY(paddingY);
    setBoxedTextPaddingY(nextPaddingY);
    rememberBoxedFormat({ paddingY: nextPaddingY });
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
      const variant = normalizeBoxedTextVariant(getLastBoxedFormat().variant) ?? "frame";
      if (variant !== "frame") {
        applyInlineFormat("boxedVariant", variant);
      }
      applyInlineFormat("boxedPaddingY", String(clampBoxedTextPaddingY(getLastBoxedFormat().paddingY)));
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

    rememberBoxedFormat({ variant: nextVariant });
    applyInlineFormat("boxedVariant", nextVariant);
  };

  const { findNext, findPrevious, replaceNext, replaceAll, searchMatchCount } = useDocumentSearchCommands({ document, selectedId, searchQuery, replaceText, setSelectedId, setStatusMessage, commitDocumentChange });

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
    deleteAiDataForDocument,
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
    saveWorkspaceState,
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
    exportDocument: async () => documentSessionRef.current?.exportDocument?.() ?? documentRef.current,
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

  useLayoutEffect(() => { workspaceDocumentActionsRef.current = { open: openDocumentInWorkspace, close: closeDocumentTab }; }, [closeDocumentTab, openDocumentInWorkspace]);
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
    if (!commentsInRail && isWhiteboardPageLayout(normalizedLayout) && !isWhiteboardDocument) {
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
    revertSessionProposals: async (ids: string[]) => {
      const session = documentSessionRef.current;
      if (!session) return undefined;
      flushOverlayChanges();
      return (await session.restoreOperations?.(ids)) ?? false;
    },
    resetEditorDocument,
    scheduleAutosaveRetry,
    announceRecovery,
    t,
  });

  useLayoutEffect(() => { surfacePreviewClearRef.current = clearAiEditPreview; }, [clearAiEditPreview]);
  const openVersionHistory = () => {
    if (versionHistoryRestoring) return;
    if (versionHistoryOpen) {
      setVersionHistoryOpen(false);
      setVersionHistoryPreviewState(null);
      return;
    }
    applyAiSurface({ displayMode: "sidebar", aiSidebarOpen: false, aiInlineOpen: false });
    setRightDock(closeRightDock);
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
  }, [applyAiSurface, promoteToSidebar, setVersionHistoryOpen]);

  // AIタスクDockの「他のドキュメント」行: その教材へ移り、部屋があればAIチャットでも開く。
  // 移動に失敗した (保存できない・読み込めない) ときは、元の教材でチャットを開かない。
  const openAiTaskDocument = useCallback(async (fileId: string, roomId: string | null) => {
    await openDocumentInWorkspace(fileId);
    if (roomId && activeFileIdRef.current === fileId) {
      focusAiSession(roomId);
    }
  }, [focusAiSession, openDocumentInWorkspace]);
  const otherDocumentsForAiTasks = useMemo(() => ({
    pendingProposals: mcpEditProposals,
    resolveDocumentTitle: (fileId: string) => metadataByFileId.get(fileId)?.title || tE("shell.untitledDocument"),
    onOpen: (fileId: string, roomId: string | null) => { void openAiTaskDocument(fileId, roomId); },
  }), [mcpEditProposals, metadataByFileId, openAiTaskDocument, tE]);

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
  }, [AI_REFERENCE_TEXT_RANGE_EVENT, aiEditPinnedReferences, aiReferenceHighlightActive]);

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
  }, [aiDisplayMode, aiInlineOpen, aiSidebarOpen, deriveAiReferenceRequestPlan, openAiInline, pinAiEditPinnedReference, setSelectedId, setStatusMessage]);

  // 範囲スクリーンショットの「AIに聞く」。撮った画像を入力欄へ添え、AI面がまだ無ければ
  // 選んだ範囲のそばにインラインで開く。開いていれば添えるだけにして、打ちかけの指示文を消さない
  // (openAiInline は会話の入力欄を作り直す)。
  const requestAiEditWithScreenshot = useCallback((
    attachment: AiEditAttachment,
    anchor: { left: number; top: number },
  ) => {
    addAiPendingAttachment(attachment);
    const activeSurfaceOpen = (aiDisplayMode === "inline" && aiInlineOpen)
      || (aiDisplayMode === "sidebar" && aiSidebarOpen);
    if (!activeSurfaceOpen) {
      openAiInline(anchor);
    }
  }, [addAiPendingAttachment, aiDisplayMode, aiInlineOpen, aiSidebarOpen, openAiInline]);

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
    if (!commentsInRail && isWhiteboardPageLayout(normalizedLayout) && !isWhiteboardDocument) {
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
        + (rightDock.open ? rightDockWidth : 0);
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
        runEditCommand, toggleBoxedText, applyTextStyle, applyBlockStructure, applyTextAlign, applyLineHeight,
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
  }, [aiDisplayMode, aiSidebarOpen, aiInlineOpen, applyAiSurface, closeAiSurface, openAiInline, commandSettingsOpen, texCommandReferenceOpen, commandSettingsError, commandSettingsLoaded, pageSettingsOpen, documentListOpen, previewOpen, aiSettingsOpen, desktopSettingsOpen, materialLibraryOpen, ribbonBackstageOpen, commandPaletteOpen, customCommands, shortcutOverrides, isInlineToggleShortcut, toggleSurface]);

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
  useRequestedDocumentLocation({
    ready: pageEditorMounted, fileId: activeFileId, document, root: editorCanvasElement,
    selectBlock: id => { setSelectedInlineMath(null); setSelectedId(id); },
    revealRegion: bounds => {
      const viewport = editorCanvasElement?.querySelector<HTMLElement>(".whiteboard-page-canvas");
      if (!viewport) return;
      const store = editorStore.getState(), scale = store.zoom / 100;
      store.setWhiteboardPan({ panX: viewport.clientWidth / 2 - (bounds.x + bounds.w / 2) * scale,
        panY: viewport.clientHeight / 2 - (bounds.y + bounds.h / 2) * scale });
    },
    unavailable: () => setStatusMessage(t("collaboration.locationUnavailable")),
  });

  const reloadFailedDocument = useCallback(async () => {
    const failure = documentOpenFailureRef.current;
    if (!failure) {
      return;
    }
    await openDocumentInWorkspace(failure.fileId, {
      saveCurrent: false,
      status: tEditor("status.reopened"),
    });
  }, [documentOpenFailureRef, openDocumentInWorkspace]);

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

  const readPaneZoom = useCallback((fileId: string) => cameraByFileIdRef.current.get(fileId)?.zoom ?? 100, []);
  const readPaneScroll = useCallback((fileId: string) => editorTabViewStateByFileIdRef.current.get(fileId), []);
  const workspacePaneView = useMemo<WorkspacePaneView>(() => ({
    zoom,
    showComments: commentsPanelOpen,
    commentsInRail: isDesktopApp && !isEmbedded,
    showResolvedComments,
    commentAuthor,
    scrollFor: readPaneScroll,
    zoomFor: readPaneZoom,
  }), [commentAuthor, commentsPanelOpen, isDesktopApp, isEmbedded, readPaneScroll, readPaneZoom, showResolvedComments, zoom]);

  const aiRoomTitles = useAiWorkspaceTabTitles();
  const workspaceTabsRow = isEmbedded ? null : (
    <WorkspaceTabStrip
      aiRoomTitles={aiRoomTitles}
      layout={workspaceLayout}
      metadata={documentMetadatas}
      activeFileId={activeFileId}
      loadingFileId={loadingFileId}
      activeDocumentTitle={resolvedDocumentTitle}
      activeDocumentTitleNodes={documentTitle.nodes}
      onActivateTab={activateWorkspaceGroupTab}
      onCloseTab={closeWorkspaceGroupTab}
      onMoveTab={moveWorkspaceGroupTab}
      onSplitTab={splitWorkspaceGroupTab}
      onFocusGroup={focusWorkspaceGroup}
    />
  );

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

  // ポケットは Backstage が全画面で覆っている間と、埋め込みでは出さない。紙面の高さは
  // `.app-shell[data-pocket]` が `--editor-pocket-height` として全画面の計算へ配る。
  const pocketVisible = !isEmbedded && !ribbonBackstageOpen;
  const pocketPhase = usePocketPhase();

  const workspaceClassName = [
    "workspace",
    showPageNavigator ? "" : "outline-hidden",
    outlineOpen ? "" : "outline-collapsed",
    // 版履歴だけが右の列を使う。右サイドバーは .app-shell の右の列で、本文の列には入らない。
    versionHistoryOpen ? "ai-sidebar-open" : "",
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

  const loadMentionCandidates = useMemo(() => loadCommentMentionCandidates
    ? () => loadCommentMentionCandidates(activeFileId)
    : undefined, [activeFileId, loadCommentMentionCandidates]);
  const commentPanelBaseProps = useMemo(() => ({
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

  const commentPanelProps = { ...commentPanelBaseProps, loadMentionCandidates, currentUserId: commentIdentity?.userId };

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

  // 選択の近くに出す操作バーへ渡す値。上部ツールバーと同じ状態・同じ操作の窓口で、
  // 別の書式実装は持たない (押せる/押せないの判定もツールバーと一致する)。
  const selectionToolbarBinding: SelectionToolbarBinding = {
    text: {
      enabled: canUseTextToolbar,
      canBlockStyle: canUseTextBlockStyle,
      canBlockStructure: canUseBlockStructure,
      canAlign: canUseTextAlign,
      fontSize: activeTextFontSize,
      fontSizeMixed: activeTextFontSizeMixed,
      blockStyle: selectedTextStyle,
      blockStructure: blockStyleState,
      bold: boldActive,
      italic: italicActive,
      underline: underlineActive,
      boxed: boxedTextActive,
      boxedVariant: boxedTextVariant,
      boxedPaddingY: boxedTextPaddingY,
      textColor,
      textBackgroundColor,
      textAlign: selectedTextAlign,
      toggleInline: runEditCommand,
      applyBlockStyle: applyTextStyle,
      applyBlockStructure,
      setFontSize: (size) => {
        setTextFontSize(size);
        applyInlineFormat("fontSize", String(size));
      },
      toggleBoxed: toggleBoxedText,
      selectBoxedVariant: selectBoxedTextVariant,
      setBoxedPaddingY: applyBoxedTextPaddingY,
      setTextColor: (color) => {
        setTextColor(color);
        applyInlineFormat("color", color);
      },
      setTextBackgroundColor: (color) => {
        setTextBackgroundColor(color);
        applyInlineFormat("backgroundColor", color ?? "");
      },
      applyTextAlign,
      insertBoxBlock: () => addBlock("boxBlock"),
    },
    shape: {
      enabled: !overlayToolbarLockedByAi,
      selection: overlaySelection,
      strokeColor,
      fillColor: selectionFillColor,
      fillOpacity: selectionFillOpacity,
      applyStyle: applyOverlayStyle,
      fillColorPatch,
      request: requestOverlayAction,
      saveAsMaterial: () => openMaterialAddDialog(),
    },
  };

  // 右サイドバーの入口 (タイトル行の右端の開くボタン / 閉じている間にウェブのページを見せるカード)。
  // どちらも、本文を操作できる状態のときだけ出す。
  const rightDockAvailable = !versionHistoryPreviewActive && workspaceReady && isDesktopApp && !isEmbedded && !activeDocumentOpenFailure;
  // 版履歴は同じ右端を使うので、見ている間はカードを出さない。コメントは同じ並びの中でカードの下に積む。
  const rightDockPeekEnabled = rightDockAvailable && !versionHistoryOpen;

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
      documentActions: renderDocumentActions ? <DocumentActionsSlot render={renderDocumentActions} context={{ fileId: activeFileId, document, getDocument: getCurrentSessionDocument, flush: saveCurrentDocumentRecord }} /> : null,
      accountAction,
      rightDockToggle: rightDockAvailable && !rightDock.open ? <RightDockToggle onOpen={openRightDockSurface} /> : undefined,
      hasDocumentSession: Boolean(documentSession),
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
      fontSizeInputRef, fontSizeSkipBlurRef, fontSizeInput, setFontSizeInput,
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
      applyOverlayStyle, arrangeOverlayShapes, changeOverlayShapeType,
      canChangeOverlayShapeType: canChangeOverlayShapeTypeNow, canArrangeOverlayShapes, canUseFillStyleControls, canUseLineEndpointControls,
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
      showTitleUpdateButton, titleInputValue, titleRichNodes, workspaceTabsRow,
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

  const aiEditPanelElement = (
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
      pendingAttachments={aiPendingAttachments}
      onRemovePendingAttachment={removeAiPendingAttachment}
      onPendingAttachmentsSent={clearAiPendingAttachments}
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
  );

  return (
    <DocumentSessionContext.Provider value={documentSession}>
    <DocumentWritableContext.Provider value={sessionWritable}>
    <MathEnvironmentProvider
      mathFractionSizing={document.metadata.mathFractionSizing}
      preamble={document.metadata.texPreamble}
    >
    {/* ribbon-chrome.css のセレクタはすべてこの属性から始まる。docs では "docs"。 */}
    <div
      ref={appShellRef}
      className="app-shell"
      data-ui-layout={uiLayoutPreference.mode}
      data-backstage-open={ribbonBackstageOpen ? "true" : undefined}
      data-ribbon-collapsed={ribbonCollapse.collapsed ? "true" : undefined}
      data-pocket={pocketVisible && pocketPhase !== "hidden" ? pocketPhase : undefined}
      data-ai-sidebar-open={aiDisplayMode === "sidebar" && aiSidebarOpen ? "true" : undefined}
      data-right-dock-open={isDesktopApp && !isEmbedded && rightDock.open ? "true" : undefined}
      data-tab-groups={!isEmbedded ? "true" : undefined}
      style={{ "--ai-sidebar-width": `${rightDockWidth}px` } as CSSProperties}
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

      {pocketVisible && <PocketBar addShortcut={commandTooltip("", "edit.pocketAdd").shortcut} />}

      <main
        className={workspaceClassName}
        // Backstage は本文を覆うので、覆っている間は本文を丸ごと不活性にする。
        // capture の keydown ガードだけでは Tab で裏へ抜けられ、beforeinput 経由で
        // 見えない本文を編集できてしまう（inert はフォーカスも入力もまとめて塞ぐ）。
        inert={ribbonBackstageOpen}
        style={{
          "--outline-width": `${outlineWidth}px`,
          // .workspace 自身が狭い画面用の幅を宣言するので、ドラッグで決めた幅はここで上書きする。
          "--ai-sidebar-width": `${rightDockWidth}px`,
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

        <WorkspaceTabGroupGrid
          enabled={!isEmbedded}
          layout={workspaceLayout}
          metadata={documentMetadatas}
          activeFileId={activeFileId}
          sessionHost={sessionHost}
          paneView={workspacePaneView}
          onFocusGroup={focusWorkspaceGroup}
          onMoveTab={moveWorkspaceGroupTab}
          onSplitTab={splitWorkspaceGroupTab}
          onResizeSplit={resizeWorkspaceGroupSplit}
          onOpenAiSettings={() => setAiSettingsOpen(true)}
        >
        <section
          className={`editor-canvas ${loadingFileId ? "is-switching" : ""}`}
          data-whiteboard={isWhiteboardDocument ? "true" : undefined}
          ref={attachEditorCanvas}
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
              otherDocuments={isDesktopApp ? otherDocumentsForAiTasks : undefined}
              resolvedProposals={resolvedMcpEditProposals}
              webMcpInstructionScopeId={webMcpEnabled ? document.docId : null}
              webMcpHistory={webMcpEnabled ? webMcpHistory : undefined}
            />
          )}
          {!versionHistoryPreviewActive && workspaceReady && isWhiteboardDocument && !commentsInRail && (
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
          {pageEditorMounted && <SelectionToolbarProvider value={selectionToolbarBinding}><OverlayImagePreviewContext.Provider value={tikzEditor.preview}><AiPageCanvasEditor
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
            commentPanel={isWhiteboardDocument || commentsInRail ? undefined : commentPanelProps}
            overlaySelection={overlaySelection}
            overlayCommentAnchor={currentOverlayCommentAnchor}
            aiDocumentWriteInProgress={mcpPreviewBusy}
            editorExtensions={sessionEditExtensions}
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
            onAiScreenshotRequest={isDesktopApp ? requestAiEditWithScreenshot : undefined}
            onAiEditPreviewApply={stableApplyVisibleAiEditPreviewGroup}
            onAiEditPreviewDismiss={stableDismissVisibleAiEditPreviewGroup}
            onOpenSourceDocument={openSourceReferenceDocument}
            suppressSelectionActions={aiDisplayMode === "inline" && aiInlineOpen}
            renderSelectionActions={renderSelectionActions ? anchor => renderSelectionActions({ fileId: activeFileId, document, metadata: activeDocumentMetadata ?? undefined, anchor }) : undefined}
            selectionTools={selectionToolbarExtension}
            externalDrop={POCKET_PAGE_DROP}
            pinAiTextSelectionReference={isDesktopApp && pinAiTextSelectionReference}
            onInlineRunPortalReady={handleInlineRunPortalReady}
            documentIdentityKey={activeFileId}
            documentWorkspaceId={activeDocumentMetadata?.workspaceId ?? null}
            onFocusAiSession={focusAiSession}
          /></OverlayImagePreviewContext.Provider></SelectionToolbarProvider>}
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
        </WorkspaceTabGroupGrid>

        {/* インラインのAI入力。サイドチャットは右のサイドバー(下)に載る。パネルは常に1か所だけに描き、
            どちらの面でも実行中の状態を失わない。 */}
        <AiEditorHost
          enabled={!isEmbedded && isDesktopApp && aiDisplayMode === "inline"}
          displayMode={aiDisplayMode}
          surface={aiSurface}
          inlineOpen={aiInlineOpen}
          inlineClosing={aiInlineClosing}
          inlineAnchor={aiInlineAnchor}
          inlineRunAnchor={aiInlineRunAnchor}
          inlineSessionId={aiInlineSessionId}
          editorCanvasRef={editorCanvasRef}
          onClose={closeAiSurface}
        >
          {aiEditPanelElement}
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

      {/* 右サイドバーは本文の列ではなく .app-shell の右の列に置く。ウィンドウの最上端から最下端まで、
          タイトル・メニュー・本文・ステータスバーの縦の並びと横に並ぶ。 */}
      {!isEmbedded && isDesktopApp && (
        <RightDockHost
          state={rightDock}
          onStateChange={setRightDock}
          width={rightDockWidth}
          onResize={setRightDockWidth}
          files={(
            <FilesPanel
              documents={documentMetadatas}
              activeFileId={activeFileId}
              openFileIds={workspaceLayoutOpenFileIds(workspaceLayout)}
              onOpenFile={(fileId) => void openDocumentInWorkspace(fileId)}
              onOpenWorkspaces={openWorkspaceScreen}
            />
          )}
          chat={aiDisplayMode === "sidebar" ? aiEditPanelElement : null}
          onOpenChat={promoteAiToSidebar}
          onCloseChat={closeRightDockChat}
          onCollapse={collapseRightDock}
          onOpen={openRightDockSurface}
          peekEnabled={rightDockPeekEnabled}
          peekHost={rightDockPeekHost}
          peekCompact={commentRailCompact}
        />
      )}
      {commentsInRail && (
        <CommentRail
          document={document}
          panel={commentPanelProps}
          open={commentsPanelOpen && rightDockAvailable && !versionHistoryOpen}
          whiteboard={isWhiteboardDocument}
          onPeekHostChange={setRightDockPeekHost}
          onCompactChange={setCommentRailCompact}
        />
      )}

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

      <EditorOutlineDialog outlineDialogOpen={outlineDialogOpen} resolvedDocumentTitle={resolvedDocumentTitle} titleNodes={documentTitle.nodes} outline={outline} outlineHeadingNumbers={outlineHeadingNumbers} selectedId={selectedId} selectOutlineItem={selectOutlineItem} onClose={() => setOutlineDialogOpen(false)} tE={tE} />

      <EditorPrintPreview previewOpen={previewOpen} document={document} renderState={printPreviewRenderState} pdfExporting={pdfExporting} isDesktopApp={isDesktopApp} isEmbedded={isEmbedded} onRenderStateChange={setPrintPreviewRenderState} onExport={() => void exportPdf()} onOpenExternal={() => void openPrintWindow()} onClose={() => setPreviewOpen(false)} tE={tE} />

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
          headingNumbering={document.metadata.headingNumbering}
          focusEntryId={settingsFocusEntryId}
          hasContent={hasMeaningfulBodyContent(document.content)}
          onClose={() => {
            setPageSettingsOpen(false);
            setSettingsFocusEntryId(undefined);
          }}
          onChange={(layout, headingNumbering) => {
            updatePageLayoutAndMetadata(layout, {
              ...document.metadata,
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
      {tikzEditor.dialog}
      {texEnvironmentSettingsOpen && (
        <TexEnvironmentSettingsDialog
          preamble={document.metadata.texPreamble}
          tikzEnvironment={document.metadata.tikzEnvironment}
          focusEntryId={settingsFocusEntryId}
          onTikzChange={(tikzEnvironment) => updateMetadata({ ...document.metadata, tikzEnvironment })}
          onChange={(texPreamble) => {
            updateMetadata({ ...document.metadata, texPreamble });
            setStatusMessage(tE("status.texEnvUpdated"));
          }}
          onClose={() => { setTexEnvironmentSettingsOpen(false); setSettingsFocusEntryId(undefined); }}
        />
      )}
    </div>
    </MathEnvironmentProvider>
    </DocumentWritableContext.Provider>
    </DocumentSessionContext.Provider>
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
