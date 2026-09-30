"use client";

import { Check, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/Button";
import { Shimmer } from "@/components/ui/Shimmer";
import { useT } from "@/lib/i18n/react";

import {
  splitStreamedFrameReply,
  type ProblemFrameChatAssistantTurn,
  type ProblemFrameChatDrawing,
  type ProblemFrameChatSession,
} from "../model/problem-frame-chat";
import styles from "./ProblemFrameChat.module.css";

const EXAMPLE_KEYS = ["sakura", "blackboard", "japanese", "notebook"] as const;
/** How close to the bottom the reader must be for the log to keep following new text. */
const FOLLOW_THRESHOLD_PX = 24;

export function frameSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function secondsBetween(from: number, to: number): number {
  return Math.max(0, Math.round((to - from) / 1000));
}

/** A clock that ticks once a second only while something is running. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    // The first reading comes on the next tick, so the effect itself sets no state.
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [active]);
  return now;
}

interface TranscriptProps {
  session: ProblemFrameChatSession | null;
  /** Whether the problem already has a frame the AI can rework. */
  hasCurrentFrame: boolean;
  onPickExample: (prompt: string) => void;
  onUse: (turn: ProblemFrameChatAssistantTurn, drawing: ProblemFrameChatDrawing) => void;
}

/**
 * The conversation: the AI's first question is always there, so the panel reads as a chat that
 * already started. The log follows new text while the reader is at the bottom and stays put once
 * they scroll up to read.
 */
export function ProblemFrameChatTranscript({ session, hasCurrentFrame, onPickExample, onUse }: TranscriptProps) {
  const t = useT("settings");
  const turns = session?.turns ?? [];
  const running = turns.some((turn) => turn.role === "assistant" && turn.status === "running");
  const now = useNow(running);
  const logRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(true);

  const last = turns.at(-1);
  const lastAssistant = last?.role === "assistant" ? last : null;
  const followKey = `${turns.length}:${lastAssistant?.streamText.length ?? 0}:${lastAssistant?.reasoningText.length ?? 0}:${lastAssistant?.status ?? ""}`;
  useEffect(() => {
    const log = logRef.current;
    if (log && followingRef.current) {
      log.scrollTop = log.scrollHeight;
    }
  }, [followKey]);

  return (
    <div
      ref={logRef}
      className={styles.log}
      role="log"
      aria-live="polite"
      aria-label={t("problem.custom.chat.logAria")}
      data-testid="problem-custom-frame-ai-log"
      onScroll={(event) => {
        const log = event.currentTarget;
        followingRef.current = log.scrollHeight - log.scrollTop - log.clientHeight <= FOLLOW_THRESHOLD_PX;
      }}
    >
      <div className={styles.assistantRow} data-testid="problem-custom-frame-ai-greeting">
        <p className={styles.message}>
          {t(hasCurrentFrame ? "problem.custom.chat.greetingWithCurrent" : "problem.custom.chat.greeting")}
        </p>
        {turns.length === 0 && (
          <div className={styles.examples} role="group" aria-label={t("problem.custom.aiExamplesLabel")}>
            {EXAMPLE_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                className={styles.example}
                onClick={() => onPickExample(t(`problem.custom.aiExamples.${key}.prompt`))}
              >
                {t(`problem.custom.aiExamples.${key}.label`)}
              </button>
            ))}
          </div>
        )}
      </div>
      {turns.map((turn) => turn.role === "user"
        ? (
          <div key={turn.id} className={styles.userRow}>
            <p className={styles.userBubble}>{turn.text}</p>
          </div>
        )
        : (
          <AssistantTurn
            key={turn.id}
            turn={turn}
            now={now}
            applied={session?.appliedTurnId === turn.id}
            onUse={onUse}
          />
        ))}
    </div>
  );
}

