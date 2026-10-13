import { createHash } from "node:crypto";

import type { SigmaDocument } from "@/features/document";
import type { SigmaDocAgentSession } from "@/lib/ai/sigma-doc-agent-tools";
import type { AiEditRunContextProvider } from "../electron/ai-edit-run-context";
import type { LocalDocumentMetadata } from "../electron/local-sigma-doc-store";
import type { VisualSessionsStatusFile, VisualSessionStatusSnapshot } from "../electron/visual-session-status";
import type { VisualInspectionIssue } from "./visual-inspection";

export interface VisualInspectionResult {
  passed: boolean;
  inspectedRevision: number;
  errorCount: number;
  warningCount: number;
  issues: VisualInspectionIssue[];
  shapeCount: number;
}

export interface VisualReviewResult {
  passed: boolean;
  reviewedRevision: number;
  previewRevision: number;
  verdict: "pass" | "needs_revision";
  /** Self-reported, recorded for telemetry only — NOT used to compute `passed`
   * (see review_visual_edit_session: passed = verdict:"pass" && issues empty && fresh inspection
   * pass && fresh render). */
  score: number;
  /** Historical threshold `score` used to have to clear before it stopped gating `passed`. Kept
   * on the payload for continuity; no longer enforced. */
  minScore: number;
  sourceImageSummary: string;
  previewSummary: string;
  matchedElements: string[];
  issues: string[];
  nextActions: string[];
  createdAt: string;
}

const VISUAL_PREVIEW_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const VISUAL_PREVIEW_CODE_LENGTH = 5;

/**
 * Derives the code printed into a visual preview. The alphabet intentionally
 * excludes 0/O and 1/I/L so a code read from an image is unambiguous. This is
 * deterministic per session revision, which also keeps preview caching safe.
 */
export function deriveVisualPreviewCode(sessionId: string, visualRevision: number): string {
  const digest = createHash("sha256")
    .update(`${sessionId}:${visualRevision}`)
    .digest();
  let code = "";
  for (let index = 0; index < VISUAL_PREVIEW_CODE_LENGTH; index += 1) {
    code += VISUAL_PREVIEW_CODE_ALPHABET[digest[index]! % VISUAL_PREVIEW_CODE_ALPHABET.length];
  }
  return code;
}

interface VisualEditSessionEvent {
  toolName: string;
  status: "ok" | "error";
  message: string;
  changedIds: string[];
  createdAt: string;
}

export interface VisualEditSession {
  sessionId: string;
  file: LocalDocumentMetadata;
  baseDocument: SigmaDocument;
  targetId: string | null;
  agentSession: SigmaDocAgentSession;
  revision: number;
  lastPreviewRevision: number;
  lastPreviewSource: "app-bridge" | "svg-fallback" | "svg-resource" | null;
  lastPreviewCode: string | null;
  // Set when the most recent render_visual_edit_session call for the current
  // revision failed to produce a preview at all (source:"none" — both the
  // app-bridge and the SVG fallback were unavailable/failed). review_visual_
  // edit_session/propose_visual_edit_session read this to report the real
  // cause instead of the generic "render_visual_edit_sessionが実行されていま
  // せん" message, which is misleading when a render WAS attempted but
  // produced no usable preview. Cleared whenever a render for the current
  // revision succeeds.
  lastRenderFailure: { revision: number; reason: string } | null;
  lastInspection: VisualInspectionResult | null;
  lastReview: VisualReviewResult | null;
  visualEvents: VisualEditSessionEvent[];
  createdAt: string;
  updatedAt: string;
  /** Calling agent's runId (see WriteRunIdSchema), captured at begin_visual_edit_session and
   * used to attribute the pending proposal created by propose_visual_edit_session. */
  runId: string | null;
  provider: AiEditRunContextProvider | null;
  proposed: boolean;
  discarded: boolean;
  /** Semantic analysis of the figure from source image and problem statement. Min 20 chars. */
  sourceAnalysis?: string;
  /** Planned shape decomposition. Each item has kind and purpose describing the shape. */
  plannedShapes?: Array<{ kind: string; purpose: string }>;
}

interface TerminalVisualSessionStatus {
  provider: AiEditRunContextProvider;
  runId: string;
  snapshot: VisualSessionStatusSnapshot;
}

const VISUAL_EDIT_SESSION_TTL_MS = 1000 * 60 * 60;
const VISUAL_SESSION_STATUS_MAP_LIMIT = 200;
const VISUAL_REVIEW_MIN_SCORE = 95;

