import { useSyncExternalStore } from "react";

import { normalizeFrameSvg } from "@/features/document";
import type { AiProvider } from "@/lib/ai/ai-providers";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import type { DesktopAiSkillDraftRequest } from "@/types/desktop";

import {
  isProblemFrameChatRunning,
  problemFrameChatHistory,
  type ProblemFrameChatAssistantTurn,
  type ProblemFrameChatDrawing,
  type ProblemFrameChatSession,
  type ProblemFrameChatTurn,
} from "../model/problem-frame-chat";

const ts = createCurrentLocaleTranslator("settings");

const MAX_TURNS_PER_SESSION = 40;
const MAX_REASONING_CHARS = 20_000;
const MAX_STREAM_CHARS = 200_000;

export interface ProblemFrameChatSendRequest {
  documentIdentityKey: string;
  problemId: string;
  key: string;
  instruction: string;
  provider: AiProvider;
  model?: string;
  reasoningEffort?: string;
  /** 直す元の枠の SVG。新しく描くなら空。 */
  baseSvg: string;
}

export type ProblemFrameChatSendResult =
  | { ok: true }
  | { ok: false; reason: "empty" | "busy" | "unavailable" };

/**
 * 実行が終わったとき、その会話を画面で見ている人 (watch している) がいなかった場合の知らせ。
 * ダイアログを閉じたあとに終わった実行を、教材の画面が「終わりました」と伝えるために使う。
 */
export interface ProblemFrameChatNotice {
  /** 返答のターン id。 */
  id: string;
  key: string;
  documentIdentityKey: string;
  problemId: string;
  kind: "drawn" | "reply" | "failed";
  drawing: ProblemFrameChatDrawing | null;
  message: string;
  error: string | null;
}

/** 画面で会話を見ている側。描き終わった絵をその場で問題へ反映する。 */
export type ProblemFrameChatWatcher = (drawing: ProblemFrameChatDrawing, turn: ProblemFrameChatAssistantTurn) => void;

type Listener = () => void;

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function appendCapped(current: string, delta: string, max: number): string {
  const next = current + delta;
  return next.length > max ? next.slice(next.length - max) : next;
}

class ProblemFrameChatStore {
  private sessions = new Map<string, ProblemFrameChatSession>();
  private snapshot: ReadonlyMap<string, ProblemFrameChatSession> = new Map();
  private notices: readonly ProblemFrameChatNotice[] = [];
  private listeners = new Set<Listener>();
  private watchers = new Map<string, Set<ProblemFrameChatWatcher>>();
  private cancelled = new Set<string>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ReadonlyMap<string, ProblemFrameChatSession> => this.snapshot;

  getNotices = (): readonly ProblemFrameChatNotice[] => this.notices;

  getSession(key: string): ProblemFrameChatSession | null {
    return this.sessions.get(key) ?? null;
  }

  /**
   * この会話を画面で見ている間だけ呼ぶ。見ている間に絵が描き上がれば、通知は出さず
   * `watcher` へ渡してその場で反映する。戻り値で見るのをやめる。
   */
  watch(key: string, watcher: ProblemFrameChatWatcher): () => void {
    const set = this.watchers.get(key) ?? new Set<ProblemFrameChatWatcher>();
    set.add(watcher);
    this.watchers.set(key, set);
    this.emit();
    return () => {
      set.delete(watcher);
      if (set.size === 0 && this.watchers.get(key) === set) {
        this.watchers.delete(key);
      }
      this.emit();
    };
  }

  /** Someone is looking at this conversation right now (its panel is on screen). */
  isWatched(key: string): boolean {
    return (this.watchers.get(key)?.size ?? 0) > 0;
  }

  send(request: ProblemFrameChatSendRequest): ProblemFrameChatSendResult {
    const instruction = request.instruction.trim();
    if (!instruction) {
      return { ok: false, reason: "empty" };
    }
    const bridge = getDesktopBridge()?.aiSkillDraft;
    if (!bridge) {
      return { ok: false, reason: "unavailable" };
    }
    const existing = this.sessions.get(request.key);
    if (isProblemFrameChatRunning(existing)) {
      return { ok: false, reason: "busy" };
    }

    const now = Date.now();
    const userTurn: ProblemFrameChatTurn = { id: nextId("u"), role: "user", text: instruction, at: now };
    const assistant: ProblemFrameChatAssistantTurn = {
      id: nextId("a"),
      role: "assistant",
      status: "running",
      provider: request.provider,
      streamText: "",
      reasoningText: "",
      message: "",
      drawing: null,
      revised: request.baseSvg.trim().length > 0,
      error: null,
      startedAt: now,
      replyStartedAt: null,
      endedAt: null,
    };
    const history = problemFrameChatHistory(existing);
    this.write({
      key: request.key,
      documentIdentityKey: request.documentIdentityKey,
      problemId: request.problemId,
      turns: [...(existing?.turns ?? []), userTurn, assistant].slice(-MAX_TURNS_PER_SESSION),
      runId: null,
      appliedTurnId: existing?.appliedTurnId ?? null,
    });

    const payload: DesktopAiSkillDraftRequest = {
      provider: request.provider,
      prompt: instruction,
      purpose: "problemFrame",
      ...(request.model ? { model: request.model } : {}),
      ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
      context: { title: "", description: "", currentContent: request.baseSvg, history },
    };
    void bridge
      .generate(
        payload,
        (event) => {
          if (event.kind === "reasoning") {
            this.updateAssistant(request.key, assistant.id, (turn) => ({
              reasoningText: appendCapped(turn.reasoningText, event.text, MAX_REASONING_CHARS),
            }));
          } else {
            this.updateAssistant(request.key, assistant.id, (turn) => ({
              streamText: appendCapped(turn.streamText, event.text, MAX_STREAM_CHARS),
              replyStartedAt: turn.replyStartedAt ?? Date.now(),
            }));
          }
        },
        (runId) => {
          const session = this.sessions.get(request.key);
          if (session) {
            this.write({ ...session, runId });
          }
        },
      )
      .then(
        (result) => this.finish(request, assistant.id, result),
        (cause: unknown) => this.finish(request, assistant.id, {
          ok: false,
          error: cause instanceof Error ? cause.message : ts("problem.custom.aiFailed"),
        }),
      );
    return { ok: true };
  }

