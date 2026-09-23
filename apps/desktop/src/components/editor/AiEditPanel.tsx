"use client";
import { AiModelMenuContents } from "./ai-model-menu-contents";

import  {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FileText,
  History,
  PanelRight,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  X,
} from "lucide-react";
import  {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties as ReactCSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { AiThinkingOrb } from "@/components/branding/AiThinkingOrb";
import  {
  AntigravityMark,
  ClaudeMark,
  OpenAiMark,
  renderModelMark,
  renderProviderMark,
} from "@/components/branding/provider-logos";
import  {
  dedupeAiSourceReferences,
  deriveAiEditPreviewOverlayShapes,
  describeRevertBlockedReason,
  type AiAppliedTurnChange,
  type AiEditPreviewState,
  type StaleMcpProposalGroup,
} from "@/components/editor/ai-edit-preview-types";
import { AiChatTextInput } from "@/components/editor/AiChatTextInput";
import { AiConnectionGate, ClaudeConnectionGate, GeminiConnectionGate } from "@/components/editor/AiConnectionGate";
import { AiStaleProposalNotice } from "@/components/editor/AiStaleProposalNotice";
import { drawCroppedImageToCanvas } from "@/components/editor/overlay-canvas/image-crop";
import type { OverlayAsset, OverlayShape } from "@/components/editor/overlay-canvas/types";
import type { OverlaySelectionSummary } from "@/components/editor/page-overlay-types";
import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import { AiAppliedChangeCard, AiProposalActions } from "@/components/ui/ai";
import { Button, IconButton } from "@/components/ui/Button";
import { Center, Grid, Stack } from "@/components/ui/layout";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Shimmer } from "@/components/ui/Shimmer";
import type { AiProposalApplyOutcome } from "@/features/ai-edit";
import  {
  AiAppliedDocumentDiffView,
  AiSourceReferenceChips,
  AiStreamRenderer,
  type AiSourceReferenceOpenDocumentParams,
} from "@/features/ai-edit/view";
import type  {
  BoxBlockChildBlock,
  InlineNode,
  LayoutSectionChildBlock,
  ListItemNode,
  ProblemAreaBlock,
  RichBlock,
  SigmaDocument,
} from "@/features/document";
import { formatAgentActivityLabel, summarizeRunningActivity } from "@/lib/ai/ai-agent-activity-label";
import { useAiConnection, useClaudeConnection, useGeminiConnection } from "@/lib/ai/ai-connection";
import  {
  buildSelectedShapesAttachmentName,
  parseSelectedShapesAttachmentCount,
  SELECTED_SHAPES_ATTACHMENT_PREFIX,
} from "@/lib/ai/ai-edit-attachment-names";
import  {
  capAiEditTurnReferences,
  createAiEditOverlaySelectionContext,
  createBlockAiEditReference,
  createCanvasRegionAiEditReference,
  getAiEditReferenceKey,
  getDefaultAiEditInsertionTargetId,
  getReferenceDisplayLabel,
  isImplicitAiEditReferenceSuppressed,
  MAX_AI_EDIT_REFERENCES,
  withAiEditOverlaySelection,
  type AiEditOverlaySelectionContext,
  type AiEditReference,
} from "@/lib/ai/ai-edit-reference";
import  {
  getAttachmentDefaultInstruction,
  imageToSigmaDocDefaultInstruction,
  type AiEditPlanStep,
} from "@/lib/ai/ai-edit-runtime";
import { buildShapesSvgPreview, type AiEditShapeOnlyPreview } from "@/lib/ai/ai-edit-shape-preview";
import  {
  cycleReasoningEffort,
  formatReasoningEffortLabel,
  getProviderReasoningEfforts,
  resolveAiModelOptions,
  resolveCatalogSelection,
} from "@/lib/ai/ai-model-catalog";
import { getAiModelPreferences, saveAiModelPreferences } from "@/lib/ai/ai-model-preferences";
import  {
  aiProviderLabel,
  claudeModelLabel,
  geminiModelLabel,
  toAiResourceProvider,
  type AiProvider,
} from "@/lib/ai/ai-providers";
import { resolveAiResourceDisplayMetadata } from "@/lib/ai/ai-resource-display";
import  {
  addChatRoom,
  aiChatRoomsStore,
  createAiRunAnchor,
  createEmptyChatRoom,
  enqueueFollowUp,
  fromDesktopChatRoom,
  hydrateChatRoomsFromDisk,
  isDefaultChatRoomTitle,
  isSameAiRunTarget,
  resolvePendingAssistantTurns,
  resolveQueuedRunAgentThreadId,
  selectChatRoom as selectChatRoomInStore,
  startRun,
  updateChatRoom,
  useAiActiveRoomId,
  useAiChatRoomsForDocument,
  type AiEditChatRoom,
  type AssistantTurn,
  type ChatTurn,
  type RunParams,
  type UserTurn,
} from "@/lib/ai/ai-run-controller";
import { aiRunSessionStore, isAiRunStatusActive, useAiRunSessions, type AiRunSession } from "@/lib/ai/ai-run-session-store";
import type { AiDisplayMode } from "@/lib/ai/ai-surface";
import { deriveAppliedDraftFallback, derivePendingDocumentDiff, type AiAppliedDocumentDiff } from "@/lib/ai/applied-document-diff";
import type { AiEditAttachment, AiEditMentionedDocumentContext } from "@/lib/ai/sigma-doc-agent-tools";
import { type AiEditModel, type AiEditReasoningEffort } from "@/lib/ai/sigma-doc-edit-schema";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { resolveDocumentTitle } from "@/lib/document-title";
import type { EditableBlock } from "@/lib/document-tree";
import { createTranslator, getAppLocale, type Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import type  {
  DesktopAiEditChatAttachmentSummary,
  DesktopAiModelCatalog,
  DesktopAiResourceManifestEntry,
  DesktopAiSourceReference,
  DesktopDocumentMetadata,
} from "@/types/desktop";

/**
 * **呼び出し時点**の表示言語で解決する `t`。
 *
 * 描画中ではなくイベントハンドラや添付づくりの中から出る文言用。フックで受けると
 * 依存配列に翻訳関数が載って回るうえ、意味的にも「その操作をした時点の言語」が正しい。
 * `EditorShell.tsx` の `tEditor` と同じ作り。
 */
function createNowTranslator<Ns extends "ai" | "editor">(namespace: Ns): Translate<Ns> {
  const cache: { locale: string | null; translate: Translate<Ns> | null } = { locale: null, translate: null };
  // `TFunction` はキーごとに補間の型を推論するオーバーロードの塊なので、可変長引数を
  // 素通しするだけのここは二段キャストで包む (呼び出し側の検査は効いたまま)。
  return ((key: string, options?: Record<string, unknown>) => {
    const locale = getAppLocale();
    if (cache.locale !== locale || !cache.translate) {
      cache.locale = locale;
      cache.translate = createTranslator(locale, namespace);
    }
    return (cache.translate as unknown as (k: string, o?: Record<string, unknown>) => string)(key, options);
  }) as unknown as Translate<Ns>;
}

const tAiNow = createNowTranslator("ai");
const tEditorNow = createNowTranslator("editor");

interface AiEditPanelProps {
  document: SigmaDocument;
  documentIdentityKey: string;
  /** Pins a tab-hosted panel to one conversation while other rooms stay visible elsewhere. */
  controlledRoomId?: string | null;
  /** 編集対象ドキュメントが属するワークスペースid(fileIdからの逆引き)。null/undefined
   * ならワークスペース不明(グローバルskillのみが候補になる)。ワークスペーススコープの
   * skill候補(/-slash)を、実行時のbuildRunContextと同じスコープに絞り込むために使う。 */
  documentWorkspaceId?: string | null;
  selectedId: string | null;
  selectedBlock: EditableBlock | null;
  reference: AiEditReference | null;
  /** ワンドボタン「AIに追加」でピン留めされた明示参照 (複数)。 */
  pinnedReferences?: AiEditReference[];
  /** 図形参照をpinした瞬間の、assetを含む表示用snapshot。reference keyごとに保持する。 */
  pinnedReferencePreviews?: ReadonlyMap<string, AiEditShapeOnlyPreview>;
  /** ピン留め参照のチップ × (getAiEditReferenceKey のキーで指定)。 */
  onRemovePinnedReference?: (referenceKey: string) => void;
  overlaySelection: OverlaySelectionSummary;
  variant?: AiDisplayMode;
  inlineSessionId?: number;
  inlineOpen?: boolean;
  inlineAnchor?: { left: number; top: number } | null;
  inlineRunAnchor?: { left: number; top: number } | null;
  inlineRunAnchorCanvas?: { left: number; top: number } | null;
  inlineRunPortalTarget?: HTMLElement | null;
  previewClearRequest?: {
    seq: number;
    outcome: "applied" | "dismissed";
    roomId?: string;
    targets?: AiEditPreviewResolutionTarget[];
    includeResolved?: boolean;
  };
  /** Pending proposal groups are mirrored here so the active room can expose
   * its decision controls without replacing or hiding the composer. */
  previewGroups?: AiEditPreviewState[];
  busy?: boolean;
  onApplyGroup?: (proposalIds: string[]) => Promise<AiProposalApplyOutcome>;
  onDismissGroup?: (proposalIds: string[]) => void;
  staleProposalGroups: StaleMcpProposalGroup[];
  /** Phase 1: Agentic RAG. Proposals' `sourceReferences` (all statuses), aggregated
   * and deduped by turnId. Used to show a "参照したドキュメント" row under each
   * assistant turn; persists after apply/dismiss while the proposal record remains. */
  sourceReferencesByTurnId?: Map<string, DesktopAiSourceReference[]>;
  /** Native overlay insertion drafts rendered as compact chat thumbnails. Derived
   * from proposals of every status, so they remain after apply/dismiss and restore. */
  insertedShapePreviewsByTurnId?: Map<string, AiEditShapeOnlyPreview>;
  /** Approved proposal records reduced to the post-apply change widget shown
   * under their assistant turn. The map is derived from proposal history, so
   * it remains accurate after chat-room persistence is restored. */
  appliedChangesByTurnId?: Map<string, AiAppliedTurnChange>;
  /** Reverts the full save batch represented by one applied-change widget.
   * The parent owns revision checks, disk IO, and proposal-store transitions. */
  onRevertAppliedChange?: (proposalIds: string[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onOpenSourceDocument?: (params: AiSourceReferenceOpenDocumentParams) => void;
  /** turnId → その最新の提案が却下(rejected)・差し戻し(reverted)済みで、承認可否に関わらず
   * ワンクリックで復元できる場合だけ設定される。pending/approvedのターンには存在しない
   * (不要な情報は表示せず、必要になった時だけ追加する)。「復元」ボタンの表示条件に使う。 */
  restorableProposalsByTurnId?: Map<string, { proposalIds: string[] }>;
  /** 復元→即承認の1クリック合成フロー (EditorShell.restoreProposalFromHistory)。
   * AiTaskDockの「もう一度提案する」と同じ関数を共有する。 */
  onRestoreProposal?: (proposalIds: string | string[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onDiscardStaleProposals: (proposalIds: string[]) => void;
  /** 作り直し (rebase): 現在のドキュメントに対して再適用を試みる。全件成功で
   * {ok:true} (グループはcurrentへ昇格し一覧から消える)、失敗時は理由を返す。 */
  onRebaseStaleProposals?: (proposalIds: string[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 競合stale提案の「AIの提案で上書き」: force:trueで承認する。渡されない場合はボタンを
   * 表示しない (API未対応のビルド向け)。 */
  onForceApplyStaleProposals?: (proposalIds: string[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onOpenAiSettings?: () => void;
  onCloseInline?: () => void;
  onPromoteToSidebar?: () => void;
  onInlineRunAnchorChange?: (anchor: { left: number; top: number } | null) => void;
  /** Bumped by the in-body run-anchor widget (R2) when the user clicks a
   * background room's widget: selects that room so its log becomes visible. */
  focusRoomRequest?: { roomId: string; seq: number } | null;
}

interface OverlayReferencePreview {
  referenceKey: string;
  preview: AiEditShapeOnlyPreview;
  shapeCount: number;
}

interface AiEditPreviewResolutionTarget {
  roomId?: string;
  turnId?: string;
}

export const MAX_AI_EDIT_ATTACHMENTS = 4;
export const MAX_AI_EDIT_MENTIONED_DOCUMENTS = 4;
// デフォルト引数が毎レンダーで新配列にならないようモジュールスコープで固定。
const EMPTY_PINNED_REFERENCES: AiEditReference[] = [];
const EMPTY_PINNED_REFERENCE_PREVIEWS: ReadonlyMap<string, AiEditShapeOnlyPreview> = new Map();
const EMPTY_OVERLAY_SHAPES: OverlayShape[] = [];
export const MAX_SIGMA_DOC_MENTION_CANDIDATES = 8;
const MAX_MENTIONED_DOCUMENT_EXCERPT = 1600;
const HISTORY_DIALOG_VIEWPORT_MARGIN = 12;
const HISTORY_DIALOG_ANCHOR_GAP = 8;
/**
 * クイック操作の id。ラベルは `ai.quickAction.label.<id>`、押したときに入力欄へ入る
 * 指示文は `ai.prompt.quickAction.<id>` が持つ。
 *
 * **指示文は「画面に出る文言」と「モデルへ渡る文」の境目**にある: 利用者が読んで
 * 編集してから送れるので UI として訳すが、実際にモデルへ届く。教材の言語と UI の
 * 言語の関係 (WI-8 の D2) が決まったら、`prompt` namespace へ移る可能性がある。
 * `variation` のようなツール引数の値は**訳さずそのまま**残すこと。
 */
export const AI_ACTION_PRESET_IDS = [
  "createProblem",
  "addAnswer",
  "table",
  "variationTable",
  "graph",
  "shape",
  "imageToMaterial",
] as const;

type AiActionPresetId = (typeof AI_ACTION_PRESET_IDS)[number];

function buildAiActionPresets(t: Translate<"ai">): Array<{ id: AiActionPresetId; label: string; prompt: string }> {
  return AI_ACTION_PRESET_IDS.map((id) => ({
    id,
    label: t(`quickAction.label.${id}` as never) as unknown as string,
    // 画像からの教材化だけは、他所と同じ既定指示を使う (辞書には持たない)。
    prompt: id === "imageToMaterial"
      ? imageToSigmaDocDefaultInstruction()
      : (t(`prompt.quickAction.${id as Exclude<AiActionPresetId, "imageToMaterial">}`) as unknown as string),
  }));
}
// R5: the chat-room/turn types and the run-lifecycle logic that mutates them
// (performRun, the follow-up queue, resolveQueuedRunAgentThreadId, ...) live
// in ai-run-controller.ts, at module scope, so a run keeps making progress
// (and lands its result in the right place) no matter what happens to
// whichever AiEditPanel instance started it — see that module's header
// comment for why a panel remount is otherwise unavoidable when promoting
// from the inline host to the docked sidebar. Re-exported here so existing
// imports of these (both within this file and from AiEditPanel.test.tsx)
// keep working unchanged.
export {
resolvePendingAssistantTurns,
resolveQueuedRunAgentThreadId,
type AiEditChatRoom,
type AssistantTurn,
type ChatTurn,
type UserTurn
};

export interface ActiveMentionQuery {
  start: number;
  end: number;
  query: string;
}

export interface ActiveSlashQuery {
  start: number;
  end: number;
  query: string;
}

/** 統一コンテキストピッカーの1候補。↑↓キー移動を「ドキュメント→スキル」でひと続きに
 * 扱えるよう、両セクションをこの共通形にフラット化して並べる。 */
export type ContextPickerItem =
  | { kind: "doc"; candidate: DesktopDocumentMetadata }
  | { kind: "skill"; candidate: DesktopAiResourceManifestEntry };

export function findActiveRoomPreview(
  previewGroups: AiEditPreviewState[],
  activeRoomId: string | null,
): AiEditPreviewState | null {
  return activeRoomId
    ? previewGroups.find((group) => group.roomId === activeRoomId) ?? null
    : null;
}

/**
 * AI会話の履歴、実行状態、参照、提案結果、送信コンポーザーを一つの表示面へ調停する。
 * 提案の適用処理そのものは親へ委ね、ここでは会話と判断UIの対応だけを担当する。
 */
export function AiEditPanel({
  document,
  documentIdentityKey,
  controlledRoomId,
  documentWorkspaceId = null,
  selectedId,
  reference,
  pinnedReferences = EMPTY_PINNED_REFERENCES,
  pinnedReferencePreviews = EMPTY_PINNED_REFERENCE_PREVIEWS,
  onRemovePinnedReference,
  overlaySelection,
  variant = "sidebar",
  inlineSessionId = 0,
  inlineOpen = false,
  inlineAnchor = null,
  inlineRunAnchor = null,
  inlineRunAnchorCanvas = null,
  inlineRunPortalTarget = null,
  previewClearRequest = { seq: 0, outcome: "dismissed" },
  previewGroups = [],
  busy = false,
  onApplyGroup,
  onDismissGroup,
  staleProposalGroups,
  sourceReferencesByTurnId,
  insertedShapePreviewsByTurnId,
  appliedChangesByTurnId,
  onRevertAppliedChange,
  restorableProposalsByTurnId,
  onRestoreProposal,
  onOpenSourceDocument,
  onDiscardStaleProposals,
  onRebaseStaleProposals,
  onForceApplyStaleProposals,
  onOpenAiSettings,
  onCloseInline,
  onPromoteToSidebar,
  onInlineRunAnchorChange,
  focusRoomRequest = null,
}: AiEditPanelProps) {
  const t = useT("ai");
  const tEditor = useT("editor");
  const tCommon = useT("common");
  const initialModelPreferences = useMemo(() => getAiModelPreferences(), []);
  const connection = useAiConnection();
  const claudeConnection = useClaudeConnection();
  const geminiConnection = useGeminiConnection();
  const [provider, setProvider] = useState<AiProvider>(initialModelPreferences.provider);
  const [model, setModel] = useState<AiEditModel>(initialModelPreferences.model);
  const [claudeModel, setClaudeModel] = useState<string>(initialModelPreferences.claudeModel);
  const [geminiModel, setGeminiModel] = useState<string>(initialModelPreferences.geminiModel);
  const [reasoningEffort, setReasoningEffort] = useState<AiEditReasoningEffort>(initialModelPreferences.reasoningEffort);
  const [instruction, setInstruction] = useState("");
  // R5: rooms and the active-room selection live in the module-level
  // controller store (ai-run-controller.ts), not component state, so an
  // in-flight run's transcript updates survive this panel being remounted
  // (promoting inline → sidebar moves it across a portal boundary, which
  // React treats as an unmount+mount).
  const chatRooms = useAiChatRoomsForDocument(documentIdentityKey);
  const storedActiveRoomId = useAiActiveRoomId(documentIdentityKey);
  const activeRoomId = controlledRoomId ?? storedActiveRoomId;
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<AiEditAttachment[]>([]);
  const [mentionedDocuments, setMentionedDocuments] = useState<AiEditMentionedDocumentContext[]>([]);
  const [mentionQuery, setMentionQuery] = useState<ActiveMentionQuery | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<DesktopDocumentMetadata[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [aiResources, setAiResources] = useState<DesktopAiResourceManifestEntry[]>([]);
  const [selectedAiResourceIds, setSelectedAiResourceIds] = useState<string[]>([]);
  const [slashQuery, setSlashQuery] = useState<ActiveSlashQuery | null>(null);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  // 統一コンテキストピッカー(+メニュー): ドキュメント/スキルを横断検索するローカル状態。
  // 選択済みは mentionedDocuments / selectedAiResourceIds にそのまま反映されるので、
  // このピッカー自身は「検索語」と「読み込んだ候補」だけを持てば足りる。
  const [contextPickerQuery, setContextPickerQuery] = useState("");
  // ピッカーを開いた瞬間に1回だけ取得する生の候補一覧。検索語での絞り込みは
  // contextPickerDocCandidates (useMemo) 側で行う — ここをキーストロークのたびに
  // 再取得すると desktop.storage.listFiles() のIPC往復が入力のたびに発生してしまう。
  const [contextPickerDocFiles, setContextPickerDocFiles] = useState<DesktopDocumentMetadata[]>([]);
  const [contextPickerDocLoading, setContextPickerDocLoading] = useState(false);
  const [contextPickerActiveIndex, setContextPickerActiveIndex] = useState(0);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelFlyout, setModelFlyout] = useState<"model" | "effort" | null>(null);
  const [runtimeModelCatalogs, setRuntimeModelCatalogs] = useState<Partial<Record<AiProvider, DesktopAiModelCatalog>>>({});
  const [modelCatalogLoadingProvider, setModelCatalogLoadingProvider] = useState<AiProvider | null>(null);
  const [modelCatalogErrors, setModelCatalogErrors] = useState<Partial<Record<AiProvider, string>>>({});
  const [dismissedReferenceKey, setDismissedReferenceKey] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  // The turn id present when the inline editor was (re)opened. The inline editor
  // shows a result only for a turn created after this baseline, so reopening starts
  // on a fresh input instead of an older turn's apply/dismiss card.
  const [inlineBaselineTurnId, setInlineBaselineTurnId] = useState<string | null>(null);
  const [inlineRunTurnId, setInlineRunTurnId] = useState<string | null>(null);
  const [threadTailSpacerHeight, setThreadTailSpacerHeight] = useState(0);
  const resolvedDocumentTitle = useMemo(() => resolveDocumentTitle(document), [document]);
  const documentTitleRef = useRef(resolvedDocumentTitle);
  const activeRoomIdRef = useRef<string | null>(null);
  const previousPreviewClearRequestRef = useRef(previewClearRequest);
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const contextPickerRef = useRef<HTMLDivElement | null>(null);
  const contextPickerSearchRef = useRef<HTMLInputElement | null>(null);
  const contextPickerToggleRef = useRef<HTMLButtonElement | null>(null);
  const modelMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const userTurnElementsRef = useRef(new Map<string, HTMLDivElement>());
  const pendingSubmittedUserTurnIdRef = useRef<string | null>(null);
  const lastRoomAutoScrolledRef = useRef<string | null>(null);
  const modelCatalogRequestSeqRef = useRef(0);
  const modelPreferencesRef = useRef({ model, claudeModel, geminiModel, reasoningEffort });
  modelPreferencesRef.current = { model, claudeModel, geminiModel, reasoningEffort };

  useEffect(() => {
    saveAiModelPreferences({ provider, model, claudeModel, geminiModel, reasoningEffort });
  }, [provider, model, claudeModel, geminiModel, reasoningEffort]);

  const refreshRuntimeModels = useCallback(async (targetProvider: AiProvider) => {
    const desktop = getDesktopBridge();
    const section = targetProvider === "claude"
      ? desktop?.claude
      : targetProvider === "antigravity"
        ? desktop?.gemini
        : desktop?.codex;
    if (!section?.listModels) {
      setModelCatalogErrors((current) => ({ ...current, [targetProvider]: t("composer.modelCatalogUnavailable") }));
      return;
    }

    const requestSeq = modelCatalogRequestSeqRef.current + 1;
    modelCatalogRequestSeqRef.current = requestSeq;
    setModelCatalogLoadingProvider(targetProvider);
    setModelCatalogErrors((current) => ({ ...current, [targetProvider]: undefined }));
    try {
      const catalog = await section.listModels();
      if (modelCatalogRequestSeqRef.current !== requestSeq) return;
      const options = resolveAiModelOptions(targetProvider, catalog);
      setRuntimeModelCatalogs((current) => ({ ...current, [targetProvider]: catalog }));

      const currentPreferences = modelPreferencesRef.current;
      if (targetProvider === "chatgpt") {
        const selection = resolveCatalogSelection({
          models: options,
          model: currentPreferences.model,
          reasoningEffort: currentPreferences.reasoningEffort,
        });
        setModel(selection.model as AiEditModel);
        setReasoningEffort(selection.reasoningEffort);
      } else if (targetProvider === "claude") {
        const selection = resolveCatalogSelection({
          models: options,
          model: currentPreferences.claudeModel,
          reasoningEffort: currentPreferences.reasoningEffort,
        });
        setClaudeModel(selection.model);
        setReasoningEffort(selection.reasoningEffort);
      } else {
        const nextModel = options.some((option) => option.id === currentPreferences.geminiModel)
          ? currentPreferences.geminiModel
          : options.find((option) => option.isDefault)?.id ?? options[0]?.id;
        if (nextModel) setGeminiModel(nextModel);
      }
    } catch (error) {
      if (modelCatalogRequestSeqRef.current !== requestSeq) return;
      setModelCatalogErrors((current) => ({
        ...current,
        [targetProvider]: error instanceof Error ? error.message : t("composer.modelCatalogFailed"),
      }));
    } finally {
      if (modelCatalogRequestSeqRef.current === requestSeq) {
        setModelCatalogLoadingProvider(null);
      }
    }
  }, [t]);

  useEffect(() => {
    documentTitleRef.current = resolvedDocumentTitle;
  }, [resolvedDocumentTitle]);

  useEffect(() => {
    activeRoomIdRef.current = activeRoomId;
  }, [activeRoomId]);

  const focusedRoomRequestSeqRef = useRef(0);
  useEffect(() => {
    if (!focusRoomRequest || focusRoomRequest.seq === focusedRoomRequestSeqRef.current) {
      return;
    }
    focusedRoomRequestSeqRef.current = focusRoomRequest.seq;
    // Selecting through the store marks the selection as explicit, so the
    // async room-list load resolving after this (panel remount races the
    // focus request against `listChatRooms`) can no longer clobber it with
    // its "default to the newest room" behavior.
    selectChatRoomInStore(documentIdentityKey, focusRoomRequest.roomId);
  }, [documentIdentityKey, focusRoomRequest]);

  useEffect(() => {
    void refreshRuntimeModels(provider);
  }, [provider, refreshRuntimeModels]);

  const clearInlineRunAnchor = useCallback(() => {
    setInlineRunTurnId(null);
    onInlineRunAnchorChange?.(null);
  }, [onInlineRunAnchorChange]);

  const resetComposerState = useCallback((options: { focusComposer?: boolean } = {}) => {
    pendingSubmittedUserTurnIdRef.current = null;
    setComposerError(null);
    setInstruction("");
    setAttachments([]);
    setMentionedDocuments([]);
    setMentionQuery(null);
    setMentionCandidates([]);
    setMentionLoading(false);
    setMentionActiveIndex(0);
    setSelectedAiResourceIds([]);
    setSlashQuery(null);
    setSlashActiveIndex(0);
    setContextMenuOpen(false);
    setContextPickerQuery("");
    setContextPickerDocFiles([]);
    setContextPickerDocLoading(false);
    setContextPickerActiveIndex(0);
    setModelMenuOpen(false);
    setModelFlyout(null);
    setDismissedReferenceKey(null);
    setThreadTailSpacerHeight(0);
    if (mediaInputRef.current) {
      mediaInputRef.current.value = "";
    }
    if (options.focusComposer) {
      window.setTimeout(() => composerRef.current?.focus(), 0);
    }
  }, []);

  useEffect(() => {
    const desktop = getDesktopBridge();
    let cancelled = false;
    const load = () => {
      if (!desktop?.aiResources) {
        return;
      }
      desktop.aiResources.getTree()
        .then((tree) => {
          if (!cancelled) {
            // 候補はグローバルskill(workspaceId未設定)と、編集対象ドキュメントが属する
            // ワークスペース専用skillだけ。ここを実行時(buildRunContext)のスコープ判定と
            // 一致させておかないと、選べるのに実行時には無視されるskillが生まれる。
            const enabledResources = tree.resources.filter((resource) =>
              resource.enabled &&
              resource.kind === "skill" &&
              (resource.workspaceId == null || resource.workspaceId === documentWorkspaceId));
            setAiResources(enabledResources);
            const enabledIds = new Set(enabledResources.map((resource) => resource.id));
            setSelectedAiResourceIds((current) => current.filter((id) => enabledIds.has(id)));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setAiResources([]);
          }
        });
    };
    load();
    const handleResourcesChanged = () => {
      load();
    };
    window.addEventListener("sigma-ai-resources-changed", handleResourcesChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("sigma-ai-resources-changed", handleResourcesChanged);
    };
  }, [documentWorkspaceId]);

  useEffect(() => {
    // Seed the controller's rooms store from disk. Rooms already known to the
    // store in this session (e.g. one being mutated by an in-flight run when
    // this panel remounted) are authoritative and left untouched — the disk
    // read only fills in rooms this session has not seen yet, and only picks
    // the default active room when nothing has been explicitly selected.
    let cancelled = false;
    const ensureFallbackRoom = () => {
      if (aiChatRoomsStore.getRoomsForDocument(documentIdentityKey).length === 0) {
        // Like the room a run would create, this fallback is only persisted
        // once it actually receives a turn.
        addChatRoom(createEmptyChatRoom(documentIdentityKey, documentTitleRef.current, tAiNow), { makeActive: true, persist: false });
      }
    };
    const timeoutId = window.setTimeout(() => {
      if (cancelled) {
        return;
      }
      resetComposerState();
      setHistoryLoading(true);
      setHistoryError(null);

      const desktop = getDesktopBridge();
      if (!desktop?.aiEdit?.listChatRooms) {
        ensureFallbackRoom();
        setHistoryLoading(false);
        return;
      }

      desktop.aiEdit.listChatRooms(documentIdentityKey)
        .then((rooms) => {
          if (cancelled) return;
          hydrateChatRoomsFromDisk(documentIdentityKey, rooms.map((room) => fromDesktopChatRoom(room)));
          ensureFallbackRoom();
          setHistoryError(null);
        })
        .catch((error) => {
          if (cancelled) return;
          ensureFallbackRoom();
          setHistoryError(error instanceof Error ? error.message : t("chat.historyLoadFailed"));
        })
        .finally(() => {
          if (!cancelled) {
            setHistoryLoading(false);
          }
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [documentIdentityKey, resetComposerState, t]);

  // R5: run status is derived from the single-source-of-truth run-session
  // store, keyed per room, instead of a component-local flag. This is what
  // lets multiple rooms run concurrently (R1) without any of them ever
  // rendering a stale "stopped" state after a room switch.
  const runSessions = useAiRunSessions();
  const activeRoomRunSession = activeRoomId ? runSessions.get(activeRoomId) ?? null : null;
  const isRunning = isAiRunStatusActive(activeRoomRunSession?.status);

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setClockNow(Date.now());
    }, 500);
    return () => window.clearInterval(intervalId);
  }, [isRunning]);

  const overlaySelectionContext = useMemo(() => createAiEditOverlaySelectionContext({
    region: overlaySelection.region,
    selectedShapeIds: overlaySelection.selectedShapeIds,
    shapes: overlaySelection.selectedShapes,
    assets: overlaySelection.selectedAssets,
  }), [overlaySelection.region, overlaySelection.selectedAssets, overlaySelection.selectedShapeIds, overlaySelection.selectedShapes]);
  const overlaySelectionTargetBlockId = useMemo(
    () => getOverlaySelectionTargetBlockId(overlaySelectionContext),
    [overlaySelectionContext],
  );
  const aiTargetId =
    (overlaySelectionContext?.region || pinnedReferences.some((item) => item.overlaySelection?.region) ? "CANVAS" : null) ??
    overlaySelectionTargetBlockId ??
    selectedId ??
    (overlaySelectionContext
      ? getDefaultAiEditInsertionTargetId(document) ?? overlaySelectionContext.selectedShapeIds[0] ?? null
      : null);

  // 暗黙参照 (implicit): 本文で選択しているだけのブロック/選択参照。overlaySelection の
  // 合成はこちらにのみ適用する (ピン留め参照はスナップショットのまま)。
  const effectiveReference = useMemo(() => {
    if (overlaySelectionContext?.region) return createCanvasRegionAiEditReference(overlaySelectionContext.region);
    const baseReference = reference && reference.targetId === aiTargetId
      ? reference
      : createBlockAiEditReference(document, aiTargetId);

    return withAiEditOverlaySelection(baseReference, overlaySelectionContext);
  }, [aiTargetId, document, overlaySelectionContext, reference]);

  // 暗黙参照チップの表示規則 (詳細は isImplicitAiEditReferenceSuppressed のコメント参照)。
  const implicitSuppressed = useMemo(
    () => isImplicitAiEditReferenceSuppressed(effectiveReference, pinnedReferences),
    [effectiveReference, pinnedReferences],
  );

  const referenceKey = useMemo(
    () => effectiveReference ? getAiEditReferenceKey(effectiveReference) : null,
    [effectiveReference],
  );
  const referenceDismissed = dismissedReferenceKey !== null && dismissedReferenceKey === referenceKey;
  // pinが上限に達した状態で暗黙参照だけ表示すると、sliceでpayloadから落ちるのにUIには
  // 見える不一致になる。送信枠がない暗黙参照は表示・preview・添付の全てから外す。
  const showReferenceChip = !!effectiveReference
    && !implicitSuppressed
    && !referenceDismissed
    && pinnedReferences.length < MAX_AI_EDIT_REFERENCES;
  const activeReference = showReferenceChip ? effectiveReference : null;
  // このturnでAIに渡す参照 (pinned 全件 + 表示中の暗黙参照)。pinned を優先し、
  // MAX_AI_EDIT_REFERENCES件を超える分 (暗黙参照側) はここで切り詰める — pinned だけで
  // 上限に達している場合は暗黙参照が入らないことになるが、その組み合わせ自体は
  // requestAiEditWithReference側の上限チェックで既に起こらない設計になっている。
  const turnReferences = useMemo<AiEditReference[]>(
    () => capAiEditTurnReferences([...pinnedReferences, ...(activeReference ? [activeReference] : [])]),
    [activeReference, pinnedReferences],
  );
  const selectedOverlayShapeCount = activeReference?.overlaySelection?.shapes.length ?? 0;
  const selectedOverlayImageCount =
    activeReference?.overlaySelection?.shapes.filter((shape) => shape.type === "image").length ?? 0;
  const selectedOverlayNonImageShapeCount = Math.max(0, selectedOverlayShapeCount - selectedOverlayImageCount);
  const activeReferenceKey = activeReference ? getAiEditReferenceKey(activeReference) : null;
  const overlayComposerPreviews = useMemo<OverlayReferencePreview[]>(
    () => turnReferences.flatMap((turnReference) => {
      const selection = turnReference.overlaySelection;
      if (!selection) {
        return [];
      }
      const turnReferenceKey = getAiEditReferenceKey(turnReference);
      const preview = pinnedReferencePreviews.get(turnReferenceKey)
        ?? (turnReferenceKey === activeReferenceKey
          ? buildSelectedOverlayShapePreview(overlaySelection)
          : buildStoredOverlaySelectionPreview(selection));
      return preview
        ? [{
          referenceKey: turnReferenceKey,
          preview,
          shapeCount: selection.shapes.length,
        }]
        : [];
    }),
    [activeReferenceKey, overlaySelection, pinnedReferencePreviews, turnReferences],
  );
  const hasAttachableSelectedImages = useMemo(
    () => Boolean(activeReference?.overlaySelection) && hasSelectedOverlayImageAttachments(overlaySelection),
    [activeReference?.overlaySelection, overlaySelection],
  );
  const activeRoom = useMemo(
    () => chatRooms.find((room) => room.id === activeRoomId) ?? null,
    [activeRoomId, chatRooms],
  );
  const activeRoomPreview = useMemo(
    () => findActiveRoomPreview(previewGroups, activeRoomId),
    [activeRoomId, previewGroups],
  );
  const scopedAgentThreadId = activeRoom?.agentThreadId ?? null;
  // A room is bound to the provider of its first run (see ai-run-controller):
  // follow-ups must stay on that provider so a thread never switches models
  // mid-conversation. Only the model/reasoning-effort within it stay adjustable.
  const lockedProvider = activeRoom?.provider ?? null;
  // Keep the composer's provider in step with the active room's locked provider.
  // Adjusting state during render (React's documented pattern for "reset/adjust
  // state when a value changes") rather than in an effect: the guard makes it
  // idempotent, and it avoids a wasted commit + the set-state-in-effect rule.
  if (lockedProvider && lockedProvider !== provider) {
    setProvider(lockedProvider);
  }
  const visibleTurns = useMemo(() => activeRoom?.turns ?? [], [activeRoom]);
  const currentOverlaySnapshot = document.pageLayout?.overlay?.overlaySnapshot;
  // `currentOverlaySnapshot?.shapes ?? []` would mint a brand-new empty array every render
  // whenever there's no overlay snapshot yet; memoizing keeps its identity stable across the
  // composer-keystroke re-renders that don't touch the overlay, which pendingDiffCache below
  // depends on to avoid recomputing every pending proposal's diff on every keystroke.
  const currentOverlayShapes = useMemo(
    () => currentOverlaySnapshot?.shapes ?? EMPTY_OVERLAY_SHAPES,
    [currentOverlaySnapshot],
  );
  // 承認前のpending差分(derivePendingDocumentDiff)はブロックツリーを辿るLCS/Intl.Segmenter計算を
  // 伴うため、コンポーザーへの1打鍵ごとに再計算されては困る。(document, currentOverlayShapes)が
  // 変わらない間は proposal オブジェクト自体をキーにキャッシュする — レンダー中にWeakMapへ
  // 書き込むのは同じ入力に対して同じ結果を書くだけなので冪等で安全。ファクトリ自体は
  // document/currentOverlayShapesを読まない(新しい空WeakMapを作るだけ)が、それらが変わった
  // 「タイミングで」古いキャッシュを丸ごと捨てたいので、意図的に依存配列へ入れている。
  const pendingDiffCache = useMemo(
    () => new WeakMap<AiEditPreviewState, AiAppliedDocumentDiff>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [document, currentOverlayShapes],
  );
  const getPendingProposalDiff = (candidate: AiEditPreviewState): AiAppliedDocumentDiff => {
    const cached = pendingDiffCache.get(candidate);
    if (cached) {
      return cached;
    }
    // updateOverlayShape/alignOverlayShapes/図形置換の追加側には、適用後の実際の姿を見せたい
    // (でないと削除側と全く同じプレビューが2つ並ぶだけで「何が変わったか分からない」に逆戻りする)。
    // deriveAiEditPreviewOverlayShapesはmutation解決/置換配置の保持まで含むその後状態を
    // 計算済みなので、ここではid引きのMapへ変換して渡すだけでよい。
    const postStateShapesById = new Map(
      deriveAiEditPreviewOverlayShapes(candidate, currentOverlayShapes).map((shape) => [shape.id, shape]),
    );
    const diff = derivePendingDocumentDiff(
      [candidate.draft],
      document,
      currentOverlayShapes,
      postStateShapesById,
      candidate.shapeReplacements,
    );
    pendingDiffCache.set(candidate, diff);
    return diff;
  };

  const latestAssistant = useMemo<AssistantTurn | null>(() => {
    for (let i = visibleTurns.length - 1; i >= 0; i -= 1) {
      const turn = visibleTurns[i];
      if (turn.role === "assistant") {
        return turn;
      }
    }
    return null;
  }, [visibleTurns]);

  const latestAssistantId = latestAssistant?.id ?? null;
  // Re-baseline when the inline editor is (re)opened, using React's "adjust state
  // during render from a previous value" pattern (avoids a set-state-in-effect).
  const [inlineBaselineSession, setInlineBaselineSession] = useState(inlineSessionId);
  if (inlineSessionId !== inlineBaselineSession) {
    setInlineBaselineSession(inlineSessionId);
    setInlineBaselineTurnId(latestAssistantId);
  }

  const lastInlineChatSessionRef = useRef(0);
  useEffect(() => {
    if (variant !== "inline" || inlineSessionId === 0 || inlineSessionId === lastInlineChatSessionRef.current) {
      return;
    }
    lastInlineChatSessionRef.current = inlineSessionId;
    // R1: every inline (⌘K-style) invocation gets a brand-new room and can run
    // concurrently with any other room's in-flight run — no longer gated on
    // whether the currently active room happens to be running.
    const nextRoom = createEmptyChatRoom(documentIdentityKey, documentTitleRef.current, tAiNow);
    addChatRoom(nextRoom, { makeActive: true });
    activeRoomIdRef.current = nextRoom.id;
    resetComposerState({ focusComposer: true });
  }, [documentIdentityKey, inlineSessionId, resetComposerState, variant]);

  useEffect(() => {
    // Focus the inline composer when it is shown: on (re)open and after a run that
    // was in flight at reopen finishes and the input returns. No-op when a result
    // card or the running badge is shown (composer unmounted, ref is null).
    if (inlineSessionId === 0 || variant !== "inline" || !inlineOpen) {
      return;
    }
    if (isRunning || latestAssistant?.isRunning) {
      return;
    }
    const handle = window.setTimeout(() => composerRef.current?.focus(), 0);
    return () => window.clearTimeout(handle);
  }, [inlineSessionId, variant, inlineOpen, isRunning, latestAssistant?.isRunning]);

  useEffect(() => {
    if (!mentionQuery) {
      return;
    }

    const desktop = getDesktopBridge();
    if (!desktop?.storage) {
      return;
    }

    let cancelled = false;
    desktop.storage.listFiles()
      .then((files) => {
        if (cancelled) return;
        setMentionCandidates(filterSigmaDocMentionCandidates({
          files,
          query: mentionQuery.query,
          currentFileId: documentIdentityKey,
          mentionedFileIds: mentionedDocuments.map((item) => item.fileId),
        }));
        setMentionActiveIndex(0);
        setComposerError((current) => current === t("composer.mentionCandidatesFailed") ? null : current);
      })
      .catch(() => {
        if (cancelled) return;
        setMentionCandidates([]);
        setMentionActiveIndex(0);
        setComposerError(t("composer.mentionCandidatesFailed"));
      })
      .finally(() => {
        if (!cancelled) {
          setMentionLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [documentIdentityKey, mentionQuery, mentionedDocuments, t]);

  // 統一コンテキストピッカー: 開いた瞬間に1回だけドキュメント候補一覧を読み込む。検索語
  // (contextPickerQuery) はここのdepsに入れない — 入力のたびにIPC (listFiles) を叩き直さない
  // ため。絞り込みは読み込んだ一覧に対する useMemo (contextPickerDocCandidates) で行う。
  // @メンションと違い、既に選択済みのドキュメントも一覧に残す(トグルで外せるように)。
  useEffect(() => {
    if (!contextMenuOpen) {
      return;
    }

    const desktop = getDesktopBridge();
    if (!desktop?.storage) {
      return;
    }

    let cancelled = false;
    setContextPickerDocLoading(true);
    desktop.storage.listFiles()
      .then((files) => {
        if (cancelled) return;
        setContextPickerDocFiles(files);
      })
      .catch(() => {
        if (cancelled) return;
        setContextPickerDocFiles([]);
      })
      .finally(() => {
        if (!cancelled) {
          setContextPickerDocLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [contextMenuOpen, documentIdentityKey]);

  // ピッカーを開いた瞬間: 検索語をリセットして検索欄にフォーカス。
  useEffect(() => {
    if (!contextMenuOpen) {
      return;
    }
    setContextPickerQuery("");
    setContextPickerActiveIndex(0);
    const frame = window.requestAnimationFrame(() => contextPickerSearchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [contextMenuOpen]);

  // 外側クリックで閉じる (Escはピッカー内の検索欄キーハンドラで処理)。
  useEffect(() => {
    if (!contextMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (contextPickerRef.current?.contains(target) || contextPickerToggleRef.current?.contains(target)) {
        return;
      }
      setContextMenuOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [contextMenuOpen]);

  const setUserTurnElement = useCallback((turnId: string, element: HTMLDivElement | null) => {
    if (element) {
      userTurnElementsRef.current.set(turnId, element);
      return;
    }
    userTurnElementsRef.current.delete(turnId);
  }, []);

  const scrollSubmittedUserTurnToTop = useCallback((turnId: string) => {
    const thread = threadRef.current;
    const turnElement = userTurnElementsRef.current.get(turnId);
    if (!thread || !turnElement) {
      return false;
    }

    const threadRect = thread.getBoundingClientRect();
    const turnRect = turnElement.getBoundingClientRect();
    const threadStyle = window.getComputedStyle(thread);
    const topInset = Number.parseFloat(threadStyle.paddingTop) || 0;
    const targetScrollTop = Math.max(0, thread.scrollTop + turnRect.top - threadRect.top - topInset);
    thread.scrollTo({ top: targetScrollTop, behavior: "smooth" });
    return true;
  }, []);

  useEffect(() => {
    const pendingTurnId = pendingSubmittedUserTurnIdRef.current;
    if (pendingTurnId) {
      // 送信でroomが新規作成された場合、この時点ではまだ下の「room切替時の最下部スクロール」を
      // 消費していない。ピン留め成功後にturnsが更新されるとそちらが後から発火し、末尾スペーサー
      // (空白) の最下部までジャンプして応答と差分が画面外に消えてしまうため、ピン留めした
      // roomは消費済みとして扱う。
      if (activeRoomId) {
        lastRoomAutoScrolledRef.current = activeRoomId;
      }
      const frameId = window.requestAnimationFrame(() => {
        if (scrollSubmittedUserTurnToTop(pendingTurnId)) {
          pendingSubmittedUserTurnIdRef.current = null;
        }
      });
      return () => window.cancelAnimationFrame(frameId);
    }

    const thread = threadRef.current;
    if (!thread || !activeRoomId || lastRoomAutoScrolledRef.current === activeRoomId) {
      return;
    }
    lastRoomAutoScrolledRef.current = activeRoomId;
    const frameId = window.requestAnimationFrame(() => {
      thread.scrollTop = thread.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [activeRoomId, scrollSubmittedUserTurnToTop, threadTailSpacerHeight, visibleTurns]);

  useEffect(() => {
    if (previousPreviewClearRequestRef.current.seq === previewClearRequest.seq) {
      return;
    }

    previousPreviewClearRequestRef.current = previewClearRequest;
    // 提案groupのroom/turn帰属に従い、解決したturnだけを確定する。targetsなしは
    // inline閉じる等のlegacy経路なのでactive roomの未解決turn全件へfallbackする。
    const requestedTargets = previewClearRequest.targets?.length
      ? previewClearRequest.targets
      : [{ roomId: previewClearRequest.roomId ?? activeRoomIdRef.current ?? undefined }];
    const targetsByRoom = new Map<string, Set<string> | null>();
    for (const target of requestedTargets) {
      const roomId = target.roomId ?? activeRoomIdRef.current;
      if (!roomId) {
        continue;
      }
      const current = targetsByRoom.get(roomId);
      if (!target.turnId) {
        targetsByRoom.set(roomId, null);
      } else if (current !== null) {
        const turnIds = current ?? new Set<string>();
        turnIds.add(target.turnId);
        targetsByRoom.set(roomId, turnIds);
      }
    }
    for (const [roomId, turnIds] of targetsByRoom) {
      updateChatRoom(roomId, (room) => ({
        ...room,
        turns: resolvePendingAssistantTurns(
          room.turns,
          previewClearRequest.outcome,
          turnIds ?? undefined,
          { includeResolved: previewClearRequest.includeResolved },
        ),
        updatedAt: new Date().toISOString(),
      }));
    }
  }, [previewClearRequest]);

  // Snapshots the live composer state into a self-contained request. Both an
  // immediate run and a later queued-follow-up dispatch (R3) go through this
  // same snapshot shape so a follow-up replays exactly what the user composed,
  // even if the live composer state has since moved on to something else.
  const buildRunParams = useCallback(async (): Promise<RunParams> => {
    const turnAttachments = await createAttachmentsWithSelectedOverlayPreview({
      attachments,
      overlayPreviews: overlayComposerPreviews,
      overlaySelection,
      activeReferenceKey,
    });
    // A room bound to a provider always runs on it, even if the composer's
    // `provider` state hasn't caught up to a just-selected room yet.
    const runProvider = lockedProvider ?? provider;
    const turnAiResourceProvider = toAiResourceProvider(runProvider);
    const turnAiResourceIds = selectedAiResourceIds.filter((id) => {
      const resource = aiResources.find((item) => item.id === id);
      return resource?.providers.includes(turnAiResourceProvider);
    });
    return {
      runDocumentIdentityKey: documentIdentityKey,
      runAgentThreadId: scopedAgentThreadId,
      runDocument: document,
      turnReferences,
      turnAttachments,
      turnMentionedDocuments: mentionedDocuments,
      turnProvider: runProvider,
      turnAiResourceIds,
      turnInstruction: instruction.trim() || getAttachmentDefaultInstruction(turnAttachments),
      turnModel: runProvider === "claude" ? claudeModel : runProvider === "antigravity" ? geminiModel : model,
      turnReasoningEffort: reasoningEffort,
      aiTargetId,
      anchor: createAiRunAnchor({
        primaryBlockId: aiTargetId === "CANVAS" ? null : aiTargetId,
        documentId: documentIdentityKey,
        document,
        references: turnReferences,
        shapeIds: overlaySelectionContext?.selectedShapeIds,
        canvas: variant === "inline" && inlineAnchor ? { left: inlineAnchor.left, top: inlineAnchor.top } : undefined,
        preferredTarget: (overlaySelectionContext || turnReferences.some((item) => item.overlaySelection?.region)) && variant === "inline" && inlineAnchor ? "canvas" : "block",
      }),
    };
  }, [
    activeReferenceKey, aiResources, aiTargetId, attachments, claudeModel, document, documentIdentityKey, geminiModel,
    inlineAnchor, instruction, lockedProvider, mentionedDocuments, model, overlayComposerPreviews, overlaySelection, overlaySelectionContext, provider, reasoningEffort,
    scopedAgentThreadId, selectedAiResourceIds, turnReferences, variant,
  ]);

  const clearComposerAfterSubmit = useCallback(() => {
    setComposerError(null);
    setInstruction("");
    setAttachments([]);
    setMentionedDocuments([]);
    setMentionQuery(null);
    setMentionCandidates([]);
    setMentionLoading(false);
    setMentionActiveIndex(0);
    setSelectedAiResourceIds([]);
    setSlashQuery(null);
    setSlashActiveIndex(0);
    setContextMenuOpen(false);
    setContextPickerQuery("");
    setContextPickerDocFiles([]);
    setContextPickerDocLoading(false);
    setContextPickerActiveIndex(0);
    if (mediaInputRef.current) {
      mediaInputRef.current.value = "";
    }
  }, []);

  const runEdit = async () => {
    const runRoom = activeRoom;
    if (historyLoading || !runRoom) {
      return;
    }

    const trimmedInstruction = instruction.trim();
    if (!trimmedInstruction && attachments.length === 0 && !hasAttachableSelectedImages) {
      setComposerError(t("composer.instructionRequired"));
      return;
    }

    const runRoomId = runRoom.id;
    const params = await buildRunParams();
    saveAiModelPreferences({
      provider: params.turnProvider,
      model: params.turnProvider === "chatgpt" ? params.turnModel as AiEditModel : model,
      claudeModel: params.turnProvider === "claude" ? params.turnModel : claudeModel,
      geminiModel: params.turnProvider === "antigravity" ? params.turnModel : geminiModel,
      reasoningEffort: params.turnReasoningEffort,
    });

    if (aiRunSessionStore.isRunning(runRoomId)) {
      const liveAnchor = aiRunSessionStore.getSession(runRoomId)?.anchor ?? null;
      if (!isSameAiRunTarget(liveAnchor, params.anchor)) {
        // 別箇所 (走行中runと異なるブロック/図形) への依頼は、走行中runの完了を待たずに
        // 新しい部屋で即座に並列開始する — 同一箇所は従来どおり下のキュー (R3) 行き。
        // 新しい部屋は新しい会話なので、走行中の部屋の agentThreadId は引き継がない。
        const nextRoom = createEmptyChatRoom(documentIdentityKey, documentTitleRef.current, tAiNow);
        addChatRoom(nextRoom, { makeActive: true });
        activeRoomIdRef.current = nextRoom.id;
        clearComposerAfterSubmit();
        const { userTurnId } = startRun(nextRoom.id, { ...params, runAgentThreadId: null });
        pendingSubmittedUserTurnIdRef.current = userTurnId;
        setThreadTailSpacerHeight(threadRef.current?.clientHeight ?? 0);
        setClockNow(Date.now());
        if (variant === "inline" && overlaySelectionContext) {
          onCloseInline?.();
        }
        return;
      }
      // R3: the room already has an active run — queue this message instead of
      // starting a second concurrent run in the same room. It renders
      // immediately as a "送信待ち" (queued) turn and is dispatched
      // automatically by the controller (merged with any other queued
      // messages) once the in-flight run completes.
      const queuedTurnId = enqueueFollowUp(runRoomId, params);
      if (runRoomId === activeRoomIdRef.current) {
        pendingSubmittedUserTurnIdRef.current = queuedTurnId;
        setThreadTailSpacerHeight(threadRef.current?.clientHeight ?? 0);
      }
      clearComposerAfterSubmit();
      if (variant === "inline" && overlaySelectionContext) {
        onCloseInline?.();
      }
      return;
    }

    clearComposerAfterSubmit();
    // The run's execution and all of its transcript/session effects live in
    // the controller (module scope), so it survives this panel being
    // remounted (e.g. promoting inline → sidebar mid-run). Only the
    // per-surface presentation side effects stay here.
    const { userTurnId, assistantTurnId } = startRun(runRoomId, params);
    if (runRoomId === activeRoomIdRef.current) {
      pendingSubmittedUserTurnIdRef.current = userTurnId;
      setThreadTailSpacerHeight(threadRef.current?.clientHeight ?? 0);
      setClockNow(Date.now());
    }
    if (variant === "inline" && runRoomId === activeRoomIdRef.current && inlineAnchor) {
      setInlineRunTurnId(assistantTurnId);
      onInlineRunAnchorChange?.(inlineAnchor);
    }
    if (variant === "inline" && overlaySelectionContext) {
      onCloseInline?.();
    }
  };

  const dismissTurn = useCallback((turnId: string) => {
    const roomId = activeRoom?.id ?? null;
    if (!roomId) {
      return;
    }
    updateChatRoom(roomId, (room) => ({
      ...room,
      turns: room.turns.map((item) =>
        item.id === turnId && item.role === "assistant" ? { ...item, dismissed: true } : item,
      ),
      updatedAt: new Date().toISOString(),
    }));
    if (turnId === inlineRunTurnId) {
      clearInlineRunAnchor();
    }
  }, [
    activeRoom?.id,
    clearInlineRunAnchor,
    inlineRunTurnId,
  ]);

  const wasInlineOpenRef = useRef(inlineOpen);
  useEffect(() => {
    // Closing the inline composer must not cancel an in-flight run. The detached
    // run badge keeps showing at the original anchor until the turn finishes.
    wasInlineOpenRef.current = inlineOpen;
  }, [inlineOpen]);

  const retryTurn = useCallback((assistantTurnId: string) => {
    const roomId = activeRoom?.id ?? null;
    const turns = activeRoom?.turns ?? [];
    const assistantIndex = turns.findIndex((item) => item.id === assistantTurnId);
    if (assistantIndex < 0) {
      return;
    }
    let userTurn: UserTurn | null = null;
    for (let index = assistantIndex - 1; index >= 0; index -= 1) {
      const candidate = turns[index];
      if (candidate.role === "user") {
        userTurn = candidate;
        break;
      }
    }
    if (!userTurn) {
      return;
    }
    setInstruction(userTurn.instruction);
    setComposerError(null);
    // Dismiss the original result so its still-live "適用" can't apply the stale
    // draft after the user edits the restored instruction.
    if (roomId) {
      updateChatRoom(roomId, (room) => ({
        ...room,
        turns: room.turns.map((item) =>
          item.id === assistantTurnId && item.role === "assistant" ? { ...item, dismissed: true } : item,
        ),
        updatedAt: new Date().toISOString(),
      }));
    }
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [activeRoom?.id, activeRoom?.turns]);

  // R3: affordance for a queued message whose run never got a chance to start
  // because the run it was waiting behind failed. Restores its text to the
  // composer (clearing the "未送信" flag) so the user can review/resend it.
  const resendQueuedTurn = useCallback((turn: UserTurn) => {
    const roomId = activeRoom?.id;
    if (roomId) {
      updateChatRoom(roomId, (room) => ({
        ...room,
        turns: room.turns.map((item) =>
          item.id === turn.id && item.role === "user" ? { ...item, queueFailed: false } : item,
        ),
        updatedAt: new Date().toISOString(),
      }));
    }
    setInstruction(turn.instruction);
    setComposerError(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [activeRoom?.id]);

  const addFileAttachments = async (
    files: File[],
    options: { source: "file" | "paste"; fillDefaultInstruction: boolean },
  ) => {
    if (files.length === 0) {
      return;
    }

    const remainingSlots = MAX_AI_EDIT_ATTACHMENTS - attachments.length;
    if (remainingSlots <= 0) {
      setComposerError(t("composer.attachmentLimit", { replace: { max: MAX_AI_EDIT_ATTACHMENTS } }));
      return;
    }

    try {
      const nextAttachments = await Promise.all(
        files.slice(0, remainingSlots).map((file) => createAiEditAttachmentFromFile(file, options.source)),
      );
      setAttachments((current) => [...current, ...nextAttachments].slice(0, MAX_AI_EDIT_ATTACHMENTS));
      setContextMenuOpen(false);
      if (options.fillDefaultInstruction) {
        setInstruction((current) => current.trim()
          ? current
          : getAttachmentDefaultInstruction([...attachments, ...nextAttachments]));
      }
      setComposerError(files.length > remainingSlots ? t("composer.attachmentLimit", { replace: { max: MAX_AI_EDIT_ATTACHMENTS } }) : null);
      composerRef.current?.focus();
    } catch {
      setComposerError(t("composer.fileReadFailed"));
    }
  };

  const handleAttachmentFiles = (files: FileList | null) => {
    void addFileAttachments(Array.from(files ?? []), {
      source: "file",
      fillDefaultInstruction: true,
    });
  };

  const handleInstructionPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = getClipboardImageFiles(event.clipboardData);
    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText) {
      const textarea = event.currentTarget;
      const selectionStart = textarea.selectionStart;
      const selectionEnd = textarea.selectionEnd;
      const nextInstruction = `${textarea.value.slice(0, selectionStart)}${pastedText}${textarea.value.slice(selectionEnd)}`;
      setInstruction(nextInstruction);
      window.requestAnimationFrame(() => {
        const cursor = selectionStart + pastedText.length;
        textarea.setSelectionRange(cursor, cursor);
      });
    }

    void addFileAttachments(imageFiles, {
      source: "paste",
      fillDefaultInstruction: !pastedText.trim(),
    });
  };

  const applyActionPreset = (prompt: string) => {
    setInstruction((current) => current.trim() ? `${current.trim()}\n${prompt}` : prompt);
    setContextMenuOpen(false);
    composerRef.current?.focus();
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  const removeMentionedDocument = (id: string) => {
    setMentionedDocuments((current) => current.filter((item) => item.id !== id));
  };

  const removeSelectedAiResource = (id: string) => {
    setSelectedAiResourceIds((current) => current.filter((item) => item !== id));
  };

  const updateMentionQueryFromInput = (value: string, cursor: number | null | undefined) => {
    const nextQuery = getActiveSigmaDocMentionQuery(value, cursor ?? value.length);
    setMentionQuery(nextQuery);
    setMentionCandidates([]);
    setMentionActiveIndex(0);
    setMentionLoading(Boolean(nextQuery));
    const nextSlashQuery = getActiveAiResourceSlashQuery(value, cursor ?? value.length);
    setSlashQuery(nextSlashQuery);
    setSlashActiveIndex(0);
  };

  const handleInstructionChange = (event: ReactChangeEvent<HTMLTextAreaElement>) => {
    const nextInstruction = event.currentTarget.value;
    setInstruction(nextInstruction);
    updateMentionQueryFromInput(nextInstruction, event.currentTarget.selectionStart);
  };

  const handleMentionCandidateSelect = async (candidate: DesktopDocumentMetadata) => {
    const activeQuery = mentionQuery;
    if (!activeQuery) {
      return;
    }

    const alreadyMentioned = mentionedDocuments.some((item) => item.fileId === candidate.fileId);
    if (!alreadyMentioned && mentionedDocuments.length >= MAX_AI_EDIT_MENTIONED_DOCUMENTS) {
      setComposerError(t("composer.mentionLimit", { replace: { max: MAX_AI_EDIT_MENTIONED_DOCUMENTS } }));
      setMentionQuery(null);
      return;
    }

    const desktop = getDesktopBridge();
    if (!desktop?.storage) {
      setComposerError(t("composer.mentionDesktopOnly"));
      setMentionQuery(null);
      return;
    }

    setMentionLoading(true);
    try {
      const mentionedDocument = await desktop.storage.loadDocument(candidate.fileId);
      if (!mentionedDocument) {
        setComposerError(t("composer.mentionLoadFailed"));
        return;
      }

      setMentionedDocuments((current) => upsertMentionedDocument(
        current,
        createMentionedDocumentContext(candidate, mentionedDocument),
        MAX_AI_EDIT_MENTIONED_DOCUMENTS,
      ));
      // @トリガーのテキストはチップに一本化するため挿入しない — トリガー範囲を削除するだけ。
      setInstruction((current) => removeActiveTriggerRange(current, activeQuery));
      setComposerError(null);
      window.requestAnimationFrame(() => {
        composerRef.current?.focus();
        composerRef.current?.setSelectionRange(activeQuery.start, activeQuery.start);
      });
    } catch {
      setComposerError(t("composer.mentionLoadFailed"));
    } finally {
      setMentionLoading(false);
      setMentionQuery(null);
      setMentionCandidates([]);
      setMentionActiveIndex(0);
    }
  };

  const handleAiResourceSelect = (resource: DesktopAiResourceManifestEntry) => {
    const activeQuery = slashQuery;
    if (!activeQuery) {
      return;
    }
    setSelectedAiResourceIds((current) => toggleAiResourceSelection(current, resource.id, { addOnly: true }));
    // /トリガーのテキストもチップに一本化するため挿入しない — トリガー範囲を削除するだけ。
    setInstruction((current) => removeActiveTriggerRange(current, activeQuery));
    setSlashQuery(null);
    setSlashActiveIndex(0);
    setComposerError(null);
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(activeQuery.start, activeQuery.start);
    });
  };

  // 統一コンテキストピッカー: ドキュメントのトグル選択 (既に選択済みなら解除)。
  const toggleContextPickerDocument = async (candidate: DesktopDocumentMetadata) => {
    const alreadyMentioned = mentionedDocuments.some((item) => item.fileId === candidate.fileId);
    if (alreadyMentioned) {
      setMentionedDocuments((current) => removeMentionedDocumentByFileId(current, candidate.fileId));
      return;
    }

    if (mentionedDocuments.length >= MAX_AI_EDIT_MENTIONED_DOCUMENTS) {
      setComposerError(t("composer.mentionLimit", { replace: { max: MAX_AI_EDIT_MENTIONED_DOCUMENTS } }));
      return;
    }

    const desktop = getDesktopBridge();
    if (!desktop?.storage) {
      setComposerError(t("composer.mentionDesktopOnly"));
      return;
    }

    try {
      const mentionedDocument = await desktop.storage.loadDocument(candidate.fileId);
      if (!mentionedDocument) {
        setComposerError(t("composer.mentionLoadFailed"));
        return;
      }

      setMentionedDocuments((current) => upsertMentionedDocument(
        current,
        createMentionedDocumentContext(candidate, mentionedDocument),
        MAX_AI_EDIT_MENTIONED_DOCUMENTS,
      ));
      setComposerError(null);
    } catch {
      setComposerError(t("composer.mentionLoadFailed"));
    }
  };

  // 統一コンテキストピッカー: スキルのトグル選択。
  const toggleContextPickerSkill = (resource: DesktopAiResourceManifestEntry) => {
    setSelectedAiResourceIds((current) => toggleAiResourceSelection(current, resource.id));
    setComposerError(null);
  };

  const selectContextPickerItem = (item: ContextPickerItem) => {
    if (item.kind === "doc") {
      void toggleContextPickerDocument(item.candidate);
      return;
    }
    toggleContextPickerSkill(item.candidate);
  };

  const hasTurns = visibleTurns.length > 0;

  const dismissReferenceChip = () => {
    if (referenceKey) {
      setDismissedReferenceKey(referenceKey);
    }
  };

  const toggleContextMenu = () => {
    setContextMenuOpen((current) => {
      const next = !current;
      if (next) {
        setModelMenuOpen(false);
        setModelFlyout(null);
      }
      return next;
    });
  };

  const toggleModelMenu = () => {
    const next = !modelMenuOpen;
    setModelMenuOpen(next);
    setModelFlyout(null);
    if (next) {
      setContextMenuOpen(false);
      void refreshRuntimeModels(provider);
    }
  };

  const startNewChatRoom = () => {
    // R1: creating a new room never has to wait for the active room's run —
    // rooms run independently.
    if (activeRoom && activeRoom.turns.length === 0) {
      resetComposerState({ focusComposer: true });
      return;
    }
    const nextRoom = createEmptyChatRoom(documentIdentityKey, documentTitleRef.current, tAiNow);
    addChatRoom(nextRoom, { makeActive: true });
    activeRoomIdRef.current = nextRoom.id;
    resetComposerState({ focusComposer: true });
  };

  const selectChatRoom = (roomId: string) => {
    // R1: switching rooms never interrupts a run — each room's run is tracked
    // independently in the run-session store, keyed by room id, not by which
    // room is currently visible.
    if (roomId === activeRoomId) {
      return;
    }
    activeRoomIdRef.current = roomId;
    selectChatRoomInStore(documentIdentityKey, roomId);
    resetComposerState({ focusComposer: true });
  };

  const prepareStaleProposalReRequest = (group: StaleMcpProposalGroup) => {
    if (group.roomId) {
      selectChatRoom(group.roomId);
    } else if (!activeRoomIdRef.current) {
      startNewChatRoom();
    }
    setInstruction((current) => current.trim()
      ? current
      : t("prompt.reRequest", { replace: { summary: group.summary } }));
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  const mentionPopoverOpen = !!mentionQuery && (mentionLoading || mentionCandidates.length > 0);
  const activeAiResourceProvider = toAiResourceProvider(provider);
  const slashCandidates = useMemo(
    () => filterAiResourceSlashCandidates({
      resources: aiResources,
      query: slashQuery?.query ?? "",
      selectedIds: selectedAiResourceIds,
      provider,
      translate: t,
    }),
    [aiResources, provider, selectedAiResourceIds, slashQuery?.query, t],
  );
  const slashPopoverOpen = !!slashQuery && slashCandidates.length > 0;
  // 統一コンテキストピッカーのドキュメント候補: 開いた時に読み込んだ生の一覧
  // (contextPickerDocFiles) を検索語で絞り込むだけ。IPC再取得はしない。
  const contextPickerDocCandidates = useMemo(
    () => filterSigmaDocMentionCandidates({
      files: contextPickerDocFiles,
      query: contextPickerQuery,
      currentFileId: documentIdentityKey,
      mentionedFileIds: [],
    }),
    [contextPickerDocFiles, contextPickerQuery, documentIdentityKey],
  );
  // 統一コンテキストピッカーのスキル候補: /ポップオーバーと同じ集合を使うが、選択済みも
  // 一覧に残してトグルで外せるようにする (selectedIds: [] で除外しない)。
  const contextPickerSkillCandidates = useMemo(
    () => filterAiResourceSlashCandidates({
      resources: aiResources,
      query: contextPickerQuery,
      selectedIds: [],
      provider,
      translate: t,
    }),
    [aiResources, contextPickerQuery, provider, t],
  );
  const contextPickerItems = useMemo<ContextPickerItem[]>(() => [
    ...contextPickerDocCandidates.map((candidate) => ({ kind: "doc" as const, candidate })),
    ...contextPickerSkillCandidates.map((candidate) => ({ kind: "skill" as const, candidate })),
  ], [contextPickerDocCandidates, contextPickerSkillCandidates]);
  if (contextPickerActiveIndex >= contextPickerItems.length && contextPickerItems.length > 0) {
    // 候補が絞り込まれてアクティブ行が範囲外になったら、レンダー中に調整 (React推奨の
    // 「前の値から導出するstateはレンダー中に補正する」パターン。setState-in-effectを避ける)。
    setContextPickerActiveIndex(contextPickerItems.length - 1);
  }
  const selectedAiResources = useMemo(
    () => selectedAiResourceIds
      .map((id) => aiResources.find((resource) => resource.id === id))
      .filter((resource): resource is DesktopAiResourceManifestEntry => resource !== undefined && resource.providers.includes(activeAiResourceProvider)),
    [activeAiResourceProvider, aiResources, selectedAiResourceIds],
  );
  const hasChipRow = pinnedReferences.length > 0
    || showReferenceChip
    || overlayComposerPreviews.length > 0
    || attachments.length > 0
    || mentionedDocuments.length > 0
    || selectedAiResources.length > 0;
  const selectedProviderModel = provider === "claude" ? claudeModel : provider === "antigravity" ? geminiModel : model;
  const activeModelOptions = resolveAiModelOptions(provider, runtimeModelCatalogs[provider]);
  const selectedModelOption = activeModelOptions.find((option) => option.id === selectedProviderModel);
  const selectedModelLabel = selectedModelOption?.label ?? (
    provider === "claude" ? claudeModelLabel(claudeModel) : provider === "antigravity" ? geminiModelLabel(geminiModel) : model
  );
  const selectedProviderLabel = aiProviderLabel(provider);
  const selectedReasoningEffortLabel = formatReasoningEffortLabel(reasoningEffort, t);
  const activeReasoningEfforts = getProviderReasoningEfforts(
    provider,
    activeModelOptions,
    selectedProviderModel,
  );
  const reasoningEffortSupported = activeReasoningEfforts.length > 0;
  const modelCatalogLoading = modelCatalogLoadingProvider === provider;
  const modelCatalogError = modelCatalogErrors[provider];


  // The composer (text field + chips + @/slash popovers + toolbar) is rendered
  // verbatim in both the docked sidebar and the inline editor so the input UI is
  // identical; only the wrapper layout differs via the --inline modifier.
  const renderComposer = (composerVariant: "inline" | "sidebar") => (
    <div
      className={`ai-chat-composer ${composerVariant === "inline" ? "ai-chat-composer--inline" : ""}`.trim()}
      aria-label={t("composer.instructionAria")}
    >
      <input
        ref={mediaInputRef}
        className="visually-hidden"
        type="file"
        multiple
        onChange={(event) => {
          handleAttachmentFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      <div
        key={composerVariant === "inline" ? `inline-${inlineSessionId}` : "sidebar"}
        className="ai-chat-input-shell ai-chat-input-shell--enter"
      >
        {hasChipRow && (
          <div className="ai-chat-context-row">
            {pinnedReferences.map((pinnedReference) => {
              const pinnedKey = getAiEditReferenceKey(pinnedReference);
              return (
                <span key={pinnedKey} className="ai-chat-chip" data-reference-kind={pinnedReference.kind}>
                  <AtSign size={11} />
                  <span className="ai-chat-chip-label">{getReferenceDisplayLabel(pinnedReference, t, tEditor)}</span>
                  {onRemovePinnedReference && (
                    <button
                      type="button"
                      className="ai-chat-chip-remove"
                      title={t("reference.clear")}
                      aria-label={t("reference.clear")}
                      onClick={() => onRemovePinnedReference(pinnedKey)}
                    >
                      <X size={12} />
                    </button>
                  )}
                </span>
              );
            })}
            {overlayComposerPreviews.map((overlayPreview) => (
              <ComposerOverlaySelectionPreview
                key={overlayPreview.referenceKey}
                preview={overlayPreview.preview}
                shapeCount={overlayPreview.shapeCount}
              />
            ))}
            {showReferenceChip && activeReference && (
              <span className="ai-chat-chip" data-reference-kind={activeReference.kind}>
                <AtSign size={11} />
                <span className="ai-chat-chip-label">{getReferenceDisplayLabel(activeReference, t, tEditor)}</span>
                {selectedOverlayImageCount > 0 && (
                  <span className="ai-chat-chip-meta">{t("reference.plusImages", { replace: { count: selectedOverlayImageCount } })}</span>
                )}
                {selectedOverlayNonImageShapeCount > 0 && (
                  <span className="ai-chat-chip-meta">{t("reference.plusShapes", { replace: { count: selectedOverlayNonImageShapeCount } })}</span>
                )}
                <button
                  type="button"
                  className="ai-chat-chip-remove"
                  title={t("reference.clear")}
                  aria-label={t("reference.clear")}
                  onClick={dismissReferenceChip}
                >
                  <X size={12} />
                </button>
              </span>
            )}
            {attachments.map((attachment) => (
              <AttachmentPreview
                key={attachment.id}
                attachment={attachment}
                onRemove={() => removeAttachment(attachment.id)}
              />
            ))}
            {mentionedDocuments.map((item) => (
              <MentionedDocumentChip
                key={item.id}
                item={item}
                onRemove={() => removeMentionedDocument(item.id)}
              />
            ))}
            {selectedAiResources.map((item) => (
              <AiResourceChip
                key={item.id}
                item={item}
                onRemove={() => removeSelectedAiResource(item.id)}
              />
            ))}
          </div>
        )}
        {mentionPopoverOpen && (
          <SigmaDocMentionPopover
            candidates={mentionCandidates}
            loading={mentionLoading}
            activeIndex={mentionActiveIndex}
            onHover={setMentionActiveIndex}
            onSelect={(candidate) => void handleMentionCandidateSelect(candidate)}
          />
        )}
        {slashPopoverOpen && (
          <AiResourceSlashPopover
            candidates={slashCandidates}
            activeIndex={slashActiveIndex}
            onHover={setSlashActiveIndex}
            onSelect={handleAiResourceSelect}
          />
        )}
        <AiChatTextInput
          ref={composerRef}
          id="ai-edit-instruction"
          aria-label={t("composer.instructionAria")}
          rows={1}
          value={instruction}
          onChange={handleInstructionChange}
          onClick={(event) => updateMentionQueryFromInput(event.currentTarget.value, event.currentTarget.selectionStart)}
          onSelect={(event) => updateMentionQueryFromInput(event.currentTarget.value, event.currentTarget.selectionStart)}
          onKeyUp={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === "Tab") {
              return;
            }
            updateMentionQueryFromInput(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          onPaste={handleInstructionPaste}
          onKeyDown={(event) => {
            if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
              && reasoningEffortSupported && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
              event.preventDefault();
              setReasoningEffort((current) => cycleReasoningEffort(
                activeReasoningEfforts,
                current,
                event.key === "ArrowUp" ? 1 : -1,
              ));
              return;
            }
            if (slashQuery) {
              if (event.key === "Escape") {
                event.preventDefault();
                setSlashQuery(null);
                setSlashActiveIndex(0);
                return;
              }
              if (slashCandidates.length > 0 && event.key === "ArrowDown") {
                event.preventDefault();
                setSlashActiveIndex((current) => (current + 1) % slashCandidates.length);
                return;
              }
              if (slashCandidates.length > 0 && event.key === "ArrowUp") {
                event.preventDefault();
                setSlashActiveIndex((current) => (current - 1 + slashCandidates.length) % slashCandidates.length);
                return;
              }
              if (slashCandidates.length > 0 && (event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                handleAiResourceSelect(slashCandidates[slashActiveIndex] ?? slashCandidates[0]);
                return;
              }
            }
            if (mentionQuery) {
              if (event.key === "Escape") {
                event.preventDefault();
                setMentionQuery(null);
                setMentionCandidates([]);
                setMentionActiveIndex(0);
                return;
              }
              if (mentionCandidates.length > 0 && event.key === "ArrowDown") {
                event.preventDefault();
                setMentionActiveIndex((current) => (current + 1) % mentionCandidates.length);
                return;
              }
              if (mentionCandidates.length > 0 && event.key === "ArrowUp") {
                event.preventDefault();
                setMentionActiveIndex((current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length);
                return;
              }
              if (mentionCandidates.length > 0 && (event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                void handleMentionCandidateSelect(mentionCandidates[mentionActiveIndex] ?? mentionCandidates[0]);
                return;
              }
            }
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void runEdit();
            }
          }}
          placeholder={hasTurns ? t("composer.placeholder") : t("composer.placeholderFirst")}
        />
        <div
          className={`ai-chat-toolbar${composerVariant === "inline" && onPromoteToSidebar ? " ai-chat-toolbar--inline" : ""}`.trim()}
        >
          <div className="ai-chat-add-wrap">
            <button
              ref={contextPickerToggleRef}
              type="button"
              className="ai-chat-icon-button"
              title={t("composer.addContext")}
              aria-label={t("composer.addContext")}
              aria-expanded={contextMenuOpen}
              onClick={toggleContextMenu}
            >
              <Plus size={16} />
            </button>
            {contextMenuOpen && (
              <div
                ref={contextPickerRef}
                className="ai-chat-context-menu ai-chat-context-picker"
                role="menu"
                aria-label={t("composer.addContext")}
                onKeyDown={(event) => {
                  // Esc closes regardless of which element inside the picker currently has
                  // focus (e.g. after clicking a toggle option button, not just from the
                  // search input's own handler below).
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setContextMenuOpen(false);
                    contextPickerToggleRef.current?.focus();
                  }
                }}
              >
                <div className="ai-chat-context-picker-heading">{tCommon("actions.add")}</div>
                <button
                  type="button"
                  role="menuitem"
                  className="ai-chat-context-file-action"
                  onClick={() => {
                    setContextMenuOpen(false);
                    mediaInputRef.current?.click();
                  }}
                >
                  <Paperclip size={15} />
                  <span>{t("composer.addFile")}</span>
                </button>
                <div className="ai-chat-menu-divider" />
                <div className="ai-chat-context-picker-search">
                  <Search size={13} />
                  <input
                    ref={contextPickerSearchRef}
                    type="text"
                    value={contextPickerQuery}
                    onChange={(event) => {
                      setContextPickerQuery(event.currentTarget.value);
                      setContextPickerActiveIndex(0);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setContextMenuOpen(false);
                        contextPickerToggleRef.current?.focus();
                        return;
                      }
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setContextPickerActiveIndex((current) =>
                          contextPickerItems.length === 0 ? 0 : (current + 1) % contextPickerItems.length);
                        return;
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setContextPickerActiveIndex((current) =>
                          contextPickerItems.length === 0 ? 0 : (current - 1 + contextPickerItems.length) % contextPickerItems.length);
                        return;
                      }
                      if (event.key === "Enter") {
                        event.preventDefault();
                        const activeItem = contextPickerItems[contextPickerActiveIndex];
                        if (activeItem) {
                          selectContextPickerItem(activeItem);
                        }
                      }
                    }}
                    placeholder={t("composer.searchDocsAndSkills")}
                    aria-label={t("composer.searchContext")}
                  />
                </div>
                <div className="ai-chat-context-picker-list">
                  <div className="ai-chat-menu-title">{t("composer.documents")}</div>
                  {contextPickerDocLoading && contextPickerDocCandidates.length === 0 ? (
                    <div className="ai-chat-mention-empty"><Shimmer>{t("composer.searching")}</Shimmer></div>
                  ) : contextPickerDocCandidates.length === 0 ? (
                    <div className="ai-chat-mention-empty">{t("composer.noCandidates")}</div>
                  ) : (
                    contextPickerDocCandidates.map((candidate, index) => {
                      const selected = mentionedDocuments.some((item) => item.fileId === candidate.fileId);
                      const capReached = !selected && mentionedDocuments.length >= MAX_AI_EDIT_MENTIONED_DOCUMENTS;
                      return (
                        <button
                          key={candidate.fileId}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={selected}
                          className="ai-chat-mention-option"
                          data-active={index === contextPickerActiveIndex}
                          disabled={capReached}
                          title={capReached ? t("composer.mentionLimitShort", { replace: { max: MAX_AI_EDIT_MENTIONED_DOCUMENTS } }) : undefined}
                          onMouseEnter={() => setContextPickerActiveIndex(index)}
                          onClick={() => selectContextPickerItem({ kind: "doc", candidate })}
                        >
                          <FileText size={15} />
                          <span className="ai-chat-mention-main">
                            <span className="ai-chat-mention-name">{candidate.title}</span>
                          </span>
                          {selected ? <Check size={14} /> : null}
                        </button>
                      );
                    })
                  )}
                  <div className="ai-chat-menu-divider" />
                  <div className="ai-chat-menu-title">{t("composer.skills")}</div>
                  {contextPickerSkillCandidates.length === 0 ? (
                    <div className="ai-chat-mention-empty">{t("composer.noCandidates")}</div>
                  ) : (
                    contextPickerSkillCandidates.map((candidate, skillIndex) => {
                      const flatIndex = contextPickerDocCandidates.length + skillIndex;
                      const selected = selectedAiResourceIds.includes(candidate.id);
                      const display = resolveAiResourceDisplayMetadata(candidate, t);
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={selected}
                          className="ai-chat-mention-option"
                          data-active={flatIndex === contextPickerActiveIndex}
                          onMouseEnter={() => setContextPickerActiveIndex(flatIndex)}
                          onClick={() => selectContextPickerItem({ kind: "skill", candidate })}
                        >
                          <Sparkles size={15} />
                          <span className="ai-chat-mention-main">
                            <span className="ai-chat-mention-name">{display.title}</span>
                            <span className="ai-chat-mention-path">{display.description}</span>
                          </span>
                          {selected ? <Check size={14} /> : <span className="ai-chat-mention-revision">{t("composer.skills")}</span>}
                        </button>
                      );
                    })
                  )}
                  <div className="ai-chat-menu-divider" />
                  <div className="ai-chat-menu-title">Actions</div>
                  {buildAiActionPresets(t).map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setInstruction((current) => (current.trim() ? `${current.trim()}\n${preset.prompt}` : preset.prompt));
                        setContextMenuOpen(false);
                        composerRef.current?.focus();
                      }}
                    >
                      <SquarePen size={14} />
                      <span>{preset.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="ai-chat-model-wrap">
            <button
              ref={modelMenuButtonRef}
              type="button"
              className="ai-chat-model-button"
              title={t("composer.modelButtonTitle", { replace: {
                provider: selectedProviderLabel,
                model: selectedModelLabel,
                effort: reasoningEffortSupported
                  ? t("composer.effortWithId", { replace: { label: selectedReasoningEffortLabel, id: reasoningEffort } })
                  : t("composer.effortUnsupported"),
              } })}
              aria-label={t("composer.providerModelAria", { replace: {
                provider: selectedProviderLabel,
                model: selectedModelLabel,
                effort: reasoningEffortSupported
                  ? t("composer.effortWithLabel", { replace: { label: selectedReasoningEffortLabel } })
                  : t("composer.effortUnsupported"),
              } })}
              aria-haspopup="menu"
              aria-expanded={modelMenuOpen}
              onClick={toggleModelMenu}
              disabled={isRunning}
            >
              {renderModelMark(selectedProviderModel, provider, { size: 13 })}
              <span className="ai-chat-model-button-label">
                <span>{selectedProviderLabel}</span>
                <span className="ai-chat-model-button-divider" aria-hidden="true">·</span>
                <span>{selectedModelLabel}</span>
                <span className="ai-chat-model-button-divider" aria-hidden="true">·</span>
                <span>{reasoningEffortSupported ? selectedReasoningEffortLabel : t("composer.effortUnsupported")}</span>
              </span>
              <ChevronDown size={12} />
            </button>
            {modelMenuOpen && (
              <ToolbarPopover
                open
                anchorRef={modelMenuButtonRef}
                onClose={() => {
                  setModelMenuOpen(false);
                  setModelFlyout(null);
                }}
                align="right"
                placement="top"
                gap={8}
                zIndex={4900}
                className="ai-chat-model-menu"
                role="menu"
                ariaLabel={t("composer.providerAndModel")}
                onMouseLeave={() => setModelFlyout(null)}
              >
                {/* Provider stays selectable only until the room is bound to one
                    (its first run). Afterwards a conversation is locked to its
                    provider — only model/effort remain adjustable. */}
                {!lockedProvider && (
                  <>
                    <div className="ai-chat-menu-title">{t("composer.provider")}</div>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={provider === "chatgpt"}
                      aria-label="ChatGPT"
                      title="ChatGPT"
                      className="ai-chat-model-menu-item"
                      onClick={() => {
                        setProvider("chatgpt");
                        setModelFlyout(null);
                      }}
                    >
                      <OpenAiMark size={13} />
                      <span>ChatGPT</span>
                      {provider === "chatgpt" && <Check size={13} />}
                    </button>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={provider === "claude"}
                      aria-label="Claude"
                      title="Claude"
                      className="ai-chat-model-menu-item"
                      onClick={() => {
                        setProvider("claude");
                        setModelFlyout(null);
                      }}
                    >
                      <ClaudeMark size={13} />
                      <span>Claude</span>
                      {provider === "claude" && <Check size={13} />}
                    </button>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={provider === "antigravity"}
                      aria-label="Antigravity"
                      title="Antigravity"
                      className="ai-chat-model-menu-item"
                      onClick={() => {
                        setProvider("antigravity");
                        setModelFlyout(null);
                      }}
                    >
                      <AntigravityMark size={13} />
                      <span>Antigravity</span>
                      {provider === "antigravity" && <Check size={13} />}
                    </button>
                    <div className="ai-chat-menu-divider" />
                  </>
                )}
                <AiModelMenuContents
                  t={t} provider={provider} selectedProviderLabel={selectedProviderLabel}
                  selectedModel={selectedProviderModel} selectedModelLabel={selectedModelLabel}
                  reasoningEffort={reasoningEffort} selectedReasoningEffortLabel={selectedReasoningEffortLabel}
                  reasoningEffortSupported={reasoningEffortSupported} reasoningEfforts={activeReasoningEfforts}
                  modelOptions={activeModelOptions} modelCatalogLoading={modelCatalogLoading && !runtimeModelCatalogs[provider]}
                  modelCatalogError={modelCatalogError} modelFlyout={modelFlyout}
                  setModelFlyout={setModelFlyout} setModelMenuOpen={setModelMenuOpen}
                  onSelectEffort={(item) => setReasoningEffort(item as AiEditReasoningEffort)}
                  onSelectModel={(item) => {
                            if (provider === "claude") {
                              setClaudeModel(item.id);
                            } else if (provider === "antigravity") {
                              setGeminiModel(item.id);
                            } else {
                              setModel(item.id as AiEditModel);
                            }
                            if (provider !== "antigravity") {
                              const efforts = item.supportedReasoningEfforts?.map((option) => option.id) ?? [];
                              if (efforts.length > 0 && !efforts.includes(reasoningEffort)) {
                                setReasoningEffort((item.defaultReasoningEffort && efforts.includes(item.defaultReasoningEffort)
                                  ? item.defaultReasoningEffort
                                  : efforts[0]) as AiEditReasoningEffort);
                              }
                            }
                            }}
                />
              </ToolbarPopover>
            )}
          </div>
          {composerVariant === "inline" && onPromoteToSidebar && (
            <button
              type="button"
              className="ai-chat-icon-button ai-inline-to-sidebar"
              title={t("run.openInSideChat")}
              aria-label={t("run.openInSideChat")}
              onClick={onPromoteToSidebar}
            >
              <PanelRight size={14} />
            </button>
          )}
          <button
            type="button"
            className="ai-chat-send-button"
            disabled={historyLoading}
            // R3: stays enabled while the room is running — sending queues a
            // follow-up turn instead of blocking on the in-flight run.
            title={historyLoading ? t("chat.historyLoading") : isRunning ? t("composer.sendQueued") : t("composer.send")}
            aria-label={historyLoading ? t("chat.historyLoading") : isRunning ? t("composer.sendQueued") : t("composer.send")}
            onClick={() => void runEdit()}
          >
            <ArrowUp size={16} strokeWidth={2.5} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );

  // Block the chat experience until the selected provider is connected, surfacing
  // an in-context sign-in path. A provider switch stays visible so the user can
  // flip to the other provider (which may already be connected) while gated.
  const activeConnectionState = provider === "claude"
    ? claudeConnection.state
    : provider === "antigravity"
    ? geminiConnection.state
    : connection.state;
  const connectionReady = activeConnectionState.kind === "loggedIn";
  if (!connectionReady) {
    return (
      <div className={`ai-edit-panel ${variant === "inline" ? "ai-inline-edit" : ""}`} data-gated="true" data-variant={variant}>
        <ProviderSwitch provider={provider} onChange={setProvider} disabled={isRunning} />
        {provider === "claude" ? (
          <ClaudeConnectionGate connection={claudeConnection} onOpenSettings={onOpenAiSettings} />
        ) : provider === "antigravity" ? (
          <GeminiConnectionGate connection={geminiConnection} onOpenSettings={onOpenAiSettings} />
        ) : (
          <AiConnectionGate connection={connection} onOpenSettings={onOpenAiSettings} />
        )}
      </div>
    );
  }

  if (variant === "inline") {
    const inlineProvider = lockedProvider ?? provider;
    const activeRunTurnId = inlineRunAnchor ? inlineRunTurnId : null;
    const runTurn = activeRunTurnId
      ? visibleTurns.find((turn): turn is AssistantTurn => turn.id === activeRunTurnId && turn.role === "assistant")
      : undefined;
    const anchorsMatch = !!(
      inlineAnchor &&
      inlineRunAnchor &&
      inlineAnchor.left === inlineRunAnchor.left &&
      inlineAnchor.top === inlineRunAnchor.top
    );
    const runTurnDetached = !!inlineRunAnchor && (!inlineOpen || !anchorsMatch);
    const runTurnWorking = !!(
      runTurn && (runTurn.isRunning || (runTurn.id === activeRunTurnId && isRunning))
    );
    const runTurnPending = !!(
      runTurn && (
        (runTurn.result && !runTurn.applied && !runTurn.dismissed)
        || (runTurn.error && !runTurn.dismissed)
      )
    );
    const runTurnActive = runTurnWorking || runTurnPending;
    const pinnedRunTurn = runTurn
      && (
        (runTurn.result && !runTurn.applied && !runTurn.dismissed)
        || (runTurn.error && !runTurn.dismissed)
      )
      ? runTurn
      : null;
    const inlineResultTurn = pinnedRunTurn && runTurnDetached
      ? null
      : pinnedRunTurn ?? (latestAssistant && latestAssistant.id !== inlineBaselineTurnId
        ? latestAssistant
        : null);
    const runningTurn = runTurnWorking ? runTurn : (latestAssistant?.isRunning ? latestAssistant : null);
    const hasInlineResult = !!(inlineResultTurn?.result && !inlineResultTurn.applied && !inlineResultTurn.dismissed);
    const inlineErrorShown = !!(inlineResultTurn?.error && !inlineResultTurn.dismissed);
    const isWorking = isRunning || !!runningTurn?.isRunning;

    const renderInlineProposalActions = (turn: AssistantTurn) => {
      const proposal = previewGroups.find((preview) => (
        preview.roomId === activeRoomId && preview.turnId === turn.id
      )) ?? (turn.id === latestAssistantId && !activeRoomPreview?.turnId ? activeRoomPreview : null);
      if (!proposal || turn.applied || turn.dismissed) return null;
      return (
        <AiTurnProposalActions
          key={proposal.proposalIds.join(",")}
          proposal={proposal}
          proposalBusy={busy}
          onApplyProposal={onApplyGroup}
          onDismissProposal={onDismissGroup}
        />
      );
    };

    const renderInlineResultControls = (turnId: string) => (
      <div className="ai-inline-result-actions" aria-label={t("panel.resultActionsAria")}>
        {onPromoteToSidebar && (
          <button
            type="button"
            className="ai-inline-card-icon"
            title={t("run.openInSideChat")}
            aria-label={t("run.openInSideChat")}
            onClick={onPromoteToSidebar}
          >
            <PanelRight size={15} />
          </button>
        )}
        <button
          type="button"
          className="ai-inline-card-icon"
          title={tCommon("actions.close")}
          aria-label={tCommon("actions.close")}
          onClick={() => {
            dismissTurn(turnId);
            onCloseInline?.();
          }}
        >
          <X size={15} />
        </button>
      </div>
    );

    const renderInlineRunSurface = (turn: AssistantTurn) => {
      const runTurnWorking = turn.isRunning || (turn.id === activeRunTurnId && isRunning);
      // R2: the shimmering "AI is working" badge that used to render here (fixed
      // at the frozen `inlineRunAnchorCanvas` position) has been retired in favor
      // of `AiRunAnchorLayer`, which anchors a per-session widget to the actual
      // target block and follows reflow/scroll. Nothing renders for the
      // in-progress state here anymore — only the settled result/error surfaces
      // below remain, so there is exactly one "AI is working" indicator on screen.
      if (runTurnWorking) {
        return null;
      }

      if (turn.result && !turn.applied && !turn.dismissed) {
        return (
          <div className="ai-edit-panel ai-inline-edit" data-variant="inline">
            <div className="ai-inline-result">
              {renderInlineResultControls(turn.id)}
              <div className="ai-inline-result-head">
                <span className="ai-inline-logo" aria-hidden="true">{renderProviderMark(inlineProvider, { size: 15 })}</span>
                <AiStreamRenderer className="ai-inline-summary" text={turn.result.draft.summary} />
              </div>
              <AiChatShapeArtifact
                preview={insertedShapePreviewsByTurnId?.get(turn.id)}
                outcome={turn.applied ? "applied" : turn.dismissed ? "dismissed" : "pending"}
              />
              {turn.events.some((event) => event.images?.some((image) => image.generatedImage)) && (
                <AssistantActivity turn={turn} clockNow={clockNow} />
              )}
              {renderInlineProposalActions(turn)}
              {turn.result.draft.warnings.length > 0 && (
                <AiEditPlanList title={t("panel.warnings")} items={turn.result.draft.warnings} compact />
              )}
            </div>
          </div>
        );
      }

      if (turn.error && !turn.dismissed) {
        return (
          <div className="ai-edit-panel ai-inline-edit" data-variant="inline">
            <div className="ai-inline-error-row">
              <span className="ai-inline-logo" aria-hidden="true">{renderProviderMark(inlineProvider, { size: 15 })}</span>
              <span className="ai-chat-error">{turn.error}</span>
              <button type="button" className="button" onClick={() => retryTurn(turn.id)}>
                <span>{tCommon("actions.retry")}</span>
              </button>
            </div>
          </div>
        );
      }

      return null;
    };

    // Keep the running surface attached to the page canvas, so scroll/zoom changes
    // move it with the document position where the run started.
    const shouldRenderRunPortal = !!(
      runTurn &&
      inlineRunAnchorCanvas &&
      inlineRunPortalTarget &&
      (runTurnWorking || (runTurnDetached && runTurnActive))
    );
    const runPortal = shouldRenderRunPortal && runTurn && inlineRunAnchorCanvas && inlineRunPortalTarget
      ? createPortal(
          <div
            className="ai-inline-run-overlay"
            style={{
              left: `${Math.max(0, inlineRunAnchorCanvas.left)}px`,
              top: `${Math.max(0, inlineRunAnchorCanvas.top)}px`,
            }}
          >
            {renderInlineRunSurface(runTurn)}
          </div>,
          inlineRunPortalTarget,
        )
      : null;

    if (!inlineOpen) {
      const detachedSurface = runTurn && runTurnActive ? renderInlineRunSurface(runTurn) : null;
      if (runPortal) {
        return <>{runPortal}</>;
      }
      if (detachedSurface) {
        return <>{detachedSurface}</>;
      }
      return null;
    }

    if (isWorking) {
      if (runPortal) {
        return <>{runPortal}</>;
      }
      if (runningTurn) {
        return <>{renderInlineRunSurface(runningTurn)}</>;
      }
    }

    const showInlineComposer = !hasInlineResult && !inlineErrorShown;

    return (
      <>
        {runPortal}
        <div
          className={`ai-edit-panel ai-inline-edit ai-inline-edit--enter ${showInlineComposer ? "ai-inline-edit--bare" : ""}`.trim()}
          data-variant="inline"
          onKeyDown={(event) => {
            if (
              event.key === "Escape" &&
              !mentionQuery &&
              !slashQuery &&
              !contextMenuOpen &&
              !modelMenuOpen
            ) {
              onCloseInline?.();
            }
          }}
        >
          {hasInlineResult && inlineResultTurn ? (
            <div className="ai-inline-result">
              {renderInlineResultControls(inlineResultTurn.id)}
              <div className="ai-inline-result-head">
                <span className="ai-inline-logo" aria-hidden="true">{renderProviderMark(inlineProvider, { size: 15 })}</span>
                <AiStreamRenderer className="ai-inline-summary" text={inlineResultTurn.result!.draft.summary} />
              </div>
              <AiChatShapeArtifact
                preview={insertedShapePreviewsByTurnId?.get(inlineResultTurn.id)}
                outcome={inlineResultTurn.applied ? "applied" : inlineResultTurn.dismissed ? "dismissed" : "pending"}
              />
              {inlineResultTurn.events.some((event) => event.images?.some((image) => image.generatedImage)) && (
                <AssistantActivity turn={inlineResultTurn} clockNow={clockNow} />
              )}
              {renderInlineProposalActions(inlineResultTurn)}
              {inlineResultTurn.result!.draft.warnings.length > 0 && (
                <AiEditPlanList title={t("panel.warnings")} items={inlineResultTurn.result!.draft.warnings} compact />
              )}
            </div>
          ) : inlineErrorShown && inlineResultTurn ? (
            <div className="ai-inline-error-row">
              <span className="ai-inline-logo" aria-hidden="true">{renderProviderMark(inlineProvider, { size: 15 })}</span>
              <span className="ai-chat-error">{inlineResultTurn.error}</span>
              <button type="button" className="button" onClick={() => retryTurn(inlineResultTurn.id)}>
                <span>{tCommon("actions.retry")}</span>
              </button>
            </div>
          ) : (
            renderComposer("inline")
          )}
          {composerError && <p className="ai-chat-error ai-inline-message">{composerError}</p>}
        </div>
      </>
    );
  }

  return (
    <div className="ai-edit-panel" data-variant={variant}>
      <ChatRoomHistory
        rooms={chatRooms}
        activeRoomId={activeRoomId}
        loading={historyLoading}
        runSessions={runSessions}
        onNewRoom={startNewChatRoom}
        onSelectRoom={selectChatRoom}
        onOpenSettings={onOpenAiSettings}
      />
      <div className="ai-chat-thread" ref={threadRef}>
        {historyError && <p className="ai-chat-error">{historyError}</p>}
        {!hasTurns ? (
          <ChatEmptyState
            reference={activeReference}
            onSelectPreset={applyActionPreset}
          />
        ) : (
          visibleTurns.map((turn) => {
            if (turn.role === "user") {
              return (
                <UserTurnView
                  key={turn.id}
                  turn={turn}
                  turnRef={(element) => setUserTurnElement(turn.id, element)}
                  onResend={resendQueuedTurn}
                />
              );
            }
            const exactPreview = previewGroups.find((preview) => (
              preview.roomId === activeRoomId && preview.turnId === turn.id
            ));
            const proposal = exactPreview
              ?? (turn.id === latestAssistantId && !activeRoomPreview?.turnId ? activeRoomPreview : null);
            // 承認する前に「何が消えて何が足されるのか」を同じGitHub風差分で先出しする
            // (承認後の適用済みカードと全く同じ見た目にすることで、「見た目で分かって
            // 承認できる」体験にする)。キャッシュ経由なので、コンポーザーへの入力など
            // 無関係な再レンダーではproposal/document/shapesが同じ限り再計算されない。
            const proposalDiff = proposal ? getPendingProposalDiff(proposal) : undefined;
            return (
              <AssistantTurnView
                key={turn.id}
                turn={turn}
                clockNow={clockNow}
                sourceReferences={sourceReferencesByTurnId?.get(turn.id)}
                shapePreview={insertedShapePreviewsByTurnId?.get(turn.id)}
                appliedChange={appliedChangesByTurnId?.get(turn.id)}
                onRevertAppliedChange={onRevertAppliedChange}
                onOpenSourceDocument={onOpenSourceDocument}
                restorable={restorableProposalsByTurnId?.get(turn.id)}
                onRestoreProposal={onRestoreProposal}
                proposal={proposal}
                proposalDiff={proposalDiff}
                proposalBusy={busy}
                onApplyProposal={onApplyGroup}
                onDismissProposal={onDismissGroup}
              />
            );
          })
        )}
        {composerError && <p className="ai-chat-error">{composerError}</p>}
        {threadTailSpacerHeight > 0 && (
          <div
            className="ai-chat-thread-tail-spacer"
            style={{ height: threadTailSpacerHeight }}
            aria-hidden="true"
          />
        )}
      </div>

      <AiStaleProposalNotice
        groups={staleProposalGroups}
        onDiscard={onDiscardStaleProposals}
        onRebase={onRebaseStaleProposals}
        onForceApply={onForceApplyStaleProposals}
        onReRequest={prepareStaleProposalReRequest}
      />

      {renderComposer("sidebar")}
    </div>
  );
}

/** AI会話の切り替え、新規作成、設定導線を共通モーダルで提供する履歴ナビゲーション。 */
function ChatRoomHistory({
  rooms,
  activeRoomId,
  loading,
  runSessions,
  onNewRoom,
  onSelectRoom,
  onOpenSettings,
}: {
  rooms: AiEditChatRoom[];
  activeRoomId: string | null;
  loading: boolean;
  // R1/R5: lets the room switcher show, at a glance, which rooms (including
  // ones not currently visible) have an AI run in flight.
  runSessions: ReadonlyMap<string, AiRunSession>;
  onNewRoom: () => void;
  onSelectRoom: (roomId: string) => void;
  onOpenSettings?: () => void;
}) {
  const t = useT("ai");
  const tCommon = useT("common");
  // 「AI設定」はダイアログ側と同じ見出し (`settings.ai.title` が出典)。
  const tSettings = useT("settings");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogPosition, setDialogPosition] = useState<{ top: number; right: number } | null>(null);
  const historyDialogAnchorRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const filteredRooms = useMemo(() => {
    const query = normalizeHistorySearchText(searchQuery);
    if (!query) {
      return rooms;
    }
    return rooms.filter((room) => normalizeHistorySearchText(getRoomSearchText(room)).includes(query));
  }, [rooms, searchQuery]);

  const updateDialogPosition = useCallback(() => {
    const anchor = historyDialogAnchorRef.current;
    if (!anchor) {
      setDialogPosition(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    setDialogPosition({
      top: Math.max(HISTORY_DIALOG_VIEWPORT_MARGIN, rect.bottom + HISTORY_DIALOG_ANCHOR_GAP),
      right: Math.max(HISTORY_DIALOG_VIEWPORT_MARGIN, window.innerWidth - rect.right),
    });
  }, []);

  useEffect(() => {
    if (!dialogOpen) {
      return;
    }
    updateDialogPosition();
    window.addEventListener("resize", updateDialogPosition);
    window.addEventListener("scroll", updateDialogPosition, true);
    return () => {
      window.removeEventListener("resize", updateDialogPosition);
      window.removeEventListener("scroll", updateDialogPosition, true);
    };
  }, [dialogOpen, updateDialogPosition]);

  useEffect(() => {
    if (!dialogOpen || !searchOpen) {
      return;
    }
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [dialogOpen, searchOpen]);

  const openDialog = () => {
    updateDialogPosition();
    setDialogOpen(true);
  };
  const closeDialog = () => {
    setDialogOpen(false);
    setSearchOpen(false);
    setSearchQuery("");
  };
  const toggleSearch = () => {
    setSearchOpen((current) => {
      if (current) {
        setSearchQuery("");
      }
      return !current;
    });
  };
  const selectRoom = (roomId: string) => {
    onSelectRoom(roomId);
    closeDialog();
  };
  const createRoom = () => {
    onNewRoom();
    closeDialog();
  };

  const runningRoomCount = useMemo(
    () => rooms.filter((room) => isAiRunStatusActive(runSessions.get(room.id)?.status)).length,
    [rooms, runSessions],
  );

  return (
    <div className="ai-chat-room-history" aria-label={t("panel.chatActionsAria")}>
      <div className="ai-chat-room-history-head">
        <span className="ai-chat-room-section-label">{t("panel.chat")}</span>
        <div className="ai-chat-room-actions" aria-label={t("panel.chatActionsAria")}>
          <IconButton
            ref={historyDialogAnchorRef}
            className="ai-chat-room-icon-button"
            label={runningRoomCount > 0 ? t("chat.showHistoryRunning", { replace: { count: rooms.length, running: runningRoomCount } }) : t("chat.showHistory", { replace: { count: rooms.length } })}
            tooltip={{ label: t("chat.openPast") }}
            tone="ghost"
            size="sm"
            onClick={openDialog}
            disabled={loading}
            aria-haspopup="dialog"
          >
            <History size={16} />
            {runningRoomCount > 0 && (
              <span className="ai-chat-room-status-dot ai-chat-room-status-dot--badge" data-running="true" aria-hidden="true" />
            )}
          </IconButton>
          {onOpenSettings && (
            <IconButton
              className="ai-chat-room-icon-button"
              label={tSettings("ai.title")}
              tone="ghost"
              size="sm"
              onClick={onOpenSettings}
            >
              <Settings size={16} />
            </IconButton>
          )}
          <IconButton
            className="ai-chat-room-icon-button"
            label={t("chat.new")}
            tooltip={{ label: t("chat.startNew") }}
            tone="ghost"
            size="sm"
            onClick={createRoom}
          >
            <SquarePen size={16} />
          </IconButton>
        </div>
      </div>
      {loading && (
        <div className="ai-chat-room-loading" role="status">
          <Shimmer>{tCommon("status.loading")}</Shimmer>
        </div>
      )}
      <ModalFrame
        open={dialogOpen}
        onDismiss={closeDialog}
        size="sm"
        className="ai-chat-room-dialog-backdrop"
        surfaceClassName="ai-chat-room-dialog"
        ariaLabel={t("chat.historyTitle")}
        style={dialogPosition ? {
          "--ai-chat-room-dialog-top": `${dialogPosition.top}px`,
          "--ai-chat-room-dialog-right": `${dialogPosition.right}px`,
        } as ReactCSSProperties : undefined}
      >
        <ModalHeader
          className="ai-chat-room-dialog-head"
          title={t("chat.history")}
          description={t("chat.roomCount", { replace: { count: rooms.length } })}
          onClose={closeDialog}
          actions={(
            <IconButton
              label={searchOpen ? t("chat.closeSearch") : t("chat.searchHistory")}
              tone="ghost"
              size="sm"
              aria-pressed={searchOpen}
              data-modal-initial-focus
              onClick={toggleSearch}
            >
              <Search size={16} aria-hidden="true" />
            </IconButton>
          )}
        />
        <ModalBody className="ai-chat-room-dialog-body" padding="none" scroll="hidden" data-search-open={searchOpen}>
          {searchOpen && <label className="ai-chat-room-search">
              <Search size={15} />
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
                placeholder={t("chat.searchHistory")}
                aria-label={t("chat.searchHistory")}
              />
          </label>}
          <div className="ai-chat-room-dialog-list" role="list">
              {filteredRooms.length === 0 ? (
                <p className="ai-chat-room-dialog-empty">{t("chat.noMatchingHistory")}</p>
              ) : (
                filteredRooms.map((room) => {
                  const active = room.id === activeRoomId;
                  return (
                    <ChatHistoryRoomItem
                      key={room.id}
                      room={room}
                      session={runSessions.get(room.id) ?? null}
                      active={active}
                      onSelect={() => selectRoom(room.id)}
                    />
                  );
                })
              )}
          </div>
        </ModalBody>
      </ModalFrame>
    </div>
  );
}

/** One dense history row: provider identity plus title only. Run state is
 * expressed by the shared shimmer without adding a second status label. */
export function ChatHistoryRoomItem({
  room,
  session,
  active,
  onSelect,
}: {
  room: AiEditChatRoom;
  session: AiRunSession | null;
  active: boolean;
  onSelect: () => void;
}) {
  const t = useT("ai");
  const running = isAiRunStatusActive(session?.status);
  // 名前が付いていない会話だけ今の言語の呼び名にする (既定文は作成時の言語で保存される)。
  const roomTitle = isDefaultChatRoomTitle(room.title) ? t("chat.untitledRoom") : room.title;
  const rowProvider = session?.provider ?? room.provider ?? null;
  const providerMark = rowProvider
    ? renderProviderMark(rowProvider, { size: 15 })
    : <Sparkles size={15} aria-hidden="true" />;

  return (
    <button
      type="button"
      className="ai-chat-room-dialog-item"
      aria-current={active ? "true" : undefined}
      data-running={running}
      data-provider={rowProvider ?? "unknown"}
      onClick={onSelect}
    >
      <span className="ai-chat-room-dialog-provider" aria-hidden="true">
        {running && rowProvider
          ? <AiThinkingOrb decorative />
          : providerMark}
      </span>
      {/*
        利用者が付けた (あるいは指示から作られた) 名前はそのまま出す。**まだ名前が
        付いていない会話だけ**、今の言語の呼び名に差し替える — 既定文は作った時点の
        言語で保存されるので (D3)、そのまま出すと英語 UI に日本語が混じる。
      */}
      <span className="ai-chat-room-dialog-title">
        {running ? <Shimmer>{roomTitle}</Shimmer> : roomTitle}
      </span>
      {running && <span className="visually-hidden" role="status">{t("dock.status.running")}</span>}
    </button>
  );
}

/** 会話開始前に、現在の参照対象とすぐ使える編集指示を中央へまとめて提示する。 */
function ChatEmptyState({
  reference,
  onSelectPreset,
}: {
  reference: AiEditReference | null;
  onSelectPreset: (prompt: string) => void;
}) {
  const t = useT("ai");
  const tEditor = useT("editor");
  return (
    <Center className="ai-chat-empty" size="sm" gutter="none">
      <Stack className="ai-chat-empty-stack" gap="lg">
        <Stack className="ai-chat-empty-intro" gap="xs">
          <h3>{t("panel.emptyTitle")}</h3>
          <p>{t("panel.emptyBody")}</p>
        </Stack>

        <Stack className="ai-chat-empty-card" gap="xs" data-reference-kind={reference?.kind ?? "none"}>
          <div className="ai-chat-empty-card-title">
            <AtSign size={12} />
            <span>{t("panel.referenceTarget")}</span>
          </div>
          {reference ? (
            <>
              <strong>{getReferenceDisplayLabel(reference, t, tEditor)}</strong>
              <p>{getReferenceContextText(reference) || t("panel.noContent")}</p>
            </>
          ) : (
            <p>{t("panel.referenceHint")}</p>
          )}
        </Stack>

        <Stack className="ai-chat-empty-presets" gap="sm">
          <div className="ai-chat-empty-presets-title">{t("panel.quickActions")}</div>
          <Grid className="ai-chat-empty-presets-grid" columns={2} gap="sm" responsive={false}>
            {buildAiActionPresets(t).map((preset) => (
              <Button
                key={preset.id}
                tone="secondary"
                size="sm"
                className="ai-chat-empty-preset"
                onClick={() => onSelectPreset(preset.prompt)}
              >
                <span>{preset.label}</span>
              </Button>
            ))}
          </Grid>
        </Stack>
      </Stack>
    </Center>
  );
}

export function UserTurnView({
  turn,
  turnRef,
  onResend,
}: {
  turn: UserTurn;
  turnRef?: (element: HTMLDivElement | null) => void;
  onResend?: (turn: UserTurn) => void;
}) {
  const t = useT("ai");
  const tEditor = useT("editor");
  const hasMeta = turn.references.length > 0 || turn.attachments.length > 0 || turn.mentionedDocuments.length > 0;
  const storedOverlayPreviews = useMemo(() => {
    const previewAttachments = turn.attachments.filter((attachment) => (
      attachment.dataUrl && attachment.name.startsWith(SELECTED_SHAPES_ATTACHMENT_PREFIX)
    ));
    const keyedAttachmentReferences = new Set(previewAttachments.flatMap((attachment) => (
      attachment.sourceReferenceKey ? [attachment.sourceReferenceKey] : []
    )));
    const legacyPreviewCount = previewAttachments.filter((attachment) => !attachment.sourceReferenceKey).length;
    const referencesWithoutKeyedPng = turn.references.filter((turnReference) => (
      turnReference.overlaySelection
      && !keyedAttachmentReferences.has(getAiEditReferenceKey(turnReference))
    ));

    return referencesWithoutKeyedPng.slice(legacyPreviewCount).flatMap((turnReference) => {
        const turnReferenceKey = getAiEditReferenceKey(turnReference);
        // sourceReferenceKey導入前のPNGは参照との対応を持たない。旧履歴では参照順と
        // 添付順が一致していたため、未対応PNGを先頭の図形参照から1件ずつ消費する。
        const preview = buildStoredOverlaySelectionPreview(turnReference.overlaySelection!);
        return preview
          ? [{
            key: turnReferenceKey,
            preview,
            shapeCount: turnReference.overlaySelection!.shapes.length,
          }]
          : [];
      });
  }, [turn.attachments, turn.references]);
  const fallbackText = turn.attachments.length > 0
    ? t("chat.attachmentsOnly")
    : turn.mentionedDocuments.length > 0
      ? t("chat.mentionsOnly")
      : "";
  return (
    <div className="ai-chat-turn user" ref={turnRef}>
      <div className="ai-chat-user-bubble">
        {turn.queued && (
          <span className="ai-chat-queued-pill" role="status">{t("chat.queued")}</span>
        )}
        {turn.queueFailed && (
          <span className="ai-chat-queued-pill ai-chat-queued-pill--failed" role="status">
            <span>{t("chat.unsent")}</span>
            {onResend && (
              <button type="button" className="ai-chat-queued-resend" onClick={() => onResend(turn)}>
                {t("chat.resend")}
              </button>
            )}
          </span>
        )}
        {hasMeta && (
          <div className="ai-chat-user-meta">
            {turn.references.map((turnReference) => (
              <span
                key={getAiEditReferenceKey(turnReference)}
                className="ai-chat-user-ref"
                data-reference-kind={turnReference.kind}
              >
                @{getReferenceDisplayLabel(turnReference, t, tEditor)}
              </span>
            ))}
            {turn.references.some((turnReference) => turnReference.overlaySelection) && (
              <span className="ai-chat-user-ref" data-reference-kind="overlay">
                {t("reference.shapeCount", { replace: {
                  count: turn.references.reduce((count, turnReference) => count + (turnReference.overlaySelection?.shapes.length ?? 0), 0),
                } })}
              </span>
            )}
            {turn.attachments.map((attachment) => (
              isImageAttachment(attachment)
                ? null
                : (
                  <span key={attachment.id} className="ai-chat-user-ref">
                    <FileIcon size={11} />
                    {attachment.name}
                  </span>
                )
            ))}
            {turn.mentionedDocuments.map((item) => (
              <span key={item.id} className="ai-chat-user-ref">
                <FileText size={11} />
                {item.title}
              </span>
            ))}
          </div>
        )}
        {(turn.attachments.some(isImageAttachment) || storedOverlayPreviews.length > 0) && (
          <div className="ai-chat-user-attachments" aria-label={t("attachment.image")}>
            {turn.attachments.map((attachment) => (
              isImageAttachment(attachment)
                ? <UserAttachmentImage key={attachment.id} attachment={attachment} />
                : null
            ))}
            {storedOverlayPreviews.map((storedOverlayPreview) => (
              <UserOverlaySelectionImage
                key={storedOverlayPreview.key}
                preview={storedOverlayPreview.preview}
                shapeCount={storedOverlayPreview.shapeCount}
              />
            ))}
          </div>
        )}
        <AiStreamRenderer className="ai-chat-user-text" text={turn.instruction || fallbackText} />
      </div>
    </div>
  );
}

function ComposerOverlaySelectionPreview({
  preview,
  shapeCount,
}: {
  preview: AiEditShapeOnlyPreview;
  shapeCount: number;
}) {
  const t = useT("ai");
  const label = buildSelectedShapesAttachmentName(shapeCount);
  const frameSize = resolveComposerOverlayPreviewFrameSize(preview);
  return (
    <figure
      className="ai-chat-attachment-preview ai-chat-overlay-preview"
      title={label}
      style={{ width: frameSize.width, minWidth: 0, maxWidth: "100%" }}
    >
      <div
        className="ai-chat-attachment-thumb ai-chat-overlay-preview-stage"
        role="img"
        aria-label={label}
        style={{ height: frameSize.height, aspectRatio: "auto" }}
        dangerouslySetInnerHTML={{ __html: preview.svg }}
      />
      <figcaption className="ai-chat-attachment-name ai-chat-shape-label-chip">
        {getOverlayShapeCaption(shapeCount, t)}
      </figcaption>
    </figure>
  );
}

function resolveComposerOverlayPreviewFrameSize(preview: AiEditShapeOnlyPreview): {
  width: number;
  height: number;
} {
  const maxWidth = 112;
  const maxHeight = 94;
  const safeWidth = Math.max(1, preview.width);
  const safeHeight = Math.max(1, preview.height);
  const scale = Math.min(maxWidth / safeWidth, maxHeight / safeHeight);
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

function UserOverlaySelectionImage({
  preview,
  shapeCount,
}: {
  preview: AiEditShapeOnlyPreview;
  shapeCount: number;
}) {
  const t = useT("ai");
  const label = buildSelectedShapesAttachmentName(shapeCount);
  return (
    <figure className="ai-chat-user-attachment ai-chat-user-attachment--overlay" title={label}>
      <div
        className="ai-chat-user-attachment-image ai-chat-user-attachment-image--svg"
        role="img"
        aria-label={t("attachment.imageNamed", { replace: { name: label } })}
        dangerouslySetInnerHTML={{ __html: preview.svg }}
      />
      <figcaption className="ai-chat-shape-label-chip">{getOverlayShapeCaption(shapeCount, t)}</figcaption>
    </figure>
  );
}

function UserAttachmentImage({ attachment }: { attachment: DesktopAiEditChatAttachmentSummary }) {
  const t = useT("ai");
  const dimensions = attachment.width && attachment.height
    ? `${attachment.width} x ${attachment.height}`
    : null;
  const title = [attachment.name, dimensions].filter(Boolean).join(" · ");
  const selectedShapeCount = parseSelectedShapesAttachmentCount(attachment.name);
  const caption = selectedShapeCount !== null
    ? getOverlayShapeCaption(selectedShapeCount, t)
    : attachment.name;
  const isOverlayPreview = selectedShapeCount !== null;

  return (
    <figure
      className={`ai-chat-user-attachment${isOverlayPreview ? " ai-chat-user-attachment--overlay" : ""}`}
      title={title}
    >
      <span
        className="ai-chat-user-attachment-image"
        role="img"
        aria-label={t("attachment.imageNamed", { replace: { name: attachment.name } })}
        style={{ backgroundImage: `url("${attachment.dataUrl ?? ""}")` }}
      />
      <figcaption className={isOverlayPreview ? "ai-chat-shape-label-chip" : undefined}>{caption}</figcaption>
    </figure>
  );
}

function getOverlayShapeCaption(shapeCount: number, t: Translate<"ai">): string {
  const safeShapeCount = Math.max(1, Math.trunc(shapeCount));
  return safeShapeCount === 1
    ? t("attachment.shapeOne")
    : t("attachment.shapeRange", { replace: { last: safeShapeCount } });
}

export function MentionedDocumentChip({
  item,
  onRemove,
}: {
  item: AiEditMentionedDocumentContext;
  onRemove: () => void;
}) {
  const t = useT("ai");
  return (
    <span className="ai-chat-chip" data-reference-kind="sigma-doc" title={item.documentPath || item.title}>
      <FileText size={12} />
      <span className="ai-chat-chip-label">{item.title}</span>
      <button
        type="button"
        className="ai-chat-chip-remove"
        title={t("composer.removeMention")}
        aria-label={t("composer.removeMention")}
        onClick={onRemove}
      >
        <X size={12} />
      </button>
    </span>
  );
}

export function AiResourceChip({ item, onRemove }: { item: DesktopAiResourceManifestEntry; onRemove: () => void }) {
  const t = useT("ai");
  const display = resolveAiResourceDisplayMetadata(item, t);
  return (
    <span className="ai-chat-chip" data-reference-kind="ai-resource" title={display.description || display.title}>
      <Sparkles size={12} />
      <span className="ai-chat-chip-label">{display.title}</span>
      <span className="ai-chat-chip-meta">{t("composer.skills")}</span>
      <button
        type="button"
        className="ai-chat-chip-remove"
        title={t("composer.removeResource")}
        aria-label={t("composer.removeResource")}
        onClick={onRemove}
      >
        <X size={12} />
      </button>
    </span>
  );
}

export function SigmaDocMentionPopover({
  candidates,
  loading,
  activeIndex,
  onHover,
  onSelect,
}: {
  candidates: DesktopDocumentMetadata[];
  loading: boolean;
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (candidate: DesktopDocumentMetadata) => void;
}) {
  const t = useT("ai");
  return (
    <div className="ai-chat-mention-popover" role="listbox" aria-label={t("composer.mentionCandidates")}>
      <div className="ai-chat-mention-title">
        <AtSign size={12} />
        <span>SigmaDoc</span>
      </div>
      {loading && candidates.length === 0 ? (
        <div className="ai-chat-mention-empty">
          <Shimmer>{t("composer.searching")}</Shimmer>
        </div>
      ) : candidates.length === 0 ? (
        <div className="ai-chat-mention-empty">{t("composer.noCandidates")}</div>
      ) : (
        candidates.map((candidate, index) => (
          <button
            key={candidate.fileId}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className="ai-chat-mention-option"
            onMouseEnter={() => onHover(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(candidate);
            }}
          >
            <FileText size={15} />
            <span className="ai-chat-mention-main">
              <span className="ai-chat-mention-name">{candidate.title}</span>
              <span className="ai-chat-mention-path">{candidate.documentPath}</span>
            </span>
            <span className="ai-chat-mention-revision">rev.{candidate.revision}</span>
          </button>
        ))
      )}
    </div>
  );
}

export function AiResourceSlashPopover({
  candidates,
  activeIndex,
  onHover,
  onSelect,
}: {
  candidates: DesktopAiResourceManifestEntry[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (candidate: DesktopAiResourceManifestEntry) => void;
}) {
  const t = useT("ai");
  return (
    <div className="ai-chat-mention-popover" role="listbox" aria-label={t("composer.resourceCandidates")}>
      <div className="ai-chat-mention-title">
        <Sparkles size={12} />
        <span>{t("composer.resources")}</span>
      </div>
      {candidates.map((candidate, index) => (
        <button
          key={candidate.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className="ai-chat-mention-option"
          onMouseEnter={() => onHover(index)}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(candidate);
          }}
        >
          <Sparkles size={15} />
          <span className="ai-chat-mention-main">
            <span className="ai-chat-mention-name">{resolveAiResourceDisplayMetadata(candidate, t).title}</span>
            <span className="ai-chat-mention-path">{resolveAiResourceDisplayMetadata(candidate, t).description}</span>
          </span>
          <span className="ai-chat-mention-revision">{t("composer.skills")}</span>
        </button>
      ))}
    </div>
  );
}

export function AttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: AiEditAttachment;
  onRemove: () => void;
}) {
  const t = useT("ai");
  if (!isImageAttachment(attachment)) {
    return (
      <span className="ai-chat-chip ai-chat-file-chip" data-reference-kind="attachment" title={attachment.name}>
        <FileIcon size={12} />
        <span className="ai-chat-chip-label">{attachment.name}</span>
        <button
          type="button"
          className="ai-chat-chip-remove"
          title={t("attachment.remove")}
          aria-label={t("attachment.remove")}
          onClick={onRemove}
        >
          <X size={12} />
        </button>
      </span>
    );
  }

  const dimensions = attachment.width && attachment.height
    ? `${attachment.width} x ${attachment.height}`
    : null;
  const title = [attachment.name, dimensions].filter(Boolean).join(" · ");

  return (
    <div className="ai-chat-attachment-preview" title={title}>
      <span
        className="ai-chat-attachment-thumb"
        role="img"
        aria-label={t("attachment.imageNamed", { replace: { name: attachment.name } })}
        style={{ backgroundImage: `url("${attachment.dataUrl}")` }}
      />
      <span className="ai-chat-attachment-name">{attachment.name}</span>
      <button
        type="button"
        className="ai-chat-attachment-remove"
        title={t("attachment.remove")}
        aria-label={t("attachment.remove")}
        onClick={onRemove}
      >
        <X size={13} />
      </button>
    </div>
  );
}

/** インライン会話とサイドバーで共通の承認・破棄操作。 */
function AiTurnProposalActions({
  proposal,
  proposalBusy,
  onApplyProposal,
  onDismissProposal,
}: {
  proposal: AiEditPreviewState;
  proposalBusy: boolean;
  onApplyProposal?: (proposalIds: string[]) => Promise<AiProposalApplyOutcome>;
  onDismissProposal?: (proposalIds: string[]) => void;
}) {
  const t = useT("ai");
  const [applyError, setApplyError] = useState<string | null>(null);
  const runApply = async () => {
    if (!onApplyProposal || !proposal) {
      return;
    }
    setApplyError(null);
    try {
      const result = await onApplyProposal(proposal.proposalIds);
      if (!result.ok) {
        setApplyError(result.reason);
      }
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : t("card.applyFailed"));
    }
  };

  return (
    <>
      <AiProposalActions
        applying={proposalBusy}
        className="ai-chat-result-proposal-actions"
        actionClassName="ai-chat-result-proposal-action"
        showDismiss={Boolean(onDismissProposal)}
        showApply={Boolean(onApplyProposal)}
        onDismiss={onDismissProposal ? () => onDismissProposal(proposal.proposalIds) : undefined}
        onApply={onApplyProposal ? () => void runApply() : undefined}
      />
      {applyError && <p className="ai-chat-error">{applyError}</p>}
    </>
  );
}

/** AIの返答、成果物、提案判断、適用後の状態を一つの時系列項目として表示する。 */
export function AssistantTurnView({
  turn,
  clockNow,
  sourceReferences,
  shapePreview,
  appliedChange,
  onRevertAppliedChange,
  onOpenSourceDocument,
  restorable,
  onRestoreProposal,
  proposal,
  proposalDiff,
  proposalBusy = false,
  onApplyProposal,
  onDismissProposal,
}: {
  turn: AssistantTurn;
  clockNow: number;
  /** Phase 1: Agentic RAG. Already deduped by the caller (EditorShell); this
   * view dedupes again defensively since it's cheap and the invariant isn't
   * guaranteed across all future callers. */
  sourceReferences?: DesktopAiSourceReference[];
  shapePreview?: AiEditShapeOnlyPreview;
  appliedChange?: AiAppliedTurnChange;
  onRevertAppliedChange?: (proposalIds: string[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onOpenSourceDocument?: (params: AiSourceReferenceOpenDocumentParams) => void;
  /** Set only when this turn's latest proposal ended up rejected/reverted, i.e.
   * can be revived with a single click (see buildRestorableProposalsByTurnId). */
  restorable?: { proposalIds: string[] };
  onRestoreProposal?: (proposalIds: string | string[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
  proposal?: AiEditPreviewState | null;
  /** 承認前に「適用したら何が消えて何が足されるか」を同じGitHub風差分表示で見せるための
   * pending diff (see derivePendingDocumentDiff)。まだ承認されていないので、これが実際の
   * 適用後差分と一致する保証はない(人手の編集やAIの後続提案で状況が変わりうる)。 */
  proposalDiff?: AiAppliedDocumentDiff;
  proposalBusy?: boolean;
  onApplyProposal?: (proposalIds: string[]) => Promise<AiProposalApplyOutcome>;
  onDismissProposal?: (proposalIds: string[]) => void;
}) {
  const t = useT("ai");
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const fallbackAppliedDiff = useMemo(
    () => deriveAppliedDraftFallback(turn.result ? [turn.result.draft] : []),
    [turn.result],
  );

  const runRestore = async () => {
    if (!onRestoreProposal || !restorable) {
      return;
    }
    setRestoring(true);
    setRestoreError(null);
    try {
      const result = await onRestoreProposal(restorable.proposalIds);
      if (!result.ok) {
        setRestoreError(result.reason);
      }
    } finally {
      setRestoring(false);
    }
  };

  const runRevert = async () => {
    if (!onRevertAppliedChange || !appliedChange?.canRevert || appliedChange.revertProposalIds.length === 0) {
      return;
    }
    setReverting(true);
    setRevertError(null);
    try {
      const result = await onRevertAppliedChange(appliedChange.revertProposalIds);
      if (!result.ok) {
        setRevertError(result.reason);
      }
    } catch (error) {
      setRevertError(error instanceof Error ? error.message : t("panel.revertFailed"));
    } finally {
      setReverting(false);
    }
  };


  const showAppliedChange = Boolean(appliedChange || (turn.applied && !restorable));

  return (
    <div className="ai-chat-turn assistant">
      <AssistantActivity turn={turn} clockNow={clockNow} />

      {turn.error && <p className="ai-chat-error">{turn.error}</p>}

      {turn.result && (
        <div className="ai-chat-result">
          <AiStreamRenderer className="ai-chat-assistant-text" text={turn.result.draft.summary} />

          {proposal && (onApplyProposal || onDismissProposal) && (
            <div className="ai-chat-result-proposal" aria-label={t("panel.proposalActionsAria")}>
              {proposalDiff && (proposalDiff.body.length > 0 || proposalDiff.shapes.length > 0) && (
                <div className="ai-chat-result-proposal-diff" aria-label={t("card.proposedChanges")}>
                  <p className="ai-chat-result-proposal-diff-heading">{t("card.proposedChanges")}</p>
                  <AiAppliedDocumentDiffView diff={proposalDiff} />
                </div>
              )}
              <AiTurnProposalActions
                proposal={proposal}
                proposalBusy={proposalBusy}
                onApplyProposal={onApplyProposal}
                onDismissProposal={onDismissProposal}
              />
            </div>
          )}

          {!proposal && !showAppliedChange && (
            <AiChatShapeArtifact
              preview={shapePreview}
              outcome={restorable && turn.applied
                ? "reverted"
                : turn.applied
                  ? "applied"
                  : turn.dismissed
                    ? "dismissed"
                    : "pending"}
            />
          )}

          {turn.result.draft.plan.length > 0 && (
            <AiEditPlanList title={t("panel.plan")} items={turn.result.draft.plan} />
          )}
          {turn.result.draft.warnings.length > 0 && (
            <AiEditPlanList title={t("panel.warnings")} items={turn.result.draft.warnings} />
          )}
          {(turn.result.questions?.length ?? 0) > 0 && (
            <AiEditPlanList title={t("panel.checks")} items={turn.result.questions ?? []} />
          )}
          {/* appliedChange が無い間 (提案の読み込み前 / 適用済みの記録が残っていない turn) は
              取り消し可否そのものが不明なので、無効なボタンも理由も出さない — 「戻せません」と
              言い切ると、実際には戻せる turn について嘘になる。 */}
          {showAppliedChange && (
            <AiAppliedChangeCard
              autoApplied={appliedChange?.autoApplied}
              canRevert={Boolean(appliedChange?.canRevert && onRevertAppliedChange)}
              reverting={reverting}
              revertBlockedReason={appliedChange
                ? describeRevertBlockedReason(appliedChange.revertBlockedReason, t)
                : undefined}
              onRevert={onRevertAppliedChange && appliedChange ? () => void runRevert() : undefined}
            >
              <AiAppliedDocumentDiffView diff={appliedChange?.diff ?? fallbackAppliedDiff} />
            </AiAppliedChangeCard>
          )}
          {sourceReferences && sourceReferences.length > 0 && (
            <AiSourceReferenceChips
              sourceReferences={dedupeAiSourceReferences(sourceReferences)}
              onOpenDocument={onOpenSourceDocument}
            />
          )}
          {revertError && <p className="ai-chat-error">{revertError}</p>}
          {(restorable || turn.dismissed || turn.restored) && (
            <div className="ai-chat-result-status">
              {restorable && turn.applied ? (
                <span>{t("panel.reverted")}</span>
              ) : turn.dismissed ? (
                <span>{t("panel.discarded")}</span>
              ) : turn.restored ? (
                <span>{t("chat.history")}</span>
              ) : null}
              {restorable && onRestoreProposal && (
                <button
                  type="button"
                  className="ai-chat-result-restore"
                  disabled={restoring}
                  onClick={() => void runRestore()}
                  title={t("panel.restoreTooltip")}
                >
                  <RotateCcw size={12} />
                  {restoring ? <Shimmer>{t("panel.restoring")}</Shimmer> : t("panel.restore")}
                </button>
              )}
            </div>
          )}
          {restoreError && <p className="ai-chat-error">{restoreError}</p>}
        </div>
      )}
    </div>
  );
}

export function AiChatShapeArtifact({
  preview,
  outcome,
}: {
  preview?: AiEditShapeOnlyPreview;
  outcome: "pending" | "applied" | "dismissed" | "reverted";
}) {
  const t = useT("ai");
  if (!preview) {
    return null;
  }
  const label = outcome === "applied"
    ? t("panel.insertedShapes")
    : outcome === "reverted"
      ? t("panel.revertedShapes")
    : outcome === "dismissed"
      ? t("panel.discardedShapes")
      : t("panel.shapesToInsert");
  return (
    <figure className="ai-chat-shape-artifact" data-outcome={outcome}>
      <div
        className="ai-chat-shape-artifact-stage"
        role="img"
        aria-label={label}
        dangerouslySetInnerHTML={{ __html: preview.svg }}
      />
      <figcaption>{label}</figcaption>
    </figure>
  );
}

export function AssistantActivity({
  turn,
  clockNow,
  forceExpanded = false,
  headerAction = null,
}: {
  turn: AssistantTurn;
  clockNow: number;
  forceExpanded?: boolean;
  headerAction?: ReactNode;
}) {
  const t = useT("ai");
  const elapsedMs = Math.max(0, (turn.isRunning ? clockNow : turn.endedAt ?? clockNow) - turn.startedAt);
  const stateKey = `${turn.isRunning ? 1 : 0}|${turn.result ? 1 : 0}|${turn.error ? 1 : 0}`;
  const [override, setOverride] = useState<{ key: string; value: boolean } | null>(null);
  // MCP tool-result PNG previews (e.g. render_visual_edit_session) attached to
  // an activity row: click a thumbnail to see it full-size in a simple
  // click-to-toggle lightbox (no existing modal primitive to reuse here).
  const [zoomedImageUrl, setZoomedImageUrl] = useState<string | null>(null);
  const zoomRequest = useRef(0);
  const [imageLoadError, setImageLoadError] = useState(false);
  useEffect(() => () => { zoomRequest.current += 1; }, []);
  const openImage = async (image: { dataUrl: string; generatedImage?: { runId: string; imageId: string } }) => {
    const request = ++zoomRequest.current;
    setImageLoadError(false);
    setZoomedImageUrl(image.dataUrl);
    if (!image.generatedImage) return;
    try {
      const original = await getDesktopBridge()?.aiEdit.getGeneratedImage?.(image.generatedImage.runId, image.generatedImage.imageId);
      if (request !== zoomRequest.current) return;
      if (original?.dataUrl) setZoomedImageUrl(original.dataUrl);
      else setImageLoadError(true);
    } catch {
      if (request === zoomRequest.current) setImageLoadError(true);
    }
  };
  const closeImage = () => { zoomRequest.current += 1; setZoomedImageUrl(null); setImageLoadError(false); };
  const hasGeneratedImage = turn.events.some((event) => event.images?.some((image) => image.generatedImage));
  const expanded = forceExpanded || (override?.key === stateKey ? override.value : hasGeneratedImage);
  const toggle = () => setOverride({ key: stateKey, value: !expanded });

  const summary = useMemo(() => {
    if (turn.error) {
      return t("panel.stoppedWithError");
    }

    if (turn.isRunning) {
      return summarizeRunningActivity(turn.events, t);
    }

    const toolCount = turn.events.filter((event) => event.kind === "tool").length;
    const validationCount = turn.events.filter((event) => event.kind === "validation").length;
    const parts: string[] = [];
    if (toolCount > 0) parts.push(t("panel.toolRuns", { replace: { count: toolCount } }));
    if (validationCount > 0) parts.push(t("panel.validations", { replace: { count: validationCount } }));
    parts.push(formatDuration(elapsedMs));
    return parts.join(" · ");
  }, [turn.error, turn.isRunning, turn.events, elapsedMs, t]);

  return (
    <div
      className={`ai-activity${forceExpanded ? " ai-activity--popover" : ""}`.trim()}
      data-running={turn.isRunning}
      data-error={!!turn.error}
    >
      {forceExpanded ? (
        <div className="ai-activity-popover-head">
          {turn.isRunning && (
            <AiThinkingOrb events={turn.events} label={summary} decorative />
          )}
          <span className="ai-activity-chip-text">
            {turn.isRunning ? <Shimmer>{summary}</Shimmer> : summary}
          </span>
          {turn.isRunning && (
            <span className="ai-activity-time" aria-hidden="true">{formatDuration(elapsedMs)}</span>
          )}
          {headerAction && (
            <span className="ai-activity-popover-action">{headerAction}</span>
          )}
        </div>
      ) : (
        <button type="button" className="ai-activity-chip" onClick={toggle} aria-expanded={expanded}>
          {turn.isRunning && (
            <AiThinkingOrb events={turn.events} label={summary} decorative />
          )}
          <span className="ai-activity-chip-text">
            {turn.isRunning ? <Shimmer>{summary}</Shimmer> : summary}
          </span>
          {turn.isRunning && (
            <span className="ai-activity-time" aria-hidden="true">{formatDuration(elapsedMs)}</span>
          )}
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      )}

      {expanded && (
        <div className="ai-activity-body">
          {turn.reasoningText.trim() && (
            <p className="ai-activity-reasoning">{truncateLiveText(turn.reasoningText)}</p>
          )}
          <AssistantPlanChecklist steps={turn.planSteps} explanation={turn.planExplanation} />
          {turn.events.length > 0 ? (
            <ul className="ai-activity-list">
              {turn.events.map((event, index) => {
                const spinning =
                  turn.isRunning &&
                  (event.kind === "activity"
                    ? event.itemStatus !== "completed"
                    : index === turn.events.length - 1 && event.kind !== "error");
                return (
                  <li
                    key={event.id}
                    className="ai-activity-item"
                    data-kind={event.kind}
                    data-status={event.itemStatus}
                  >
                    <span className="ai-activity-item-icon">
                      {spinning ? (
                        <Shimmer variant="marker" className="ai-activity-item-shimmer">…</Shimmer>
                      ) : event.kind === "error" ? (
                        <X size={12} />
                      ) : (
                        <Check size={12} />
                      )}
                    </span>
                    <span className="ai-activity-item-message">{formatAgentActivityLabel(event, t)}</span>
                    {event.images && event.images.length > 0 && (
                      <div className="ai-activity-item-images">
                        {event.images.map((image, imageIndex) => (
                          <button
                            key={imageIndex}
                            type="button"
                            className="ai-activity-item-image-thumb"
                            onClick={() => { void openImage(image); }}
                            aria-label={t("panel.zoomPreview")}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={image.dataUrl} alt={t("panel.toolPreviewImage")} />
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="ai-activity-empty">{t("panel.noRunLog")}</p>
          )}
          {turn.streamText.trim() && (
            <AiStreamRenderer
              className="ai-activity-stream"
              text={truncateLiveText(turn.streamText)}
            />
          )}
        </div>
      )}
      {imageLoadError && <p role="status">{t("panel.generatedImageUnavailable")}</p>}
      {zoomedImageUrl && createPortal(
        <div
          className="ai-activity-image-lightbox"
          role="button"
          tabIndex={-1}
          aria-label={t("panel.closeZoom")}
          onClick={closeImage}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoomedImageUrl} alt={t("panel.zoomedPreview")} />
        </div>,
        document.body,
      )}
    </div>
  );
}

export function AssistantPlanChecklist({
  steps,
  explanation,
}: {
  steps: AiEditPlanStep[];
  explanation: string | null;
}) {
  if (steps.length === 0) {
    return null;
  }

  return (
    <div className="ai-activity-plan">
      {explanation?.trim() && <p className="ai-activity-plan-explanation">{explanation.trim()}</p>}
      <ul className="ai-activity-plan-list">
        {steps.map((step, index) => (
          <li
            key={`${index}:${step.step}`}
            className="ai-activity-plan-item"
            data-status={step.status}
          >
            <span className="ai-activity-plan-icon">
              {step.status === "completed" ? (
                <Check size={12} />
              ) : step.status === "inProgress" ? (
                <Shimmer variant="marker" className="ai-activity-plan-icon-shimmer">…</Shimmer>
              ) : (
                <span aria-hidden="true">·</span>
              )}
            </span>
            <span className="ai-activity-plan-step">{step.step}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AiEditPlanList({ title, items, compact = false }: { title: string; items: string[]; compact?: boolean }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className={`ai-edit-plan-list ${compact ? "compact" : ""}`}>
      <div className="ai-edit-preview-title">{title}</div>
      <ol>
        {items.map((item, index) => (
          <li key={`${title}:${index}`}>
            <AiStreamRenderer className="ai-edit-plan-item-text" text={item} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, "0")}` : `${seconds}s`;
}

function truncateLiveText(text: string): string {
  const normalized = text.trim();
  return normalized.length > 1800 ? `...${normalized.slice(normalized.length - 1800)}` : normalized;
}

const OVERLAY_SELECTION_THUMBNAIL_MAX_DIMENSION_PX = 1024;
const OVERLAY_SELECTION_THUMBNAIL_PIXEL_RATIO = 2;

async function createAttachmentsWithSelectedOverlayPreview({
  attachments,
  overlayPreviews,
  overlaySelection,
  activeReferenceKey,
}: {
  attachments: AiEditAttachment[];
  overlayPreviews: OverlayReferencePreview[];
  overlaySelection: OverlaySelectionSummary;
  activeReferenceKey: string | null;
}): Promise<AiEditAttachment[]> {
  const requestedPreviews = overlayPreviews.slice(0, MAX_AI_EDIT_ATTACHMENTS);
  const generatedPreviews: AiEditAttachment[] = [];
  for (const overlayPreview of requestedPreviews) {
    const attachment = await createAttachmentFromOverlayPreview(overlayPreview);
    if (attachment) {
      generatedPreviews.push(attachment);
    }
  }

  // SVGからPNGへの変換ができない古い/特殊な画像素材でも、従来どおりinline画像単体は
  // AIへ渡せるように残す。通常は上の複合プレビューが選択図形全体を表す。
  const activePreviewWasGenerated = activeReferenceKey !== null
    && generatedPreviews.some((attachment) => attachment.sourceReferenceKey === activeReferenceKey);
  // preview生成に失敗した予約枠はまずmanual添付へ返す。ユーザーが明示添付した画像を
  // rasterize失敗だけで静かに落とさず、残り枠があれば従来の選択画像fallbackを足す。
  const manualAttachments = attachments.slice(
    0,
    Math.max(0, MAX_AI_EDIT_ATTACHMENTS - generatedPreviews.length),
  );
  const selectedImageAttachments: AiEditAttachment[] = [];
  if (activeReferenceKey && !activePreviewWasGenerated) {
    const remainingOverlaySlots = MAX_AI_EDIT_ATTACHMENTS
      - generatedPreviews.length
      - manualAttachments.length;
    const imageShapes = overlaySelection.selectedShapes
      .filter((shape): shape is Extract<OverlayShape, { type: "image" }> => shape.type === "image")
      .slice(0, remainingOverlaySlots);
    for (const shape of imageShapes) {
      const asset = overlaySelection.selectedAssets[shape.props.assetId];
      if (!asset || !asset.props.src.startsWith("data:image/")) {
        continue;
      }
      const attachment = await createAttachmentFromSelectedImageShape(shape, asset, activeReferenceKey);
      if (attachment) {
        selectedImageAttachments.push(attachment);
      }
    }
  }

  return [...manualAttachments, ...generatedPreviews, ...selectedImageAttachments]
    .slice(0, MAX_AI_EDIT_ATTACHMENTS);
}

export function buildSelectedOverlayShapePreview(overlaySelection: OverlaySelectionSummary) {
  if (overlaySelection.selectedShapes.length === 0) {
    return null;
  }
  return buildShapesSvgPreview(overlaySelection.selectedShapes, overlaySelection.selectedAssets, {
    paddingPx: 10,
    minWidthPx: 48,
    minHeightPx: 48,
  });
}

export function buildStoredOverlaySelectionPreview(selection: AiEditOverlaySelectionContext) {
  // Historical turns created before selected-shape PNG attachments were added
  // still retain their native shape JSON. Re-render those native shapes so the
  // chat remains visually understandable. Image-shape pixels are intentionally
  // excluded because the persisted reference stores asset metadata, not src.
  const nativeShapes = selection.shapes.filter((shape) => shape.type !== "image");
  return buildShapesSvgPreview(nativeShapes, {}, {
    paddingPx: 10,
    minWidthPx: 48,
    minHeightPx: 48,
  });
}

async function createAttachmentFromOverlayPreview(
  overlayPreview: OverlayReferencePreview,
): Promise<AiEditAttachment | null> {
  const { preview, referenceKey, shapeCount } = overlayPreview;
  try {
    const longestSide = Math.max(preview.width, preview.height);
    const scale = Math.min(
      OVERLAY_SELECTION_THUMBNAIL_PIXEL_RATIO,
      OVERLAY_SELECTION_THUMBNAIL_MAX_DIMENSION_PX / Math.max(1, longestSide),
    );
    const width = Math.max(1, Math.round(preview.width * scale));
    const height = Math.max(1, Math.round(preview.height * scale));
    const image = await loadImageElement(toSvgDataUrl(preview.svg));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/png");
    const logicalSelectionCount = Math.max(1, shapeCount);
    return {
      id: createAttachmentId(),
      name: `${buildSelectedShapesAttachmentName(logicalSelectionCount)}.png`,
      mimeType: "image/png",
      dataUrl,
      width,
      height,
      fileSize: estimateDataUrlSize(dataUrl),
      sourceReferenceKey: referenceKey,
    };
  } catch {
    return null;
  }
}

function toSvgDataUrl(svg: string): string {
  // data URLを使うと、foreignObjectを含むSVGをblob URL経由で描画した際にChromiumが
  // canvasをtaint扱いする問題を避けられる。最終的な会話履歴にはPNGだけを保存する。
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function hasSelectedOverlayImageAttachments(overlaySelection: OverlaySelectionSummary): boolean {
  return overlaySelection.selectedShapes.some((shape) => {
    if (shape.type !== "image") {
      return false;
    }
    const asset = overlaySelection.selectedAssets[shape.props.assetId];
    return Boolean(asset?.props.src.startsWith("data:image/"));
  });
}

async function createAttachmentFromSelectedImageShape(
  shape: Extract<OverlayShape, { type: "image" }>,
  asset: OverlayAsset,
  sourceReferenceKey?: string,
): Promise<AiEditAttachment | null> {
  try {
    const image = await loadImageElement(asset.props.src);
    const canvas = document.createElement("canvas");
    drawCroppedImageToCanvas(canvas, image, shape, asset);
    const dataUrl = canvas.toDataURL("image/png");
    return {
      id: createAttachmentId(),
      name: `${tAiNow("attachment.selectedImagePrefix")}${asset.props.name || shape.id}.png`,
      mimeType: "image/png",
      dataUrl,
      width: canvas.width,
      height: canvas.height,
      fileSize: estimateDataUrlSize(dataUrl),
      ...(sourceReferenceKey ? { sourceReferenceKey } : {}),
    };
  } catch {
    return null;
  }
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(tAiNow("panel.imageLoadFailed")));
    image.src = src;
  });
}

function estimateDataUrlSize(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  return Math.floor(base64.length * 0.75);
}

function getRoomPreviewText(room: AiEditChatRoom): string {
  for (let index = room.turns.length - 1; index >= 0; index -= 1) {
    const turn = room.turns[index];
    if (turn.role === "user") {
      const text = turn.instruction.trim();
      if (text) {
        return truncateRoomPreview(text);
      }
    } else {
      const text = turn.result?.draft.summary ?? turn.error ?? turn.events[turn.events.length - 1]?.message ?? "";
      if (text.trim()) {
        return truncateRoomPreview(text);
      }
    }
  }
  return tAiNow("chat.noMessages");
}

function getRoomSearchText(room: AiEditChatRoom): string {
  const turnTexts = room.turns.flatMap((turn) => {
    if (turn.role === "user") {
      return [
        turn.instruction,
        ...turn.references.map((turnReference) => getReferenceDisplayLabel(turnReference, tAiNow, tEditorNow)),
        ...turn.attachments.map((attachment) => attachment.name),
        ...turn.mentionedDocuments.map((item) => `${item.title} ${item.documentPath}`),
      ];
    }
    return [
      turn.result?.draft.summary ?? "",
      ...(turn.result?.draft.plan ?? []),
      ...(turn.result?.draft.warnings ?? []),
      ...(turn.result?.questions ?? []),
      turn.error ?? "",
    ];
  });
  return [room.title, getRoomPreviewText(room), ...turnTexts].join(" ");
}

function normalizeHistorySearchText(value: string): string {
  return value.trim().toLowerCase();
}

function truncateRoomPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 72 ? `${normalized.slice(0, 72)}...` : normalized;
}

function getOverlaySelectionTargetBlockId(selection: AiEditOverlaySelectionContext | null): string | null {
  if (!selection) {
    return null;
  }

  const shapesById = new Map(selection.shapes.map((shape) => [shape.id, shape]));
  for (const shape of selection.shapes) {
    const blockId = getShapeAnchorBlockId(shape, shapesById, new Set());
    if (blockId) {
      return blockId;
    }
  }

  return null;
}

function getShapeAnchorBlockId(
  shape: AiEditOverlaySelectionContext["shapes"][number],
  shapesById: Map<string, AiEditOverlaySelectionContext["shapes"][number]>,
  visited: Set<string>,
): string | null {
  if (visited.has(shape.id)) {
    return null;
  }
  visited.add(shape.id);

  const anchor = shape.anchor;
  if (!anchor) {
    return null;
  }

  if (anchor.type === "block") {
    return anchor.blockId;
  }

  if (anchor.type === "shape") {
    const parentShape = shapesById.get(anchor.shapeId);
    return parentShape ? getShapeAnchorBlockId(parentShape, shapesById, visited) : null;
  }

  return null;
}

export function getReferenceContextText(reference: AiEditReference): string {
  const overlayText = reference.overlaySelection?.shapes.length
    ? tAiNow(reference.overlaySelection.shapes.some((shape) => shape.type === "image")
      ? "panel.selectedImagesAndShapes"
      : "panel.selectedShapes", { replace: {
        shapes: reference.overlaySelection.shapes.map((shape) => `${shape.type}:${shape.id}`).join(", "),
      } })
    : "";
  const baseText = (() => {
    if (reference.overlaySelection && reference.targetType.startsWith("overlayShape:")) {
      return getReferenceDisplayLabel(reference, tAiNow, tEditorNow);
    }

    if (reference.kind === "textSelection") {
      return reference.selectedText || reference.excerpt;
    }

    if (reference.kind === "inlineMath") {
      return reference.tex ? `$${reference.tex}$` : reference.excerpt;
    }

    return reference.excerpt;
  })();

  return [baseText, overlayText].filter(Boolean).join("\n");
}

function blockToPreviewText(block: EditableBlock): string {
  if (block.type === "section") {
    return block.title;
  }

  if (block.type === "heading" || block.type === "paragraph") {
    return inlineNodesToPreviewText(block.children);
  }

  if (block.type === "list") {
    return listToPreviewText(block.items);
  }

  if (block.type === "listItem") {
    return listItemToPreviewText(block);
  }

  if (block.type === "layoutSection") {
    return block.children.map(blockToPreviewText).filter(Boolean).join("\n");
  }

  if (block.type === "boxBlock") {
    return [
      inlineNodesToPreviewText(block.title ?? []),
      boxBlockChildrenToPreviewText(tEditorNow("block.paragraph"), block.blocks),
    ].filter(Boolean).join("\n");
  }

  if (block.type === "divider") {
    return "";
  }

  if (block.type === "quote") {
    return block.blocks.map(blockToPreviewText).filter(Boolean).join("\n");
  }

  if (block.type === "codeBlock") {
    return inlineNodesToPreviewText(block.children);
  }

  const answer = block.answer
    ? tAiNow("panel.answerLine", { replace: { answer: block.answer.expected } })
    : "";
  return [
    richBlocksToPreviewText(tEditorNow("block.problemLead"), block.lead),
    richBlocksToPreviewText(tEditorNow("block.problemPrompt"), block.prompt),
    answer,
    richBlocksToPreviewText(tEditorNow("block.problemHints"), block.hints),
    richBlocksToPreviewText(tEditorNow("block.problemSolution"), block.solution),
  ]
    .filter(Boolean)
    .join("\n");
}

function richBlocksToPreviewText(label: string, blocks: ProblemAreaBlock[]): string {
  if (blocks.length === 0) {
    return "";
  }

  return `${label}:\n${blocks.map(problemAreaBlockToPreviewText).join("\n")}`;
}

function problemAreaBlockToPreviewText(block: ProblemAreaBlock): string {
  if (block.type === "layoutSection") {
    return block.children.map(layoutSectionChildToPreviewText).filter(Boolean).join("\n");
  }
  if (block.type === "boxBlock" || block.type === "quote" || block.type === "codeBlock") {
    return blockToPreviewText(block);
  }
  if (block.type === "divider") {
    return "";
  }
  return richBlockToPreviewText(block);
}

function boxBlockChildrenToPreviewText(label: string, blocks: BoxBlockChildBlock[]): string {
  if (blocks.length === 0) {
    return "";
  }

  return `${label}:\n${blocks.map(boxBlockChildToPreviewText).filter(Boolean).join("\n")}`;
}

function boxBlockChildToPreviewText(block: BoxBlockChildBlock): string {
  if (block.type === "problem") return blockToPreviewText(block);
  if (block.type === "layoutSection") {
    return block.children.map(layoutSectionChildToPreviewText).filter(Boolean).join("\n");
  }
  return layoutSectionChildToPreviewText(block);
}

function layoutSectionChildToPreviewText(block: LayoutSectionChildBlock): string {
  if (block.type === "section") {
    return block.title;
  }
  if (block.type === "divider") {
    return "";
  }
  if (block.type === "boxBlock" || block.type === "quote" || block.type === "codeBlock") {
    return blockToPreviewText(block);
  }
  return richBlockToPreviewText(block);
}

function richBlockToPreviewText(block: RichBlock): string {
  if (block.type === "list") {
    return listToPreviewText(block.items);
  }

  return inlineNodesToPreviewText(block.children);
}

function listToPreviewText(items: ListItemNode[], depth = 0): string {
  return items.map((item) => {
    const marker = `${"  ".repeat(depth)}- `;
    const nested = (item.nested ?? []).map((list) => listToPreviewText(list.items, depth + 1)).filter(Boolean);
    return [marker + listItemToPreviewText(item), ...nested].filter(Boolean).join("\n");
  }).join("\n");
}

function listItemToPreviewText(item: ListItemNode): string {
  return inlineNodesToPreviewText(item.children);
}

function inlineNodesToPreviewText(children: InlineNode[]): string {
  return children
    .map((child) => {
      if (child.type === "text") {
        return child.text;
      }
      return `$${child.tex}$`;
    })
    .join("");
}

export function getActiveSigmaDocMentionQuery(value: string, cursor: number): ActiveMentionQuery | null {
  if (cursor < 0 || cursor > value.length) {
    return null;
  }

  const beforeCursor = value.slice(0, cursor);
  const lineStart = Math.max(beforeCursor.lastIndexOf("\n") + 1, 0);
  const atIndex = beforeCursor.lastIndexOf("@");
  if (atIndex < lineStart) {
    return null;
  }

  const query = value.slice(atIndex + 1, cursor);
  if (/[\t\r\n]/.test(query) || /\s$/.test(query)) {
    return null;
  }

  return {
    start: atIndex,
    end: cursor,
    query,
  };
}

export function getActiveAiResourceSlashQuery(value: string, cursor: number): ActiveSlashQuery | null {
  if (cursor < 0 || cursor > value.length) {
    return null;
  }

  const beforeCursor = value.slice(0, cursor);
  const lineStart = Math.max(beforeCursor.lastIndexOf("\n") + 1, 0);
  const slashIndex = beforeCursor.lastIndexOf("/");
  if (slashIndex < lineStart) {
    return null;
  }
  if (slashIndex > 0 && !/[\s(「『（]$/.test(value.slice(0, slashIndex))) {
    return null;
  }

  const query = value.slice(slashIndex + 1, cursor);
  if (/[\t\r\n]/.test(query) || /\s$/.test(query)) {
    return null;
  }

  return {
    start: slashIndex,
    end: cursor,
    query,
  };
}

// @/ の候補選択は入力欄にタイトルを挿入せず、トリガー文字列そのものを削除してチップだけ
// 残す (チップと入力欄テキストの二重管理をやめるため)。ActiveMentionQuery/ActiveSlashQuery
// はどちらも `{ start, end }` のトリガー範囲を持つので、共通の1関数で両方に使える。
export function removeActiveTriggerRange(value: string, range: { start: number; end: number }): string {
  const before = value.slice(0, range.start);
  const after = value.slice(range.end);
  // トリガーの手前にあった区切り空白は、後ろが空/空白/改行で始まる (=もう区切りが要らない)
  // なら畳む。両側とも空白付きの場合(前後の連結)にも、末尾で消える場合(afterが空)にも効く。
  if (before.endsWith(" ") && (after.length === 0 || after.startsWith(" ") || after.startsWith("\n"))) {
    return `${before.slice(0, -1)}${after}`;
  }
  // 行頭のトリガーを消したら、後ろに残った区切り空白だけが浮くので落とす。
  if (before.length === 0 && after.startsWith(" ")) {
    return after.slice(1);
  }
  return `${before}${after}`;
}

export function filterAiResourceSlashCandidates({
  resources,
  query,
  selectedIds,
  provider,
  translate,
}: {
  resources: DesktopAiResourceManifestEntry[];
  query: string;
  selectedIds: string[];
  provider: AiProvider;
  translate?: Translate<"ai">;
}): DesktopAiResourceManifestEntry[] {
  const selected = new Set(selectedIds);
  const providerKey = toAiResourceProvider(provider);
  const normalizedQuery = query.trim().toLowerCase();
  return resources
    .filter((resource) => resource.enabled && resource.providers.includes(providerKey) && !selected.has(resource.id))
    .filter((resource) => {
      if (!normalizedQuery) {
        return true;
      }
      const display = translate ? resolveAiResourceDisplayMetadata(resource, translate) : resource;
      const text = [
        resource.title,
        resource.description,
        ...resource.tags,
        display.title,
        display.description,
        ...display.tags,
        resource.sourcePath,
      ].join(" ").toLowerCase();
      return text.includes(normalizedQuery);
    })
    .slice(0, 8);
}

/** スキルのトグル選択: 選択済みなら外し、そうでなければ追加する。`/`スキルポップオーバー
 * (常に追加のみ) と統一ピッカー (トグル) の両方で共有するので `addOnly` で分岐する。 */
export function toggleAiResourceSelection(
  current: string[],
  resourceId: string,
  options: { addOnly?: boolean } = {},
): string[] {
  if (!current.includes(resourceId)) {
    return [...current, resourceId];
  }
  return options.addOnly ? current : current.filter((id) => id !== resourceId);
}

/** 統一ピッカー/@メンションの「追加」側: 既に同じ fileId があれば何もせず、なければ上限
 * (cap) でクランプして追加する。 */
export function upsertMentionedDocument(
  current: AiEditMentionedDocumentContext[],
  next: AiEditMentionedDocumentContext,
  cap: number,
): AiEditMentionedDocumentContext[] {
  if (current.some((item) => item.fileId === next.fileId)) {
    return current;
  }
  return [...current, next].slice(0, cap);
}

/** 統一ピッカーの「解除」側: 指定した fileId のドキュメントを取り除く。 */
export function removeMentionedDocumentByFileId(
  current: AiEditMentionedDocumentContext[],
  fileId: string,
): AiEditMentionedDocumentContext[] {
  return current.filter((item) => item.fileId !== fileId);
}

export function filterSigmaDocMentionCandidates({
  files,
  query,
  currentFileId,
  mentionedFileIds,
}: {
  files: DesktopDocumentMetadata[];
  query: string;
  currentFileId: string;
  mentionedFileIds: string[];
}): DesktopDocumentMetadata[] {
  const normalizedQuery = normalizeMentionSearchText(query);
  const mentioned = new Set(mentionedFileIds);
  return files
    .filter((file) => file.fileId !== currentFileId && !mentioned.has(file.fileId))
    .filter((file) => {
      if (!normalizedQuery) {
        return true;
      }
      return normalizeMentionSearchText(`${file.title} ${file.documentPath}`).includes(normalizedQuery);
    })
    .slice(0, MAX_SIGMA_DOC_MENTION_CANDIDATES);
}

function normalizeMentionSearchText(value: string): string {
  return value.trim().toLowerCase();
}

export function createMentionedDocumentContext(
  metadata: DesktopDocumentMetadata,
  document: SigmaDocument,
): AiEditMentionedDocumentContext {
  return {
    id: createMentionedDocumentId(metadata.fileId),
    fileId: metadata.fileId,
    title: metadata.title,
    documentPath: metadata.documentPath ?? "",
    revision: metadata.revision,
    excerpt: createMentionedDocumentExcerpt(document),
    document,
  };
}

function createMentionedDocumentExcerpt(document: SigmaDocument): string {
  const title = `title: ${resolveDocumentTitle(document)}`;
  const body = document.content
    .slice(0, 8)
    .map((block) => blockToPreviewText(block))
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
  const excerpt = [title, body].filter(Boolean).join("\n");
  return excerpt.length > MAX_MENTIONED_DOCUMENT_EXCERPT
    ? `${excerpt.slice(0, MAX_MENTIONED_DOCUMENT_EXCERPT)}...`
    : excerpt;
}

function createMentionedDocumentId(fileId: string): string {
  return `sigma-doc-${fileId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

export function isImageAttachment(
  attachment: { mimeType?: string | null; dataUrl?: string | null },
): boolean {
  return Boolean(
    attachment.mimeType?.startsWith("image/")
    || attachment.dataUrl?.startsWith("data:image/"),
  );
}

export function getClipboardImageFiles(clipboardData: DataTransfer): File[] {
  const itemFiles = Array.from(clipboardData.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (itemFiles.length > 0) {
    return itemFiles;
  }

  return Array.from(clipboardData.files).filter(isImageFile);
}

export function createAttachmentId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `media_${crypto.randomUUID()}`;
  }

  return `media_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function createAttachmentName(file: File, source: "file" | "paste"): string {
  const fileName = file.name.trim();
  if (source === "file" && fileName) {
    return fileName;
  }

  if (source === "paste" && fileName && !isGenericClipboardImageName(fileName)) {
    return fileName;
  }

  return `image_${createRandomHex(6)}.${getImageExtension(file.type)}`;
}

export async function createAiEditAttachmentFromFile(
  file: File,
  source: "file" | "paste",
): Promise<AiEditAttachment> {
  const rawDataUrl = await readFileAsDataUrl(file);
  const detectedMimeType = file.type || getDataUrlMimeType(rawDataUrl) || "application/octet-stream";
  // Some OS file pickers omit the MIME type for PDFs. Keep every provider's
  // data-URL parser on the same PDF path in that case.
  const mimeType = detectedMimeType === "application/octet-stream" && /\.pdf$/i.test(file.name)
    ? "application/pdf"
    : detectedMimeType;
  const dataUrl = mimeType !== detectedMimeType
    ? rawDataUrl.replace(/^data:[^;,]*/, `data:${mimeType}`)
    : rawDataUrl;
  const dimensions = isImageAttachment({ mimeType, dataUrl })
    ? await readImageDimensions(dataUrl)
    : null;
  return {
    id: createAttachmentId(),
    name: createAttachmentName(file, source),
    mimeType,
    dataUrl,
    ...(dimensions?.width ? { width: dimensions.width } : {}),
    ...(dimensions?.height ? { height: dimensions.height } : {}),
    fileSize: file.size,
  };
}

function getDataUrlMimeType(dataUrl: string): string | null {
  const match = /^data:([^;,]+)/i.exec(dataUrl);
  return match?.[1] ?? null;
}

function isGenericClipboardImageName(fileName: string): boolean {
  return /^(image|screenshot|clipboard)(?:[-_\s]?\d+)?\.(png|jpe?g|webp|gif|svg)$/i.test(fileName);
}

function getImageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/svg+xml") return "svg";
  const match = /^image\/([a-z0-9.+-]+)$/i.exec(mimeType);
  return match?.[1]?.replace(/[^a-z0-9]/gi, "") || "png";
}

function createRandomHex(length: number): string {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, length);
  }

  return Math.random().toString(16).slice(2, 2 + length).padEnd(length, "0");
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error(tAiNow("composer.fileReadFailed")));
      }
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error(tAiNow("composer.fileReadFailed"))));
    reader.readAsDataURL(file);
  });
}

export function readImageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = src;
  });
}

// ゲート画面でもプロバイダを切り替えられるようにするトグル (片方が未接続でももう片方へ移れる)。
export function ProviderSwitch({
  provider,
  onChange,
  disabled,
}: {
  provider: AiProvider;
  onChange: (provider: AiProvider) => void;
  disabled?: boolean;
}) {
  const t = useT("ai");
  return (
    <div className="ai-provider-switch" role="radiogroup" aria-label={t("composer.providerSwitchAria")}>
      <button
        type="button"
        role="radio"
        aria-checked={provider === "chatgpt"}
        aria-label="ChatGPT"
        title="ChatGPT"
        className="ai-provider-switch-item"
        data-active={provider === "chatgpt"}
        onClick={() => onChange("chatgpt")}
        disabled={disabled}
      >
        <OpenAiMark size={14} />
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={provider === "claude"}
        aria-label="Claude"
        title="Claude"
        className="ai-provider-switch-item"
        data-active={provider === "claude"}
        onClick={() => onChange("claude")}
        disabled={disabled}
      >
        <ClaudeMark size={14} />
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={provider === "antigravity"}
        aria-label="Antigravity"
        title="Antigravity"
        className="ai-provider-switch-item"
        data-active={provider === "antigravity"}
        onClick={() => onChange("antigravity")}
        disabled={disabled}
      >
        <AntigravityMark size={14} />
      </button>
    </div>
  );
}