export interface VisualSessionStatusWriteTarget {
  /** 同じ保存先への snapshot は、この key ごとに生成順で書き出す。 */
  key: string;
  write(status: VisualSessionsStatusFile): Promise<void>;
  /**
   * 書き出す直前に今の内容を読む。同じ run の別プロセス (前の turn の MCP サーバー) が
   * 記録した未完了 session を、このプロセスが知らないという理由で消さないために使う。
   * 無い・読めない場合は null。
   */
  read?(): Promise<VisualSessionsStatusFile | null>;
}

export type VisualEditSessionStateWriteOutcome = "written" | "superseded" | "failed";

/** run 単位で保存した 1 session の状態ファイル。 */
export interface VisualEditSessionStateTarget {
  /** 同じ保存先への書き込み・削除は、この key ごとに生成順で行う。 */
  key: string;
  /** 保存済みの世代。無い・読めない場合は null。 */
  readGeneration(): Promise<number | null>;
  /**
   * enqueue 時に直列化した状態を書く。保存済みの世代が `generation` 以上なら、別プロセスが
   * 先へ進めた状態を古い状態で上書きしないよう書かずに "superseded" を返す。
   * 失敗は例外にせず "failed" を返す (状態ファイルが書けなくてもツールの実行は続ける)。
   */
  write(serialized: string, generation: number): Promise<VisualEditSessionStateWriteOutcome>;
  remove(): Promise<void>;
}

export interface StoredVisualEditSession {
  session: VisualEditSession;
  generation: number;
}

/**
 * MCP サーバーのプロセスをまたいで scratch session を同じ sessionId で再開するための保存先。
 * Claude と Antigravity は turn ごとに MCP サーバーを起動し直すので、memory だけでは
 * 強制継続の turn で session が見つからない。保存先は provider と runId で決まる run 単位の
 * パスに限り、runId を持たない session は従来どおりプロセス内だけに置く。
 */
export interface VisualEditSessionStatePort {
  /** 保存先は enqueue 時点に解決する。provider/runId が無ければ null。 */
  resolveTarget(session: VisualEditSession): VisualEditSessionStateTarget | null;
  /** 書き込む内容は enqueue 時点の状態から作る (後から memory が変わっても混ざらない)。 */
  serialize(session: VisualEditSession, generation: number): string;
  /** memory に無い sessionId を保存から読み戻す。無い・壊れている場合は null。 */
  load(sessionId: string): Promise<StoredVisualEditSession | null>;
}

export interface VisualEditSessionLifecyclePorts {
  now(): number;
  /** 保存先は enqueue 時点に解決する。環境変数の読み取りを開始時へ繰り上げない。 */
  resolveStatusTarget(
    provider: AiEditRunContextProvider | null,
    runId: string | undefined,
  ): VisualSessionStatusWriteTarget | null;
  /** 省略時は従来どおり session をプロセスの memory だけに置く。 */
  sessionState?: VisualEditSessionStatePort;
}

export interface VisualEditSessionStart {
  sessionId: string;
  file: LocalDocumentMetadata;
  baseDocument: SigmaDocument;
  targetId: string | null;
  agentSession: SigmaDocAgentSession;
  createdAt: string;
  runId?: string;
  provider: AiEditRunContextProvider | null;
  sourceAnalysis?: string;
  plannedShapes?: Array<{ kind: string; purpose: string }>;
}

export interface VisualReviewInput {
  verdict: "pass" | "needs_revision";
  score: number;
  previewCode: string;
  sourceImageSummary: string;
  previewSummary: string;
  matchedElements?: string[];
  issues?: string[];
  nextActions?: string[];
}

/**
 * scratch session の寿命・確認世代・終了状態の通知を所有する。MCP の登録や response、
 * SigmaDoc の描画・提案保存は呼び出し側が担当する。clock と保存先以外の副作用を持たない。
 * server ごとに作り直さず、core が持つ 1 インスタンスをプロセス全体で共有する。
 * `sessionState` port があれば、未完了の session を run 単位で保存し、別プロセスからも
 * 同じ sessionId で再開できるようにする (memory は保存の cache として扱う)。
 */
export class VisualEditSessionLifecycle {
  private readonly live = new Map<string, VisualEditSession>();
  private readonly terminal = new Map<string, TerminalVisualSessionStatus>();
  private readonly pendingWrites = new Map<string, Promise<void>>();
  /** memory の session が反映済みの保存の世代。保存側の方が新しければ読み直す。 */
  private readonly generations = new Map<string, number>();
  /** 同じ sessionId の読み戻しを 1 本にまとめ、別々の object が live に入るのを防ぐ。 */
  private readonly restoring = new Map<string, Promise<VisualEditSession | undefined>>();

