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

/**
 * tool 呼び出しの後の保存の結果。
 * - saved: 別のプロセスからも同じ sessionId で再開できる。
 * - memory-only: run を持たない session など、元からこのプロセスの memory だけに置くもの。
 * - skipped: 呼び出しの中で提案化・破棄された (保存するものが無い)。
 * - not-saved: 保存できなかった。古い保存も消したので、次の turn では再開できない。
 * - superseded: 別のプロセスがこの session を先に進めていた。この呼び出しの変更は捨てた。
 */
export type VisualEditSessionPersistOutcome = "saved" | "memory-only" | "skipped" | "not-saved" | "superseded";

/** 呼び出し元の run。`explicit` は tool の引数で runId が渡されたとき。 */
export interface VisualEditSessionCaller {
  runId: string | null;
  explicit: boolean;
}

/** run 単位で保存した 1 session の状態。 */
export interface VisualEditSessionStateTarget {
  /** 同じ保存先への書き込み・削除は、この key ごとに生成順で行う。 */
  key: string;
  /** 保存済みの一番新しい世代。無い・読めない場合は null。 */
  readGeneration(): Promise<number | null>;
  /** 別のプロセスがこの session を提案化・破棄した目印があるか。 */
  isRetired(): Promise<boolean>;
  /**
   * 直列化した状態をこの世代として保存する。同じ世代か新しい世代を別プロセスが先に保存して
   * いた・提案化・破棄されていた場合は書かずに "superseded" を返す (プロセスをまたいだ比較更新)。
   * 失敗は例外にせず "failed" を返し、そのとき保存済みの古い世代は無効にする (書けなかった
   * 変更より古い状態を最新として読み戻させない。到達した世代の記録は残す)。
   */
  write(serialized: string, generation: number): Promise<VisualEditSessionStateWriteOutcome>;
  /** 保存した世代をすべて無効にする (直列化できなかったとき)。到達した世代の記録は残す。 */
  clear(): Promise<void>;
  /** 提案化・破棄の目印を残して、保存した世代を消す。目印のある session は読み戻さない。 */
  retire(): Promise<void>;
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
  /** 書く直前の memory の状態を直列化する (世代は保存済みの世代の次に決まる)。 */
  serialize(session: VisualEditSession, generation: number): string;
  /** memory に無い sessionId を、その run の保存からだけ読み戻す。無い・壊れている場合は null。 */
  load(sessionId: string, runId: string): Promise<StoredVisualEditSession | null>;
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
  /** memory の session の元になった保存の世代 (読み戻した・書けた世代)。保存側の方が新しければ読み直す。 */
  private readonly generations = new Map<string, number>();
  /** 別のプロセスに先を越された memory の session。待っている書き込みも保存しない。 */
  private readonly superseded = new WeakSet<VisualEditSession>();
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
  async resolve(sessionId: string, caller?: VisualEditSessionCaller): Promise<VisualEditSession> {
    const session = await this.find(sessionId, caller);
    if (!session) {
      throw new Error(`visual edit session が見つかりません: ${sessionId}`);
    }
    return session;
  }

