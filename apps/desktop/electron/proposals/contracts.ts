import { type AiEditSessionDocumentDraft, type AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import { type AiAppliedDocumentDiff } from "@/lib/ai/applied-document-diff";
import { type SigmaDocument } from "@/features/document";

// "reverted" は承認済み提案を revertDocument で巻き戻した後の終端状態
// (resolveProposal の approved/rejected とは別経路の markReverted() で設定される)。
export type LocalMcpEditProposalStatus = "pending" | "approved" | "rejected" | "reverted";

// どのAIプロバイダの起動プロセスがこの提案を作ったか。外部CLIから直接叩かれた場合など、
// 判別できないケースは null (仕様上の正当な値であり、後方互換のための欠損値ではない)。
// electron側 (main/preload/mcp server) の唯一の宣言。sigma-studio-mcp-launch.ts はこれを
// 再エクスポートして使い、renderer 側は electron を import できないため src/types/desktop.d.ts
// に同じ union をミラーした DesktopMcpEditProposalProvider を宣言している (2箇所が上限)。
export type McpEditProposalProvider = "claude" | "chatgpt" | "antigravity";

// electron側でこのunionを検証する唯一のバリデータ。sigma-studio-mcp-launch.ts と
// mcp/sigma-doc-mcp-server-core.ts の両方がこれを使う (重複した if/switch ガードを避けるため)。
export function parseMcpProposalProvider(value: unknown): McpEditProposalProvider | null {
  return value === "claude" || value === "chatgpt" || value === "antigravity" ? value : null;
}

// MCPサーバー (Phase 1: Agentic RAG) が書き込み系ツール呼び出し時にオプションで渡す
// 「この編集が参照した過去教材・素材・Webページ」の記録。デスクトップUIに「参照元」として
// 表示するための情報で、編集内容そのものには影響しない。electron側の唯一の宣言。renderer側は
// electron を import できないため src/types/desktop.d.ts に同じ union をミラーした
// DesktopAiSourceReference を宣言している (2箇所が上限)。
// "webSearch" は「Web検索したが URL は取れない」ケース用。Codex の webSearch item は
// query しか持たない (v2/ItemStartedNotification.json) ため、開けない URL を捏造せず
// 検索語をそのまま出典として示す。
/** 1提案が保持する参照元の上限。MCPの入力スキーマ側と同じ値を electron 側でも守る。 */
export const MAX_PROPOSAL_SOURCE_REFERENCES = 10;

export type AiSourceReference =
  | { type: "document"; fileId: string; title?: string; blockId?: string; note?: string }
  | { type: "web"; url: string; title?: string }
  | { type: "webSearch"; query: string }
  | { type: "material"; materialId: string; name?: string };

// 寛容な型ガード: 壊れた/将来の値を持つ1件だけを黙って落とせるよう、配列全体ではなく
// 要素単位で検証する (parseProposal 側で parseAiSourceReferences がこれでフィルタする)。
export function isAiSourceReference(value: unknown): value is AiSourceReference {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "document") {
    return (
      typeof value.fileId === "string" &&
      (value.title === undefined || typeof value.title === "string") &&
      (value.blockId === undefined || typeof value.blockId === "string") &&
      (value.note === undefined || typeof value.note === "string")
    );
  }
  if (value.type === "web") {
    return typeof value.url === "string" && (value.title === undefined || typeof value.title === "string");
  }
  if (value.type === "webSearch") {
    return typeof value.query === "string";
  }
  if (value.type === "material") {
    return typeof value.materialId === "string" && (value.name === undefined || typeof value.name === "string");
  }
  return false;
}

export function isAiSourceReferenceArray(value: unknown): value is AiSourceReference[] {
  return Array.isArray(value) && value.every(isAiSourceReference);
}

/** 永続化済み提案の読み戻し用: 不正な要素だけを落とし、正しい参照は残す。 */
export function parseAiSourceReferences(value: unknown): AiSourceReference[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isAiSourceReference);
}

// MCPサーバー (mcp/sigma-doc-mcp-server-core.ts、今回のバッチ外) が提案作成時に実行コンテキスト
// から埋める帰属情報。すべて任意 (外部CLIから直接叩かれた場合など判別できないケースがあるため)。
// 旧レコード (これらのフィールドが存在しない) は parseProposal で単に undefined として扱われ、
// 拒否や表示に影響しない。
export interface LocalMcpEditProposalAttribution {
  /** ai-edit:run の runId。concurrent runs の突合に使う。 */
  runId?: string;
  /** チャットルームID (AiEditChatRoom.id)。 */
  roomId?: string;
  /** ルーム内の発話(ターン)ID。 */
  turnId?: string;
  /** 人間可読なセッションラベル (UI表示用、値の意味はrenderer側が決める)。 */
  sessionLabel?: string;
}