  constructor(private readonly ports: VisualEditSessionLifecyclePorts) {}

  begin(input: VisualEditSessionStart): VisualEditSession {
    const session: VisualEditSession = {
      sessionId: input.sessionId,
      file: input.file,
      baseDocument: input.baseDocument,
      targetId: input.targetId,
      agentSession: input.agentSession,
      revision: 0,
      lastPreviewRevision: -1,
      lastPreviewSource: null,
      lastPreviewCode: null,
      lastRenderFailure: null,
      lastInspection: null,
      lastReview: null,
      visualEvents: [],
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      runId: input.runId?.trim() || null,
      provider: input.provider,
      proposed: false,
      discarded: false,
      sourceAnalysis: input.sourceAnalysis,
      plannedShapes: input.plannedShapes,
    };
    this.live.set(session.sessionId, session);
    this.generations.set(session.sessionId, 0);
    void this.queueStatusWrite(session);
    return session;
  }

  peek(sessionId: string): VisualEditSession | undefined {
    return this.live.get(sessionId);
  }

  get(sessionId: string): VisualEditSession {
    this.prune();
    const session = this.live.get(sessionId);
    if (!session) {
      throw new Error(`visual edit session が見つかりません: ${sessionId}`);
    }
    return session;
  }

  /**
   * `get` と同じだが、memory に無い session を run 単位の保存から読み戻す。前の turn の
   * MCP サーバーが作った session も、同じ sessionId のまま続けられる。
   */
  async resolve(sessionId: string): Promise<VisualEditSession> {
    const session = await this.find(sessionId);
    if (!session) {
      throw new Error(`visual edit session が見つかりません: ${sessionId}`);
    }
    return session;
  }

  /** `resolve` の見つからなければ undefined を返す版 (破棄のように、無くても失敗にしない呼び出し用)。 */
  find(sessionId: string): Promise<VisualEditSession | undefined> {
    this.prune();
    const inFlight = this.restoring.get(sessionId);
    if (inFlight) {
      return inFlight;
    }
    const lookup = this.findCurrent(sessionId).finally(() => {
      if (this.restoring.get(sessionId) === lookup) {
        this.restoring.delete(sessionId);
      }
    });
    this.restoring.set(sessionId, lookup);
    return lookup;
  }

  prune(now = this.ports.now()): void {
    for (const [sessionId, session] of this.live) {
      if (isExpired(session, now)) {
        // 期限切れも terminal snapshot を live map に存在する間に enqueue する。
        // 期限切れ処理は従来どおり書き出しを待たず、scratch 本体を解放する。
        void this.rememberTerminal(session, "discarded");
        this.live.delete(sessionId);
        this.generations.delete(sessionId);
        void this.removeState(session);
      }
    }
  }

  /**
   * tool 呼び出しで変わった状態を run 単位の保存へ書き、同じ run の状態ファイルの書き込みと
   * あわせて終わるまで待つ。応答を返した直後に turn が終わり MCP サーバーが止められても、
   * 次の turn のプロセスが同じ状態から続けられるようにするため。書き込みの失敗は例外にしない。
   * 終了済み・読み直しで置き換わった session は書かない。
   */
  async persist(session: VisualEditSession): Promise<void> {
    if (this.live.get(session.sessionId) !== session) {
      return;
    }
    const waits: Promise<void>[] = [];
    const port = this.ports.sessionState;
    const target = port?.resolveTarget(session) ?? null;
    if (port && target) {
      const generation = (this.generations.get(session.sessionId) ?? 0) + 1;
      let serialized: string | null = null;
      try {
        serialized = port.serialize(session, generation);
      } catch {
        // 直列化できない状態は保存しない。この process の memory では引き続き使える。
      }
      if (serialized !== null) {
        const payload = serialized;
        this.generations.set(session.sessionId, generation);
        waits.push(this.enqueueWrite(target.key, async () => {
          const outcome = await target.write(payload, generation);
          if (outcome === "superseded" && this.live.get(session.sessionId) === session) {
            // 別プロセスが同じ session を先へ進めていた。古い memory を捨て、次の呼び出しで
            // 保存側を読み直す。
            this.live.delete(session.sessionId);
            this.generations.delete(session.sessionId);
          }
        }));
      }
    }
    const statusKey = this.ports.resolveStatusTarget(session.provider, session.runId?.trim())?.key;
    const pendingStatus = statusKey ? this.pendingWrites.get(statusKey) : undefined;
    if (pendingStatus) {
      waits.push(pendingStatus);
    }
    await Promise.all(waits.map((wait) => wait.catch(() => undefined)));
  }

