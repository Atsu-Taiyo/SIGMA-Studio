import {
  type AiAppliedTurnChange,
  type AiEditPreviewState,
  type StaleMcpProposalGroup,
} from "@/features/ai-edit/model/preview";
import type { OverlaySelectionSummary } from "@/components/editor/page-overlay-types";
import type { AiProposalApplyOutcome } from "@/features/ai-edit";
import { type AiSourceReferenceOpenDocumentParams } from "./ai-source-reference-contracts";
import type { SigmaDocument } from "@/features/document";
import { type AiEditReference } from "@/lib/ai/ai-edit-reference";
import { type AiEditShapeOnlyPreview } from "@/lib/ai/ai-edit-shape-preview";
import type { AiDisplayMode } from "@/lib/ai/ai-surface";
import type { AiProposalContent } from "../model/proposal-content";
import type { EditableBlock } from "@/lib/document-tree";
import type { AiEditAttachment } from "@/lib/ai/sigma-doc-agent-tools";
import type { DesktopAiSourceReference } from "@/types/desktop";

export interface AiEditPanelProps {
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
  /**
   * 入力欄の外で用意された添付 (範囲スクリーンショットの「AIに聞く」)。入力欄の下書きは会話の
   * 切り替えやパネルの開き直しで作り直されるので、その中ではなくここから差し込む。
   */
  pendingAttachments?: AiEditAttachment[];
  /** 差し込まれた添付の × (添付の id で指定)。 */
  onRemovePendingAttachment?: (attachmentId: string) => void;
  /** 送信で差し込んだ添付を使い切った。 */
  onPendingAttachmentsSent?: () => void;
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
  /**
   * ⌘K のパネルが提案の判断 (承認バー) を出した (`shown`)・下げた。紙面はその提案の浮かぶバーを出さない
   * (1 つの提案に見える承認バーは 1 本)。
   */
  onInlineDecisionShownChange?: (proposalIds: readonly string[], shown: boolean) => void;
  staleProposalGroups: StaleMcpProposalGroup[];
  /** Phase 1: Agentic RAG. Proposals' `sourceReferences` (all statuses), aggregated
   * and deduped by turnId. Used to show a "参照したドキュメント" row under each
   * assistant turn; persists after apply/dismiss while the proposal record remains. */
  sourceReferencesByTurnId?: Map<string, DesktopAiSourceReference[]>;
  /** Native overlay insertion drafts rendered as compact chat thumbnails. Derived
   * from proposals of every status, so they remain after apply/dismiss and restore. */
  /** turn ごとの、挿入した図形のサムネの内容 (`buildInsertedShapePreviewsByTurnId`)。 */
  insertedShapePreviewsByTurnId?: Map<string, AiProposalContent>;
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

export interface AiEditPreviewResolutionTarget {
  roomId?: string;
  turnId?: string;
}