  /** 実行中の描画を中止する。 */
  cancel(key: string): void {
    const session = this.sessions.get(key);
    const running = session?.turns.find(
      (turn): turn is ProblemFrameChatAssistantTurn => turn.role === "assistant" && turn.status === "running",
    );
    if (!session || !running) {
      return;
    }
    this.cancelled.add(running.id);
    if (session.runId) {
      void getDesktopBridge()?.aiSkillDraft?.cancel(session.runId);
    }
    this.updateAssistant(key, running.id, () => ({ status: "cancelled", streamText: "", endedAt: Date.now() }));
    const current = this.sessions.get(key);
    if (current) {
      this.write({ ...current, runId: null });
    }
  }

  /** この返答の絵が問題の枠として使われた、と記録する。 */
  markApplied(key: string, turnId: string): void {
    const session = this.sessions.get(key);
    if (session && session.appliedTurnId !== turnId) {
      this.write({ ...session, appliedTurnId: turnId });
    }
  }

  dismissNotice(turnId: string): void {
    if (this.notices.some((notice) => notice.id === turnId)) {
      this.notices = this.notices.filter((notice) => notice.id !== turnId);
      this.emit();
    }
  }

  private finish(
    request: ProblemFrameChatSendRequest,
    turnId: string,
    result: { ok: true; text: string; message?: string } | { ok: false; error: string; message?: string },
  ): void {
    if (this.cancelled.delete(turnId)) {
      return;
    }
    const normalized = result.ok ? normalizeFrameSvg(result.text) : null;
    const drawing: ProblemFrameChatDrawing | null = normalized?.ok
      ? { svg: normalized.svg, width: normalized.width, height: normalized.height }
      : null;
    const error = result.ok ? (drawing ? null : ts("problem.custom.aiInvalid")) : result.error;
    const message = result.message?.trim() ?? "";

    this.updateAssistant(request.key, turnId, () => ({
      status: error ? "error" : "done",
      streamText: "",
      message,
      drawing,
      error,
      endedAt: Date.now(),
    }));
    const session = this.sessions.get(request.key);
    if (session) {
      this.write({ ...session, runId: null });
    }

    const watchers = this.watchers.get(request.key);
    if (drawing && watchers && watchers.size > 0) {
      this.markApplied(request.key, turnId);
      const finished = this.sessions.get(request.key)?.turns.find(
        (turn): turn is ProblemFrameChatAssistantTurn => turn.role === "assistant" && turn.id === turnId,
      );
      if (finished) {
        watchers.forEach((watcher) => watcher(drawing, finished));
      }
      return;
    }
    this.notices = [
      ...this.notices,
      {
        id: turnId,
        key: request.key,
        documentIdentityKey: request.documentIdentityKey,
        problemId: request.problemId,
        kind: drawing ? "drawn" : error ? "failed" : "reply",
        drawing,
        message,
        error,
      },
    ];
    this.emit();
  }

  private updateAssistant(
    key: string,
    turnId: string,
    patch: (turn: ProblemFrameChatAssistantTurn) => Partial<ProblemFrameChatAssistantTurn>,
  ): void {
    const session = this.sessions.get(key);
    if (!session) {
      return;
    }
    let changed = false;
    const turns = session.turns.map((turn) => {
      if (turn.role !== "assistant" || turn.id !== turnId) {
        return turn;
      }
      changed = true;
      return { ...turn, ...patch(turn) };
    });
    if (changed) {
      this.write({ ...session, turns });
    }
  }

  private write(session: ProblemFrameChatSession): void {
    this.sessions.set(session.key, session);
    this.emit();
  }

  private emit(): void {
    this.snapshot = new Map(this.sessions);
    this.listeners.forEach((listener) => listener());
  }

  /** テスト用: 状態を空に戻す。 */
  resetForTests(): void {
    this.sessions.clear();
    this.watchers.clear();
    this.cancelled.clear();
    this.notices = [];
    this.emit();
  }
}

export const problemFrameChatStore = new ProblemFrameChatStore();

export function useProblemFrameChatSession(key: string): ProblemFrameChatSession | null {
  const sessions = useSyncExternalStore(
    problemFrameChatStore.subscribe,
    problemFrameChatStore.getSnapshot,
    problemFrameChatStore.getSnapshot,
  );
  return sessions.get(key) ?? null;
}

export function useProblemFrameChatSessions(): ReadonlyMap<string, ProblemFrameChatSession> {
  return useSyncExternalStore(
    problemFrameChatStore.subscribe,
    problemFrameChatStore.getSnapshot,
    problemFrameChatStore.getSnapshot,
  );
}

export function useProblemFrameChatNotices(): readonly ProblemFrameChatNotice[] {
  return useSyncExternalStore(
    problemFrameChatStore.subscribe,
    problemFrameChatStore.getNotices,
    problemFrameChatStore.getNotices,
  );
}