  touch(session: VisualEditSession): void {
    session.updatedAt = new Date(this.ports.now()).toISOString();
  }

  markChanged(session: VisualEditSession): void {
    session.revision += 1;
    session.lastPreviewSource = null;
    session.lastPreviewCode = null;
    session.lastInspection = null;
    session.lastReview = null;
    void this.queueStatusWrite(session);
  }

  recordEvent(
    session: VisualEditSession,
    toolName: string,
    message: string,
    changedIds: string[] = [],
    status: "ok" | "error" = "ok",
  ): void {
    session.visualEvents.push({
      toolName,
      status,
      message,
      changedIds,
      createdAt: new Date(this.ports.now()).toISOString(),
    });
  }

  isRenderStale(session: VisualEditSession, revisionAtRenderStart: number): boolean {
    return session.lastPreviewRevision > revisionAtRenderStart
      || session.revision !== revisionAtRenderStart;
  }

  recordPreview(
    session: VisualEditSession,
    revisionAtRenderStart: number,
    previewCode: string,
    source: NonNullable<VisualEditSession["lastPreviewSource"]>,
  ): void {
    if (!this.isRenderStale(session, revisionAtRenderStart)) {
      session.lastRenderFailure = null;
      session.lastPreviewRevision = revisionAtRenderStart;
      session.lastPreviewSource = source;
      session.lastPreviewCode = previewCode;
    }
    void this.queueStatusWrite(session);
  }

  recordRenderFailure(session: VisualEditSession, revisionAtRenderStart: number, reason: string): void {
    if (!this.isRenderStale(session, revisionAtRenderStart)) {
      session.lastRenderFailure = { revision: revisionAtRenderStart, reason };
    }
  }

  recordInspection(session: VisualEditSession, inspection: VisualInspectionResult): void {
    session.lastInspection = inspection;
    this.touch(session);
  }

  review(session: VisualEditSession, input: VisualReviewInput): { review: VisualReviewResult; previewCodeMatches: boolean } {
    const { verdict, score, previewCode, sourceImageSummary, previewSummary, matchedElements, issues, nextActions } = input;
    if (session.lastPreviewRevision !== session.revision) {
      throw new Error(this.describeMissingRenderError(session));
    }

    const normalizedIssues = issues ?? [];
    const previewCodeMatches = session.lastPreviewCode !== null && previewCode === session.lastPreviewCode;
    const codeNextAction = previewCodeMatches
      ? []
      : ["previewFileをview_imageツールで開いて画像右上のコードを読み取り、正しいpreviewCodeでreview_visual_edit_sessionを再実行してください。"];
    const inspectionPassed = Boolean(
      session.lastInspection
      && session.lastInspection.inspectedRevision === session.revision
      && session.lastInspection.passed,
    );
    const renderedAfterLastChange = session.lastPreviewRevision === session.revision;
    // 合否は自己申告のscoreではなく機械的な条件で決める(score >= 閾値だけでpassできる
    // 抜け道を塞ぐ)。scoreは後方互換のため引数として受け取り記録するが、判定には使わない。
    const passed = verdict === "pass"
      && normalizedIssues.length === 0
      && inspectionPassed
      && renderedAfterLastChange
      && previewCodeMatches;
    const review: VisualReviewResult = {
      passed,
      reviewedRevision: session.revision,
      previewRevision: session.lastPreviewRevision,
      verdict,
      score,
      minScore: VISUAL_REVIEW_MIN_SCORE,
      sourceImageSummary,
      previewSummary,
      matchedElements: matchedElements ?? [],
      issues: normalizedIssues,
      nextActions: [...(nextActions ?? []), ...codeNextAction],
      createdAt: new Date(this.ports.now()).toISOString(),
    };
    session.lastReview = review;
    this.touch(session);
    this.recordEvent(
      session,
      "review_visual_edit_session",
      passed
        ? "元画像とpreviewの視覚レビューに合格しました。"
        : "元画像とpreviewの視覚レビューで修正が必要です。",
      [],
      passed ? "ok" : "error",
    );
    void this.queueStatusWrite(session);
    return { review, previewCodeMatches };
  }

