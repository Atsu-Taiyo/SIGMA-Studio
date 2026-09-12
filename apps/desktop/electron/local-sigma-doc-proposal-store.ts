import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, watch, type FSWatcher, type WatchEventType } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { readBlockHashRevisions } from "./block-hash-sidecar";
import { createId } from "@/lib/id";
import {
  assertAiOverlayAssetsInDocument,
  isAllowedAiOverlayAssetSource,
  isAdditiveInsertOnlyDraft,
  parseAiEditSessionDraft,
  resolveAiEditSessionOperationOrder,
  type AiEditSessionDraft,
  type AiEditSessionOperationOrderEntry,
} from "@/lib/ai/sigma-doc-edit-schema";
import { deriveAppliedDocumentDiff, type AiAppliedDocumentDiff } from "@/lib/ai/applied-document-diff";
import { resolveAiOverlayShapeReplacementRequestedId } from "@/lib/ai/overlay-shape-replacement";
import { resolveDocumentTitle } from "@/lib/document-title";
import { computeDocumentBlockHashes } from "@/lib/sigma-doc-block-hash";
import { type SigmaDocument } from "@/features/document";
import { logLedgerEvent } from "./ledger-log";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import {
  type LocalMcpEditProposalStatus,
  parseMcpProposalProvider,
  MAX_PROPOSAL_SOURCE_REFERENCES,
  type AiSourceReference,
  parseAiSourceReferences,
  type LocalMcpEditProposalAttribution,
  type LocalMcpEditProposalVerification,
  type LocalMcpEditProposalTouchedBlock,
  type LocalMcpEditProposalConflictReason,
  type LocalMcpEditProposalConflict,
  type LocalMcpEditProposalHistoryEntry,
  type LocalMcpEditProposalRequestSelection,
  type LocalMcpEditProposal,
  type LocalMcpEditProposalMeta,
  type LocalMcpEditProposalSummary,
  type LocalMcpEditProposalChangeEvent,
  type LocalMcpEditProposalCreateInput,
  resolveProposalAttribution,
  type RebaseProposalResult,
  type ResolveProposalExtra,
  type RevertPlanResult,
  type SelectiveRevertBatchDraft,
  type RestoreProposalResult,
  selectGroupRepresentatives,
} from "./proposals/contracts";
import {
  collectRequiredInsertAnchorBlockIds,
  collectOccupiedInsertIds,
  collectConflictSensitiveBlockIds,
  computeTouchedBlocks,
  findProposalFreshnessConflictIds,
  findProposalFreshnessConflict,
  collectLocalColumnRangeAnchorIds,
} from "./proposals/freshness";
import {
  replayProposalDraft,
  collectReplaceTargetIds,
  findMissingUpdateRichContentTargetIds,
  assertAppliedProposalHasRealChanges,
} from "./proposals/replay";
import { buildSelectiveRevertDocument } from "./proposals/selective-revert";

// Existing Electron and MCP imports keep their public contract while proposal
// policy and document transformations live independently of filesystem storage.
export {
  type LocalMcpEditProposalStatus,
  type McpEditProposalProvider,
  parseMcpProposalProvider,
  MAX_PROPOSAL_SOURCE_REFERENCES,
  type AiSourceReference,
  isAiSourceReference,
  isAiSourceReferenceArray,
  parseAiSourceReferences,
  type LocalMcpEditProposalAttribution,
  type LocalMcpEditProposalVerification,
  type LocalMcpEditProposalTouchedBlock,
  type LocalMcpEditProposalConflictReason,
  type LocalMcpEditProposalConflict,
  type ProposalFreshnessConflict,
  type LocalMcpEditProposalHistoryEntry,
  type LocalMcpEditProposalRequestSelection,
  type LocalMcpEditProposal,
  type LocalMcpEditProposalMeta,
  type LocalMcpEditProposalSummary,
  type LocalMcpEditProposalChangeEvent,
  type LocalMcpEditProposalCreateInput,
  resolveProposalAttribution,
  type RebaseProposalResult,
  type ResolveProposalExtra,
  type RevertPlanResult,
  type SelectiveRevertBatchDraft,
  type SelectiveRevertResult,
  type RestoreProposalResult,
} from "./proposals/contracts";
export {
  canForceApplyProposalConflict,
  shouldAutoApplyProposal,
  collectTouchedBlockIds,
  collectConflictSensitiveBlockIds,
  findConflictingBlockIds,
  findRequestSelectionConflictIds,
  findProposalFreshnessConflictIds,
  findProposalFreshnessConflict,
  classifyProposalReplayFailure,
} from "./proposals/freshness";
export {
  type MergeProposalDraftsResult,
  mergeProposalDraftsIntoDocument,
  replayProposalDraft,
  assertAppliedProposalHasRealChanges,
} from "./proposals/replay";
export {
  buildSelectiveRevertDocument,
} from "./proposals/selective-revert";

const te = createCurrentLocaleTranslator("error");
const DATA_DIR_NAME = "data";
const PROPOSALS_DIR_NAME = "proposals";
const DOC_BLOCK_HASHES_DIR_NAME = "doc-block-hashes";
const PROPOSAL_FILE_SUFFIX = ".proposal.json";
const DEFAULT_RESOLVED_PROPOSAL_LIMIT = 50;
const INDEX_STAT_CONCURRENCY = 32;
const INDEX_META_READ_CONCURRENCY = 8;

// Proposal files are atomic JSON writes. A short debounce is enough to merge
// the rename/change pair emitted by fs.watch while keeping the canvas preview
// responsive after an MCP insertion.
const WATCH_DEBOUNCE_MS = 20;
const DEFAULT_WATCH_RETRY_BASE_MS = 250;
const DEFAULT_WATCH_MAX_RETRIES = 3;
export const MAX_MCP_PROPOSAL_FILE_BYTES = 16 * 1024 * 1024;

// LocalMcpEditProposalStore はMCP tool呼び出しごとに生成されることがあるため、instance内の
// mutexでは承認IPCとupsert/rejectを直列化できない。dataDir+fileIdをkeyにしたprocess共有queueを
// 使い、同じ非同期連鎖からの再入だけAsyncLocalStorageで許可する。
const proposalMutationQueues = new Map<string, Promise<unknown>>();
const heldProposalMutationLocks = new AsyncLocalStorage<Set<string>>();

interface ProposalIndexEntry {
  filePath: string;
  mtimeMs: number;
  size: number;
  meta: LocalMcpEditProposalMeta;
}

interface ProposalIndexStats {
  sweeps: number;
  metaReads: number;
  fullLoads: number;
}

export interface LocalMcpEditProposalStoreOptions {
  readDocumentBlockHashes?: (
    fileId: string,
    revision: number,
  ) => Promise<Record<string, string> | undefined>;
  watchFactory?: (
    filename: string,
    options: { persistent: boolean },
    listener: (eventType: WatchEventType, filename: string | Buffer | null) => void,
  ) => FSWatcher;
  watchRetryBaseMs?: number;
  watchMaxRetries?: number;
}

export class LocalMcpEditProposalStore {
  private readonly dataDir: string;
  private readonly proposalsDir: string;
  private readonly docBlockHashesDir: string;
  private readonly documentBlockHashReader?: LocalMcpEditProposalStoreOptions["readDocumentBlockHashes"];
  private readonly watchFactory: NonNullable<LocalMcpEditProposalStoreOptions["watchFactory"]>;
  private readonly watchRetryBaseMs: number;
  private readonly watchMaxRetries: number;
  private watchTimer: NodeJS.Timeout | null = null;
  private watchRetryTimer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private readonly watchListeners = new Set<(event: LocalMcpEditProposalChangeEvent) => void>();
  private readonly ownWatchSuppressions = new Map<string, number>();
  private readonly pendingWatchProposalIds = new Set<string>();
  private pendingUnknownWatchChange = false;
  private indexCache = new Map<string, ProposalIndexEntry>();
  private indexValidatedAt = 0;
  private indexDirty = false;
  private indexBuild: Promise<void> | null = null;
  private indexInvalidationVersion = 0;
  private indexMutationGeneration = 0;
  private readonly preciseIndexMutations = new Map<string, {
    generation: number;
    entry: ProposalIndexEntry | null;
  }>();
  private readonly indexStats: ProposalIndexStats = { sweeps: 0, metaReads: 0, fullLoads: 0 };
  private readonly runSnapshots = new Map<string, {
    roomId: string;
    fileId: string;
    proposals: LocalMcpEditProposal[];
  }>();

  constructor(userDataPath: string, options: LocalMcpEditProposalStoreOptions = {}) {
    this.dataDir = path.join(userDataPath, DATA_DIR_NAME);
    this.proposalsDir = path.join(this.dataDir, PROPOSALS_DIR_NAME);
    this.docBlockHashesDir = path.join(this.dataDir, DOC_BLOCK_HASHES_DIR_NAME);
    this.documentBlockHashReader = options.readDocumentBlockHashes;
    this.watchFactory = options.watchFactory ?? watch;
    this.watchRetryBaseMs = options.watchRetryBaseMs ?? DEFAULT_WATCH_RETRY_BASE_MS;
    this.watchMaxRetries = options.watchMaxRetries ?? DEFAULT_WATCH_MAX_RETRIES;
  }

  getProposalsDir(): string {
    return this.proposalsDir;
  }

  public __getIndexStatsForTests(): ProposalIndexStats {
    return { ...this.indexStats };
  }

  public __resetIndexStatsForTests(): void {
    this.indexStats.sweeps = 0;
    this.indexStats.metaReads = 0;
    this.indexStats.fullLoads = 0;
  }

