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
}

export interface VisualEditSessionLifecyclePorts {
  now(): number;
  /** 保存先は enqueue 時点に解決する。環境変数の読み取りを開始時へ繰り上げない。 */
  resolveStatusTarget(
    provider: AiEditRunContextProvider | null,
    runId: string | undefined,
  ): VisualSessionStatusWriteTarget | null;
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
 */
export class VisualEditSessionLifecycle {
  private readonly live = new Map<string, VisualEditSession>();
  private readonly terminal = new Map<string, TerminalVisualSessionStatus>();
  private readonly pendingWrites = new Map<string, Promise<void>>();

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

  prune(now = this.ports.now()): void {
    for (const [sessionId, session] of this.live) {
      if (now - Date.parse(session.updatedAt) > VISUAL_EDIT_SESSION_TTL_MS) {
        // 期限切れも terminal snapshot を live map に存在する間に enqueue する。
        // 期限切れ処理は従来どおり書き出しを待たず、scratch 本体を解放する。
        void this.rememberTerminal(session, "discarded");
        this.live.delete(sessionId);
      }
    }
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
      sessions: [...statusBySessionId.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
    };
    const previous = this.pendingWrites.get(target.key) ?? Promise.resolve();
    const next = previous.then(() => target.write(statusFile));
    this.pendingWrites.set(target.key, next);
    void next.finally(() => {
      if (this.pendingWrites.get(target.key) === next) {
        this.pendingWrites.delete(target.key);
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