  assertReadyForProposal(
    session: VisualEditSession,
    inspect: (session: VisualEditSession) => VisualInspectionResult,
  ): asserts session is VisualEditSession & { lastInspection: VisualInspectionResult; lastReview: VisualReviewResult } {
    if (session.agentSession.operations.length === 0) {
      throw new Error("提案化する図形操作がありません。visual_insert_shapeで図形を追加してください。");
    }
    if (session.lastPreviewRevision !== session.revision) {
      throw new Error(this.describeMissingRenderError(session));
    }
    if (!session.lastInspection || session.lastInspection.inspectedRevision !== session.revision) {
      throw new Error("最後の変更後にinspect_visual_edit_sessionが実行されていません。");
    }
    if (!session.lastInspection.passed) {
      throw new Error("品質検査に通過していないため提案化できません。inspection.issuesを修正してください。");
    }
    if (
      !session.lastReview
      || session.lastReview.reviewedRevision !== session.revision
      || session.lastReview.previewRevision !== session.lastPreviewRevision
    ) {
      throw new Error("最後の変更後にreview_visual_edit_sessionで元画像とpreviewを見比べた結果が記録されていません。");
    }
    if (!session.lastReview.passed) {
      throw new Error("視覚レビューに合格していないため提案化できません。review_visual_edit_sessionのissuesを解消し、verdict:'pass'で再レビューしてください。");
    }

    // commit直前に再検査する: inspect/review以降にセッション状態を直接操作する経路は
    // 現状ないため通常はここで結果が変わることはないが、機械検査を「最後の関門」として
    // 明示することで、将来inspect/review以外の経路が増えても機械検査を経ずに提案化されない
    // ようにする(自己申告のみでcommitできる抜け道を防ぐ、というaudit指摘への対応)。
    const proposalTimeInspection = inspect(session);
    if (!proposalTimeInspection.passed) {
      throw new Error("commit直前の品質再検査に失敗しました。品質検査の結果が変わっています。inspect_visual_edit_sessionを再実行して問題を修正してください。");
    }
  }

  async finish(session: VisualEditSession, terminalState: "proposed" | "discarded"): Promise<void> {
    await this.rememberTerminal(session, terminalState);
    this.live.delete(session.sessionId);
    this.generations.delete(session.sessionId);
    // 終了を状態ファイルへ書いてから保存を消す。逆順だと、間でプロセスが止まったときに
    // 「未完了なのに再開できない」session が残り、強制継続が図形を作り直させてしまう。
    await this.removeState(session);
  }

  cacheSizes(): { terminal: number; pending: number } {
    return { terminal: this.terminal.size, pending: this.pendingWrites.size };
  }

  async flushStatusWrites(): Promise<void> {
    await Promise.all([...this.pendingWrites.values()]);
  }

  describeMissingRenderError(session: VisualEditSession): string {
    if (session.lastRenderFailure && session.lastRenderFailure.revision === session.revision) {
      return `最後の変更後のrender_visual_edit_sessionでpreview生成に失敗しています(bridge/フォールバックいずれも利用不能): ${session.lastRenderFailure.reason}`;
    }
    return "最後の変更後にrender_visual_edit_sessionが実行されていません。";
  }

  private queueStatusWrite(session: VisualEditSession): Promise<void> {
    const provider = session.provider;
    const runId = session.runId?.trim();
    const target = this.ports.resolveStatusTarget(provider, runId);
    if (!provider || !runId || !target) {
      return Promise.resolve();
    }

    const statusBySessionId = new Map<string, VisualSessionStatusSnapshot>();
    for (const terminalStatus of this.terminal.values()) {
      if (terminalStatus.provider === provider && terminalStatus.runId === runId) {
        statusBySessionId.set(terminalStatus.snapshot.sessionId, terminalStatus.snapshot);
      }
    }
    for (const activeSession of this.live.values()) {
      if (activeSession.provider === provider && activeSession.runId?.trim() === runId) {
        statusBySessionId.set(activeSession.sessionId, snapshotVisualSessionStatus(activeSession));
      }
    }

    const statusFile: VisualSessionsStatusFile = {
      version: 1,
      updatedAt: new Date(this.ports.now()).toISOString(),
      sessions: [...statusBySessionId.values()].sort(compareSessionIds),
    };
    const knownSessionIds = new Set(statusBySessionId.keys());
    return this.enqueueWrite(target.key, async () => {
      const current = target.read ? await target.read() : null;
      await target.write(carryOverUnknownIncompleteSessions(current, statusFile, knownSessionIds));
    });
  }