// MCPサーバー側が提案の検証結果を書き込むための任意フィールド。今回のバッチでは
// ストアが値を保存・往復させるだけで、検証自体はMCPサーバー側 (今回のバッチ外) が行う。
export interface LocalMcpEditProposalVerification {
  validationOk: boolean;
  /** 検証に使ったプレビュー描画の由来 (例: "katex" / "graph2d")。任意の自由文字列。 */
  previewSource?: string;
}

// 提案のdraftがID単位で「触りうる」対象 (変更/削除/置換対象、および挿入のアンカー) 1件分。
// baseHash は提案作成時点 (baseDocument) でのそのIDのブロック/overlay図形ハッシュ
// (computeDocumentBlockHashes 参照)。baseHash が null なのは「baseDocument 時点にはまだ
// 存在しないID」(挿入で新規に作られるブロック/図形) を意味する。
export interface LocalMcpEditProposalTouchedBlock {
  id: string;
  baseHash: string | null;
}

// autoRebaseProposalsForFile が「触った対象のどれかが提案作成後に実際に変更されていた」ことを
// 検出した場合に立てるフラグ。手動rebaseの手掛かりとして残るだけで、これ自体は
// pending/approved/rejected といった status 遷移には関与しない (conflict中でもpendingのまま)。
export type LocalMcpEditProposalConflictReason =
  | "content-stale"
  | "anchor-missing"
  | "asset-collision"
  | "replay-failed";

export interface LocalMcpEditProposalConflict {
  blockIds: string[];
  detectedAtRevision: number;
  reason?: LocalMcpEditProposalConflictReason;
}

export interface ProposalFreshnessConflict {
  blockIds: string[];
  reason: LocalMcpEditProposalConflictReason;
}

export interface LocalMcpEditProposalHistoryEntry {
  action: "revised" | "rejected" | "withdrawn" | "reproposed";
  at: string;
  reason?: string;
  runId?: string;
  turnId?: string;
}

// 「依頼時の選択範囲」のスナップショット (electron/ai-edit-run-context.ts の
// AiEditRequestSelection をMCP経由で提案に記録したもの)。現在は旧提案の判定材料として保持する。
// draftとtouchedBlocksを持つ新しい提案では、選択範囲ではなく「提案が実際に上書きする対象」を
// 衝突判定に使う。選択した文章を参照して別の場所へ追記するだけの提案まで、選択側の編集を理由に
// 一律で拒否しないため。
export interface LocalMcpEditProposalRequestSelection {
  blockIds: string[];
  /** blockIds のうち、依頼時点でドキュメントに存在していたIDの内容ハッシュ (computeDocumentBlockHashes)。 */
  hashes: Record<string, string>;
  capturedRevision: number;
}

export interface LocalMcpEditProposal extends LocalMcpEditProposalAttribution {
  version: 1;
  proposalId: string;
  /** 同じAI run内で連続して作られた提案群のID。旧レコードでは存在しない。 */
  groupId?: string;
  /** グループを構成するproposalIdをtool実行順に並べたもの。 */
  groupMemberIds?: string[];
  /** グループ内の位置 (0始まり)。 */
  groupPosition?: number;
  fileId: string;
  baseRevision: number;
  baseDocId: string;
  title: string;
  summary: string;
  plan: string[];
  warnings: string[];
  changedIds: string[];
  provider: McpEditProposalProvider | null;
  source: {
    toolName: string;
    toolArgs: unknown;
  };
  draft: AiEditSessionDocumentDraft["draft"];
  nextDocument: SigmaDocument;
  status: LocalMcpEditProposalStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolutionMessage?: string;
  verification?: LocalMcpEditProposalVerification;
  // 却下 (reject) 専用の理由・日時。resolvedAt/resolutionMessage (承認/却下共通の汎用フィールド)
  // とは別に、UI側が「却下理由」だけを表示・検索できるようにするための専用フィールド。
  rejectedReason?: string;
  rejectedAt?: string;
  // rebaseProposal() が古い baseRevision をここに退避する (baseRevision 自体は現在値に更新される)。
  rebasedFrom?: number;
  // 承認 (approve/自動承認) の結果を「取り消し (revert)」できるようにするための保存フィールド。
  // appliedRevision: 保存直後のファイルrevision。revertはこのrevisionと現在のファイルrevisionが
  // 一致する場合のみ許可される (承認後にさらに別の変更が入っていたら取り消し不可)。
  appliedRevision?: number;
  appliedOperationId?: string;
  // revertDocument: 適用前 (マージ前) に読み込んだ現在ドキュメント。rebase後に承認された場合は
  // baseDocument (提案作成時点の文書) ではなく「承認実行時に読み込んだ文書」なので注意。
  revertDocument?: SigmaDocument;
  // 承認時に一度だけ計算して保存する小さな実差分。一覧表示で巨大なbefore/after文書を
  // 読み直さないための派生データで、revertの正本は引き続きrevertDocument。
  appliedDiff?: AiAppliedDocumentDiff;
  // 検証ゲート付き自動承認 (aiAutoApplyVerifiedProposals 設定) で承認された場合に true。
  autoApplied?: boolean;
  // Phase 1: Agentic RAG。この編集が参照した過去教材・素材・Webページ (存在する場合のみ)。
  sourceReferences?: AiSourceReference[];
  // draftがID単位で触りうる対象の一覧 (createProposal が baseDocument から計算)。旧レコード
  // (この機能追加前に作成された提案) には存在しないため undefined のまま扱う
  // (自動rebase/承認時の鮮度比較は「従来どおり手動rebase行き」にフォールバックする)。
  touchedBlocks?: LocalMcpEditProposalTouchedBlock[];
  // 依頼時の選択範囲スナップショット。draft/touchedBlocksが揃わない旧提案の判定にも使う。
  requestSelection?: LocalMcpEditProposalRequestSelection;
  // autoRebaseProposalsForFile が検出した「対象ブロックの実変更」。rebase成功でクリアされる。
  conflict?: LocalMcpEditProposalConflict;
  /** Runtime schemaで拒否された永続化draft。元draftは一切preview/replayせず、破棄だけを許可する。 */
  invalidReason?: string;
  /** 却下後の復活や同一room内での修正を、現在statusと独立して監査できる履歴。 */
  history?: LocalMcpEditProposalHistoryEntry[];
}

