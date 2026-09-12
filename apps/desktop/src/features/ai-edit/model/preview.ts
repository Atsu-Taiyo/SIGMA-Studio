import {
  computeAlignedOverlayShapes,
  computeUpdatedOverlayShapes,
  isAdditiveInsertOnlyDraft,
  primarySigmaDocMutationOpTargetId,
  resolveAiEditSessionOperationOrder,
  type AiEditDraft,
  type AiEditSessionDraft,
  type SigmaDocMutationOp,
} from "@/lib/ai/sigma-doc-edit-schema";
import type {
  OverlayAsset,
  OverlayShape,
  SigmaDocument,
} from "@/features/document";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import type { DesktopAiSourceReference, DesktopMcpEditProposalProvider, DesktopMcpEditProposalSummary } from "@/types/desktop";
import {
  deriveAiOverlayShapeReplacementPairs,
  preserveOverlayShapePlacementForReplacement,
  type AiOverlayShapeReplacementPair,
} from "@/lib/ai/overlay-shape-replacement";
import { buildShapeOnlyPreview, type AiEditShapeOnlyPreview } from "@/lib/ai/ai-edit-shape-preview";
import {
  deriveAppliedDraftFallback,
  isOverlayAnchorSupportDraft,
  mergeAppliedDocumentDiffs,
  type AiAppliedDocumentDiff,
} from "@/lib/ai/applied-document-diff";

export { isOverlayAnchorSupportDraft } from "@/lib/ai/applied-document-diff";

export type McpEditProposalProvider = DesktopMcpEditProposalProvider;

export interface AiEditPreviewState {
  targetId: string;
  draft: AiEditSessionDraft;
  createdAt: number;
  // このプレビューに合体された全 pending proposal の ID (作成順)。
  // apply で全て approve、dismiss で全て reject する (決定A: 同一runの複数提案は1プレビューに合体)。
  proposalIds: string[];
  baseRevision: number;
  // 提案を作ったプロバイダの一意集合、createdAt順。空配列は不明 (provider情報なし)。
  providers: McpEditProposalProvider[];
  // このグループの元になった ai-edit:run の runId。異なる runId は別グループになる
  // (決定B: run単位でプレビュー/apply/dismissを分離)。帰属不明な提案の集約は undefined。
  runId?: string;
  // チャットの部屋/ターンID (却下フィードバックループでの再依頼に使う)。
  roomId?: string;
  turnId?: string;
  // グループのラベル (チャットのセッションタイトル、または最初の指示の抜粋)。
  sessionLabel?: string;
  /** Web proposals rely on their revision/content freshness guards and remain
   * directly editable while their on-page preview is visible. Desktop AI
   * proposals omit this field and keep the established target reservation. */
  lockTargets?: boolean;
  // Phase 1: Agentic RAG。このグループの全提案が参照した過去教材・素材・Webページを
  // 集約・重複排除したもの (存在する場合のみ、空配列にはしない)。
  sourceReferences?: DesktopAiSourceReference[];
  /** A delete + insert sequence that represents one logical shape replacement. */
  shapeReplacements?: AiOverlayShapeReplacementPair[];
}

/**
 * One assistant turn's approved proposal data, reduced to the information the
 * chat history needs after the pending preview has disappeared. The renderer
 * owns neither proposal persistence nor reverting; it only receives the exact
 * batch ids that are still safe to roll back.
 */
export interface AiAppliedTurnChange {
  proposalIds: string[];
  /**
   * main の revert IPC に渡せる提案ID群。同じ1回の保存を共有したバッチごとに全IDを含み、
   * 新しい保存revisionのバッチが先に来る (revertは新しい方から順に巻き戻す必要がある)。
   * canRevertがfalseのときは空。
   */
  revertProposalIds: string[];
  providers: McpEditProposalProvider[];
  diff: AiAppliedDocumentDiff;
  autoApplied: boolean;
  canRevert: boolean;
  /**
   * canRevertがfalseのときだけ設定される、元に戻せない理由の分類。
   * - "missingData": appliedRevisionが1件も記録されていない旧レコード。戻す土台となる
   *   保存バッチを引けないため、main側でも判定不能。
   * - "unknownRevision": 提案側の記録はあるが、開いている教材の保存revisionがまだ
   *   分からない (読み込み中など)。一時的な状態で、原因は提案ではなく教材側にある。
   * Phase 2以降、「承認後に教材が編集された」ことも「turnが複数の保存revisionに
   * またがった」ことも revert を塞がない (前者はmain側の選択的revertが、後者は新しい
   * バッチから順に巻き戻すループが解決する)。
   * 呼び出し側 (AiEditPanel) は describeRevertBlockedReason で日本語のコピーへ変換して
   * AiAppliedChangeCardへ渡す — コピーは1箇所にまとめておく。
   */
  revertBlockedReason?: "missingData" | "unknownRevision";
}

/**
 * revertBlockedReason を利用者に見せる日本語1文へ変換する唯一の場所。分類が無い
 * (= 適用済みだが判定材料そのものが無い) ケースにも汎用文を返すので、呼び出し側で
 * フォールバックのコピーを重複させない。
 */
export function describeRevertBlockedReason(
  reason?: AiAppliedTurnChange["revertBlockedReason"],
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): string {
  switch (reason) {
    case "missingData":
      return t("applied.revertBlocked.missingData");
    case "unknownRevision":
      return t("applied.revertBlocked.unknownRevision");
    default:
      return t("applied.revertBlocked.other");
  }
}

// W2: 自動rebase (electron/local-sigma-doc-proposal-store.ts の autoRebaseProposalsForFile) が
// 入ったことで、stale (baseRevisionが古い) pending提案は一様ではなくなった。3種に分類する:
// - "conflict": 提案が触ったブロックへの実際の人間の編集を自動rebaseが検出し、pendingのまま
//   confict を立てて残した。人間の編集とAIの提案のどちらを残すか、ユーザーに選んでもらう
//   必要がある (作り直しボタンでの黙った再適用は危険 — rebaseProposal は conflict の有無に
//   関わらずblindに提案draftをreplayしてconflictをクリアしてしまうため)。
// - "pending-auto-rebase": touchedBlocksは記録されているがまだconflictは立っていない一時状態。
//   次の保存で自動rebaseされてbaseRevisionが追従し、このstale状態自体が解消されるはず — 手動
//   操作は不要 (自動rebase自体はmain側の責務)。
// - "manual-rebase": touchedBlocksを記録する前に作られた旧い提案。判定材料がないため、
//   従来どおり手動の「作り直し」に頼る。
export type StaleMcpProposalKind = "conflict" | "manual-rebase" | "pending-auto-rebase";

/** stale (baseRevisionが古い) pending提案1件を上記3種に分類する。 */
export function classifyStaleMcpProposal(
  proposal: Pick<DesktopMcpEditProposalSummary, "conflict" | "touchedBlocks">,
): StaleMcpProposalKind {
  if (proposal.conflict) {
    return "conflict";
  }
  if (proposal.touchedBlocks && proposal.touchedBlocks.length > 0) {
    return "pending-auto-rebase";
  }
  return "manual-rebase";
}