  private async findCurrent(sessionId: string): Promise<VisualEditSession | undefined> {
    const port = this.ports.sessionState;
    const live = this.live.get(sessionId);
    if (!port) {
      return live;
    }
    if (live) {
      const target = port.resolveTarget(live);
      const storedGeneration = target ? await target.readGeneration() : null;
      if (storedGeneration === null || storedGeneration <= (this.generations.get(sessionId) ?? 0)) {
        return this.live.get(sessionId);
      }
    } else if (this.terminal.has(sessionId)) {
      // この process で提案化・破棄した session は、保存の削除が遅れていても戻さない。
      return undefined;
    }

    const stored = await port.load(sessionId);
    const current = this.live.get(sessionId);
    if (!stored || stored.session.sessionId !== sessionId) {
      return current;
    }
    if (current && stored.generation <= (this.generations.get(sessionId) ?? 0)) {
      return current;
    }
    if (isExpired(stored.session, this.ports.now())) {
      // memory の期限切れと同じく破棄として記録し、保存も消す。
      this.live.delete(sessionId);
      this.generations.delete(sessionId);
      await this.rememberTerminal(stored.session, "discarded");
      await this.removeState(stored.session);
      return undefined;
    }
    this.live.set(sessionId, stored.session);
    this.generations.set(sessionId, stored.generation);
    return stored.session;
  }

  private removeState(session: VisualEditSession): Promise<void> {
    const target = this.ports.sessionState?.resolveTarget(session) ?? null;
    if (!target) {
      return Promise.resolve();
    }
    return this.enqueueWrite(target.key, () => target.remove());
  }

  /** 同じ保存先への書き込み・削除を生成順に並べる。 */
  private enqueueWrite(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.pendingWrites.get(key) ?? Promise.resolve();
    const next = previous.then(task);
    this.pendingWrites.set(key, next);
    void next.finally(() => {
      if (this.pendingWrites.get(key) === next) {
        this.pendingWrites.delete(key);
      }
    }).catch(() => undefined);
    return next;
  }

  private rememberTerminal(session: VisualEditSession, terminalState: "proposed" | "discarded"): Promise<void> {
    const provider = session.provider;
    const runId = session.runId?.trim();
    if (!provider || !runId) {
      return Promise.resolve();
    }

    session.proposed = terminalState === "proposed";
    session.discarded = terminalState === "discarded";
    this.terminal.set(session.sessionId, {
      provider,
      runId,
      snapshot: snapshotVisualSessionStatus(session),
    });
    while (this.terminal.size > VISUAL_SESSION_STATUS_MAP_LIMIT) {
      const oldestKey = this.terminal.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.terminal.delete(oldestKey);
    }
    return this.queueStatusWrite(session);
  }
}

function isExpired(session: VisualEditSession, now: number): boolean {
  return now - Date.parse(session.updatedAt) > VISUAL_EDIT_SESSION_TTL_MS;
}

function compareSessionIds(left: VisualSessionStatusSnapshot, right: VisualSessionStatusSnapshot): number {
  return left.sessionId.localeCompare(right.sessionId);
}

/**
 * 状態ファイルは run 全体の一覧なので、前の turn の MCP サーバーが作り、この process がまだ
 * 読み戻していない未完了 session を落とさない。この process が知っている session は自分の
 * 記録を正とし、知らない完了済み session は従来どおり上限で落ちてよい。
 */
function carryOverUnknownIncompleteSessions(
  current: VisualSessionsStatusFile | null,
  next: VisualSessionsStatusFile,
  knownSessionIds: ReadonlySet<string>,
): VisualSessionsStatusFile {
  const carried = (current?.sessions ?? []).filter(
    (status) => !knownSessionIds.has(status.sessionId) && !status.proposed && !status.discarded,
  );
  if (carried.length === 0) {
    return next;
  }
  return { ...next, sessions: [...next.sessions, ...carried].sort(compareSessionIds) };
}

function snapshotVisualSessionStatus(session: VisualEditSession): VisualSessionStatusSnapshot {
  return {
    sessionId: session.sessionId,
    targetId: session.targetId,
    operationCount: session.agentSession.operations.length,
    revision: session.revision,
    lastReviewPassed: session.lastReview?.passed ?? null,
    proposed: session.proposed,
    discarded: session.discarded,
    sourceAnalysis: session.sourceAnalysis,
    plannedShapes: session.plannedShapes,
  };
}
