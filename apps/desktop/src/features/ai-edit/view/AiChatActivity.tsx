"use client";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AiThinkingOrb } from "@/components/branding/AiThinkingOrb";
import { Shimmer } from "@/components/ui/Shimmer";
import { AiStreamRenderer } from "@/features/ai-edit/view";
import { formatAgentActivityLabel, summarizeRunningActivity } from "@/lib/ai/ai-agent-activity-label";
import { type AssistantTurn } from "@/lib/ai/ai-run-controller";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { type Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import { AssistantPlanChecklist } from "./AiChatPlan";
export function AssistantActivity({
  turn,
  clockNow,
  forceExpanded = false,
  headerAction = null,
}: {
  turn: AssistantTurn;
  clockNow: number;
  forceExpanded?: boolean;
  headerAction?: ReactNode;
}) {
  const t = useT("ai");
  const elapsedMs = Math.max(0, (turn.isRunning ? clockNow : turn.endedAt ?? clockNow) - turn.startedAt);
  const stateKey = `${turn.isRunning ? 1 : 0}|${turn.result ? 1 : 0}|${turn.error ? 1 : 0}`;
  const [override, setOverride] = useState<{ key: string; value: boolean } | null>(null);
  // MCP tool-result PNG previews (e.g. render_visual_edit_session) attached to
  // an activity row: click a thumbnail to see it full-size in a simple
  // click-to-toggle lightbox (no existing modal primitive to reuse here).
  const [zoomedImageUrl, setZoomedImageUrl] = useState<string | null>(null);
  const zoomRequest = useRef(0);
  const [imageLoadError, setImageLoadError] = useState(false);
  useEffect(() => () => { zoomRequest.current += 1; }, []);
  const openImage = async (image: { dataUrl: string; generatedImage?: { runId: string; imageId: string } }) => {
    const request = ++zoomRequest.current;
    setImageLoadError(false);
    setZoomedImageUrl(image.dataUrl);
    if (!image.generatedImage) return;
    try {
      const original = await getDesktopBridge()?.aiEdit.getGeneratedImage?.(image.generatedImage.runId, image.generatedImage.imageId);
      if (request !== zoomRequest.current) return;
      if (original?.dataUrl) setZoomedImageUrl(original.dataUrl);
      else setImageLoadError(true);
    } catch {
      if (request === zoomRequest.current) setImageLoadError(true);
    }
  };
  const closeImage = () => { zoomRequest.current += 1; setZoomedImageUrl(null); setImageLoadError(false); };
  const hasGeneratedImage = turn.events.some((event) => event.images?.some((image) => image.generatedImage));
  const expanded = forceExpanded || (override?.key === stateKey ? override.value : hasGeneratedImage);
  const toggle = () => setOverride({ key: stateKey, value: !expanded });

  const summary = useMemo(() => {
    if (turn.error) {
      return t("panel.stoppedWithError");
    }

    if (turn.isRunning) {
      return summarizeRunningActivity(turn.events, t);
    }

    const toolCount = turn.events.filter((event) => event.kind === "tool").length;
    const validationCount = turn.events.filter((event) => event.kind === "validation").length;
    const parts: string[] = [];
    if (toolCount > 0) parts.push(t("panel.toolRuns", { replace: { count: toolCount } }));
    if (validationCount > 0) parts.push(t("panel.validations", { replace: { count: validationCount } }));
    parts.push(formatDuration(elapsedMs, t));
    return parts.join(" · ");
  }, [turn.error, turn.isRunning, turn.events, elapsedMs, t]);

  return (
    <div
      className={`ai-activity${forceExpanded ? " ai-activity--popover" : ""}`.trim()}
      data-running={turn.isRunning}
      data-error={!!turn.error}
    >
      {forceExpanded ? (
        <div className="ai-activity-popover-head">
          {turn.isRunning && (
            <AiThinkingOrb events={turn.events} label={summary} decorative />
          )}
          <span className="ai-activity-chip-text">
            {turn.isRunning ? <Shimmer>{summary}</Shimmer> : summary}
          </span>
          {turn.isRunning && (
            <span className="ai-activity-time" aria-hidden="true">{formatDuration(elapsedMs, t)}</span>
          )}
          {headerAction && (
            <span className="ai-activity-popover-action">{headerAction}</span>
          )}
        </div>
      ) : (
        <button type="button" className="ai-activity-chip" onClick={toggle} aria-expanded={expanded}>
          {turn.isRunning && (
            <AiThinkingOrb events={turn.events} label={summary} decorative />
          )}
          <span className="ai-activity-chip-text">
            {turn.isRunning ? <Shimmer>{summary}</Shimmer> : summary}
          </span>
          {turn.isRunning && (
            <span className="ai-activity-time" aria-hidden="true">{formatDuration(elapsedMs, t)}</span>
          )}
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      )}

      {expanded && (
        <div className="ai-activity-body">
          {turn.reasoningText.trim() && (
            <p className="ai-activity-reasoning">{truncateLiveText(turn.reasoningText)}</p>
          )}
          <AssistantPlanChecklist steps={turn.planSteps} explanation={turn.planExplanation} />
          {turn.events.length > 0 ? (
            <ul className="ai-activity-list">
              {turn.events.map((event, index) => {
                const spinning =
                  turn.isRunning &&
                  (event.kind === "activity"
                    ? event.itemStatus !== "completed"
                    : index === turn.events.length - 1 && event.kind !== "error");
                return (
                  <li
                    key={event.id}
                    className="ai-activity-item"
                    data-kind={event.kind}
                    data-status={event.itemStatus}
                  >
                    <span className="ai-activity-item-icon">
                      {spinning ? (
                        <Shimmer variant="marker" className="ai-activity-item-shimmer">…</Shimmer>
                      ) : event.kind === "error" ? (
                        <X size={12} />
                      ) : (
                        <Check size={12} />
                      )}
                    </span>
                    <span className="ai-activity-item-message">{formatAgentActivityLabel(event, t)}</span>
                    {event.images && event.images.length > 0 && (
                      <div className="ai-activity-item-images">
                        {event.images.map((image, imageIndex) => (
                          <button
                            key={imageIndex}
                            type="button"
                            className="ai-activity-item-image-thumb"
                            onClick={() => { void openImage(image); }}
                            aria-label={t("panel.zoomPreview")}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={image.dataUrl} alt={t("panel.toolPreviewImage")} />
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="ai-activity-empty">{t("panel.noRunLog")}</p>
          )}
          {turn.streamText.trim() && (
            <AiStreamRenderer
              className="ai-activity-stream"
              text={truncateLiveText(turn.streamText)}
            />
          )}
        </div>
      )}
      {imageLoadError && <p role="status">{t("panel.generatedImageUnavailable")}</p>}
      {zoomedImageUrl && createPortal(
        <div
          className="ai-activity-image-lightbox"
          role="button"
          tabIndex={-1}
          aria-label={t("panel.closeZoom")}
          onClick={closeImage}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoomedImageUrl} alt={t("panel.zoomedPreview")} />
        </div>,
        document.body,
      )}
    </div>
  );
}

/** 経過時間。「3s」のような略記ではなく、表示言語の単位で出す(日本語なら「3秒」「1分4秒」)。 */
function formatDuration(milliseconds: number, t: Translate<"ai">): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? t("panel.durationMinutes", { replace: { minutes, seconds } })
    : t("panel.durationSeconds", { replace: { seconds } });
}

function truncateLiveText(text: string): string {
  const normalized = text.trim();
  return normalized.length > 1800 ? `...${normalized.slice(normalized.length - 1800)}` : normalized;
}