export interface StaleMcpProposalGroup {
  baseRevision: number;
  currentRevision: number;
  proposalIds: string[];
  providers: McpEditProposalProvider[];
  summary: string;
  // グループ内で最新の createdAt (ms)。stale group同士の並び替えに使う。
  createdAt: number;
  // チャットの部屋/ターンID (AIタスクDockでのセッション紐付けに使う)。
  roomId?: string;
  turnId?: string;
  // classifyStaleMcpProposal による分類。同じ (baseRevision, kind) の提案はグルーピング時に
  // 1つにまとめられるため、グループ内の全提案は常に同じkindになる。
  kind: StaleMcpProposalKind;
  // kind === "conflict" のときのみ設定。グループ内の全提案の conflict.blockIds を統合・重複排除。
  conflictBlockIds?: string[];
  conflictReason?: NonNullable<DesktopMcpEditProposalSummary["conflict"]>["reason"];
  invalidReason?: string;
}

export interface GroupMcpProposalsForPreviewResult {
  // pending proposal 群を runId (帰属不明なら "unattributed" にまとめて) でグルーピングしたもの。
  // 1 run = 1確認カード: baseRevision はグルーピングに使わない (conflict提案とレガシーstale提案
  // だけが stale 側へ回る)。各要素が独立したプレビュー単位 (それぞれ自分の apply/dismiss を持つ)
  // になる。作成順 (createdAt昇順)。
  groups: AiEditPreviewState[];
  stale: StaleMcpProposalGroup[];
  // 後方互換フィールド (mcp/sigma-doc-mcp-server.test.ts など単一グループ前提の既存呼び出し向け)。
  // 常に groups[0] ?? null。複数runのプレビューを扱う新しいコードは groups を使うこと。
  current: AiEditPreviewState | null;
}

const PROVIDER_LABELS: Record<McpEditProposalProvider, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  antigravity: "Antigravity",
};

export function formatAiProposalProviderLabel(providers: McpEditProposalProvider[]): string {
  const unique = [...new Set(providers)];
  if (unique.length === 1) {
    return PROVIDER_LABELS[unique[0]];
  }
  return "AI";
}

function uniqueProviders(proposals: DesktopMcpEditProposalSummary[]): McpEditProposalProvider[] {
  return [...new Set(proposals.map((proposal) => proposal.provider).filter((p): p is McpEditProposalProvider => p !== null))];
}

function latestCreatedAtMs(proposals: DesktopMcpEditProposalSummary[]): number {
  return proposals.reduce((max, proposal) => Math.max(max, Date.parse(proposal.createdAt) || 0), 0);
}

// Phase 1: Agentic RAG。同じソースを指す複数の参照 (同一 fileId/url/materialId) を
// 1件に畳み込む。最初に出てきたものを残す — MCPサーバーが document 参照に title を
// 補完してから作った提案が先にあれば、後続の (title未補完な) 重複でそれを失わないため。
/** Aggregates `sourceReferences` from proposals onto their `turnId` keys. */
export function buildSourceReferencesByTurnId(
  proposals: Pick<DesktopMcpEditProposalSummary, "turnId" | "sourceReferences">[],
): Map<string, DesktopAiSourceReference[]> {
  const grouped = new Map<string, DesktopAiSourceReference[]>();
  for (const proposal of proposals) {
    if (!proposal.turnId || !proposal.sourceReferences || proposal.sourceReferences.length === 0) {
      continue;
    }
    const existing = grouped.get(proposal.turnId);
    if (existing) {
      existing.push(...proposal.sourceReferences);
    } else {
      grouped.set(proposal.turnId, [...proposal.sourceReferences]);
    }
  }
  const result = new Map<string, DesktopAiSourceReference[]>();
  for (const [turnId, references] of grouped) {
    result.set(turnId, dedupeAiSourceReferences(references));
  }
  return result;
}

/**
 * Builds one stable, shape-only chat thumbnail for every assistant turn that
 * created overlay insertion proposals. Proposal drafts remain the native
 * SigmaDoc source of truth; this SVG is only a derived chat representation.
 * Using proposals from every status keeps the thumbnail available after the
 * user approves or rejects the insertion and after chat history is restored.
 */
export function buildInsertedShapePreviewsByTurnId(
  proposals: Pick<DesktopMcpEditProposalSummary, "turnId" | "createdAt" | "draft">[],
): Map<string, AiEditShapeOnlyPreview> {
  const proposalsByTurnId = new Map<string, typeof proposals>();
  for (const proposal of proposals) {
    if (!proposal.turnId) {
      continue;
    }
    const existing = proposalsByTurnId.get(proposal.turnId);
    if (existing) {
      existing.push(proposal);
    } else {
      proposalsByTurnId.set(proposal.turnId, [proposal]);
    }
  }

  const result = new Map<string, AiEditShapeOnlyPreview>();
  for (const [turnId, turnProposals] of proposalsByTurnId) {
    const visualOperations = turnProposals
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .flatMap((proposal) => proposal.draft.operations)
      .filter((operation) => operation.operation === "insertOverlayShape" || operation.operation === "insertTableShape");
    const preview = buildShapeOnlyPreview(visualOperations);
    if (preview) {
      result.set(turnId, preview);
    }
  }
  return result;
}

// 「復元」ボタン (AIチャット履歴 / AIタスクDock) の対象判定。ターンごとの全提案を集約する
// 必要はなく、turnId単位で「最後に何が起きたか (最新のupdatedAt)」だけが分かればよい —
// rejected/revertedならもう一度提案できる、pendingならまだ解決していない (ボタンを出さない)、
// approvedなら現在適用中 (同様にボタンを出さない)。AiEditPanel側には解決済み提案の全件では
// なくこの最小限のMapだけを渡す (不要な情報は表示せず、必要になった時だけ追加する)。
/** Collects every rejected/reverted proposal attributed to a fully resolved turn. A single AI
 * response can create several proposal records (for example delete + insert for a
 * replacement), so restoring only the latest record would replay half the edit. If
 * any sibling is still pending, the existing decision UI remains authoritative and
 * the history restore action stays hidden. */
export function buildRestorableProposalsByTurnId(
  proposals: Pick<DesktopMcpEditProposalSummary, "turnId" | "proposalId" | "status" | "updatedAt">[],
): Map<string, { proposalIds: string[] }> {
  const latestByProposalId = new Map<string, typeof proposals[number]>();
  for (const proposal of proposals) {
    const existing = latestByProposalId.get(proposal.proposalId);
    if (!existing || proposal.updatedAt.localeCompare(existing.updatedAt) > 0) {
      latestByProposalId.set(proposal.proposalId, proposal);
    }
  }
  const pendingTurnIds = new Set<string>();
  const restorableByTurnId = new Map<string, Array<{ proposalId: string; updatedAt: string }>>();
  for (const proposal of latestByProposalId.values()) {
    if (!proposal.turnId) {
      continue;
    }
    if (proposal.status === "pending") {
      pendingTurnIds.add(proposal.turnId);
      continue;
    }
    if (proposal.status !== "rejected" && proposal.status !== "reverted") {
      continue;
    }
    const existing = restorableByTurnId.get(proposal.turnId) ?? [];
    existing.push({ proposalId: proposal.proposalId, updatedAt: proposal.updatedAt });
    restorableByTurnId.set(proposal.turnId, existing);
  }
  const result = new Map<string, { proposalIds: string[] }>();
  for (const [turnId, proposalsForTurn] of restorableByTurnId) {
    if (pendingTurnIds.has(turnId)) {
      continue;
    }
    const proposalIds = [...new Map(
      proposalsForTurn
        .slice()
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.proposalId.localeCompare(b.proposalId))
        .map((proposal) => [proposal.proposalId, proposal] as const),
    ).keys()];
    if (proposalIds.length > 0) {
      result.set(turnId, { proposalIds });
    }
  }
  return result;
}