function AssistantTurn({
  turn,
  now,
  applied,
  onUse,
}: {
  turn: ProblemFrameChatAssistantTurn;
  now: number;
  applied: boolean;
  onUse: TranscriptProps["onUse"];
}) {
  const t = useT("settings");
  const running = turn.status === "running";
  const streamed = running ? splitStreamedFrameReply(turn.streamText) : null;
  const message = running ? streamed?.message ?? "" : turn.message;

  return (
    <div className={styles.assistantRow} data-status={turn.status} data-testid="problem-custom-frame-ai-turn">
      <Thinking turn={turn} now={now} />
      {message && <p className={styles.message}>{message}</p>}
      {running && (streamed?.drawingChars ?? 0) > 0 && (
        <p className={styles.progress}>
          <Shimmer>{t("problem.custom.chat.writing", { chars: streamed?.drawingChars ?? 0 })}</Shimmer>
        </p>
      )}
      {turn.drawing && (
        <div className={styles.drawing} data-testid="problem-custom-frame-ai-drawing">
          {/* eslint-disable-next-line @next/next/no-img-element -- an inline SVG data URL, not a fetched image */}
          <img
            className={styles.drawingImage}
            src={frameSvgDataUrl(turn.drawing.svg)}
            alt={t("problem.custom.chat.drawingAlt")}
            width={turn.drawing.width}
            height={turn.drawing.height}
          />
          {applied ? (
            <span className={styles.inUse} data-testid="problem-custom-frame-ai-in-use">
              <Check size={13} aria-hidden="true" />
              {t("problem.custom.chat.inUse")}
            </span>
          ) : (
            <Button
              size="sm"
              data-testid="problem-custom-frame-ai-use"
              onClick={() => turn.drawing && onUse(turn, turn.drawing)}
            >
              {t("problem.custom.chat.useFrame")}
            </Button>
          )}
        </div>
      )}
      {turn.error && <p role="alert" className={styles.error}>{turn.error}</p>}
      {turn.status === "cancelled" && <p className={styles.meta}>{t("problem.custom.chat.cancelled")}</p>}
    </div>
  );
}

/**
 * What the AI is doing right now, and how long it has been at it. The thinking text streams in
 * while it runs (for the providers that expose it) and folds away once the answer is there, to be
 * opened again from the header.
 */
function Thinking({ turn, now }: { turn: ProblemFrameChatAssistantTurn; now: number }) {
  const t = useT("settings");
  const running = turn.status === "running";
  const hasReasoning = turn.reasoningText.trim().length > 0;
  const [open, setOpen] = useState(running);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) {
      setOpen(false);
    }
    wasRunning.current = running;
  }, [running]);

  const bodyRef = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (running && body) {
      body.scrollTop = body.scrollHeight;
    }
  }, [running, turn.reasoningText]);

  const end = turn.endedAt ?? now;
  let label: ReactNode = null;
  if (running) {
    label = turn.replyStartedAt === null
      ? <Shimmer>{t("problem.custom.chat.thinkingFor", { seconds: secondsBetween(turn.startedAt, now) })}</Shimmer>
      : <Shimmer>{t("problem.custom.chat.drawingFor", { seconds: secondsBetween(turn.startedAt, now) })}</Shimmer>;
  } else if (turn.status === "done" || turn.status === "error") {
    label = hasReasoning
      ? t("problem.custom.chat.thoughtFor", { seconds: secondsBetween(turn.startedAt, turn.replyStartedAt ?? end) })
      : turn.status === "done"
        ? t("problem.custom.chat.drewFor", { seconds: secondsBetween(turn.startedAt, end) })
        : null;
  }
  if (!label && !hasReasoning) {
    return null;
  }

  return (
    <div className={styles.thinking} data-testid="problem-custom-frame-ai-thinking">
      {hasReasoning ? (
        <button
          type="button"
          className={styles.thinkingToggle}
          aria-expanded={open}
          aria-label={t(open ? "problem.custom.chat.hideReasoning" : "problem.custom.chat.showReasoning")}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronRight size={13} aria-hidden="true" className={styles.chevron} data-open={open} />
          <span role={running ? "status" : undefined}>{label}</span>
        </button>
      ) : (
        <span className={styles.thinkingStatic} role={running ? "status" : undefined}>{label}</span>
      )}
      {hasReasoning && open && (
        <p ref={bodyRef} className={styles.reasoning} data-testid="problem-custom-frame-ai-reasoning">
          {turn.reasoningText}
        </p>
      )}
    </div>
  );
}