/**
 * 埋め込みSigmaDocumentを除いた提案レコード。listing・鮮度判定・帰属の絞り込みは
 * すべてこの範囲で足りるため、インデックスはこちらだけを保持して巨大な
 * nextDocument/revertDocument のパースとzod検証を丸ごと省く。
 */
export type LocalMcpEditProposalMeta =
  Omit<LocalMcpEditProposal, "nextDocument" | "revertDocument">;

export interface LocalMcpEditProposalSummary extends LocalMcpEditProposalAttribution {
  proposalId: string;
  groupId?: string;
  groupMemberIds?: string[];
  groupPosition?: number;
  fileId: string;
  baseRevision: number;
  baseDocId: string;
  title: string;
  summary: string;
  plan: string[];
  warnings: string[];
  changedIds: string[];
  provider: McpEditProposalProvider | null;
  /** Insert toolが要求した図形ID。delete+insertの論理置換をrendererで結び付けるための要約値。 */
  requestedShapeId?: string;
  // インラインプレビュー描画に使うため draft を summary にも含める (nextDocument は main 側のみ)。
  draft: AiEditSessionDocumentDraft["draft"];
  status: LocalMcpEditProposalStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolutionMessage?: string;
  verification?: LocalMcpEditProposalVerification;
  rejectedReason?: string;
  rejectedAt?: string;
  rebasedFrom?: number;
  appliedRevision?: number;
  appliedOperationId?: string;
  // rendererへ返す適用結果。revertDocument自体は渡さず、対象ノードのbefore/afterだけを返す。
  appliedDiff?: AiAppliedDocumentDiff;
  autoApplied?: boolean;
  sourceReferences?: AiSourceReference[];
  touchedBlocks?: LocalMcpEditProposalTouchedBlock[];
  requestSelection?: LocalMcpEditProposalRequestSelection;
  conflict?: LocalMcpEditProposalConflict;
  invalidReason?: string;
  history?: LocalMcpEditProposalHistoryEntry[];
  // revertDocument はサイズが大きく、renderer には不要なため summary からは意図的に除外する
  // (electron側の main.ts が revert 実行時に loadProposal() 経由でフル版から読む)。
}

export type LocalMcpEditProposalChangeEvent =
  | {
      type: "mcpProposal";
      proposalId?: string;
      change: "changed";
      timestamp: number;
      /** 検証済み自動承認 (aiAutoApplyVerifiedProposals) によって承認された変更であることを示す。 */
      autoApplied?: boolean;
      /** 却下時: 一括で却下された proposalId 群 (単一却下でも1件の配列)。 */
      rejectedProposalIds?: string[];
      /** 却下理由 (存在する場合)。 */
      rejectedReason?: string;
    }
  | {
      type: "watcher";
      scope: "mcpProposal";
      change: "failed" | "recovered";
      timestamp: number;
    };