export function dedupeAiSourceReferences(references: DesktopAiSourceReference[]): DesktopAiSourceReference[] {
  const seen = new Set<string>();
  const result: DesktopAiSourceReference[] = [];
  for (const reference of references) {
    const key =
      reference.type === "document"
        ? `document:${reference.fileId}`
        : reference.type === "web"
          ? `web:${reference.url}`
          : reference.type === "webSearch"
            ? `webSearch:${reference.query}`
            : `material:${reference.materialId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(reference);
  }
  return result;
}

function resolveGroupTargetId(
  operations: AiEditSessionDraft["operations"],
  mutationOperations: NonNullable<AiEditSessionDraft["mutationOperations"]>,
  ordered: DesktopMcpEditProposalSummary[],
): string {
  return (
    operations[0]?.targetId ??
    (mutationOperations[0] ? primarySigmaDocMutationOpTargetId(mutationOperations[0]) : undefined) ??
    ordered[0]?.changedIds[0] ??
    ""
  );
}

// pending proposal 群をプレビュー単位にグルーピングする。1 run = 1確認カード: 提案は runId
// (帰属不明なら "unattributed") ごとに1つのプレビュー単位へまとめられ、それぞれが自分の
// apply/dismiss を持つ (決定B)。baseRevision はプレビュー分割に使わない — run 途中で人手編集や
// 別提案の適用で revision が進んでも、同一 run の提案は1カードのまま (承認時に現在docへ順に
// replay される)。stale 扱いになるのは (a) 自動rebaseが実上書き対象の変更、またはreplay不能を
// 検出して conflict を立てた提案と、(b) requestSelection を持たないレガシー提案が baseRevision の
// 古いまま残っているケースだけ。
export function groupMcpProposalsForPreview(
  proposals: DesktopMcpEditProposalSummary[],
  fileId: string,
  currentRevision: number | null,
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): GroupMcpProposalsForPreviewResult {
  if (currentRevision === null) {
    return { groups: [], stale: [], current: null };
  }

  const pending = proposals.filter((proposal) => proposal.fileId === fileId && proposal.status === "pending");
  if (pending.length === 0) {
    return { groups: [], stale: [], current: null };
  }

  const currentProposals: DesktopMcpEditProposalSummary[] = [];
  const staleProposals: DesktopMcpEditProposalSummary[] = [];
  for (const proposal of pending) {
    if (proposal.conflict) {
      staleProposals.push(proposal);
    } else if (
      !proposal.requestSelection
      && proposal.baseRevision !== currentRevision
      && !isAdditiveInsertOnlyDraft(proposal.draft)
    ) {
      // 比較契約を持たない上書き系の旧提案だけrevisionでstale判定する。純粋なinsertは
      // アンカー内容に依存せず、main側で外部アンカーの存在を確認して最新docへreplayする。
      staleProposals.push(proposal);
    } else {
      currentProposals.push(proposal);
    }
  }

  const groups: AiEditPreviewState[] = [];
  const stale: StaleMcpProposalGroup[] = [];

  // stale 側は (baseRevision, kind) ごとに分割する。conflict の有無・touchedBlocks の有無で
  // 必要なUI/操作が異なる (classifyStaleMcpProposal 参照) — conflict提案を manual-rebase 提案と
  // 同じグループに混ぜると、後者向けの「作り直し」(blind replay) が前者にも適用できてしまい、
  // 人間の編集を黙って上書きしかねない。
  const staleByKey = new Map<string, {
    baseRevision: number;
    kind: StaleMcpProposalKind;
    conflictReason?: NonNullable<DesktopMcpEditProposalSummary["conflict"]>["reason"];
    invalidReason?: string;
    items: DesktopMcpEditProposalSummary[];
  }>();
  for (const proposal of staleProposals) {
    const kind = classifyStaleMcpProposal(proposal);
    const conflictReason = kind === "conflict" ? proposal.conflict?.reason : undefined;
    const invalidReason = proposal.invalidReason;
    const key = `${proposal.baseRevision}::${kind}::${conflictReason ?? "unclassified"}::${invalidReason ?? "valid"}`;
    const bucket = staleByKey.get(key);
    if (bucket) {
      bucket.items.push(proposal);
    } else {
      staleByKey.set(key, { baseRevision: proposal.baseRevision, kind, conflictReason, invalidReason, items: [proposal] });
    }
  }

  for (const { baseRevision, kind, conflictReason, invalidReason, items } of staleByKey.values()) {
    const ordered = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const providers = uniqueProviders(ordered);
    const summaries = ordered.map((proposal) => proposal.summary).filter((text) => text.length > 0);
    const fallbackSummary = t("preview.fallbackSummary");
    const conflictBlockIds = kind === "conflict"
      ? [...new Set(ordered.flatMap((proposal) => proposal.conflict?.blockIds ?? []))]
      : [];
    stale.push({
      baseRevision,
      currentRevision,
      proposalIds: ordered.map((proposal) => proposal.proposalId),
      providers,
      summary: summaries.join(" / ") || fallbackSummary,
      createdAt: latestCreatedAtMs(ordered) || Date.now(),
      roomId: ordered.map((proposal) => proposal.roomId).find((id) => !!id),
      turnId: ordered.map((proposal) => proposal.turnId).find((id) => !!id),
      kind,
      ...(conflictBlockIds.length > 0 ? { conflictBlockIds } : {}),
      ...(conflictReason ? { conflictReason } : {}),
      ...(invalidReason ? { invalidReason } : {}),
    });
  }

  const byConversation = new Map<string, DesktopMcpEditProposalSummary[]>();
  for (const proposal of currentProposals) {
    // Follow-up turns in the same chat room revise one pending decision. Runs
    // still separate proposals when no room context exists (legacy/external
    // MCP callers), and unattributed proposals retain their old fallback.
    const groupKey = proposal.roomId
      ? `room:${proposal.roomId}`
      : proposal.runId
        ? `run:${proposal.runId}`
        : "unattributed";
    const conversationGroup = byConversation.get(groupKey);
    if (conversationGroup) {
      conversationGroup.push(proposal);
    } else {
      byConversation.set(groupKey, [proposal]);
    }
  }

  for (const [, conversationGroup] of byConversation) {
    const ordered = [...conversationGroup].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latestFirst = [...ordered].reverse();
    const providers = uniqueProviders(ordered);
    const createdAtMs = latestCreatedAtMs(ordered);
    const summaries = ordered.map((proposal) => proposal.summary).filter((text) => text.length > 0);
    const proposalIds = ordered.map((proposal) => proposal.proposalId);
    const fallbackSummary = t("preview.fallbackSummary");
    const summary = summaries.join(" / ") || fallbackSummary;
    const operations = ordered.flatMap((proposal) => proposal.draft.operations);
    const mutationOperations = ordered.flatMap((proposal) => proposal.draft.mutationOperations ?? []);
    let operationOffset = 0;
    let mutationOffset = 0;
    const operationOrder = ordered.flatMap(({ draft }) => {
      const entries = resolveAiEditSessionOperationOrder(draft).map((entry) => ({
        ...entry, index: entry.index + (entry.kind === "operation" ? operationOffset : mutationOffset),
      }));
      operationOffset += draft.operations.length;
      mutationOffset += draft.mutationOperations?.length ?? 0;
      return entries;
    });
    if (operations.length === 0 && mutationOperations.length === 0) {
      continue;
    }
    const plan = ordered.flatMap((proposal) => proposal.draft.plan);
    const warnings = ordered.flatMap((proposal) => proposal.draft.warnings ?? []);
    const sessionLabel = ordered.map((proposal) => proposal.sessionLabel).find((label) => !!label?.trim());
    const roomId = latestFirst.map((proposal) => proposal.roomId).find((id) => !!id);
    const turnId = latestFirst.map((proposal) => proposal.turnId).find((id) => !!id);
    const runId = latestFirst.map((proposal) => proposal.runId).find((id) => !!id);
    const sourceReferences = dedupeAiSourceReferences(ordered.flatMap((proposal) => proposal.sourceReferences ?? []));
    const shapeReplacements = deriveAiOverlayShapeReplacementPairs(ordered);

    groups.push({
      targetId: resolveGroupTargetId(operations, mutationOperations, ordered),
      draft: {
        summary,
        plan,
        operations,
        operationOrder,
        warnings,
        ...(mutationOperations.length > 0 ? { mutationOperations } : {}),
      },
      createdAt: createdAtMs || Date.now(),
      proposalIds,
      // run 内で revision を跨いだ場合は最新の baseRevision を代表値にする (表示用のメタ情報で、
      // プレビュー分割・承認判定には使われない)。
      baseRevision: Math.max(...ordered.map((proposal) => proposal.baseRevision)),
      providers,
      runId,
      roomId,
      turnId,
      sessionLabel,
      ...(sourceReferences.length > 0 ? { sourceReferences } : {}),
      ...(shapeReplacements.length > 0 ? { shapeReplacements } : {}),
    });
  }

  groups.sort((a, b) => a.createdAt - b.createdAt);
  stale.sort((a, b) => b.createdAt - a.createdAt);

  return { groups, stale, current: groups[0] ?? null };
}

// --- GitHub-style diff derivation for pending proposals ---
//
// Pure id/shape-set derivation shared by the pending-diff preview (pale red
// "will be removed/replaced" / pale green "will be added" coloring in the body
// text flow and the overlay layer) and, indirectly, by the apply animations
// (EditorShell computes its transient "removing"/"just added" id sets from the
// same shape of data — see AiEditPostApplyHighlight below). Kept independent of
// any rendering concern so it's cheaply unit-testable.

export interface AiEditPreviewAddedShape {
  shape: OverlayShape;
  assets: Record<string, OverlayAsset>;
}

export interface AiEditPreviewDiff {
  /** Body blocks that will be overwritten (`replace`) or removed (`deleteBlocks`). */
  removedBlockIds: Set<string>;
  /** Overlay shapes that will be deleted (`deleteOverlayShapes`). */
  removedShapeIds: Set<string>;
  /** Overlay shapes that will be changed in place (`updateOverlayShape` / `alignOverlayShapes`) — neither purely added nor removed. */
  modifiedShapeIds: Set<string>;
  /** New overlay shapes/tables (`insertOverlayShape` / `insertTableShape`), with their own assets, for ghost-preview rendering. */
  addedShapes: AiEditPreviewAddedShape[];
}

/** True when an ordinary AI edit draft changes only the page overlay layer. */
export function isOverlayAiEditDraft(operation: AiEditDraft): boolean {
  return operation.operation === "insertOverlayShape" || operation.operation === "insertTableShape";
}

/**
 * `insert_shape` / `insert_table` / `insert_graph` may need to create one empty
 * paragraph when the requested problem area has no real block to anchor the
 * overlay shape to. The draft path represents that implementation detail as a
 * `replace` immediately before the overlay insert. It belongs to the overlay
 * proposal UI; treating it as an ordinary body edit is what used to put new
 * shapes back into a body-flow proposal card.
 */
/** True when a draft is rendered/decided in the page overlay, not body flow. */
export function isOverlayOwnedAiEditDraft(operation: AiEditDraft, operations: AiEditDraft[]): boolean {
  return isOverlayAiEditDraft(operation) || isOverlayAnchorSupportDraft(operation, operations);
}

/** True when a mutation op changes only existing shapes in the page overlay layer. */
export function isOverlaySigmaDocMutationOp(operation: SigmaDocMutationOp): boolean {
  return operation.operation === "updateOverlayShape" ||
    operation.operation === "alignOverlayShapes" ||
    operation.operation === "deleteOverlayShapes";
}

/** True when a proposal contains at least one visible overlay change. */
export function hasOverlayAiEditChanges(preview: AiEditPreviewState): boolean {
  return preview.draft.operations.some(isOverlayAiEditDraft) ||
    (preview.draft.mutationOperations ?? []).some(isOverlaySigmaDocMutationOp);
}

/** True when a proposal also contains a user-visible body-flow change. */
export function hasBodyAiEditChanges(preview: AiEditPreviewState): boolean {
  const operations = preview.draft.operations;
  return operations.some((operation) => !isOverlayOwnedAiEditDraft(operation, operations)) ||
    (preview.draft.mutationOperations ?? []).some((operation) => !isOverlaySigmaDocMutationOp(operation));
}

/**
 * Overlay-only proposals get a canvas-native approval widget instead of an
 * inline body card. Mixed proposals intentionally stay inline: one decision
 * must continue to describe both their body and overlay changes together.
 */
export function isOverlayOnlyAiEditPreview(preview: AiEditPreviewState): boolean {
  const operations = preview.draft.operations;
  const mutationOperations = preview.draft.mutationOperations ?? [];
  return operations.length + mutationOperations.length > 0 &&
    operations.every((operation) => isOverlayOwnedAiEditDraft(operation, operations)) &&
    mutationOperations.every(isOverlaySigmaDocMutationOp);
}

// --- Change summary (承認カードの「何を変更したのか」一行サマリー) ---
//
// The overlay approval widget floats over the canvas with no room for the
// full diff the inline body card can show, and even the inline card benefits
// from a glanceable header before the user reads every entry. This derives
// short Japanese lines like "表(3×4)を挿入" / "円を追加" / "図形を2件更新" /
// "グラフを削除" straight from the draft's ops — no rendering, no document
// access beyond the optional `currentShapes` used to name shapes that
// mutation ops only reference by id (updateOverlayShape/alignOverlayShapes/
// deleteOverlayShapes carry a shapeId, not the shape itself).

/**
 * `t` を省略したときの解決器。**呼び出し時点の表示言語**で引く。
 * 固定ロケールにすると渡し忘れが静かに日本語で出るバグになるため (WI-7 で実測)。
 * `window` の無い環境では既定ロケール (日本語) に落ちるので既存の期待値は不変。
 */
const DEFAULT_AI_TRANSLATE = createCurrentLocaleTranslator("ai");

/**
 * 変更行に出てくる「何を」。**文言ではなく識別子。**
 *
 * 以前はここが日本語の文字列で、(1) 画面に出す文言 (2) 集計のバケツキー
 * (3) `noun === "グラフ"` という分岐、の 3 役を兼ねていた。訳した瞬間に
 * 集計と分岐が壊れるので、id と文言を分けてある。文言は `ai.change.noun.<id>`。
 */
export const AI_EDIT_CHANGE_NOUN_IDS = [
  "shape",
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "pentagon",
  "arrow",
  "sector",
  "arc",
  "curve",
  "freehand",
  "line",
  "text",
  "image",
  "callout",
  "graph",
  "table",
  "body",
] as const;

export type AiEditChangeNounId = (typeof AI_EDIT_CHANGE_NOUN_IDS)[number];

/** 図形の呼び名の id。解決できない (sub)kind と id 不明はどちらも汎用の `shape`。 */
export function overlayShapeNounId(shape: OverlayShape | undefined): AiEditChangeNounId {
  if (!shape) {
    return "shape";
  }
  switch (shape.type) {
    case "geo":
      switch (shape.props.geo) {
        case "rectangle": return "rectangle";
        case "ellipse": return "ellipse";
        case "triangle": return "triangle";
        case "diamond": return "diamond";
        case "pentagon": return "pentagon";
        case "blockArrow": return "arrow";
        default: return "shape";
      }
    case "arc":
      return shape.props.kind === "sector" ? "sector" : "arc";
    case "arrow":
      return "arrow";
    case "line":
      switch (shape.props.kind) {
        case "curve": return "curve";
        case "freehand": return "freehand";
        default: return "line";
      }
    case "text":
      return "text";
    case "image":
      return "image";
    case "callout":
      return "callout";
    case "graph2dShape":
      return "graph";
    case "tableShape":
      return "table";
    case "group":
    default:
      return "shape";
  }
}

/** Exported so the preview card names a shape the same way its change summary does. */
export function overlayShapeNoun(
  shape: OverlayShape | undefined,
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): string {
  // 呼び名は**単数形**。辞書は複数形つき (`_one`/`_other`) なので `count` を渡さないと
  // i18next がどちらも選べず生キーになる。
  return t(`change.noun.${overlayShapeNounId(shape)}` as never, { count: 1 } as never) as unknown as string;
}

type AiEditChangeAction = "insert" | "update" | "align" | "delete" | "move";

/** 動詞も id で持つ。「グラフだけ『挿入』」は**呼び名の文字列ではなく id で**判定する。 */
export const CHANGE_VERB_IDS = ["insert", "add", "update", "align", "delete", "move", "replace"] as const;

type AiEditChangeVerbId = (typeof CHANGE_VERB_IDS)[number];

function aiEditChangeVerbId(action: AiEditChangeAction, noun: AiEditChangeNounId): AiEditChangeVerbId {
  switch (action) {
    case "insert": return noun === "graph" ? "insert" : "add";
    case "update": return "update";
    case "align": return "align";
    case "delete": return "delete";
    case "move": return "move";
  }
}

function formatAiEditChangeLine(
  noun: AiEditChangeNounId,
  count: number,
  verb: AiEditChangeVerbId,
  t: Translate<"ai">,
): string {
  const values = {
    // `count` を渡すと i18next が複数形を選ぶ (英語だけ語形が変わる)。
    noun: t(`change.noun.${noun}` as never, { count } as never) as unknown as string,
    verb: t(`change.verb.${verb}` as never) as unknown as string,
    count,
  };
  return t(count > 1 ? "change.counted" : "change.single", { count, replace: values });
}

/**
 * Derives a short, ordered list of Japanese "what changed" lines for one
 * preview group — e.g. `["表(3×4)を挿入"]` or `["円を追加", "図形を2件更新"]`.
 * Table inserts get their own line with dimensions instead of being folded
 * into a count (a 3×4 table and a 2×2 table aren't "2 tables"). Everything
 * else buckets by (action, noun): a bucket with more than one distinct noun
 * collapses to the generic "図形" — e.g. updating one rectangle and one
 * ellipse together reads as "図形を2件更新", not two separate lines.
 *
 * `currentShapes` (the live document's resolved overlay shapes) is only used
 * to name shapes that mutation ops reference solely by id (update/align/
 * delete); insert ops always carry their own shape, so naming those never
 * needs it. Safe to omit for contexts (like the inline body card) where only
 * a generic fallback matters.
 */
export function summarizeAiEditPreviewChanges(
  preview: AiEditPreviewState,
  currentShapes: OverlayShape[] = [],
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): string[] {
  const shapesById = new Map(currentShapes.map((shape) => [shape.id, shape]));
  const replacementByAddedId = new Map(
    (preview.shapeReplacements ?? []).map((pair) => [pair.addedShapeId, pair.removedShapeId]),
  );
  const replacementRemovedIds = new Set((preview.shapeReplacements ?? []).map((pair) => pair.removedShapeId));

  // 集計は**呼び名の id** で行う。文言で集計すると、言語が変わっただけで
  // まとまり方が変わる (訳語が同じ 2 種類が 1 つに潰れる、など)。
  const buckets = new Map<AiEditChangeAction, Map<AiEditChangeNounId, number>>();
  const bump = (action: AiEditChangeAction, noun: AiEditChangeNounId, count = 1) => {
    const bucket = buckets.get(action) ?? new Map<AiEditChangeNounId, number>();
    bucket.set(noun, (bucket.get(noun) ?? 0) + count);
    buckets.set(action, bucket);
  };
  const tableLines: string[] = [];
  const replaceCounts = new Map<AiEditChangeNounId, number>();
  const bumpReplace = (noun: AiEditChangeNounId) => replaceCounts.set(noun, (replaceCounts.get(noun) ?? 0) + 1);

  const allOperations = preview.draft.operations;
  for (const operation of allOperations) {
    if (operation.operation === "insertTableShape") {
      if (replacementByAddedId.has(operation.tableShape.id)) {
        bumpReplace("table");
        continue;
      }
      const { rows, columns } = operation.tableShape.props.table;
      tableLines.push(t("change.tableInsert", { replace: { rows: rows.length, columns: columns.length } }));
      continue;
    }
    if (operation.operation === "insertOverlayShape") {
      const noun = overlayShapeNounId(operation.overlayShape);
      if (replacementByAddedId.has(operation.overlayShape.id)) {
        bumpReplace(noun);
        continue;
      }
      bump("insert", noun);
      continue;
    }
    if (operation.operation === "insertAfter") {
      bump("insert", "body");
      continue;
    }
    if (!isOverlayAnchorSupportDraft(operation, allOperations)) {
      bump("update", "body");
    }
  }

  for (const op of preview.draft.mutationOperations ?? []) {
    if (op.operation === "deleteBlocks") {
      bump("delete", "body", op.blockIds.length);
    } else if (op.operation === "moveBlocks") {
      bump("move", "body", op.blockIds.length);
    } else if (op.operation === "updateOverlayShape") {
      bump("update", overlayShapeNounId(shapesById.get(op.shapeId)));
    } else if (op.operation === "alignOverlayShapes") {
      op.shapeIds.forEach((shapeId) => bump("align", overlayShapeNounId(shapesById.get(shapeId))));
    } else if (op.operation === "deleteOverlayShapes") {
      op.shapeIds
        .filter((shapeId) => !replacementRemovedIds.has(shapeId))
        .forEach((shapeId) => bump("delete", overlayShapeNounId(shapesById.get(shapeId))));
    }
  }

  const lines: string[] = [...tableLines];
  for (const [noun, count] of replaceCounts) {
    lines.push(formatAiEditChangeLine(noun, count, "replace", t));
  }
  (["insert", "update", "align", "delete", "move"] as const).forEach((action) => {
    const bucket = buckets.get(action);
    if (!bucket || bucket.size === 0) {
      return;
    }
    if (bucket.size === 1) {
      const [noun, count] = [...bucket.entries()][0];
      lines.push(formatAiEditChangeLine(noun, count, aiEditChangeVerbId(action, noun), t));
      return;
    }
    const totalCount = [...bucket.values()].reduce((sum, count) => sum + count, 0);
    lines.push(formatAiEditChangeLine("shape", totalCount, aiEditChangeVerbId(action, "shape"), t));
  });

  return lines;
}

/**
 * Builds the compact "what changed" widget model for approved chat turns.
 * Revert is not gated on the document still being at the exact appliedRevision
 * (whole-document CAS) — main resolves the actual revert plan (full restore vs.
 * selective per-block restore) per saved batch when the button is pressed (see
 * getRevertPlan/buildSelectiveRevertDocument in
 * electron/local-sigma-doc-proposal-store.ts). Nor is it gated on the turn
 * having landed in exactly one save revision: a turn spread over several
 * batches is rolled back newest-batch-first by the caller, which is exactly
 * how buildSelectiveRevertDocument composes. Only a turn where *no* proposal
 * recorded an appliedRevision ("missingData") has nothing for main to revert
 * to. All approved proposal ids from each of those save revisions are returned
 * as the rollback batch (newest revision first) so a one-run multi-proposal
 * approval cannot leave sibling records marked as approved after its shared
 * revert document has been restored.
 */
export function buildAppliedTurnChangesByTurnId(
  proposals: DesktopMcpEditProposalSummary[],
  fileId: string,
  currentRevision: number | null,
  currentShapes: OverlayShape[] = [],
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): Map<string, AiAppliedTurnChange> {
  const latestByProposalId = new Map<string, DesktopMcpEditProposalSummary>();
  for (const proposal of proposals) {
    const existing = latestByProposalId.get(proposal.proposalId);
    if (!existing || proposal.updatedAt.localeCompare(existing.updatedAt) > 0) {
      latestByProposalId.set(proposal.proposalId, proposal);
    }
  }

  const approved = [...latestByProposalId.values()].filter((proposal) => (
    proposal.fileId === fileId && proposal.status === "approved"
  ));
  const approvedByRevision = new Map<number, string[]>();
  for (const proposal of approved) {
    if (proposal.appliedRevision === undefined) {
      continue;
    }
    const ids = approvedByRevision.get(proposal.appliedRevision) ?? [];
    ids.push(proposal.proposalId);
    approvedByRevision.set(proposal.appliedRevision, ids);
  }

  const byTurnId = new Map<string, DesktopMcpEditProposalSummary[]>();
  for (const proposal of approved) {
    if (!proposal.turnId) {
      continue;
    }
    const group = byTurnId.get(proposal.turnId) ?? [];
    group.push(proposal);
    byTurnId.set(proposal.turnId, group);
  }

  const result = new Map<string, AiAppliedTurnChange>();
  for (const [turnId, turnProposals] of byTurnId) {
    const ordered = turnProposals.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const operations = ordered.flatMap((proposal) => proposal.draft.operations);
    const mutationOperations = ordered.flatMap((proposal) => proposal.draft.mutationOperations ?? []);
    const providers = uniqueProviders(ordered);
    const summaries = [...new Set(
      ordered
        .map((proposal) => proposal.draft.summary?.trim() || proposal.summary.trim())
        .filter(Boolean),
    )];
    const preview: AiEditPreviewState = {
      targetId: resolveGroupTargetId(operations, mutationOperations, ordered),
      draft: {
        // プロバイダ名 (ChatGPT / Claude …) はブランド名なので翻訳対象ではない。
        summary: summaries.join(" / ")
          || t("preview.providerEdit", { replace: { provider: formatAiProposalProviderLabel(providers) } }),
        plan: ordered.flatMap((proposal) => proposal.draft.plan),
        operations,
        warnings: ordered.flatMap((proposal) => proposal.draft.warnings ?? []),
        ...(mutationOperations.length > 0 ? { mutationOperations } : {}),
      },
      createdAt: latestCreatedAtMs(ordered),
      proposalIds: ordered.map((proposal) => proposal.proposalId),
      baseRevision: Math.max(...ordered.map((proposal) => proposal.baseRevision)),
      providers,
      roomId: ordered.map((proposal) => proposal.roomId).find(Boolean),
      turnId,
      shapeReplacements: deriveAiOverlayShapeReplacementPairs(ordered),
    };
    // Phase 3: neither "the document moved on" nor "this turn spans several save
    // revisions" blocks revert anymore. main resolves full-vs-selective per batch
    // (getRevertPlan), and several batches are rolled back newest-first by the caller.
    // A turn is revertable as soon as at least one of its proposals recorded the save
    // revision its batch can be looked up by.
    const appliedRevisions = [...new Set(
      ordered
        .map((proposal) => proposal.appliedRevision)
        .filter((revision): revision is number => revision !== undefined),
    )].sort((a, b) => b - a);
    const canRevert = currentRevision !== null && appliedRevisions.length > 0;
    const revertBlockedReason: AiAppliedTurnChange["revertBlockedReason"] = canRevert
      ? undefined
      : appliedRevisions.length > 0
        ? "unknownRevision"
        : "missingData";
    const diff = mergeAppliedDocumentDiffs(ordered.map((proposal) => (
      proposal.appliedDiff ?? deriveAppliedDraftFallback([proposal.draft], currentShapes)
    )));

    result.set(turnId, {
      proposalIds: preview.proposalIds,
      revertProposalIds: canRevert
        ? [...new Set(appliedRevisions.flatMap(
          (revision) => approvedByRevision.get(revision) ?? [],
        ))]
        : [],
      providers,
      diff,
      autoApplied: ordered.every((proposal) => proposal.autoApplied === true),
      canRevert,
      ...(revertBlockedReason ? { revertBlockedReason } : {}),
    });
  }
  return result;
}

/** Derives the pending-diff id/shape sets for one or more preview groups
 * (see `AiEditPreviewState`), merging across groups so several concurrent
 * runs' proposals all get diff coloring at once. `moveBlocks` is deliberately
 * not represented here — it changes position, not content, so there is
 * nothing GitHub-diff-shaped to color for it. */
export function deriveAiEditPreviewDiff(
  previews: AiEditPreviewState[],
  currentShapes: OverlayShape[] = [],
): AiEditPreviewDiff {
  const removedBlockIds = new Set<string>();
  const removedShapeIds = new Set<string>();
  const modifiedShapeIds = new Set<string>();
  const addedShapes: AiEditPreviewAddedShape[] = [];

  let shapeCursor = currentShapes;
  for (const preview of previews) {
    const replacementByAddedId = new Map(
      (preview.shapeReplacements ?? []).map((pair) => [pair.addedShapeId, pair.removedShapeId]),
    );
    const currentShapesById = new Map(shapeCursor.map((shape) => [shape.id, shape]));
    const order = resolveAiEditSessionOperationOrder(preview.draft);
    // Newly inserted images can be revised before approval. Fold their geometry AND assets
    // in the same order as draft application; the original insertion is not the final preview.
    for (const entry of order) {
      if (entry.kind === "operation") {
        const operation = preview.draft.operations[entry.index];
        if (!operation) continue;
        if (operation.operation === "insertOverlayShape" || operation.operation === "insertTableShape") {
          const inserted = operation.operation === "insertOverlayShape" ? operation.overlayShape : operation.tableShape;
          const existingShape = currentShapesById.get(replacementByAddedId.get(inserted.id) ?? "");
          const shape = existingShape ? preserveOverlayShapePlacementForReplacement(existingShape, inserted) : inserted;
          addedShapes.push({ shape, assets: operation.operation === "insertOverlayShape" ? operation.assets ?? {} : {} });
          shapeCursor = [...shapeCursor.filter((candidate) => candidate.id !== shape.id), shape];
        } else if (operation.operation !== "insertAfter" && !isOverlayAnchorSupportDraft(operation, preview.draft.operations)) {
          removedBlockIds.add(operation.targetId);
        }
        continue;
      }
      const op = preview.draft.mutationOperations?.[entry.index];
      if (!op) continue;
      if (op.operation === "deleteBlocks") {
        op.blockIds.forEach((id) => removedBlockIds.add(id));
      } else if (op.operation === "deleteOverlayShapes") {
        op.shapeIds.forEach((id) => removedShapeIds.add(id));
        shapeCursor = shapeCursor.filter((shape) => !op.shapeIds.includes(shape.id));
        for (let index = addedShapes.length - 1; index >= 0; index -= 1) {
          if (op.shapeIds.includes(addedShapes[index].shape.id)) addedShapes.splice(index, 1);
        }
      } else if (op.operation === "updateOverlayShape" || op.operation === "alignOverlayShapes") {
        const ids = op.operation === "updateOverlayShape" ? [op.shapeId] : op.shapeIds;
        ids.forEach((id) => modifiedShapeIds.add(id));
        const results = resolveMutationOpShapeResults(op, shapeCursor);
        if (!results) continue;
        const byId = new Map(results.map((shape) => [shape.id, shape]));
        shapeCursor = shapeCursor.map((shape) => byId.get(shape.id) ?? shape);
        for (const added of addedShapes) {
          added.shape = byId.get(added.shape.id) ?? added.shape;
          added.assets = resolveMutationOpAssets(op, added.assets);
        }
      }
    }
  }

  return { removedBlockIds, removedShapeIds, modifiedShapeIds, addedShapes };
}

/** Existing document targets that must remain read-only after a run finishes
 * and while its proposal is still awaiting a human decision. Newly inserted
 * blocks/shapes are ghosts and therefore need no lock of their own. */
export function derivePendingAiProposalLockTargets(previews: AiEditPreviewState[]): {
  blockIds: Set<string>;
  shapeIds: Set<string>;
} {
  const blockIds = new Set<string>();
  const shapeIds = new Set<string>();

  for (const preview of previews) {
    if (preview.lockTargets === false) {
      continue;
    }
    const allOperations = preview.draft.operations;
    for (const operation of allOperations) {
      if (operation.operation === "insertOverlayShape" || operation.operation === "insertTableShape") {
        continue;
      }
      if (isOverlayAnchorSupportDraft(operation, allOperations)) {
        continue;
      }
      // Insertion only reads the anchor's identity. Its text is not overwritten.
      if (operation.operation === "replace") blockIds.add(operation.targetId);
    }

    for (const operation of preview.draft.mutationOperations ?? []) {
      if (operation.operation === "deleteBlocks") {
        operation.blockIds.forEach((id) => blockIds.add(id));
      } else if (operation.operation === "moveBlocks") {
        operation.blockIds.forEach((id) => blockIds.add(id));
      } else if (operation.operation === "deleteOverlayShapes") {
        operation.shapeIds.forEach((id) => shapeIds.add(id));
      } else if (operation.operation === "updateOverlayShape") {
        shapeIds.add(operation.shapeId);
      } else if (operation.operation === "alignOverlayShapes") {
        operation.shapeIds.forEach((id) => shapeIds.add(id));
      }
    }

    preview.shapeReplacements?.forEach((replacement) => shapeIds.add(replacement.removedShapeId));
  }

  return { blockIds, shapeIds };
}

/**
 * Returns the overlay shapes a single proposal asks the user to decide about.
 * Updated/aligned shapes are returned in their final proposed state; deleted
 * shapes are returned in their last visible state so the approval widget can
 * remain anchored beside them. Explicit delete+insert replacement pairs are
 * collapsed to the new shape at the old shape's identity and placement.
 */
export function deriveAiEditPreviewOverlayShapes(
  preview: AiEditPreviewState,
  currentShapes: OverlayShape[],
): OverlayShape[] {
  let shapes = currentShapes.slice();
  const affectedIds = new Set<string>();
  const deletedById = new Map<string, OverlayShape>();
  const replacementByAddedId = new Map(
    (preview.shapeReplacements ?? []).map((pair) => [pair.addedShapeId, pair.removedShapeId]),
  );
  const replacementRemovedIds = new Set((preview.shapeReplacements ?? []).map((pair) => pair.removedShapeId));
  const currentShapesById = new Map(currentShapes.map((shape) => [shape.id, shape]));

  const upsertShape = (nextShape: OverlayShape) => {
    const index = shapes.findIndex((shape) => shape.id === nextShape.id);
    if (index === -1) {
      shapes = [...shapes, nextShape];
    } else {
      shapes = shapes.map((shape, shapeIndex) => shapeIndex === index ? nextShape : shape);
    }
    affectedIds.add(nextShape.id);
  };

  for (const operation of preview.draft.operations) {
    if (operation.operation === "insertOverlayShape") {
      const existingShape = currentShapesById.get(replacementByAddedId.get(operation.overlayShape.id) ?? "");
      upsertShape(existingShape
        ? preserveOverlayShapePlacementForReplacement(existingShape, operation.overlayShape)
        : operation.overlayShape);
    } else if (operation.operation === "insertTableShape") {
      const existingShape = currentShapesById.get(replacementByAddedId.get(operation.tableShape.id) ?? "");
      upsertShape(existingShape
        ? preserveOverlayShapePlacementForReplacement(existingShape, operation.tableShape)
        : operation.tableShape);
    }
  }

  for (const operation of preview.draft.mutationOperations ?? []) {
    if (operation.operation === "updateOverlayShape" || operation.operation === "alignOverlayShapes") {
      const results = resolveMutationOpShapeResults(operation, shapes)
        ?.filter((shape) => !replacementRemovedIds.has(shape.id));
      results?.forEach(upsertShape);
      continue;
    }

    if (operation.operation === "deleteOverlayShapes") {
      for (const shapeId of operation.shapeIds) {
        if (replacementRemovedIds.has(shapeId)) {
          continue;
        }
        const shape = shapes.find((candidate) => candidate.id === shapeId);
        if (shape) {
          deletedById.set(shapeId, shape);
          affectedIds.add(shapeId);
        }
      }
      const deletedIds = new Set(operation.shapeIds.filter((shapeId) => !replacementRemovedIds.has(shapeId)));
      shapes = shapes.filter((shape) => !deletedIds.has(shape.id));
    }
  }

  const finalById = new Map(shapes.map((shape) => [shape.id, shape]));
  return [...affectedIds].flatMap((shapeId) => {
    const shape = finalById.get(shapeId) ?? deletedById.get(shapeId);
    return shape ? [shape] : [];
  });
}

export interface AiEditPostApplyHighlight {
  blockIds: string[];
  shapeIds: string[];
}

/** Derives the ids that should get a transient "just applied" green flash
 * once a proposal group's operations have actually been written into the
 * document (i.e. right after the approve round-trip, not before). Distinct
 * from `deriveAiEditPreviewDiff` above: that one describes what pending
 * proposals WOULD do to the current document; this one describes, given a
 * proposal that WAS just applied, which of the resulting ids are worth
 * calling out. `deleteBlocks`/`deleteOverlayShapes` contribute nothing here —
 * removed content has nothing left to highlight. */
export function derivePostApplyHighlightIds(preview: AiEditPreviewState): AiEditPostApplyHighlight {
  const blockIds = new Set<string>();
  const shapeIds = new Set<string>();
  const replacementByAddedId = new Map(
    (preview.shapeReplacements ?? []).map((pair) => [pair.addedShapeId, pair.removedShapeId]),
  );

  for (const operation of preview.draft.operations) {
    if (operation.operation === "insertAfter") {
      blockIds.add(operation.insertedBlock.id);
    } else if (operation.operation === "insertOverlayShape") {
      shapeIds.add(replacementByAddedId.get(operation.overlayShape.id) ?? operation.overlayShape.id);
    } else if (operation.operation === "insertTableShape") {
      shapeIds.add(replacementByAddedId.get(operation.tableShape.id) ?? operation.tableShape.id);
    } else if (!isOverlayAnchorSupportDraft(operation, preview.draft.operations)) {
      blockIds.add(operation.targetId);
    }
  }

  for (const op of preview.draft.mutationOperations ?? []) {
    if (op.operation === "moveBlocks") {
      op.blockIds.forEach((id) => blockIds.add(id));
    } else if (op.operation === "updateOverlayShape") {
      shapeIds.add(op.shapeId);
    } else if (op.operation === "alignOverlayShapes") {
      op.shapeIds.forEach((id) => shapeIds.add(id));
    }
  }

  return { blockIds: [...blockIds], shapeIds: [...shapeIds] };
}

/** Transient apply-in-progress state owned by EditorShell (the only place that
 * knows the apply lifecycle's timing), projected by the AI feature into the
 * generic text-flow and overlay decoration contracts. */
export interface AiApplyAnimationState {
  removingBlockIds: string[];
  removingShapeIds: string[];
  addedBlockIds: string[];
  addedShapeIds: string[];
}

// --- Overlay-shape update/align previews ---
//
// `updateOverlayShape`/`alignOverlayShapes` mutation ops only carry a shape id + patch (or a
// shapeIds + mode), not the resulting shape — the inline preview card cannot render "what will
// this look like" from the op alone, and the op's shapeId also isn't a body-block id, so the
// card's block-anchor resolution fails outright. The helpers below fix both problems: resolving
// the block a shape is anchored to (possibly transitively, through a chain of shape anchors —
// see resolveShapeAnchorPositions in features/drawing for the same chain walked at
// render time), and computing shapes' after-state by delegating to the exact same
// patch-merge/align functions sigma-doc-edit-schema.ts's real apply path uses, so the preview
// can never drift from what apply actually does.

/**
 * Finds the overlay shape `shapeId` in `document`'s overlay snapshot and returns the body-block
 * id it is (possibly transitively, via a chain of `{type: "shape"}` anchors) anchored to.
 * Returns undefined if the shape doesn't exist, has no anchor, is page-anchored, or the anchor
 * chain doesn't bottom out at a block anchor (e.g. a cycle, or a dangling parent shape id).
 */
export function resolveOverlayShapeAnchorBlockId(document: SigmaDocument, shapeId: string): string | undefined {
  const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes;
  if (!shapes || shapes.length === 0) {
    return undefined;
  }

  const byId = new Map(shapes.map((shape) => [shape.id, shape]));
  const visited = new Set<string>();
  let current = byId.get(shapeId);

  while (current) {
    if (visited.has(current.id)) {
      return undefined;
    }
    visited.add(current.id);

    const anchor = current.anchor;
    if (!anchor) {
      return undefined;
    }
    if (anchor.type === "block") {
      return anchor.blockId;
    }
    if (anchor.type === "page") {
      return undefined;
    }
    current = byId.get(anchor.shapeId);
  }

  return undefined;
}

export interface AiEditPreviewShapeUpdate {
  shapeId: string;
  /** The shape as it will look AFTER the proposal is applied (patch merged / alignment applied), using the exact same merge semantics as the real apply path. */
  after: OverlayShape;
  /**
   * Assets the proposal replaces along with the shape — a picture derived from the shape itself
   * (a 3D figure's preview PNG), which an update rewrites. Merge these over the document's assets
   * when drawing `after`, or the new shape is drawn with the picture of the old one. Carried
   * forward onto every later update in the same run, so collapsing updates per shape cannot drop
   * it. Absent when the run replaces no asset (the overwhelmingly common case).
   */
  replacedAssets?: Record<string, OverlayAsset>;
}

/**
 * After-state shapes for a single mutation op:
 * - `updateOverlayShape` → `[patchedShape]` (the one shape the op targets).
 * - `alignOverlayShapes` → the aligned shapes, in `op.shapeIds` order.
 * - any other op, or an update/align op whose shape id(s) are missing from `currentShapes`
 *   (or, for `distributeX`/`distributeY`, too few shapes to align) → `null`.
 */
export function resolveMutationOpShapeResults(op: SigmaDocMutationOp, currentShapes: OverlayShape[]): OverlayShape[] | null {
  if (op.operation === "updateOverlayShape") {
    if (!currentShapes.some((shape) => shape.id === op.shapeId)) {
      return null;
    }
    try {
      const updated = computeUpdatedOverlayShapes(currentShapes, op);
      const after = updated.find((shape) => shape.id === op.shapeId);
      return after ? [after] : null;
    } catch {
      return null;
    }
  }

  if (op.operation === "alignOverlayShapes") {
    if (op.shapeIds.some((id) => !currentShapes.some((shape) => shape.id === id))) {
      return null;
    }
    try {
      const aligned = computeAlignedOverlayShapes(currentShapes, op);
      const alignedById = new Map(aligned.map((shape) => [shape.id, shape]));
      const results = op.shapeIds.map((id) => alignedById.get(id)).filter((shape): shape is OverlayShape => !!shape);
      return results.length > 0 ? results : null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Overlay assets as they will look AFTER the op is applied.
 *
 * An `updateOverlayShape` may carry a replacement for a picture derived from the shape it
 * updates (a 3D figure's preview PNG). Rendering the after-state against the live document's
 * assets would draw the new spec with the old picture — exactly the drift the assets channel
 * exists to prevent — so the op's own assets win, the same way apply merges them.
 */
export function resolveMutationOpAssets(
  op: SigmaDocMutationOp,
  currentAssets: Record<string, OverlayAsset>,
): Record<string, OverlayAsset> {
  if (op.operation !== "updateOverlayShape" || !op.assets || Object.keys(op.assets).length === 0) {
    return currentAssets;
  }
  return { ...currentAssets, ...op.assets };
}

/**
 * For every `updateOverlayShape`/`alignOverlayShapes` op across `previews` (in group then
 * array order — the same order `applySigmaDocMutationOp` would apply them in), computes the
 * after-state of the affected shapes against `currentShapes` (the live document's resolved
 * overlay shapes). Ops whose shape id(s) are missing from `currentShapes` are skipped. Later
 * ops see the results of earlier ops — shapes are threaded through sequentially, exactly as
 * they would be if the ops were actually applied one after another.
 */
export function deriveAiEditPreviewShapeUpdates(
  previews: AiEditPreviewState[],
  currentShapes: OverlayShape[],
): AiEditPreviewShapeUpdate[] {
  let shapes = currentShapes;
  // Replacement assets accumulate across ops, exactly like `shapes` does: a caller that keeps
  // only the last update per shape (the canvas ghost does) must still get the picture an earlier
  // op replaced, or a follow-up resize/align silently restores the stale drawing.
  let replacedAssets: Record<string, OverlayAsset> = {};
  const updates: AiEditPreviewShapeUpdate[] = [];

  for (const preview of previews) {
    const replacedShapeIds = new Set((preview.shapeReplacements ?? []).map((pair) => pair.removedShapeId));
    for (const op of preview.draft.mutationOperations ?? []) {
      if (op.operation !== "updateOverlayShape" && op.operation !== "alignOverlayShapes") {
        continue;
      }

      const results = resolveMutationOpShapeResults(op, shapes)
        ?.filter((shape) => !replacedShapeIds.has(shape.id));
      if (!results) {
        continue;
      }

      const resultsById = new Map(results.map((shape) => [shape.id, shape]));
      shapes = shapes.map((shape) => resultsById.get(shape.id) ?? shape);
      replacedAssets = resolveMutationOpAssets(op, replacedAssets);
      const carried = Object.keys(replacedAssets).length > 0 ? replacedAssets : undefined;
      for (const shape of results) {
        updates.push({ shapeId: shape.id, after: shape, ...(carried ? { replacedAssets: carried } : {}) });
      }
    }
  }

  return updates;
}
