"use client";

import { ThinkingOrb, type OrbState } from "thinking-orbs";

import type { AiEditRunEvent } from "@/lib/ai/ai-edit-runtime";
import { useT } from "@/lib/i18n/react";

type ActivityEvent = Pick<AiEditRunEvent, "kind" | "phase" | "itemType">;

const PHASE_ORB_STATES: Record<AiEditRunEvent["phase"], OrbState> = {
  preparing: "connecting",
  reading: "searching",
  thinking: "weaving",
  streaming: "composing",
  validating: "solving",
  repairing: "shaping",
  complete: "breathing",
};

/** Agent item semantics take precedence over the broader run phase. */
export function resolveAiThinkingOrbState(events: ReadonlyArray<ActivityEvent>): OrbState {
  const latest = events.at(-1);
  if (!latest) {
    return "working";
  }

  if (latest.itemType === "webSearch") return "searching";
  if (latest.itemType === "reasoning") return "weaving";
  if (latest.itemType === "agentMessage") return "composing";
  if (latest.itemType === "todoList") return "shaping";
  if (
    latest.itemType === "commandExecution"
    || latest.itemType === "fileChange"
    || latest.itemType === "mcpToolCall"
  ) {
    return "working";
  }

  return PHASE_ORB_STATES[latest.phase] ?? "working";
}

export function AiThinkingOrb({
  events = [],
  state,
  label,
  className = "",
  decorative = false,
}: {
  events?: ReadonlyArray<ActivityEvent>;
  state?: OrbState;
  label?: string;
  className?: string;
  decorative?: boolean;
}) {
  const t = useT("ai");
  return (
    <ThinkingOrb
      state={state ?? resolveAiThinkingOrbState(events)}
      size={20}
      theme="light"
      className={`ai-thinking-orb ${className}`.trim()}
      aria-label={decorative ? undefined : label ?? t("activity.orbLabel")}
      aria-hidden={decorative || undefined}
    />
  );
}
