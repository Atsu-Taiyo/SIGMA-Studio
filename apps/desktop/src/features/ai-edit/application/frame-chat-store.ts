import { useSyncExternalStore } from "react";

import { normalizeFrameSvg } from "@/features/document";
import type { AiProvider } from "@/lib/ai/ai-providers";
import type { CustomFrameTarget } from "@/lib/custom-frame";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import type { DesktopAiSkillDraftRequest } from "@/types/desktop";

import {
  isFrameChatRunning,
  frameChatHistory,
  type FrameChatAssistantTurn,
  type FrameChatDrawing,
  type FrameChatSession,
  type FrameChatTurn,
} from "../model/frame-chat";

const ts = createCurrentLocaleTranslator("settings");

const MAX_TURNS_PER_SESSION = 40;
const MAX_REASONING_CHARS = 20_000;
const MAX_STREAM_CHARS = 200_000;

export interface FrameChatSendRequest {
  documentIdentityKey: string;
  /** どの問題 (または箱) の枠か。AI への依頼文もこれで少し変わる。 */
  target: CustomFrameTarget;
  key: string;
  instruction: string;
  provider: AiProvider;
  model?: string;
  reasoningEffort?: string;
  /** 直す元の枠の SVG。新しく描くなら空。 */
  baseSvg: string;
}

export type FrameChatSendResult =
  | { ok: true }
  | { ok: false; reason: "empty" | "busy" | "unavailable" };

/**
 * 実行が終わったとき、その会話を画面で見ている人 (watch している) がいなかった場合の知らせ。
 * ダイアログを閉じたあとに終わった実行を、教材の画面が「終わりました」と伝えるために使う。
 */
export interface FrameChatNotice {
  /** 返答のターン id。 */
  id: string;
  key: string;
  documentIdentityKey: string;
  target: CustomFrameTarget;
  kind: "drawn" | "reply" | "failed";
  drawing: FrameChatDrawing | null;
  message: string;
  error: string | null;
}

/** 画面で会話を見ている側。描き終わった絵をその場で対象 (問題・箱) へ反映する。 */
export type FrameChatWatcher = (drawing: FrameChatDrawing, turn: FrameChatAssistantTurn) => void;

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

class FrameChatStore {
  private sessions = new Map<string, FrameChatSession>();
  private snapshot: ReadonlyMap<string, FrameChatSession> = new Map();
  private notices: readonly FrameChatNotice[] = [];
  private listeners = new Set<Listener>();
  private watchers = new Map<string, Set<FrameChatWatcher>>();
  private cancelled = new Set<string>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ReadonlyMap<string, FrameChatSession> => this.snapshot;

  getNotices = (): readonly FrameChatNotice[] => this.notices;

  getSession(key: string): FrameChatSession | null {
    return this.sessions.get(key) ?? null;
  }

  /**
   * この会話を画面で見ている間だけ呼ぶ。見ている間に絵が描き上がれば、通知は出さず
   * `watcher` へ渡してその場で反映する。戻り値で見るのをやめる。
   */
  watch(key: string, watcher: FrameChatWatcher): () => void {
    const set = this.watchers.get(key) ?? new Set<FrameChatWatcher>();
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

  send(request: FrameChatSendRequest): FrameChatSendResult {
    const instruction = request.instruction.trim();
    if (!instruction) {
      return { ok: false, reason: "empty" };
    }
    const bridge = getDesktopBridge()?.aiSkillDraft;
    if (!bridge) {
      return { ok: false, reason: "unavailable" };
    }
    const existing = this.sessions.get(request.key);
    if (isFrameChatRunning(existing)) {
      return { ok: false, reason: "busy" };
    }

    const now = Date.now();
    const userTurn: FrameChatTurn = { id: nextId("u"), role: "user", text: instruction, at: now };
    const assistant: FrameChatAssistantTurn = {
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
    const history = frameChatHistory(existing);
    this.write({
      key: request.key,
      documentIdentityKey: request.documentIdentityKey,
      target: request.target,
      turns: [...(existing?.turns ?? []), userTurn, assistant].slice(-MAX_TURNS_PER_SESSION),
      runId: null,
      appliedTurnId: existing?.appliedTurnId ?? null,
    });

    const payload: DesktopAiSkillDraftRequest = {
      provider: request.provider,
      prompt: instruction,
      purpose: "frameDrawing",
      frameTarget: request.target.kind,
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
          error: cause instanceof Error ? cause.message : ts("frame.aiFailed"),
        }),
      );
    return { ok: true };
  }

  /** 実行中の描画を中止する。 */
  cancel(key: string): void {
    const session = this.sessions.get(key);
    const running = session?.turns.find(
      (turn): turn is FrameChatAssistantTurn => turn.role === "assistant" && turn.status === "running",
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

  /** この返答の絵が対象の枠として使われた、と記録する。 */
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
    request: FrameChatSendRequest,
    turnId: string,
    result: { ok: true; text: string; message?: string } | { ok: false; error: string; message?: string },
  ): void {
    if (this.cancelled.delete(turnId)) {
      return;
    }
    const normalized = result.ok ? normalizeFrameSvg(result.text) : null;
    const drawing: FrameChatDrawing | null = normalized?.ok
      ? { svg: normalized.svg, width: normalized.width, height: normalized.height }
      : null;
    const error = result.ok ? (drawing ? null : ts("frame.aiInvalid")) : result.error;
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
        (turn): turn is FrameChatAssistantTurn => turn.role === "assistant" && turn.id === turnId,
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
        target: request.target,
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
    patch: (turn: FrameChatAssistantTurn) => Partial<FrameChatAssistantTurn>,
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

  private write(session: FrameChatSession): void {
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

export const frameChatStore = new FrameChatStore();

export function useFrameChatSession(key: string): FrameChatSession | null {
  const sessions = useSyncExternalStore(
    frameChatStore.subscribe,
    frameChatStore.getSnapshot,
    frameChatStore.getSnapshot,
  );
  return sessions.get(key) ?? null;
}

export function useFrameChatSessions(): ReadonlyMap<string, FrameChatSession> {
  return useSyncExternalStore(
    frameChatStore.subscribe,
    frameChatStore.getSnapshot,
    frameChatStore.getSnapshot,
  );
}

export function useFrameChatNotices(): readonly FrameChatNotice[] {
  return useSyncExternalStore(
    frameChatStore.subscribe,
    frameChatStore.getNotices,
    frameChatStore.getNotices,
  );
}