  /**
   * `resolve` の見つからなければ undefined を返す版 (破棄のように、無くても失敗にしない呼び出し用)。
   * 保存から読み戻すのは呼び出し元の run の session だけ。runId が引数で渡された呼び出しは、
   * memory にある別の run の session も見つからないものとして扱う。
   */
  async find(sessionId: string, caller?: VisualEditSessionCaller): Promise<VisualEditSession | undefined> {
    this.prune();
    const live = this.live.get(sessionId);
    if (live && !ownedBy(live, caller)) {
      return undefined;
    }
    const ownerRunId = live?.runId?.trim() || caller?.runId?.trim() || null;
    const key = `${sessionId}\u0000${ownerRunId ?? ""}`;
    const inFlight = this.restoring.get(key);
    const lookup = inFlight ?? this.findCurrent(sessionId, ownerRunId).finally(() => {
      if (this.restoring.get(key) === lookup) {
        this.restoring.delete(key);
      }
    });
    if (!inFlight) {
      this.restoring.set(key, lookup);
    }
    const found = await lookup;
    return found && ownedBy(found, caller) ? found : undefined;
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
   * 次の turn のプロセスが同じ状態から続けられるようにするため。結果は呼び出し元が応答へ
   * 反映する (保存できなかったのに、次の turn で再開できるとは伝えない)。
   * 終了済み・読み直しで置き換わった session は書かない。
   */
  async persist(session: VisualEditSession): Promise<VisualEditSessionPersistOutcome> {
    if (this.live.get(session.sessionId) !== session) {
      return this.superseded.has(session) ? "superseded" : "skipped";
    }
    const port = this.ports.sessionState;
    const target = port?.resolveTarget(session) ?? null;
    let saving: Promise<VisualEditSessionPersistOutcome> = Promise.resolve("memory-only");
    if (port && target) {
      // 世代は書く直前に、保存済みの世代の次に決める。書けなかった世代は飛ばさず次も同じ番号で
      // 比べるので、その間に別のプロセスが同じ番号を保存していれば先を越されたと分かる。
      saving = this.enqueueWrite(target.key, async (): Promise<VisualEditSessionPersistOutcome> => {
        if (this.superseded.has(session)) {
          return "superseded";
        }
        if (this.live.get(session.sessionId) !== session) {
          return "skipped";
        }
        const generation = (this.generations.get(session.sessionId) ?? 0) + 1;
        let serialized: string;
        try {
          serialized = port.serialize(session, generation);
        } catch {
          // 直列化できない状態は保存しない。この process の memory では引き続き使えるが、
          // 前に保存した古い状態を別のプロセスが最新として読み戻さないよう消す。
          await target.clear();
          return "not-saved";
        }
        const outcome = await target.write(serialized, generation);
        if (outcome === "written") {
          this.generations.set(session.sessionId, generation);
          return "saved";
        }
        if (outcome === "superseded") {
          // 別プロセスが同じ session を先に進めていた。古い memory を捨て、次の呼び出しで
          // 保存側を読み直す。この session の後続の書き込みも保存しない。
          this.superseded.add(session);
          if (this.live.get(session.sessionId) === session) {
            this.live.delete(session.sessionId);
            this.generations.delete(session.sessionId);
          }
          return "superseded";
        }
        return "not-saved";
      });
    }
    const statusKey = this.ports.resolveStatusTarget(session.provider, session.runId?.trim())?.key;
    const pendingStatus = statusKey ? this.pendingWrites.get(statusKey) : undefined;
    const [outcome] = await Promise.all([
      saving.catch(() => "not-saved" as const),
      pendingStatus?.catch(() => undefined),
    ]);
    return outcome;
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
      await target.write(carryOverUnknownSessions(current, keepRecordedFinishes(current, statusFile), knownSessionIds));
    });
  }

  private async findCurrent(sessionId: string, ownerRunId: string | null): Promise<VisualEditSession | undefined> {
    const port = this.ports.sessionState;
    const live = this.live.get(sessionId);
    if (!port) {
      return live;
    }
    // memory の copy より新しい世代が保存されている。読み戻せなければ古い copy では続けない。
    let newerSaved = false;
    if (live) {
      const target = port.resolveTarget(live);
      if ((target && await target.isRetired()) || await this.isRecordedTerminal(live)) {
        // 別のプロセスが提案化・破棄した。この memory の古い copy で続けない (二重の提案を防ぐ)。
        this.dropLive(live);
        return undefined;
      }
      const storedGeneration = target ? await target.readGeneration() : null;
      if (storedGeneration === null || storedGeneration <= (this.generations.get(sessionId) ?? 0)) {
        return this.live.get(sessionId);
      }
      newerSaved = true;
    } else if (this.terminal.has(sessionId)) {
      // この process で提案化・破棄した session は、保存の削除が遅れていても戻さない。
      return undefined;
    }
    if (!ownerRunId) {
      // どの run の session か分からない呼び出しは、保存から読み戻さない。
      return live;
    }

    const stored = await port.load(sessionId, ownerRunId);
    const current = this.live.get(sessionId);
    if (!stored || stored.session.sessionId !== sessionId) {
      if (newerSaved && live) {
        // 新しい世代を読む前に、さらに新しい世代へ置き換わった・無効になった。次の呼び出しで読み直す。
        this.dropLive(live);
        return undefined;
      }
      return current;
    }
    if (current && stored.generation <= (this.generations.get(sessionId) ?? 0)) {
      return current;
    }
    if (await this.isRecordedTerminal(stored.session)) {
      // 別のプロセスが提案化・破棄を記録した後、保存を消す前に止まった (または消せなかった)。
      // 終わった session を再開させず、残った保存を片付ける。
      this.live.delete(sessionId);
      this.generations.delete(sessionId);
      await this.removeState(stored.session);
      return undefined;
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

  /**
   * 提案化の直前に、memory の copy が今も最新の保存か確かめる。別のプロセスがより新しい世代を
   * 保存した・提案化や破棄をした場合は copy を捨てて false を返す (古い内容で提案を作らない)。
   */
  async isLatest(session: VisualEditSession): Promise<boolean> {
    if (this.live.get(session.sessionId) !== session || this.superseded.has(session)) {
      return false;
    }
    const target = this.ports.sessionState?.resolveTarget(session) ?? null;
    if (!target) {
      return true;
    }
    const pending = this.pendingWrites.get(target.key);
    await pending?.catch(() => undefined);
    const storedGeneration = await target.readGeneration();
    const latest = !(await target.isRetired())
      && !(await this.isRecordedTerminal(session))
      && (storedGeneration === null || storedGeneration <= (this.generations.get(session.sessionId) ?? 0));
    if (!latest) {
      this.superseded.add(session);
      this.dropLive(session);
    }
    return latest;
  }

  private dropLive(session: VisualEditSession): void {
    if (this.live.get(session.sessionId) === session) {
      this.live.delete(session.sessionId);
      this.generations.delete(session.sessionId);
    }
  }

  /** run の状態ファイルに、この session の提案化・破棄が記録されているか。読めなければ false。 */
  private async isRecordedTerminal(session: VisualEditSession): Promise<boolean> {
    const target = this.ports.resolveStatusTarget(session.provider, session.runId?.trim());
    if (!target?.read) {
      return false;
    }
    const pending = this.pendingWrites.get(target.key);
    await pending?.catch(() => undefined);
    let status: VisualSessionsStatusFile | null;
    try {
      status = await target.read();
    } catch {
      return false;
    }
    const recorded = status?.sessions.find((item) => item.sessionId === session.sessionId);
    return Boolean(recorded?.proposed || recorded?.discarded);
  }

  private removeState(session: VisualEditSession): Promise<void> {
    const target = this.ports.sessionState?.resolveTarget(session) ?? null;
    if (!target) {
      return Promise.resolve();
    }
    return this.enqueueWrite(target.key, () => target.retire());
  }

  /** 同じ保存先への書き込み・削除を生成順に並べる。 */
  private enqueueWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.pendingWrites.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const settled = next.then(() => undefined, () => undefined);
    this.pendingWrites.set(key, settled);
    void settled.finally(() => {
      if (this.pendingWrites.get(key) === settled) {
        this.pendingWrites.delete(key);
      }
    });
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

/** runId が引数で渡された呼び出しには、その run の session だけを見せる。 */
function ownedBy(session: VisualEditSession, caller: VisualEditSessionCaller | undefined): boolean {
  const callerRunId = caller?.explicit ? caller.runId?.trim() : undefined;
  const sessionRunId = session.runId?.trim();
  return !callerRunId || !sessionRunId || callerRunId === sessionRunId;
}

function isExpired(session: VisualEditSession, now: number): boolean {
  return now - Date.parse(session.updatedAt) > VISUAL_EDIT_SESSION_TTL_MS;
}

function compareSessionIds(left: VisualSessionStatusSnapshot, right: VisualSessionStatusSnapshot): number {
  return left.sessionId.localeCompare(right.sessionId);
}

/**
 * 状態ファイルは run 全体の一覧なので、前の turn の MCP サーバーが記録し、この process が
 * まだ知らない session を落とさない。未完了のものは強制継続の判定に、提案化・破棄済みのものは
 * 別のプロセスが残った保存から読み戻さないための記録に使う。この process が知っている
 * session は自分の記録を正とする。提案化・破棄済みの記録は memory と同じ上限までとし、
 * 溢れたら引き継いだ分から落とす (読み戻しを止める第一の目印は保存先の終了の目印)。
 */
function carryOverUnknownSessions(
  current: VisualSessionsStatusFile | null,
  next: VisualSessionsStatusFile,
  knownSessionIds: ReadonlySet<string>,
): VisualSessionsStatusFile {
  const unknown = (current?.sessions ?? []).filter((status) => !knownSessionIds.has(status.sessionId));
  const isFinished = (status: VisualSessionStatusSnapshot) => status.proposed || status.discarded;
  const finishedRoom = Math.max(0, VISUAL_SESSION_STATUS_MAP_LIMIT - next.sessions.filter(isFinished).length);
  const carried = [
    ...unknown.filter((status) => !isFinished(status)),
    ...unknown.filter(isFinished).slice(0, finishedRoom),
  ];
  if (carried.length === 0) {
    return next;
  }
  return { ...next, sessions: [...next.sessions, ...carried].sort(compareSessionIds) };
}

/**
 * 別のプロセスが提案化・破棄を記録した session は、この process の memory の未終了の copy で
 * 未終了へ戻さない (戻すと、残った保存を別のプロセスが読み戻せてしまう)。
 */
function keepRecordedFinishes(current: VisualSessionsStatusFile | null, next: VisualSessionsStatusFile): VisualSessionsStatusFile {
  const finished = new Map((current?.sessions ?? [])
    .filter((status) => status.proposed || status.discarded)
    .map((status) => [status.sessionId, status] as const));
  if (finished.size === 0) {
    return next;
  }
  return {
    ...next,
    sessions: next.sessions.map((status) =>
      !status.proposed && !status.discarded ? finished.get(status.sessionId) ?? status : status),
  };
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
