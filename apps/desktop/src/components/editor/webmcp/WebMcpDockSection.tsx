"use client";

import { CircleAlert, CircleCheck, CircleHelp, LoaderCircle } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { WEBMCP_STATUS_EVENT, type WebMcpUiStatus } from "@/features/webmcp/model/ui-status";
import { getWebMcpAgentInstructionsStorageKey } from "@/lib/webmcp-tools";
import { useT } from "@/lib/i18n/react";

const EMPTY_STATUS: WebMcpUiStatus = { state: "loading", registeredToolCount: 0, failedToolNames: [], operationCount: 0, changedIds: [], conflictTargetIds: [], conflictTargets: "" };

/**
 * Web版のAI面はキャンバス左上の `AiTaskDock` 1箇所に集約している。ここはその中の
 * 「エージェントとの接続状態」と「エージェントへの自由記述指示」だけを担当する
 * (旧: 右上の独自カードと、右サイドのWeb用AIパネル)。
 *
 * 指示は教材IDごとの設定データとしてlocalStorageに置き、`get_agent_instructions`
 * からだけ読める。ambient contextへは混ぜない (docs/webmcp.md)。
 */
export function WebMcpDockSection({ instructionScopeId, onDismissProposal }: { instructionScopeId: string; onDismissProposal(): void }) {
  const t = useT("ai");
  const tEditor = useT("editor");
  const instructionsId = useId();
  const storageKey = getWebMcpAgentInstructionsStorageKey(instructionScopeId);
  const [instructions, setInstructions] = useState(() => typeof window === "undefined" ? "" : window.localStorage.getItem(storageKey) ?? "");
  const [status, setStatus] = useState<WebMcpUiStatus>(() => typeof window === "undefined" ? EMPTY_STATUS : (window as typeof window & { __sigmaWebMcpStatus?: WebMcpUiStatus }).__sigmaWebMcpStatus ?? EMPTY_STATUS);

  useEffect(() => {
    const receiveStatus = (event: Event) => setStatus((event as CustomEvent<WebMcpUiStatus>).detail);
    window.addEventListener(WEBMCP_STATUS_EVENT, receiveStatus);
    return () => window.removeEventListener(WEBMCP_STATUS_EVENT, receiveStatus);
  }, []);

  const saveInstructions = (value: string) => {
    setInstructions(value);
    window.localStorage.setItem(storageKey, value);
  };

  const connectionStatus = (() => {
    switch (status.state) {
      case "loading": return { icon: <LoaderCircle size={13} aria-hidden="true" />, text: t("webPlaceholder.loading") };
      case "connected": return { icon: <CircleCheck size={13} aria-hidden="true" />, text: t("webPlaceholder.connected", { tools: status.registeredToolCount }) };
      case "partial": return { icon: <CircleAlert size={13} aria-hidden="true" />, text: t("webPlaceholder.partial", { tools: status.registeredToolCount, failedTools: status.failedToolNames.join(", ") }) };
      case "failed": return { icon: <CircleAlert size={13} aria-hidden="true" />, text: t("webPlaceholder.failed", { failedTools: status.failedToolNames.join(", ") }) };
      case "unavailable": return { icon: <CircleHelp size={13} aria-hidden="true" />, text: t("webPlaceholder.unavailable") };
    }
  })();

  return (
    <section className="ai-task-dock-webmcp">
      <p className="ai-task-dock-webmcp-status" role="status" data-state={status.state}>
        {connectionStatus.icon}
        <span>{connectionStatus.text}</span>
      </p>
      {status.conflictTargetIds.length > 0 && (
        <div className="ai-task-dock-webmcp-conflict" role="status">
          <CircleAlert size={13} aria-hidden="true" />
          <span>{tEditor("webMcpProposal.previewConflict", { targets: status.conflictTargets })}</span>
          <button type="button" className="ai-task-dock-action" onClick={() => onDismissProposal()}>
            {tEditor("webMcpProposal.discardDraft")}
          </button>
        </div>
      )}
      {status.state === "unavailable" && <p className="ai-task-dock-webmcp-note">{t("webPlaceholder.enableSteps")}</p>}
      <h3 id={`${instructionsId}-title`} className="ai-task-dock-webmcp-title">{t("webPlaceholder.instructionsTitle")}</h3>
      <textarea
        id={instructionsId}
        className="ai-task-dock-webmcp-input"
        aria-label={t("webPlaceholder.instructionsDescription")}
        value={instructions}
        onChange={(event) => saveInstructions(event.target.value)}
        placeholder={t("webPlaceholder.instructionsPlaceholder")}
        rows={4}
      />
      <p className="ai-task-dock-webmcp-note">{t("webPlaceholder.savedLocally")}</p>
    </section>
  );
}