  async runExclusive<T>(fileId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${this.dataDir}\0${fileId}`;
    const held = heldProposalMutationLocks.getStore();
    if (held?.has(key)) {
      return fn();
    }
    const prior = proposalMutationQueues.get(key) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(() => {
      const nextHeld = new Set(held ?? []);
      nextHeld.add(key);
      return heldProposalMutationLocks.run(nextHeld, fn);
    });
    const tail = run.then(() => undefined, () => undefined);
    proposalMutationQueues.set(key, tail);
    try {
      return await run;
    } finally {
      if (proposalMutationQueues.get(key) === tail) {
        proposalMutationQueues.delete(key);
      }
    }
  }

  /** 起動直後にmeta indexだけを先読みし、最初の「適用」クリックからdirectory走査を外す。 */
  async warmIndex(): Promise<void> {
    await this.refreshIndex();
  }

  async createProposal(input: LocalMcpEditProposalCreateInput): Promise<LocalMcpEditProposal> {
    return this.runExclusive(input.fileId, () => this.createProposalUnlocked(input));
  }

  private async createProposalUnlocked(input: LocalMcpEditProposalCreateInput): Promise<LocalMcpEditProposal> {
    await this.ensureBaseDirs();
    const draft = parseProposalDraftAtCreation(input);
    const now = new Date().toISOString();
    const nextDocument = parseSigmaDocument(input.nextDocument);
    assertAiOverlayAssetsInDocument(nextDocument);
    const baseDocument = parseSigmaDocument(input.baseDocument);
    const attribution = resolveProposalAttribution(input);
    const touchedBlocks = computeTouchedBlocks(draft, baseDocument);
    const proposal: LocalMcpEditProposal = {
      version: 1,
      proposalId: createId("mcp_proposal"),
      fileId: input.fileId,
      baseRevision: input.baseRevision,
      baseDocId: baseDocument.docId,
      title: resolveDocumentTitle(nextDocument, resolveDocumentTitle(baseDocument)),
      summary: input.summary || "MCP編集提案",
      plan: normalizeStringArray(input.plan),
      warnings: normalizeStringArray(input.warnings),
      changedIds: normalizeStringArray(input.changedIds),
      provider: input.provider,
      source: input.source,
      draft,
      nextDocument,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      ...attribution,
      ...(input.verification ? { verification: input.verification } : {}),
      ...(input.sourceReferences?.length ? { sourceReferences: input.sourceReferences } : {}),
      ...(touchedBlocks.length > 0 ? { touchedBlocks } : {}),
      ...(input.requestSelection ? { requestSelection: input.requestSelection } : {}),
    };
    await this.writeProposal(proposal);
    return proposal;
  }

  /**
   * room/runに帰属する現在のpending案を1件だけ返す。roomIdが分かる場合は
   * turnをまたぐ自己修正を可能にするためroomを優先し、外部MCPなどroom不明の場合だけ
   * runIdにフォールバックする。
   */
  async findCurrentPendingProposal(params: {
    fileId: string;
    roomId?: string;
    runId?: string;
  }): Promise<LocalMcpEditProposal | null> {
    const roomId = params.roomId?.trim();
    const runId = params.runId?.trim();
    if (!roomId && !runId) {
      return null;
    }
    const candidates = (await this.getIndexMetas())
      .filter((proposal) => proposal.status === "pending" && proposal.fileId === params.fileId)
      .filter((proposal) => roomId ? proposal.roomId === roomId : proposal.runId === runId)
      .sort((a, b) => {
        const timeCompare = b.updatedAt.localeCompare(a.updatedAt);
        if (timeCompare !== 0) return timeCompare;
        // Tie-breaker for same-run proposals with identical updatedAt:
        // select the one with highest groupPosition (representative)
        const aPosition = a.groupPosition ?? -1;
        const bPosition = b.groupPosition ?? -1;
        return bPosition - aPosition;
      });
    // indexは候補IDの絞り込み専用。別プロセスが直前に解決していても古いpendingを
    // 返さないよう、候補を権威あるファイルから読み直して条件を再確認する。
    for (const candidate of candidates) {
      const proposal = await this.loadProposal(candidate.proposalId);
      if (
        proposal?.status === "pending"
        && !proposal.invalidReason
        && proposal.fileId === params.fileId
        && (roomId ? proposal.roomId === roomId : proposal.runId === runId)
      ) {
        return proposal;
      }
    }
    return null;
  }

  async findLatestPendingProposalForFile(fileId: string): Promise<LocalMcpEditProposal | null> {
    const candidates = (await this.getIndexMetas())
      .filter((proposal) => proposal.status === "pending" && proposal.fileId === fileId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const candidate of candidates) {
      const proposal = await this.loadProposal(candidate.proposalId);
      if (proposal?.status === "pending" && !proposal.invalidReason && proposal.fileId === fileId) {
        return proposal;
      }
    }
    return null;
  }

  /**
   * MCPが同じroomの作業案上で次の操作を実行した後、pendingレコードを原子的に置き換える。
   * proposalIdは内部参照の安定のため維持し、一時的に新旧両方ともpendingになる窓を作らない。
   * callerはbaseDocumentに保存済みSigmaDoc、draft/nextDocumentにそこからの集約差分を渡す。
   */
  async upsertCurrentProposal(input: LocalMcpEditProposalCreateInput): Promise<LocalMcpEditProposal> {
    return this.runExclusive(input.fileId, () => this.upsertCurrentProposalUnlocked(input));
  }

  private async upsertCurrentProposalUnlocked(input: LocalMcpEditProposalCreateInput): Promise<LocalMcpEditProposal> {
    const inputDraft = parseProposalDraftAtCreation(input);
    const attribution = resolveProposalAttribution(input);
    const current = await this.findCurrentPendingProposal({
      fileId: input.fileId,
      roomId: attribution.roomId,
      runId: attribution.runId,
    });
    if (!current) {
      return this.createProposalUnlocked(input);
    }

    const isSameRun = Boolean(attribution.runId && current.runId === attribution.runId);
    if (isSameRun) {
      const now = new Date().toISOString();
      const baseDocument = parseSigmaDocument(input.baseDocument);
      const combinedDraft = appendProposalDraft(current.draft, inputDraft);
      const replay = replayProposalDraft(baseDocument, combinedDraft);
      const nextDocument = parseSigmaDocument(replay.nextDocument);
      assertAiOverlayAssetsInDocument(nextDocument);
      const groupId = current.groupId ?? createId("mcp_proposal_group");
      const existingMemberIds = normalizeGroupMemberIds(current);
      const proposalId = createId("mcp_proposal");
      const groupMemberIds = [...existingMemberIds, proposalId];
      const touchedBlocks = computeTouchedBlocks(replay.draft, baseDocument);
      const combinedChangedIds = Array.from(new Set([
        ...current.changedIds,
        ...normalizeStringArray(input.changedIds),
      ]));
      const historyEntry: LocalMcpEditProposalHistoryEntry = {
        action: "revised",
        at: now,
        ...(attribution.runId ? { runId: attribution.runId } : {}),
        ...(attribution.turnId ? { turnId: attribution.turnId } : {}),
      };
      const existingMembers = await this.loadProposalGroup(current);
      const shared = {
        ...attribution,
        groupId,
        groupMemberIds,
        baseRevision: input.baseRevision,
        baseDocId: baseDocument.docId,
        title: resolveDocumentTitle(nextDocument, resolveDocumentTitle(baseDocument)),
        summary: input.summary || "MCP編集提案",
        plan: replay.draft.plan,
        warnings: replay.draft.warnings,
        changedIds: combinedChangedIds,
        provider: input.provider,
        draft: replay.draft,
        nextDocument,
        updatedAt: now,
        verification: input.verification,
        sourceReferences: input.sourceReferences?.length
          ? mergeSourceReferences(current.sourceReferences, input.sourceReferences)
          : current.sourceReferences,
        touchedBlocks: touchedBlocks.length > 0 ? touchedBlocks : undefined,
        requestSelection: input.requestSelection ?? current.requestSelection,
        conflict: undefined,
      } satisfies Partial<LocalMcpEditProposal>;
      const updatedMembers = existingMembers.map((member, index): LocalMcpEditProposal => ({
        ...member,
        ...shared,
        groupPosition: index,
        history: [...(member.history ?? []), historyEntry],
      }));
      const nextProposal: LocalMcpEditProposal = {
        ...current,
        ...shared,
        proposalId,
        source: input.source,
        createdAt: now,
        groupPosition: groupMemberIds.length - 1,
        history: [...(current.history ?? []), historyEntry],
      };
      await Promise.all([...updatedMembers, nextProposal].map((proposal) => this.writeProposal(proposal)));
      return nextProposal;
    }

    const now = new Date().toISOString();
    const baseDocument = parseSigmaDocument(input.baseDocument);
    const nextDocument = parseSigmaDocument(input.nextDocument);
    assertAiOverlayAssetsInDocument(nextDocument);
    const touchedBlocks = computeTouchedBlocks(inputDraft, baseDocument);
    const history = [
      ...(current.history ?? []),
      {
        action: "revised" as const,
        at: now,
        ...(attribution.runId ? { runId: attribution.runId } : {}),
        ...(attribution.turnId ? { turnId: attribution.turnId } : {}),
      },
    ];
    const nextProposal: LocalMcpEditProposal = {
      ...current,
      ...attribution,
      baseRevision: input.baseRevision,
      baseDocId: baseDocument.docId,
      title: resolveDocumentTitle(nextDocument, resolveDocumentTitle(baseDocument)),
      summary: input.summary || "MCP編集提案",
      plan: normalizeStringArray(input.plan),
      warnings: normalizeStringArray(input.warnings),
      changedIds: normalizeStringArray(input.changedIds),
      provider: input.provider,
      source: input.source,
      draft: inputDraft,
      nextDocument,
      updatedAt: now,
      history,
      verification: input.verification,
      sourceReferences: input.sourceReferences?.length ? input.sourceReferences : current.sourceReferences,
      touchedBlocks: touchedBlocks.length > 0 ? touchedBlocks : undefined,
      requestSelection: input.requestSelection ?? current.requestSelection,
      conflict: undefined,
    };
    await this.writeProposal(nextProposal);
    return nextProposal;
  }

  async withdrawCurrentProposal(params: {
    fileId: string;
    roomId?: string;
    runId?: string;
    reason?: string;
  }): Promise<LocalMcpEditProposal | null> {
    return this.runExclusive(params.fileId, () => this.withdrawCurrentProposalUnlocked(params));
  }

  private async withdrawCurrentProposalUnlocked(params: {
    fileId: string;
    roomId?: string;
    runId?: string;
    reason?: string;
  }): Promise<LocalMcpEditProposal | null> {
    const proposal = await this.findCurrentPendingProposal(params);
    if (!proposal) {
      return null;
    }
    const now = new Date().toISOString();
    const reason = params.reason?.trim() || te("electron.proposalStore.withdrawnByAi");
    const members = await this.loadProposalGroup(proposal);
    const nextProposals = members.map((member): LocalMcpEditProposal => ({
      ...member,
      status: "rejected",
      updatedAt: now,
      resolvedAt: now,
      resolutionMessage: reason,
      rejectedAt: now,
      rejectedReason: reason,
      history: [...(member.history ?? []), { action: "withdrawn", at: now, reason }],
    }));
    await Promise.all(nextProposals.map((p) => this.writeProposal(p)));
    return nextProposals[nextProposals.length - 1] || proposal;
  }

  /** AI run中のper-tool upsertを失敗時にまるごと戻すためのmain-process内snapshot。 */
  async beginProposalRunSnapshot(roomId: string, fileId: string): Promise<string> {
    const normalizedRoomId = roomId.trim();
    const normalizedFileId = fileId.trim();
    if (!normalizedRoomId || !normalizedFileId) {
      throw new Error(te("electron.proposalStore.roomAndFileRequired"));
    }
    const snapshotId = createId("mcp_proposal_run");
    const candidateIds = (await this.getIndexMetas())
      .filter((proposal) =>
        proposal.status === "pending" && proposal.fileId === normalizedFileId && proposal.roomId === normalizedRoomId)
      .map((proposal) => proposal.proposalId);
    const proposals = (await Promise.all(candidateIds.map((proposalId) => this.loadProposal(proposalId))))
      .filter((proposal): proposal is LocalMcpEditProposal => Boolean(
        proposal
        && proposal.status === "pending"
        && proposal.fileId === normalizedFileId
        && proposal.roomId === normalizedRoomId,
      ));
    this.runSnapshots.set(snapshotId, {
      roomId: normalizedRoomId,
      fileId: normalizedFileId,
      proposals: structuredClone(proposals),
    });
    return snapshotId;
  }

  completeProposalRunSnapshot(snapshotId: string): boolean {
    return this.runSnapshots.delete(snapshotId);
  }

  async rollbackProposalRunSnapshot(snapshotId: string): Promise<boolean> {
    const snapshot = this.runSnapshots.get(snapshotId);
    if (!snapshot) {
      return false;
    }
    try {
      const snapshotIds = new Set(snapshot.proposals.map((proposal) => proposal.proposalId));
      const candidateIds = (await this.getIndexMetas())
        .filter((proposal) =>
          proposal.status === "pending" && proposal.fileId === snapshot.fileId && proposal.roomId === snapshot.roomId)
        .map((proposal) => proposal.proposalId);
      const current = (await Promise.all(candidateIds.map((proposalId) => this.loadProposal(proposalId))))
        .filter((proposal): proposal is LocalMcpEditProposal => Boolean(
          proposal
          && proposal.status === "pending"
          && proposal.fileId === snapshot.fileId
          && proposal.roomId === snapshot.roomId,
        ));
      await Promise.all(current
        .filter((proposal) => !snapshotIds.has(proposal.proposalId))
        .map((proposal) => this.deleteProposalFile(proposal.proposalId)));
      for (const proposal of snapshot.proposals) {
        await this.writeProposal(proposal);
      }
      return true;
    } finally {
      this.runSnapshots.delete(snapshotId);
    }
  }

  /**
   * run 終了時に、その run が作った全提案へ参照元を追記する。
   *
   * MCPサーバー側で記録できない参照 (Codex の web 検索は query しか通知されず、しかも
   * MCPツール呼び出しですらない) を、main プロセスが run のイベント列から拾って後付けする
   * ための経路。既に承認済みの提案にも追記する — 適用後もチップを出し続けるのが要件なので、
   * pending に限定してはならない。
   */
  async appendSourceReferencesForRun(runId: string, references: AiSourceReference[]): Promise<number> {
    const trimmedRunId = runId.trim();
    if (!trimmedRunId || references.length === 0) {
      return 0;
    }
    const targetIds = (await this.getIndexMetas())
      .filter((proposal) => proposal.runId === trimmedRunId)
      .map((proposal) => proposal.proposalId);

    let updatedCount = 0;
    for (const proposalId of targetIds) {
      // 書き込み直前に読み直す。この store には提案単位のロックが無く、run 終了処理と
      // 承認・自動rebaseが並走しうるため、最初の一括読み取り時点のレコードをそのまま
      // 書き戻すと status や appliedRevision を巻き戻してしまう (lost update)。
      // 参照元は補助情報なので、窓を最小化したうえで最新レコードに対してだけ足す。
      const current = await this.loadProposal(proposalId);
      if (!current) {
        continue;
      }
      const merged = mergeSourceReferences(current.sourceReferences, references)
        .slice(0, MAX_PROPOSAL_SOURCE_REFERENCES);
      if (merged.length === (current.sourceReferences?.length ?? 0)) {
        continue;
      }
      await this.writeProposal({ ...current, sourceReferences: merged });
      updatedCount += 1;
    }
    return updatedCount;
  }

  async listProposals(options: {
    status?: LocalMcpEditProposalStatus | "all";
    fileId?: string;
    resolvedLimit?: number;
  } = {}): Promise<LocalMcpEditProposalSummary[]> {
    const status = options.status ?? "pending";
    const filtered = (await this.getIndexMetas())
      .filter((proposal) => status === "all" || proposal.status === status)
      .filter((proposal) => (
        proposal.status === "pending"
        || !options.fileId
        || proposal.fileId === options.fileId
      ));
    const representatives = selectGroupRepresentatives(filtered)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const resolvedLimit = options.resolvedLimit ?? DEFAULT_RESOLVED_PROPOSAL_LIMIT;
    let resolvedCount = 0;
    return representatives
      .filter((proposal) => {
        if (proposal.status === "pending") {
          return true;
        }
        resolvedCount += 1;
        return resolvedCount <= resolvedLimit;
      })
      .map(summarizeProposalMeta);
  }

  async loadProposal(proposalId: string): Promise<LocalMcpEditProposal | null> {
    await this.ensureBaseDirs();
    return this.readProposalFile(this.getProposalPath(proposalId));
  }

  /**
   * Completes the validation/preview metadata after a proposal has already
   * been made visible to the desktop. An unverified proposal is never eligible
   * for automatic approval, so the slower preview render can safely finish
   * after the initial atomic proposal write.
   */
  async updateProposalVerification(
    proposalId: string,
    expected: Pick<LocalMcpEditProposal, "updatedAt" | "baseRevision" | "draft" | "changedIds">,
    verification: LocalMcpEditProposalVerification,
  ): Promise<LocalMcpEditProposal | null> {
    const proposal = await this.loadProposal(proposalId);
    if (
      !proposal
      || proposal.status !== "pending"
      || proposal.updatedAt !== expected.updatedAt
      || proposal.baseRevision !== expected.baseRevision
      || JSON.stringify(proposal.draft) !== JSON.stringify(expected.draft)
      || JSON.stringify(proposal.changedIds) !== JSON.stringify(expected.changedIds)
    ) {
      return null;
    }
    const nextProposal: LocalMcpEditProposal = {
      ...proposal,
      verification,
      updatedAt: new Date().toISOString(),
    };
    await this.writeProposal(nextProposal);
    return nextProposal;
  }

  async resolveProposal(
    proposalId: string,
    status: Extract<LocalMcpEditProposalStatus, "approved" | "rejected">,
    message?: string,
    extra: ResolveProposalExtra = {},
  ): Promise<LocalMcpEditProposal> {
    const candidate = await this.loadProposal(proposalId);
    if (!candidate) {
      throw new Error(te("electron.proposal.notFound"));
    }
    return this.runExclusive(candidate.fileId, () => this.resolveProposalUnlocked(proposalId, status, message, extra));
  }

  private async resolveProposalUnlocked(
    proposalId: string,
    status: Extract<LocalMcpEditProposalStatus, "approved" | "rejected">,
    message?: string,
    extra: ResolveProposalExtra = {},
  ): Promise<LocalMcpEditProposal> {
    const proposal = await this.loadProposal(proposalId);
    if (!proposal) {
      throw new Error(te("electron.proposal.notFound"));
    }
    if (proposal.status !== "pending") {
      throw new Error(te("electron.proposal.alreadyProcessed"));
    }

    const members = await this.loadProposalGroup(proposal);
    if (members.some((member) => member.status !== "pending")) {
      throw new Error(te("electron.proposalStore.groupAlreadyProcessed"));
    }

    const revertDocument = status === "approved" && extra.revertDocument
      ? parseSigmaDocument(extra.revertDocument)
      : undefined;
    let appliedDocument = extra.appliedDocument ? parseSigmaDocument(extra.appliedDocument) : undefined;
    if (status === "approved" && proposal.groupId && revertDocument) {
      try {
        const representative = members.at(-1) ?? proposal;
        appliedDocument = replayProposalDraft(revertDocument, representative.draft).nextDocument;
      } catch {
        throw new Error(te("electron.proposalStore.groupApplyFailed"));
      }
    }

    const now = new Date().toISOString();
    const nextMembers = members.map((member): LocalMcpEditProposal => ({
      ...member,
      status,
      updatedAt: now,
      resolvedAt: now,
      ...(message ? { resolutionMessage: message } : {}),
      ...(status === "approved" && extra.appliedRevision !== undefined ? { appliedRevision: extra.appliedRevision } : {}),
      ...(status === "approved" && revertDocument ? { revertDocument } : {}),
      ...(status === "approved" && appliedDocument ? { nextDocument: appliedDocument } : {}),
      ...(status === "approved" && revertDocument && appliedDocument
        ? { appliedDiff: deriveAppliedDocumentDiff(revertDocument, appliedDocument, [member.draft]) }
        : {}),
      ...(status === "approved" && extra.autoApplied ? { autoApplied: true } : {}),
      ...(status === "rejected" ? { rejectedAt: now, ...(extra.rejectedReason ? { rejectedReason: extra.rejectedReason } : {}) } : {}),
      ...(status === "rejected" ? {
        history: [...(member.history ?? []), {
          action: "rejected" as const,
          at: now,
          ...(extra.rejectedReason ? { reason: extra.rejectedReason } : {}),
        }],
      } : {}),
    }));
    await Promise.all(nextMembers.map((member) => this.writeProposal(member)));
    return nextMembers.find((member) => member.proposalId === proposalId) ?? nextMembers.at(-1)!;
  }

  /**
   * 複数の pending 提案をまとめて却下する。承認 (approve-mcp-edit-proposals) と違い各提案は
   * 独立に却下されるため (合成適用しない)、1件が処理済みで失敗しても他の対象は処理を続ける。
   * 却下できた・できなかったIDを両方返し、呼び出し元 (main.ts) が1回のbroadcastにまとめる。
   */
  async rejectProposals(
    proposalIds: string[],
    reason?: string,
  ): Promise<{ rejected: LocalMcpEditProposal[]; failed: { proposalId: string; error: string }[] }> {
    const rejected: LocalMcpEditProposal[] = [];
    const failed: { proposalId: string; error: string }[] = [];
    const handled = new Set<string>();
    for (const proposalId of proposalIds) {
      if (handled.has(proposalId)) {
        continue;
      }
      try {
        const before = await this.loadProposal(proposalId);
        const memberIds = before ? normalizeGroupMemberIds(before) : [proposalId];
        await this.resolveProposal(proposalId, "rejected", te("electron.proposal.desktopRejected"), {
          rejectedReason: reason,
        });
        handled.add(proposalId);
        for (const memberId of memberIds) {
          handled.add(memberId);
          const member = await this.loadProposal(memberId);
          if (member) {
            rejected.push(member);
          }
        }
      } catch (error) {
        failed.push({
          proposalId,
          error: error instanceof Error ? error.message : te("electron.proposalStore.rejectFailed"),
        });
      }
    }
    return { rejected, failed };
  }
  /**
   * fileId のすべての pending 提案を、セッション (roomId/runId) に関わらず返す。
   * 過去セッション由来の取り下げ不可な提案を UI 側で表示・却下するために使う。
   */
  async listAllPendingProposalsForFile(fileId: string): Promise<LocalMcpEditProposalSummary[]> {
    return selectGroupRepresentatives(await this.listPendingMetasForFile(fileId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(summarizeProposalMeta);
  }

  async countPendingProposalsForFile(fileId: string): Promise<number> {
    return (await this.listPendingMetasForFile(fileId)).length;
  }

  /**
   * 任意の pending 提案を1件だけ却下する。rejectProposals (複数) と違い、
   * roomId/runId に関わらず指定 proposalId 1件を処理する。
   * グループメンバーも一括して却下する。
   */
  async rejectSingleProposal(proposalId: string, reason?: string): Promise<LocalMcpEditProposal> {
    const before = await this.loadProposal(proposalId);
    if (!before) {
      throw new Error(te("electron.proposal.notFound"));
    }
    if (before.status !== "pending") {
      throw new Error(te("electron.proposalStore.processedCannotReject"));
    }

    return this.runExclusive(before.fileId, () => this.resolveProposalUnlocked(
      proposalId,
      "rejected",
      reason?.trim() || te("electron.proposalStore.rejectedFromCrossSession"),
      { rejectedReason: reason?.trim() || te("electron.proposalStore.rejectedFromCrossSession") },
    ));
  }

  /**
   * pending 提案を、提案作成時点 (baseRevision) ではなく現在のドキュメントに対して再適用できるか
   * 試す。成功すれば提案レコードをその場で更新 (baseRevision/baseDocId/nextDocumentを現在値に、
   * rebasedFrom に元のbaseRevisionを保存) し、失敗すればレコードには一切触れない。
   */
  async rebaseProposal(
    proposalId: string,
    currentDocument: SigmaDocument,
    currentRevision: number,
  ): Promise<RebaseProposalResult> {
    const proposal = await this.loadProposal(proposalId);
    if (!proposal) {
      return { ok: false, reason: te("electron.proposal.notFound") };
    }
    if (proposal.status !== "pending") {
      return { ok: false, reason: te("electron.proposalStore.processedCannotRebase") };
    }
    if (proposal.invalidReason) {
      return { ok: false, reason: proposal.invalidReason };
    }

    let normalizedCurrentDocument: SigmaDocument;
    try {
      normalizedCurrentDocument = parseSigmaDocument(currentDocument);
    } catch {
      return { ok: false, reason: te("electron.proposalStore.currentDocumentRebaseFailed") };
    }

    const members = await this.loadProposalGroup(proposal);
    if (members.some((member) => member.status !== "pending")) {
      return { ok: false, reason: te("electron.proposalStore.processedGroupCannotRebase") };
    }
    const representative = members.at(-1) ?? proposal;
    const missingRichContentTargetIds = findMissingUpdateRichContentTargetIds(representative, normalizedCurrentDocument);
    if (missingRichContentTargetIds.length > 0) {
      await this.writeGroupConflict(members, missingRichContentTargetIds, currentRevision, "anchor-missing");
      return {
        ok: false,
        reason: te("electron.proposalStore.missingRichContentTargets", { ids: missingRichContentTargetIds.join(", ") }),
      };
    }

    let nextDocument: SigmaDocument;
    let replayDraft = representative.draft;
    try {
      const replay = replayProposalDraft(normalizedCurrentDocument, representative.draft);
      nextDocument = replay.nextDocument;
      replayDraft = replay.draft;
    } catch {
      return { ok: false, reason: te("electron.proposalStore.targetMismatch") };
    }

    try {
      assertAppliedProposalHasRealChanges(normalizedCurrentDocument, nextDocument, replayDraft);
    } catch (error) {
      const blockIds = collectReplaceTargetIds(replayDraft);
      if (blockIds.length > 0) {
        await this.writeGroupConflict(members, blockIds, currentRevision, "replay-failed");
      }
      return {
        ok: false,
        reason: error instanceof Error ? error.message : te("electron.proposalStore.rebaseDiffFailed"),
      };
    }

    const now = new Date().toISOString();
    const sharedTouchedBlocks = computeTouchedBlocks(replayDraft, normalizedCurrentDocument);
    const nextMembers = members.map((member): LocalMcpEditProposal => ({
      ...member,
      baseRevision: currentRevision,
      baseDocId: normalizedCurrentDocument.docId,
      draft: replayDraft,
      nextDocument: parseSigmaDocument(nextDocument),
      rebasedFrom: member.baseRevision,
      // touchedBlocks の baseHash は「(旧)baseDocument 時点のハッシュ」だったので、rebase後は
      // 新しい base (= currentDocument) に対して取り直す。取り直さないと次回のrebase/承認時に
      // 古い base のハッシュのまま比較してしまい、誤って「変更あり」と判定してしまう。
      ...(members.some((candidate) => candidate.touchedBlocks) ? { touchedBlocks: sharedTouchedBlocks } : {}),
      // rebase成功 = 検出されていた競合(あれば)は解消済み。
      conflict: undefined,
      updatedAt: now,
    }));
    await Promise.all(nextMembers.map((member) => this.writeProposal(member)));
    const nextProposal = nextMembers.find((member) => member.proposalId === proposalId) ?? nextMembers.at(-1)!;
    return { ok: true, proposal: summarizeProposal(nextProposal) };
  }

  /**
   * 却下 (rejected) または差し戻し (reverted、承認後にCtrl+Z/承認取消で巻き戻されたもの) 済みの
   * draftを現在SigmaDocにreplayでき、実際の上書き対象も無変更の場合だけpendingへ戻す。
   * AIチャット履歴・AIタスクDockどちらの「復元」ボタンからも、承認可否に関わらずこのメソッド
   * 1本を通る (rejected/revertedを別メソッドに分けない)。
   */
  async restoreResolvedProposal(
    proposalId: string,
    currentDocument: SigmaDocument,
    currentRevision: number,
  ): Promise<RestoreProposalResult> {
    const proposal = await this.loadProposal(proposalId);
    if (!proposal) {
      return { ok: false, reason: te("electron.proposal.notFound") };
    }
    if (proposal.status !== "rejected" && proposal.status !== "reverted") {
      return { ok: false, reason: te("electron.proposalStore.onlyResolvedCanRestore") };
    }
    if (proposal.invalidReason) {
      return { ok: false, reason: proposal.invalidReason };
    }

    const normalizedCurrentDocument = parseSigmaDocument(currentDocument);
    const conflictIds = findProposalFreshnessConflictIds(
      proposal,
      computeDocumentBlockHashes(normalizedCurrentDocument),
      currentRevision,
      normalizedCurrentDocument,
    );
    if (conflictIds.length > 0) {
      return { ok: false, reason: te("electron.proposalStore.restoreConflict", { ids: conflictIds.join(", ") }) };
    }

    let nextDocument: SigmaDocument;
    let replayDraft = proposal.draft;
    try {
      const replay = replayProposalDraft(normalizedCurrentDocument, proposal.draft);
      replayDraft = replay.draft;
      nextDocument = replay.nextDocument;
    } catch {
      return { ok: false, reason: te("electron.proposalStore.restoreReplayFailed") };
    }

    const now = new Date().toISOString();
    const nextProposal: LocalMcpEditProposal = {
      ...proposal,
      status: "pending",
      baseRevision: currentRevision,
      baseDocId: normalizedCurrentDocument.docId,
      draft: replayDraft,
      nextDocument: parseSigmaDocument(nextDocument),
      touchedBlocks: computeTouchedBlocks(replayDraft, normalizedCurrentDocument),
      conflict: undefined,
      updatedAt: now,
      history: [...(proposal.history ?? []), { action: "reproposed", at: now }],
    };
    delete nextProposal.rejectedAt;
    delete nextProposal.rejectedReason;
    delete nextProposal.resolvedAt;
    delete nextProposal.resolutionMessage;
    // reverted提案は「承認済みだった頃」の appliedRevision/revertDocument/autoApplied を
    // markReverted() 後もそのまま引きずっている (revert機能自体がrevertDocument等を必要と
    // するため意図的に残されている)。pendingに戻す以上これらは古い承認の残骸でしかなく、
    // 消さずに置くと次の承認 (resolveProposal) が autoApplied を条件付きspreadでしか更新
    // しないため「手動承認したのに自動適用ラベルが残る」といった表示不整合を招く。
    delete nextProposal.appliedRevision;
    delete nextProposal.revertDocument;
    delete nextProposal.appliedDiff;
    delete nextProposal.autoApplied;

    // If this proposal is part of a group, restore all members atomically
    if (proposal.groupId) {
      try {
        const members = await this.loadProposalGroup(proposal);
        const updatedMembers = members.map((member): LocalMcpEditProposal => ({
          ...member,
          status: "pending",
          baseRevision: currentRevision,
          baseDocId: normalizedCurrentDocument.docId,
          draft: replayDraft,
          nextDocument: parseSigmaDocument(nextDocument),
          touchedBlocks: computeTouchedBlocks(replayDraft, normalizedCurrentDocument),
          conflict: undefined,
          updatedAt: now,
          history: [...(member.history ?? []), { action: "reproposed", at: now }],
        }));
        // Clear the same fields from all members
        updatedMembers.forEach((member) => {
          delete member.rejectedAt;
          delete member.rejectedReason;
          delete member.resolvedAt;
          delete member.resolutionMessage;
          delete member.appliedRevision;
          delete member.revertDocument;
          delete member.appliedDiff;
          delete member.autoApplied;
        });
        await Promise.all(updatedMembers.map((member) => this.writeProposal(member)));
        return { ok: true, proposal: summarizeProposal(updatedMembers.find((m) => m.proposalId === proposalId) ?? updatedMembers[0]) };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : te("electron.proposalStore.groupRestoreFailed") };
      }
    }

    await this.writeProposal(nextProposal);
    return { ok: true, proposal: summarizeProposal(nextProposal) };
  }

  /**
   * baseRevision が古い(currentRevision未満)pending提案を、現在のドキュメントへ自動的に
   * 追従(rebase)させる。直前revisionのhash差分がdraftの競合対象・挿入アンカーと交差しない
   * 場合はblind replayせずbaseRevisionだけを進め、交差する場合だけreplayと衝突判定を行う。
   * hash履歴が読めない場合は安全側の従来判定へ戻す。精密判定できない旧提案は
   * requestSelection、さらにtouchedBlocksへフォールバックし、どちらも無い旧提案は対象外
   * (手動rebase行き)。
   */
  async autoRebaseProposalsForFile(
    fileId: string,
    currentDocument: SigmaDocument,
    currentRevision: number,
  ): Promise<{ rebased: string[]; conflicted: string[] }> {
    const candidates = selectGroupRepresentatives(
      (await this.listPendingMetasForFile(fileId))
        .filter((proposal) => proposal.baseRevision < currentRevision),
    );
    if (candidates.length === 0) {
      return { rebased: [], conflicted: [] };
    }

    const normalizedCurrentDocument = parseSigmaDocument(currentDocument);
    const currentHashes = computeDocumentBlockHashes(normalizedCurrentDocument);
    const previousHashes = await this.readDocumentBlockHashes(fileId, currentRevision - 1);
    const changedBlockIds = previousHashes && Object.keys(previousHashes).length > 0
      && !looksLikeBlockHashFormatChanged(previousHashes, currentHashes)
      ? findChangedBlockIds(previousHashes, currentHashes)
      : undefined;
    const rebased: string[] = [];
    const conflicted: string[] = [];

    for (const candidate of candidates) {
      const insertAnchorIds = collectRequiredInsertAnchorBlockIds(candidate.draft);
      const conflictSensitiveIds = collectConflictSensitiveBlockIds(candidate.draft);
      if (
        !candidate.requestSelection
        && !candidate.touchedBlocks?.length
        && !isAdditiveInsertOnlyDraft(candidate.draft, normalizedCurrentDocument)
      ) {
        // 上書き系の旧提案はbaseHashが無いと安全性を判定できない。純粋なinsertだけは
        // 「外部アンカーが存在すること」を最小契約として現在docへreplayできる。
        continue;
      }
      const freshnessConflict = findProposalFreshnessConflict(
        candidate,
        currentHashes,
        currentRevision,
        normalizedCurrentDocument,
      );
      if (freshnessConflict) {
        await this.markConflict(
          candidate.proposalId,
          freshnessConflict.blockIds,
          currentRevision,
          freshnessConflict.reason,
        );
        conflicted.push(candidate.proposalId);
        continue;
      }
      const rebaseSensitiveIds = new Set([
        ...conflictSensitiveIds,
        ...insertAnchorIds,
      ]);
      // changedBlockIds は「直前revision→現在」の差分しか表さない。candidate の
      // baseRevision がそれより古い場合 (AI run開始後・提案書き込み前に人手保存が
      // 挟まった等) は、その間の変更が差分に現れないため早道に乗せず従来判定へ倒す。
      // 承認時の鮮度判定は touchedBlocks の baseHash を絶対比較するので最終的な
      // 取りこぼしは無いが、conflictの提示が承認時まで遅れるのを避ける。
      const changedBlockIdsCoverCandidate = changedBlockIds
        && candidate.baseRevision === currentRevision - 1;
      if (
        changedBlockIds
        && changedBlockIdsCoverCandidate
        && !candidate.conflict
        && !hasSetIntersection(changedBlockIds, rebaseSensitiveIds)
      ) {
        const advanced = await this.advanceProposalBaseRevisionWithoutReplay(
          candidate.proposalId,
          normalizedCurrentDocument.docId,
          currentRevision,
        );
        if (advanced) {
          rebased.push(candidate.proposalId);
        }
        continue;
      }
      const result = await this.rebaseProposal(candidate.proposalId, normalizedCurrentDocument, currentRevision);
      if (result.ok) {
        rebased.push(candidate.proposalId);
      } else {
        // 上書き対象は無変更だったのにreplayが失敗した(挿入アンカーの削除等の
        // 想定外ケース)。安全側に倒してconflict扱いにする。
        const columnRangeAnchorIds = collectLocalColumnRangeAnchorIds(candidate.draft);
        const missingColumnRangeAnchorIds = columnRangeAnchorIds.filter((id) => currentHashes[id] === undefined);
        const missingInsertAnchorIds = insertAnchorIds.filter((id) => currentHashes[id] === undefined);
        const occupiedInsertIds = collectOccupiedInsertIds(candidate.draft, currentHashes);
        const fallbackIds = missingColumnRangeAnchorIds.length > 0
          ? missingColumnRangeAnchorIds
          : missingInsertAnchorIds.length > 0
            ? missingInsertAnchorIds
            : occupiedInsertIds.length > 0
              ? occupiedInsertIds
            : candidate.requestSelection?.blockIds.length
              ? candidate.requestSelection.blockIds
              : (candidate.touchedBlocks ?? []).map((touched) => touched.id);
        await this.markConflict(
          candidate.proposalId,
          fallbackIds,
          currentRevision,
          missingColumnRangeAnchorIds.length > 0 || missingInsertAnchorIds.length > 0
            ? "anchor-missing"
            : "replay-failed",
        );
        conflicted.push(candidate.proposalId);
      }
    }
    return { rebased, conflicted };
  }

  private async readDocumentBlockHashes(
    fileId: string,
    revision: number,
  ): Promise<Record<string, string> | undefined> {
    if (this.documentBlockHashReader) {
      try {
        return await this.documentBlockHashReader(fileId, revision);
      } catch {
        return undefined;
      }
    }

    // 形式・拡張子は `block-hash-sidecar.ts` が唯一の出典。ここに自前の定数とパーサを
    // 持っていたせいで、書き手だけが追記型へ移った時に**黙って何も読めなくなり**、
    // 自動 rebase が「履歴が読めない時の安全側フォールバック」に落ち続けていた。
    try {
      const revisions = await readBlockHashRevisions(this.docBlockHashesDir, fileId);
      return revisions?.[String(revision)];
    } catch {
      return undefined;
    }
  }

  private async advanceProposalBaseRevisionWithoutReplay(
    proposalId: string,
    baseDocId: string,
    currentRevision: number,
  ): Promise<boolean> {
    const proposal = await this.loadProposal(proposalId);
    if (!proposal || proposal.status !== "pending") {
      return false;
    }
    const members = await this.loadProposalGroup(proposal);
    if (members.some((member) => member.status !== "pending")) {
      return false;
    }

    const now = new Date().toISOString();
    await Promise.all(members.map((member) => this.writeProposal({
      ...member,
      baseRevision: currentRevision,
      baseDocId,
      rebasedFrom: member.baseRevision,
      conflict: undefined,
      updatedAt: now,
    })));
    return true;
  }

  async recordProposalConflict(
    proposalId: string,
    blockIds: string[],
    detectedAtRevision: number,
    reason: LocalMcpEditProposalConflictReason,
  ): Promise<void> {
    const proposal = await this.loadProposal(proposalId);
    if (!proposal || proposal.status !== "pending" || proposal.invalidReason) {
      return;
    }
    await this.writeGroupConflict(await this.loadProposalGroup(proposal), blockIds, detectedAtRevision, reason);
  }

  private async markConflict(
    proposalId: string,
    blockIds: string[],
    detectedAtRevision: number,
    reason: LocalMcpEditProposalConflictReason,
  ): Promise<void> {
    await this.recordProposalConflict(proposalId, blockIds, detectedAtRevision, reason);
  }

  /**
   * revert (取り消し) 実行前の判定。承認済みで、承認直後のrevisionから教材がまったく
   * 変更されていなければ revertDocument をまるごと戻す ("full")。教材が進んでいても、
   * この提案(と同じ保存を共有した承認バッチ全員)が触ったブロック/図形自体がその後
   * 無編集なら、現在のドキュメントを土台にその範囲だけを戻す ("selective")。
   * 実際の巻き戻し保存は main.ts が localSigmaDocStore 経由で行い、成功したら
   * proposalIds 全員を reverted に遷移させる (2段階なのは、ここでは「保存できるか」を
   * 判定できないため = このストアはドキュメント保存を持たない)。
   */
  async getRevertPlan(
    proposalId: string,
    currentRevision: number,
    currentDocument: SigmaDocument,
  ): Promise<RevertPlanResult> {
    const proposal = await this.loadProposal(proposalId);
    if (!proposal) {
      return { ok: false, reason: te("electron.proposal.notFound") };
    }
    if (proposal.status !== "approved") {
      return { ok: false, reason: te("electron.proposalStore.onlyApprovedCanUndo") };
    }
    if (proposal.appliedRevision === undefined) {
      return { ok: false, reason: te("electron.proposalStore.undoInfoMissing") };
    }
    if (!proposal.revertDocument) {
      return { ok: false, reason: te("electron.proposalStore.undoDocumentMissing") };
    }

    // 同じ1回の保存を共有した承認バッチ全体 (approve-mcp-edit-proposals が1回の保存で
    // 複数提案を合成した場合、全員が同じ fileId + appliedRevision を持つ)。承認時の並び順
    // (createdAt昇順、approve-mcp-edit-proposalsのorderedと同じ) で揃え直す。
    const candidateIds = (await this.getIndexMetas())
      .filter((candidate) => (
        candidate.fileId === proposal.fileId
        && candidate.status === "approved"
        && candidate.appliedRevision === proposal.appliedRevision
      ))
      .map((candidate) => candidate.proposalId);
    if (!candidateIds.includes(proposal.proposalId)) {
      candidateIds.push(proposal.proposalId);
    }
    const batch = (await Promise.all(candidateIds.map((candidateId) => this.loadProposal(candidateId))))
      .filter((candidate): candidate is LocalMcpEditProposal => Boolean(
        candidate
        && candidate.fileId === proposal.fileId
        && candidate.status === "approved"
        && candidate.appliedRevision === proposal.appliedRevision,
      ))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const proposalIds = batch.map((candidate) => candidate.proposalId);

    if (proposal.appliedRevision === currentRevision) {
      return { ok: true, mode: "full", document: proposal.revertDocument, proposalIds };
    }

    const normalizedCurrentDocument = parseSigmaDocument(currentDocument);
    const batchDrafts: SelectiveRevertBatchDraft[] = batch.map((candidate) => ({
      proposalId: candidate.proposalId,
      draft: candidate.draft,
      createdAt: candidate.createdAt,
      source: candidate.source,
      groupId: candidate.groupId,
      groupPosition: candidate.groupPosition,
    }));
    const selective = buildSelectiveRevertDocument({
      revertDocument: proposal.revertDocument,
      batchDrafts,
      currentDocument: normalizedCurrentDocument,
    });
    if (!selective.ok) {
      return selective;
    }
    return { ok: true, mode: "selective", document: selective.document, proposalIds };
  }

  /**
   * エディタの Ctrl+Z (undo) がAI適用を1手で取り消したときのストア側整合: approved → reverted。
   * ドキュメント本体の巻き戻しは renderer の undo スタックが行う (revertMcpEditProposal と違い
   * ここではドキュメントを保存しない) ため、appliedRevision === currentRevision の前提条件は
   * 要求しない — undo は後続編集を先に巻き戻してから到達する順序が保証されているため。
   * approved 以外の提案はスキップして続行する (二重undo・別経路で解決済みのケース)。
   */
  async markProposalsRevertedByUndo(proposalIds: string[]): Promise<{ transitioned: string[]; skipped: string[] }> {
    return this.transitionProposals(proposalIds, "approved", "reverted");
  }

  /** markProposalsRevertedByUndo の逆方向 (redo での再適用): reverted → approved。 */
  async markProposalsReappliedByRedo(proposalIds: string[]): Promise<{ transitioned: string[]; skipped: string[] }> {
    return this.transitionProposals(proposalIds, "reverted", "approved");
  }

  private async transitionProposals(
    proposalIds: string[],
    fromStatus: LocalMcpEditProposalStatus,
    toStatus: LocalMcpEditProposalStatus,
  ): Promise<{ transitioned: string[]; skipped: string[] }> {
    const transitioned: string[] = [];
    const skipped: string[] = [];
    const now = new Date().toISOString();
    for (const proposalId of proposalIds) {
      const proposal = await this.loadProposal(proposalId);
      if (!proposal || proposal.status !== fromStatus) {
        skipped.push(proposalId);
        continue;
      }
      // Expand group members to transition all related proposals
      const idsToTransition = proposal.groupMemberIds && proposal.groupMemberIds.length > 0
        ? proposal.groupMemberIds
        : [proposalId];
      for (const idToTransition of idsToTransition) {
        const member = await this.loadProposal(idToTransition);
        if (member && member.status === fromStatus) {
          await this.writeProposal({ ...member, status: toStatus, updatedAt: now });
          transitioned.push(idToTransition);
        }
      }
    }
    return { transitioned, skipped };
  }

  /** getRevertPlan() のOKを受けて、保存が成功した後にバッチの各proposalIdへ呼ぶ終端状態への遷移。 */
  async markReverted(proposalId: string): Promise<LocalMcpEditProposal> {
    const proposal = await this.loadProposal(proposalId);
    if (!proposal) {
      throw new Error(te("electron.proposal.notFound"));
    }
    const now = new Date().toISOString();
    const nextProposal: LocalMcpEditProposal = {
      ...proposal,
      status: "reverted",
      updatedAt: now,
    };
    await this.writeProposal(nextProposal);
    return nextProposal;
  }

  watch(onChange: (event: LocalMcpEditProposalChangeEvent) => void): () => void {
    this.ensureBaseDirsSync();
    this.watchListeners.add(onChange);
    this.ensureWatcher();

    return () => {
      this.watchListeners.delete(onChange);
      if (this.watchListeners.size === 0) {
        this.watcher?.close();
        this.watcher = null;
        if (this.watchRetryTimer) {
          clearTimeout(this.watchRetryTimer);
          this.watchRetryTimer = null;
        }
      }
    };
  }

  private async ensureBaseDirs(): Promise<void> {
    await fs.mkdir(this.proposalsDir, { recursive: true });
  }

  private ensureBaseDirsSync(): void {
    mkdirSync(this.proposalsDir, { recursive: true });
  }

  private getProposalPath(proposalId: string): string {
    return path.join(this.proposalsDir, `${encodeURIComponent(proposalId)}${PROPOSAL_FILE_SUFFIX}`);
  }

  private async getIndexMetas(): Promise<LocalMcpEditProposalMeta[]> {
    // 別のMCPサーバー/renderer/mainプロセスによる変更も次の問い合わせで必ず拾う。
    // refreshIndexはmtime+sizeが同じファイルを再利用するため、通常時のI/Oはreaddir+statだけ。
    await this.refreshIndex();
    return [...this.indexCache.values()].map((entry) => entry.meta);
  }

  private async refreshIndex(): Promise<void> {
    if (this.indexBuild) {
      return this.indexBuild;
    }

    const build = (async () => {
      await this.ensureBaseDirs();
      this.indexStats.sweeps += 1;
      const mutationGenerationAtStart = this.indexMutationGeneration;
      const names = (await fs.readdir(this.proposalsDir))
        .filter((name) => name.endsWith(PROPOSAL_FILE_SUFFIX));

      const statEntries = await mapWithConcurrency(
        names,
        INDEX_STAT_CONCURRENCY,
        async (name): Promise<{
          proposalId: string;
          filePath: string;
          mtimeMs: number;
          size: number;
        } | null> => {
          const filePath = path.join(this.proposalsDir, name);
          try {
            const stat = await fs.stat(filePath);
            const proposalId = decodeProposalFileName(name);
            if (!stat.isFile() || !proposalId) {
              return null;
            }
            return {
              proposalId,
              filePath,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
            };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              console.warn(`MCP編集提案の索引用statに失敗しました: ${filePath}`, error);
            }
            return null;
          }
        },
      );

      const nextCache = new Map<string, ProposalIndexEntry>();
      const changedEntries: Array<NonNullable<(typeof statEntries)[number]>> = [];
      for (const statEntry of statEntries) {
        if (!statEntry) {
          continue;
        }
        const cached = this.indexCache.get(statEntry.proposalId);
        if (
          cached
          && cached.mtimeMs === statEntry.mtimeMs
          && cached.size === statEntry.size
        ) {
          // mtimeとsizeが一致するレコードはオブジェクトごと再利用し、巨大なJSONを読み直さない。
          nextCache.set(statEntry.proposalId, cached);
        } else {
          changedEntries.push(statEntry);
        }
      }

      const parsedEntries = await mapWithConcurrency(
        changedEntries,
        INDEX_META_READ_CONCURRENCY,
        async (statEntry): Promise<{ proposalId: string; entry: ProposalIndexEntry } | null> => {
          const meta = await this.readProposalMetaFile(statEntry.filePath);
          if (!meta) {
            return null;
          }
          return {
            proposalId: statEntry.proposalId,
            entry: {
              filePath: statEntry.filePath,
              mtimeMs: statEntry.mtimeMs,
              size: statEntry.size,
              meta,
            },
          };
        },
      );
      for (const parsedEntry of parsedEntries) {
        if (parsedEntry) {
          nextCache.set(parsedEntry.proposalId, parsedEntry.entry);
        }
      }

      // refresh中にこのstore自身が原子的な書き込み・削除を完了した場合、その精密更新を
      // readdir/statの古いスナップショットで上書きしない。
      const mutationGenerationAtCommit = this.indexMutationGeneration;
      for (const [proposalId, mutation] of this.preciseIndexMutations) {
        if (mutation.generation <= mutationGenerationAtStart) {
          continue;
        }
        if (mutation.entry) {
          nextCache.set(proposalId, mutation.entry);
        } else {
          nextCache.delete(proposalId);
        }
      }

      this.indexCache = nextCache;
      this.indexValidatedAt = Date.now();
      // 全問い合わせでreaddir+statするため、watcherの世代をTTL相当の信頼判定へ
      // 持ち越す必要はない。refresh中の自プロセス更新は上のprecise mutationで反映済み。
      this.indexDirty = false;
      for (const [proposalId, mutation] of this.preciseIndexMutations) {
        if (mutation.generation <= mutationGenerationAtCommit) {
          this.preciseIndexMutations.delete(proposalId);
        }
      }
    })();
    this.indexBuild = build;
    try {
      await build;
    } finally {
      if (this.indexBuild === build) {
        this.indexBuild = null;
      }
    }
  }

  private async listPendingMetasForFile(fileId: string): Promise<LocalMcpEditProposalMeta[]> {
    return (await this.getIndexMetas())
      .filter((meta) => meta.status === "pending" && meta.fileId === fileId);
  }

  private ensureWatcher(retryAttempt = 0): void {
    if (this.watcher || this.watchRetryTimer || this.watchListeners.size === 0) {
      return;
    }
    this.ensureBaseDirsSync();
    let watcher: FSWatcher;
    try {
      watcher = this.watchFactory(this.proposalsDir, { persistent: false }, (_event, filename) => {
        const proposalId = typeof filename === "string" && filename.endsWith(PROPOSAL_FILE_SUFFIX)
          ? decodeProposalFileName(filename)
          : undefined;
        if (typeof filename === "string" && !proposalId) {
          // Atomic-write用tmpやcorruptディレクトリはproposal indexの対象ではない。
          return;
        }

        // debounceの後ではなく、fs.watchイベントを受けた時点で索引を不正化する。
        this.indexDirty = true;
        this.indexInvalidationVersion += 1;
        if (proposalId) {
          this.pendingWatchProposalIds.add(proposalId);
        } else {
          this.pendingUnknownWatchChange = true;
        }
        if (this.watchTimer) {
          clearTimeout(this.watchTimer);
        }
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          const proposalIds = [...this.pendingWatchProposalIds];
          const hasUnknownChange = this.pendingUnknownWatchChange;
          const invalidationVersion = this.indexInvalidationVersion;
          this.pendingWatchProposalIds.clear();
          this.pendingUnknownWatchChange = false;

          void (async () => {
            if (!hasUnknownChange) {
              await Promise.all(proposalIds.map((id) => this.invalidateIndex(id)));
              if (this.indexInvalidationVersion === invalidationVersion) {
                this.indexDirty = false;
              }
            }
            for (const id of proposalIds) {
              this.ownWatchSuppressions.delete(id);
            }

            const eventProposalId = proposalIds.length === 1 && !hasUnknownChange
              ? proposalIds[0]
              : undefined;
            const event: LocalMcpEditProposalChangeEvent = {
              type: "mcpProposal",
              proposalId: eventProposalId,
              change: "changed",
              timestamp: Date.now(),
            };
            for (const listener of this.watchListeners) {
              listener(event);
            }
          })();
        }, WATCH_DEBOUNCE_MS);
      });
    } catch (error) {
      this.handleWatcherFailure(retryAttempt, error);
      return;
    }
    this.watcher = watcher;
    if (retryAttempt > 0) {
      logLedgerEvent(this.dataDir, "local-store-watch-restarted", { scope: "mcpProposal", retryAttempt });
      // 旧watcher停止から再装着までのイベントはfs.watchから届かない。新watcherを先に
      // 装着したうえでindexを強制再走査し、停止中の変更もrendererへ1回の合成イベントで通知する。
      this.indexDirty = true;
      this.indexInvalidationVersion += 1;
      void (async () => {
        await this.refreshIndex();
        const timestamp = Date.now();
        for (const listener of this.watchListeners) {
          listener({ type: "mcpProposal", change: "changed", timestamp });
        }
      })().catch((error) => {
        if (this.watcher === watcher) {
          watcher.close();
          this.watcher = null;
        }
        this.handleWatcherFailure(retryAttempt, error);
      });
    }
    watcher.on("error", (error) => {
      if (this.watcher !== watcher) {
        return;
      }
      watcher.close();
      this.watcher = null;
      this.handleWatcherFailure(retryAttempt, error);
    });
  }

  private handleWatcherFailure(retryAttempt: number, error: unknown): void {
    this.indexDirty = true;
    this.indexInvalidationVersion += 1;
    const errorMessage = error instanceof Error ? error.message : String(error);
    logLedgerEvent(this.dataDir, "local-store-watch-failed", {
      scope: "mcpProposal",
      retryAttempt,
      error: errorMessage,
    });
    if (retryAttempt >= this.watchMaxRetries) {
      logLedgerEvent(this.dataDir, "local-store-watch-permanently-failed", {
        scope: "mcpProposal",
        retryAttempt,
        error: errorMessage,
      });
      for (const listener of this.watchListeners) {
        listener({ type: "watcher", scope: "mcpProposal", change: "failed", timestamp: Date.now() });
      }
      return;
    }
    const delay = this.watchRetryBaseMs * (2 ** retryAttempt);
    this.watchRetryTimer = setTimeout(() => {
      this.watchRetryTimer = null;
      this.ensureWatcher(retryAttempt + 1);
    }, delay);
  }

  private async invalidateIndex(proposalId?: string): Promise<void> {
    if (!proposalId) {
      this.indexDirty = true;
      this.indexInvalidationVersion += 1;
      return;
    }

    const filePath = this.getProposalPath(proposalId);
    let entry: ProposalIndexEntry | null = null;
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        const meta = await this.readProposalMetaFile(filePath);
        if (meta) {
          entry = {
            filePath,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            meta,
          };
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`MCP編集提案の索引更新に失敗しました: ${filePath}`, error);
        this.indexDirty = true;
        this.indexInvalidationVersion += 1;
        return;
      }
    }

    const generation = ++this.indexMutationGeneration;
    const mutation = { generation, entry };
    this.preciseIndexMutations.set(proposalId, mutation);
    if (entry) {
      this.indexCache.set(proposalId, entry);
    } else {
      this.indexCache.delete(proposalId);
    }
  }

  private parseProposalMeta(value: unknown): LocalMcpEditProposalMeta | null {
    if (!isRecord(value) || value.version !== 1) {
      return null;
    }
    if (
      typeof value.proposalId !== "string"
      || typeof value.fileId !== "string"
      || typeof value.baseRevision !== "number"
      || typeof value.baseDocId !== "string"
      || typeof value.title !== "string"
      || typeof value.summary !== "string"
      || !isProposalStatus(value.status)
      || typeof value.createdAt !== "string"
      || typeof value.updatedAt !== "string"
      || !isRecord(value.source)
      || typeof value.source.toolName !== "string"
    ) {
      return null;
    }

    try {
      const appliedDiff = parseAppliedDocumentDiff(value.appliedDiff);
      const parsedDraft = parsePersistedProposalDraft(value.draft);
      const documentAssetInvalidReason = getPersistedProposalDocumentAssetInvalidReason(value);
      const invalidReason = parsedDraft.invalidReason ?? documentAssetInvalidReason
        ?? (typeof value.invalidReason === "string" ? value.invalidReason : undefined);
      return {
        version: 1,
        proposalId: value.proposalId,
        ...(typeof value.groupId === "string" ? { groupId: value.groupId } : {}),
        ...(Array.isArray(value.groupMemberIds)
          ? { groupMemberIds: value.groupMemberIds.filter((id): id is string => typeof id === "string") }
          : {}),
        ...(typeof value.groupPosition === "number" && Number.isInteger(value.groupPosition) && value.groupPosition >= 0
          ? { groupPosition: value.groupPosition }
          : {}),
        fileId: value.fileId,
        baseRevision: value.baseRevision,
        baseDocId: value.baseDocId,
        title: value.title,
        summary: value.summary,
        plan: normalizeStringArray(value.plan),
        warnings: [
          ...normalizeStringArray(value.warnings),
          ...(invalidReason ? [invalidReason] : []),
        ],
        changedIds: normalizeStringArray(value.changedIds),
        source: {
          toolName: value.source.toolName,
          toolArgs: value.source.toolArgs,
        },
        provider: parseMcpProposalProvider(value.provider),
        draft: parsedDraft.draft,
        status: value.status,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        ...(typeof value.resolvedAt === "string" ? { resolvedAt: value.resolvedAt } : {}),
        ...(typeof value.resolutionMessage === "string" ? { resolutionMessage: value.resolutionMessage } : {}),
        ...(typeof value.rejectedAt === "string" ? { rejectedAt: value.rejectedAt } : {}),
        ...(typeof value.rejectedReason === "string" ? { rejectedReason: value.rejectedReason } : {}),
        ...(typeof value.rebasedFrom === "number" ? { rebasedFrom: value.rebasedFrom } : {}),
        ...(typeof value.appliedRevision === "number" ? { appliedRevision: value.appliedRevision } : {}),
        ...(appliedDiff ? { appliedDiff } : {}),
        ...(typeof value.autoApplied === "boolean" ? { autoApplied: value.autoApplied } : {}),
        ...parseAttributionFields(value),
        ...(isVerification(value.verification) ? { verification: value.verification } : {}),
        ...(() => {
          const sourceReferences = parseAiSourceReferences(value.sourceReferences);
          return sourceReferences.length ? { sourceReferences } : {};
        })(),
        ...(() => {
          const touchedBlocks = parseTouchedBlocks(value.touchedBlocks);
          return touchedBlocks ? { touchedBlocks } : {};
        })(),
        ...(() => {
          const requestSelection = parseRequestSelection(value.requestSelection);
          return requestSelection ? { requestSelection } : {};
        })(),
        ...(() => {
          const conflict = invalidReason
            ? {
                blockIds: [],
                detectedAtRevision: value.baseRevision,
                reason: "replay-failed" as const,
              }
            : parseConflict(value.conflict);
          return conflict ? { conflict } : {};
        })(),
        ...(invalidReason ? { invalidReason } : {}),
        ...(() => {
          const history = parseProposalHistory(value.history);
          return history.length > 0 ? { history } : {};
        })(),
      };
    } catch {
      return null;
    }
  }

  private parseProposal(value: unknown): LocalMcpEditProposal | null {
    const meta = this.parseProposalMeta(value);
    if (!meta || !isRecord(value)) {
      return null;
    }
    try {
      const nextDocument = parseSigmaDocument(value.nextDocument);
      const revertDocument = value.revertDocument
        ? parseSigmaDocument(value.revertDocument)
        : undefined;
      return {
        ...meta,
        nextDocument,
        ...(revertDocument ? { revertDocument } : {}),
      };
    } catch {
      return null;
    }
  }

  private async readProposalMetaFile(filePath: string): Promise<LocalMcpEditProposalMeta | null> {
    this.indexStats.metaReads += 1;
    try {
      await this.assertProposalFileWithinLimit(filePath);
      const raw = await fs.readFile(filePath, "utf8");
      return this.parseProposalMeta(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      await this.quarantineCorruptProposalFile(filePath, error);
      return null;
    }
  }

  private async readProposalFile(filePath: string): Promise<LocalMcpEditProposal | null> {
    this.indexStats.fullLoads += 1;
    try {
      await this.assertProposalFileWithinLimit(filePath);
      const raw = await fs.readFile(filePath, "utf8");
      return this.parseProposal(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      await this.quarantineCorruptProposalFile(filePath, error);
      return null;
    }
  }

  private async assertProposalFileWithinLimit(filePath: string): Promise<void> {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_MCP_PROPOSAL_FILE_BYTES) {
      throw new Error(te("electron.proposalStore.fileTooLarge", { maxBytes: MAX_MCP_PROPOSAL_FILE_BYTES }));
    }
  }

  private async quarantineCorruptProposalFile(filePath: string, error: unknown): Promise<void> {
    console.warn(`Corrupt proposal file (quarantining): ${filePath}`, error);
    const corruptDir = path.join(this.proposalsDir, "corrupt");
    const corruptPath = path.join(corruptDir, `${path.basename(filePath)}.${Date.now()}`);
    try {
      await fs.mkdir(corruptDir, { recursive: true });
      await fs.rename(filePath, corruptPath);
    } catch (renameError) {
      const code = (renameError as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOENT") {
        console.warn(`Corrupt proposal file could not be quarantined: ${filePath}`, renameError);
      }
    }
  }

  private async loadProposalGroup(proposal: LocalMcpEditProposal): Promise<LocalMcpEditProposal[]> {
    if (!proposal.groupId) {
      return [proposal];
    }
    const memberIds = normalizeGroupMemberIds(proposal);
    const members = await Promise.all(memberIds.map((proposalId) => this.loadProposal(proposalId)));
    if (members.some((member) => !member || member.groupId !== proposal.groupId)) {
      throw new Error(te("electron.proposalStore.groupLoadFailed"));
    }
    return (members as LocalMcpEditProposal[]).sort((a, b) =>
      (a.groupPosition ?? memberIds.indexOf(a.proposalId)) - (b.groupPosition ?? memberIds.indexOf(b.proposalId)));
  }

  private async writeGroupConflict(
    members: LocalMcpEditProposal[],
    blockIds: string[],
    detectedAtRevision: number,
    reason: LocalMcpEditProposalConflictReason,
  ): Promise<void> {
    const updatedAt = new Date().toISOString();
    await Promise.all(members.map((member) => this.writeProposal({
      ...member,
      conflict: { blockIds, detectedAtRevision, reason },
      updatedAt,
    })));
  }

  private async writeProposal(proposal: LocalMcpEditProposal): Promise<void> {
    await this.ensureBaseDirs();
    const data = JSON.stringify(proposal);
    if (Buffer.byteLength(data, "utf8") > MAX_MCP_PROPOSAL_FILE_BYTES) {
      throw new Error(te("electron.proposalStore.fileTooLarge", { maxBytes: MAX_MCP_PROPOSAL_FILE_BYTES }));
    }
    const targetPath = this.getProposalPath(proposal.proposalId);
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    this.ownWatchSuppressions.set(proposal.proposalId, Date.now());
    try {
      await fs.writeFile(temporaryPath, data, "utf8");
      await fs.rename(temporaryPath, targetPath);
    } catch (error) {
      this.ownWatchSuppressions.delete(proposal.proposalId);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await this.invalidateIndex(proposal.proposalId);
  }

  private async deleteProposalFile(proposalId: string): Promise<void> {
    this.ownWatchSuppressions.set(proposalId, Date.now());
    await fs.rm(this.getProposalPath(proposalId), { force: true });
    this.indexCache.delete(proposalId);
    await this.invalidateIndex(proposalId);
  }
}

function parseAppliedDocumentDiff(value: unknown): AiAppliedDocumentDiff | null {
  if (!isRecord(value) || !Array.isArray(value.body) || !Array.isArray(value.shapes)) {
    return null;
  }
  const validChange = (change: unknown): change is "added" | "removed" =>
    change === "added" || change === "removed";
  if (!value.body.every((entry) => (
    isRecord(entry)
    && validChange(entry.change)
    && isRecord(entry.block)
    && typeof entry.block.id === "string"
  ))) {
    return null;
  }
  if (!value.shapes.every((entry) => (
    isRecord(entry)
    && validChange(entry.change)
    && isRecord(entry.shape)
    && typeof entry.shape.id === "string"
  ))) {
    return null;
  }
  return value as unknown as AiAppliedDocumentDiff;
}

function parseTouchedBlocks(value: unknown): LocalMcpEditProposalTouchedBlock[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items = value.filter((item): item is LocalMcpEditProposalTouchedBlock =>
    isRecord(item) && typeof item.id === "string" && (item.baseHash === null || typeof item.baseHash === "string"));
  return items.length > 0 ? items : null;
}

// blockIds が空配列でも有効なスナップショット (「選択なしの依頼 = 衝突なし」の明示) なので、
// touchedBlocks と違い空でも捨てずに残す。
function parseRequestSelection(value: unknown): LocalMcpEditProposalRequestSelection | null {
  if (!isRecord(value) || !Array.isArray(value.blockIds) || !isRecord(value.hashes) || typeof value.capturedRevision !== "number") {
    return null;
  }
  const blockIds = value.blockIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  const hashes: Record<string, string> = {};
  for (const [id, hash] of Object.entries(value.hashes)) {
    if (typeof hash === "string") {
      hashes[id] = hash;
    }
  }
  return { blockIds, hashes, capturedRevision: value.capturedRevision };
}

function parseConflict(value: unknown): LocalMcpEditProposalConflict | null {
  if (!isRecord(value) || !Array.isArray(value.blockIds) || typeof value.detectedAtRevision !== "number") {
    return null;
  }
  const blockIds = value.blockIds.filter((id): id is string => typeof id === "string");
  const reason = isProposalFreshnessConflictReason(value.reason) ? value.reason : undefined;
  return blockIds.length > 0 || reason === "replay-failed"
    ? { blockIds, detectedAtRevision: value.detectedAtRevision, ...(reason ? { reason } : {}) }
    : null;
}

function isProposalFreshnessConflictReason(value: unknown): value is LocalMcpEditProposalConflictReason {
  return value === "content-stale"
    || value === "anchor-missing"
    || value === "asset-collision"
    || value === "replay-failed";
}

function parseProposalHistory(value: unknown): LocalMcpEditProposalHistoryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is LocalMcpEditProposalHistoryEntry => (
    isRecord(entry)
    && (entry.action === "revised" || entry.action === "rejected" || entry.action === "withdrawn" || entry.action === "reproposed")
    && typeof entry.at === "string"
    && (entry.reason === undefined || typeof entry.reason === "string")
    && (entry.runId === undefined || typeof entry.runId === "string")
    && (entry.turnId === undefined || typeof entry.turnId === "string")
  ));
}

function isVerification(value: unknown): value is LocalMcpEditProposalVerification {
  return (
    isRecord(value) &&
    typeof value.validationOk === "boolean" &&
    (value.previewSource === undefined || typeof value.previewSource === "string")
  );
}

// 旧レコード (これらのフィールドが書き込まれる前に作成された提案) には存在しないため、
// すべて任意・型ガード付きで読み取る。1つでも壊れていても他のフィールドの解析には影響しない。
function parseAttributionFields(value: Record<string, unknown>): LocalMcpEditProposalAttribution {
  return {
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.roomId === "string" ? { roomId: value.roomId } : {}),
    ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
    ...(typeof value.sessionLabel === "string" ? { sessionLabel: value.sessionLabel } : {}),
  };
}

function summarizeProposal(proposal: LocalMcpEditProposal): LocalMcpEditProposalSummary {
  const requestedShapeId = resolveAiOverlayShapeReplacementRequestedId(proposal);
  const appliedDiff = proposal.appliedDiff
    ?? (proposal.status === "approved" && proposal.revertDocument
      ? deriveAppliedDocumentDiff(proposal.revertDocument, proposal.nextDocument, [proposal.draft])
      : undefined);
  return {
    proposalId: proposal.proposalId,
    ...(proposal.groupId ? { groupId: proposal.groupId } : {}),
    ...(proposal.groupMemberIds ? { groupMemberIds: proposal.groupMemberIds } : {}),
    ...(proposal.groupPosition !== undefined ? { groupPosition: proposal.groupPosition } : {}),
    fileId: proposal.fileId,
    baseRevision: proposal.baseRevision,
    baseDocId: proposal.baseDocId,
    title: proposal.title,
    summary: proposal.summary,
    plan: proposal.plan,
    warnings: proposal.warnings,
    changedIds: proposal.changedIds,
    provider: proposal.provider,
    ...(requestedShapeId ? { requestedShapeId } : {}),
    draft: proposal.draft,
    status: proposal.status,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    ...(proposal.resolvedAt ? { resolvedAt: proposal.resolvedAt } : {}),
    ...(proposal.resolutionMessage ? { resolutionMessage: proposal.resolutionMessage } : {}),
    ...(proposal.rejectedAt ? { rejectedAt: proposal.rejectedAt } : {}),
    ...(proposal.rejectedReason ? { rejectedReason: proposal.rejectedReason } : {}),
    ...(proposal.rebasedFrom !== undefined ? { rebasedFrom: proposal.rebasedFrom } : {}),
    ...(proposal.appliedRevision !== undefined ? { appliedRevision: proposal.appliedRevision } : {}),
    ...(appliedDiff ? { appliedDiff } : {}),
    ...(proposal.autoApplied ? { autoApplied: proposal.autoApplied } : {}),
    ...(proposal.runId ? { runId: proposal.runId } : {}),
    ...(proposal.roomId ? { roomId: proposal.roomId } : {}),
    ...(proposal.turnId ? { turnId: proposal.turnId } : {}),
    ...(proposal.sessionLabel ? { sessionLabel: proposal.sessionLabel } : {}),
    ...(proposal.verification ? { verification: proposal.verification } : {}),
    ...(proposal.sourceReferences?.length ? { sourceReferences: proposal.sourceReferences } : {}),
    ...(proposal.touchedBlocks?.length ? { touchedBlocks: proposal.touchedBlocks } : {}),
    ...(proposal.requestSelection ? { requestSelection: proposal.requestSelection } : {}),
    ...(proposal.conflict ? { conflict: proposal.conflict } : {}),
    ...(proposal.invalidReason ? { invalidReason: proposal.invalidReason } : {}),
    ...(proposal.history?.length ? { history: proposal.history } : {}),
    // revertDocument は意図的に含めない (LocalMcpEditProposalSummary のコメント参照)。
  };
}

function summarizeProposalMeta(meta: LocalMcpEditProposalMeta): LocalMcpEditProposalSummary {
  const requestedShapeId = resolveAiOverlayShapeReplacementRequestedId(meta);
  return {
    proposalId: meta.proposalId,
    ...(meta.groupId ? { groupId: meta.groupId } : {}),
    ...(meta.groupMemberIds ? { groupMemberIds: meta.groupMemberIds } : {}),
    ...(meta.groupPosition !== undefined ? { groupPosition: meta.groupPosition } : {}),
    fileId: meta.fileId,
    baseRevision: meta.baseRevision,
    baseDocId: meta.baseDocId,
    title: meta.title,
    summary: meta.summary,
    plan: meta.plan,
    warnings: meta.warnings,
    changedIds: meta.changedIds,
    provider: meta.provider,
    ...(requestedShapeId ? { requestedShapeId } : {}),
    draft: meta.draft,
    status: meta.status,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(meta.resolvedAt ? { resolvedAt: meta.resolvedAt } : {}),
    ...(meta.resolutionMessage ? { resolutionMessage: meta.resolutionMessage } : {}),
    ...(meta.rejectedAt ? { rejectedAt: meta.rejectedAt } : {}),
    ...(meta.rejectedReason ? { rejectedReason: meta.rejectedReason } : {}),
    ...(meta.rebasedFrom !== undefined ? { rebasedFrom: meta.rebasedFrom } : {}),
    ...(meta.appliedRevision !== undefined ? { appliedRevision: meta.appliedRevision } : {}),
    ...(meta.appliedDiff ? { appliedDiff: meta.appliedDiff } : {}),
    ...(meta.autoApplied ? { autoApplied: meta.autoApplied } : {}),
    ...(meta.runId ? { runId: meta.runId } : {}),
    ...(meta.roomId ? { roomId: meta.roomId } : {}),
    ...(meta.turnId ? { turnId: meta.turnId } : {}),
    ...(meta.sessionLabel ? { sessionLabel: meta.sessionLabel } : {}),
    ...(meta.verification ? { verification: meta.verification } : {}),
    ...(meta.sourceReferences?.length ? { sourceReferences: meta.sourceReferences } : {}),
    ...(meta.touchedBlocks?.length ? { touchedBlocks: meta.touchedBlocks } : {}),
    ...(meta.requestSelection ? { requestSelection: meta.requestSelection } : {}),
    ...(meta.conflict ? { conflict: meta.conflict } : {}),
    ...(meta.invalidReason ? { invalidReason: meta.invalidReason } : {}),
    ...(meta.history?.length ? { history: meta.history } : {}),
  };
}

function normalizeGroupMemberIds(proposal: LocalMcpEditProposal): string[] {
  const memberIds = proposal.groupMemberIds?.filter((id, index, all) => id.length > 0 && all.indexOf(id) === index) ?? [];
  return memberIds.includes(proposal.proposalId) ? memberIds : [...memberIds, proposal.proposalId];
}

/**
 * upsert callerには旧実装との互換上「今回の差分だけ」と「既存draftを含む集約済みdraft」の
 * 両方が来うる。既存列をprefixとして既に含む場合は二重追加せず、そのまま採用する。
 */
function appendProposalDraft(current: AiEditSessionDraft, next: AiEditSessionDraft): AiEditSessionDraft {
  const appendUnlessPrefixed = <T>(existing: T[], incoming: T[]): T[] => {
    // incoming is a prefix of existing: this is a normalized/contracted draft, use it as-is
    if (existing.length >= incoming.length && incoming.every((item, index) => isDeepStrictEqual(item, existing[index]))) {
      return existing;
    }
    // incoming contains existing as a prefix: incoming is an expansion, use it as-is
    if (incoming.length >= existing.length && existing.every((item, index) => isDeepStrictEqual(item, incoming[index]))) {
      return incoming;
    }
    // Neither is a prefix of the other: concatenate
    return [...existing, ...incoming];
  };
  const mergeOperationFamily = <T>(existing: T[], incoming: T[]): {
    items: T[];
    currentIndexMap: number[];
    nextIndexMap: number[];
  } => {
    const incomingIsPrefix = existing.length >= incoming.length
      && incoming.every((item, index) => isDeepStrictEqual(item, existing[index]));
    if (incomingIsPrefix) {
      return {
        items: existing,
        currentIndexMap: existing.map((_, index) => index),
        nextIndexMap: incoming.map((_, index) => index),
      };
    }
    const existingIsPrefix = incoming.length >= existing.length
      && existing.every((item, index) => isDeepStrictEqual(item, incoming[index]));
    if (existingIsPrefix) {
      return {
        items: incoming,
        currentIndexMap: existing.map((_, index) => index),
        nextIndexMap: incoming.map((_, index) => index),
      };
    }
    return {
      items: [...existing, ...incoming],
      currentIndexMap: existing.map((_, index) => index),
      nextIndexMap: incoming.map((_, index) => existing.length + index),
    };
  };

  const operations = mergeOperationFamily(current.operations, next.operations);
  const mutationOperations = mergeOperationFamily(current.mutationOperations ?? [], next.mutationOperations ?? []);
  const operationOrder: AiEditSessionOperationOrderEntry[] = [];
  const seenOrderEntries = new Set<string>();
  const appendOrder = (
    draft: AiEditSessionDraft,
    operationIndexMap: number[],
    mutationIndexMap: number[],
  ): void => {
    for (const entry of resolveAiEditSessionOperationOrder(draft)) {
      const index = entry.kind === "operation"
        ? operationIndexMap[entry.index]
        : mutationIndexMap[entry.index];
      if (index === undefined) {
        throw new Error(te("electron.proposalStore.operationOrderFailed"));
      }
      const key = `${entry.kind}:${index}`;
      if (!seenOrderEntries.has(key)) {
        seenOrderEntries.add(key);
        operationOrder.push({ kind: entry.kind, index });
      }
    }
  };
  appendOrder(current, operations.currentIndexMap, mutationOperations.currentIndexMap);
  appendOrder(next, operations.nextIndexMap, mutationOperations.nextIndexMap);

  return {
    summary: next.summary || current.summary,
    plan: appendUnlessPrefixed(current.plan, next.plan),
    operations: operations.items,
    warnings: appendUnlessPrefixed(current.warnings, next.warnings),
    mutationOperations: mutationOperations.items,
    operationOrder,
  };
}

function mergeSourceReferences(
  current: AiSourceReference[] | undefined,
  incoming: AiSourceReference[],
): AiSourceReference[] {
  return [...(current ?? []), ...incoming]
    .filter((reference, index, all) => all.findIndex((candidate) => isDeepStrictEqual(candidate, reference)) === index)
    // 参照元は「増える一方」の項目なので、マージ経路にも上限を置かないと部屋の提案が
    // ターンをまたいで際限なく肥大する (MCP入力スキーマの上限だけでは守れない)。
    .slice(0, MAX_PROPOSAL_SOURCE_REFERENCES);
}

function decodeProposalFileName(name: string): string | undefined {
  try {
    return decodeURIComponent(name.slice(0, -PROPOSAL_FILE_SUFFIX.length));
  } catch {
    return undefined;
  }
}

function isProposalStatus(value: unknown): value is LocalMcpEditProposalStatus {
  return value === "pending" || value === "approved" || value === "rejected" || value === "reverted";
}

function getPersistedProposalDocumentAssetInvalidReason(value: Record<string, unknown>): string | undefined {
  for (const field of ["nextDocument", "revertDocument"] as const) {
    const document = value[field];
    if (document === undefined) {
      continue;
    }
    if (!isRecord(document)) {
      return te("electron.proposalStore.invalidStoredDocument", { field });
    }
    const pageLayout = document.pageLayout;
    if (!isRecord(pageLayout)) {
      continue;
    }
    const overlay = pageLayout.overlay;
    if (!isRecord(overlay)) {
      continue;
    }
    const snapshot = overlay.overlaySnapshot;
    if (!isRecord(snapshot)) {
      continue;
    }
    const assets = snapshot.assets;
    if (!isRecord(assets)) {
      continue;
    }
    for (const [assetId, asset] of Object.entries(assets)) {
      if (
        !isRecord(asset)
        || asset.id !== assetId
        || !isRecord(asset.props)
        || typeof asset.props.src !== "string"
        || !isAllowedAiOverlayAssetSource(asset.props.src)
      ) {
        return te("electron.proposalStore.unsafeStoredAsset", { field, assetId: assetId.slice(0, 80) });
      }
    }
  }
  return undefined;
}

function parsePersistedProposalDraft(value: unknown): {
  draft: AiEditSessionDraft;
  invalidReason?: string;
} {
  try {
    return { draft: parseAiEditSessionDraft(value) };
  } catch (error) {
    const firstIssue = isRecord(error) && Array.isArray(error.issues) ? error.issues[0] : undefined;
    const detail = isRecord(firstIssue) && typeof firstIssue.message === "string"
      ? firstIssue.message
      : error instanceof Error ? error.message.split("\n")[0] : "runtime schema validation failed";
    const invalidReason = te("electron.proposalStore.invalidStoredProposal", { detail: detail.slice(0, 400) });
    return {
      draft: {
        summary: te("electron.proposalStore.invalidSummary"),
        plan: [te("electron.proposalStore.invalidPlan")],
        operations: [],
        warnings: [invalidReason],
      },
      invalidReason,
    };
  }
}

function parseProposalDraftAtCreation(input: Pick<LocalMcpEditProposalCreateInput, "draft" | "summary">): AiEditSessionDraft {
  // 一部の内部toolは表示用planを別フィールドにだけ持つ。新規提案は保存前に必ずschemaへ
  // 通しつつ、空planだけは同じ入力のsummaryから正規化して永続化する。
  return parseAiEditSessionDraft({
    ...input.draft,
    plan: input.draft.plan.length > 0
      ? input.draft.plan
      : [input.summary || input.draft.summary || "AI編集提案"],
  });
}

function findChangedBlockIds(
  previousHashes: Record<string, string>,
  currentHashes: Record<string, string>,
): Set<string> {
  const allIds = new Set([...Object.keys(previousHashes), ...Object.keys(currentHashes)]);
  return new Set(
    [...allIds].filter((id) => (previousHashes[id] ?? null) !== (currentHashes[id] ?? null)),
  );
}

function looksLikeBlockHashFormatChanged(
  previousHashes: Record<string, string>,
  currentHashes: Record<string, string>,
): boolean {
  const sharedIds = Object.keys(previousHashes)
    .filter((id) => Object.prototype.hasOwnProperty.call(currentHashes, id));
  return sharedIds.length > 0
    && sharedIds.every((id) => previousHashes[id] !== currentHashes[id]);
}

function hasSetIntersection(left: Set<string>, right: Set<string>): boolean {
  for (const id of left) {
    if (right.has(id)) {
      return true;
    }
  }
  return false;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
