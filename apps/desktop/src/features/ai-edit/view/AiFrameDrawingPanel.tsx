"use client";

import { useEffect, useRef, useState } from "react";

import type { FrameDrawingPanelProps } from "@/components/editor/editor-extension-context";
import { AI_FRAME_DRAWING } from "@/features/document";
import {
  useAiConnection,
  useClaudeConnection,
  useGeminiConnection,
  type AiConnectionStateKind,
} from "@/lib/ai/ai-connection";
import type { AiProvider } from "@/lib/ai/ai-providers";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";

import { frameChatStore, useFrameChatSession } from "../application/frame-chat-store";
import { useAiModelSelection } from "../application/use-ai-model-selection";
import {
  isFrameChatRunning,
  latestFrameChatDrawing,
  frameChatKey,
  type FrameChatAssistantTurn,
  type FrameChatDrawing,
} from "../model/frame-chat";
import { FrameChatComposer } from "./FrameChatComposer";
import { FrameChatTranscript } from "./FrameChatTranscript";
import styles from "./FrameChat.module.css";

const PROVIDERS: readonly AiProvider[] = ["chatgpt", "claude", "antigravity"];

export interface AiFrameDrawingPanelProps extends FrameDrawingPanelProps {
  /** The document the target belongs to. Two documents can each have a problem with the same id. */
  documentIdentityKey?: string | null;
}

/**
 * "Draw with AI" tab of the frame editor (problem and box dialogs alike), as a chat: the AI has
 * already asked what kind of frame you want, you answer in the input below, and the drawing arrives
 * with the AI's thinking streaming in above it. It rides on the tool-less one-shot call the skill
 * editor uses (`aiSkillDraft`, purpose `frameDrawing`): the model only ever returns one SVG, which is
 * normalized before it can become a frame, so it cannot touch the document by itself.
 *
 * The conversation lives in `frameChatStore`, not here, so it keeps running when the dialog is
 * closed. While this panel is on screen a finished drawing goes straight onto the target; otherwise
 * the document shows a notice (see `FrameChatNotices`) and the drawing waits in the conversation.
 */
export function AiFrameDrawingPanel({ target, documentIdentityKey, currentSvg, onDrawn }: AiFrameDrawingPanelProps) {
  const t = useT("settings");
  const tAi = useT("ai");
  const key = frameChatKey(documentIdentityKey, target);
  const session = useFrameChatSession(key);
  const running = isFrameChatRunning(session);

  const connections: Record<AiProvider, AiConnectionStateKind> = {
    chatgpt: useAiConnection().state.kind,
    claude: useClaudeConnection().state.kind,
    antigravity: useGeminiConnection().state.kind,
  };
  const selection = useAiModelSelection(tAi, connections);
  // Nothing to draw with: not the desktop app, or every AI is known not to be connected.
  const unavailable = !getDesktopBridge()?.aiSkillDraft
    || PROVIDERS.every((provider) => connections[provider] !== "loggedIn" && connections[provider] !== "checking");
  // The chosen AI is still being checked: the chat is there, but sending waits for it.
  const waiting = !unavailable && !selection.providerReady;

  const [draft, setDraft] = useState("");
  const [reviseFromCurrent, setReviseFromCurrent] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const onDrawnRef = useRef(onDrawn);
  useEffect(() => {
    onDrawnRef.current = onDrawn;
  });

  const putOnTarget = (drawing: FrameChatDrawing, revised: boolean) => {
    onDrawnRef.current({
      svg: drawing.svg,
      width: drawing.width,
      height: drawing.height,
      slice: AI_FRAME_DRAWING.slice,
      asNew: !revised,
    });
  };

  // A drawing that finishes while this panel is on screen goes straight onto the target.
  // (`putOnTarget` only reads the latest `onDrawn`, through the ref.)
  useEffect(
    () => frameChatStore.watch(key, (drawing, turn) => putOnTarget(drawing, turn.revised)),
    [key],
  );

  // A finished drawing changes the dialog above the panel (the frame's own controls appear), which
  // moves the conversation; keep it where the reader is looking.
  const lastTurn = session?.turns.at(-1);
  const lastStatus = lastTurn?.role === "assistant" ? lastTurn.status : null;
  const previousStatus = useRef(lastStatus);
  useEffect(() => {
    if (previousStatus.current === "running" && lastStatus !== "running") {
      panelRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }
    previousStatus.current = lastStatus;
  }, [lastStatus]);

  const chatDrawing = latestFrameChatDrawing(session);
  const hasCurrentFrame = currentSvg.trim().length > 0;
  const showReviseChip = hasCurrentFrame && chatDrawing === null && reviseFromCurrent;

  const submit = () => {
    const instruction = draft.trim();
    if (!instruction || running || unavailable || waiting) {
      return;
    }
    const result = frameChatStore.send({
      key,
      documentIdentityKey: documentIdentityKey ?? "",
      target,
      instruction,
      provider: selection.provider,
      ...(selection.runtimeModel ? { model: selection.runtimeModel } : {}),
      ...(selection.runtimeReasoningEffort ? { reasoningEffort: selection.runtimeReasoningEffort } : {}),
      // The next request reworks the latest drawing of this conversation; the first one reworks
      // the target's current frame unless the reader took that chip off.
      baseSvg: chatDrawing?.svg ?? (showReviseChip ? currentSvg : ""),
    });
    if (result.ok) {
      setDraft("");
      // The dialog above this panel is long: bring the conversation into view so the thinking
      // that starts streaming now is not below the fold.
      panelRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }
  };

  return (
    <div ref={panelRef} className={styles.panel}>
      {unavailable && <p className={styles.notice} role="status">{t("frame.aiUnavailable")}</p>}
      <FrameChatTranscript
        session={session}
        hasCurrentFrame={hasCurrentFrame}
        onPickExample={(prompt) => {
          setDraft(prompt);
          inputRef.current?.focus();
        }}
        onUse={(turn: FrameChatAssistantTurn, drawing) => {
          putOnTarget(drawing, turn.revised);
          frameChatStore.markApplied(key, turn.id);
        }}
      />
      <FrameChatComposer
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={submit}
        onStop={() => frameChatStore.cancel(key)}
        running={running}
        unavailable={unavailable}
        waiting={waiting}
        placeholder={t(session && session.turns.length > 0 ? "frame.chat.followUpPlaceholder" : "frame.aiPlaceholder")}
        selection={selection}
        connections={connections}
        reviseFromCurrent={showReviseChip}
        onRemoveRevise={() => setReviseFromCurrent(false)}
        inputRef={inputRef}
      />
      {waiting && <p className={styles.note} role="status">{t("frame.aiStatusChecking")}</p>}
      <p className={styles.note}>{t("frame.aiSends")}</p>
      {running && <p className={styles.note} role="status">{t("frame.chat.background")}</p>}
    </div>
  );
}
