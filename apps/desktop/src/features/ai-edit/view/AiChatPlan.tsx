"use client";
import { Check } from "lucide-react";
import { Shimmer } from "@/components/ui/Shimmer";
import { AiStreamRenderer } from "@/features/ai-edit/view";
import { type AiEditPlanStep } from "@/lib/ai/ai-edit-runtime";

export function AssistantPlanChecklist({
  steps,
  explanation,
}: {
  steps: AiEditPlanStep[];
  explanation: string | null;
}) {
  if (steps.length === 0) {
    return null;
  }

  return (
    <div className="ai-activity-plan">
      {explanation?.trim() && <p className="ai-activity-plan-explanation">{explanation.trim()}</p>}
      <ul className="ai-activity-plan-list">
        {steps.map((step, index) => (
          <li
            key={`${index}:${step.step}`}
            className="ai-activity-plan-item"
            data-status={step.status}
          >
            <span className="ai-activity-plan-icon">
              {step.status === "completed" ? (
                <Check size={12} />
              ) : step.status === "inProgress" ? (
                <Shimmer variant="marker" className="ai-activity-plan-icon-shimmer">…</Shimmer>
              ) : (
                <span aria-hidden="true">·</span>
              )}
            </span>
            <span className="ai-activity-plan-step">{step.step}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AiEditPlanList({ title, items, compact = false }: { title: string; items: string[]; compact?: boolean }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className={`ai-edit-plan-list ${compact ? "compact" : ""}`}>
      <div className="ai-edit-preview-title">{title}</div>
      <ol>
        {items.map((item, index) => (
          <li key={`${title}:${index}`}>
            <AiStreamRenderer className="ai-edit-plan-item-text" text={item} />
          </li>
        ))}
      </ol>
    </div>
  );
}