export interface LocalMcpEditProposalCreateInput extends LocalMcpEditProposalAttribution {
  fileId: string;
  baseRevision: number;
  baseDocument: SigmaDocument;
  summary: string;
  plan: string[];
  warnings?: string[];
  changedIds?: string[];
  provider: McpEditProposalProvider | null;
  source: {
    toolName: string;
    toolArgs: unknown;
  };
  draft: AiEditSessionDocumentDraft["draft"];
  nextDocument: SigmaDocument;
  verification?: LocalMcpEditProposalVerification;
  sourceReferences?: AiSourceReference[];
  /** 依頼時の選択範囲スナップショット (MCPサーバーがrun contextから読み出して渡す)。 */
  requestSelection?: LocalMcpEditProposalRequestSelection;
}

// MCPサーバー (今回のバッチ外) が実行コンテキスト (AiEditRunContext相当のshape) から
// createProposal に渡す帰属情報を組み立てるための小さなヘルパー。フィールド名の対応を
// ここ1箇所に閉じることで、MCPサーバー側は
// `createProposal({ ...resolveProposalAttribution(runContext), ... })` を呼ぶだけで済む。
// 値が空文字/非文字列の場合はキーごと省略する (LocalMcpEditProposal 側は「存在しない」ことを
// 「未判別」として扱うため、空文字列を書き込むより省略する方が安全)。
export function resolveProposalAttribution(
  runContextLike:
    | {
        runId?: unknown;
        roomId?: unknown;
        turnId?: unknown;
        sessionLabel?: unknown;
      }
    | null
    | undefined,
): LocalMcpEditProposalAttribution {
  if (!runContextLike) {
    return {};
  }
  const pick = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  const runId = pick(runContextLike.runId);
  const roomId = pick(runContextLike.roomId);
  const turnId = pick(runContextLike.turnId);
  const sessionLabel = pick(runContextLike.sessionLabel);
  return {
    ...(runId ? { runId } : {}),
    ...(roomId ? { roomId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(sessionLabel ? { sessionLabel } : {}),
  };
}

export type RebaseProposalResult =
  | { ok: true; proposal: LocalMcpEditProposalSummary }
  | { ok: false; reason: string };

export interface ResolveProposalExtra {
  /** approved のみ: 保存直後のファイルrevision (revertの前提条件として保存)。 */
  appliedRevision?: number;
  appliedOperationId?: string;
  /** approved のみ: 適用前 (マージ前) に読み込んだ現在ドキュメント (revert先)。 */
  revertDocument?: SigmaDocument;
  /** approved のみ: 実際に保存した適用後ドキュメント。実差分のafter側を確定する。 */
  appliedDocument?: SigmaDocument;
  /** approved のみ: 検証ゲート付き自動承認によるものであれば true。 */
  autoApplied?: boolean;
  /** rejected のみ: 却下理由。 */
  rejectedReason?: string;
}

// Phase 2: CASが崩れていても「AIが触ったブロック/図形自体は無編集」なら選択的に戻せるように
// なったため、getRevertableProposal (完全一致のみ許可) は getRevertPlan に統合された。
// mode: "full" は旧来どおり revertDocument をまるごと書き戻す (承認直後から教材が一切
// 変わっていないケース)。"selective" は buildSelectiveRevertDocument が current を土台に
// 触られた範囲だけ書き戻した結果。proposalIds は「同じ1回の保存を共有した承認バッチ全体」
// (同一fileId・同一appliedRevisionの承認済み提案) — 呼び出し元はこれを全部 reverted に遷移させる。
export type RevertPlanResult =
  | { ok: true; mode: "full" | "selective"; document: SigmaDocument; proposalIds: string[] }
  | { ok: false; reason: string };

export interface SelectiveRevertBatchDraft {
  proposalId: string;
  draft: AiEditSessionDraft;
  createdAt?: string;
  source?: { toolName: string; toolArgs: unknown };
  groupId?: string;
  groupPosition?: number;
}

export type SelectiveRevertResult =
  | { ok: true; document: SigmaDocument }
  | { ok: false; reason: string };

export type RestoreProposalResult =
  | { ok: true; proposal: LocalMcpEditProposalSummary }
  | { ok: false; reason: string };

export function selectGroupRepresentatives<T extends { groupId?: string; groupPosition?: number }>(proposals: T[]): T[] {
  const latestPositions = new Map<string, number>();
  for (const proposal of proposals) {
    if (proposal.groupId) {
      latestPositions.set(
        proposal.groupId,
        Math.max(latestPositions.get(proposal.groupId) ?? -1, proposal.groupPosition ?? 0),
      );
    }
  }
  return proposals.filter((proposal) =>
    !proposal.groupId || (proposal.groupPosition ?? 0) === latestPositions.get(proposal.groupId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
