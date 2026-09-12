"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { SigmaDocument } from "@/features/document";
import type { AiProposalApplyOutcome } from "@/features/ai-edit/application/proposal-action-model";
import type { AiEditPreviewState } from "@/features/ai-edit/model/preview";
import { blockToReferenceText } from "@/lib/ai/ai-edit-reference";
import { collectOverlayShapeOutline, findBlock } from "@/lib/document-tree";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import { SigmaDocumentSchema } from "@/lib/sigma-doc-schema";
import { WEBMCP_HISTORY_LIMIT, type WebMcpHistoryEntry } from "../model/history";
import { WEBMCP_STATUS_EVENT, type WebMcpRegistrationState, type WebMcpUiStatus } from "../model/ui-status";
import {
  createSigmaWebMcpTools,
  getWebMcpAgentInstructionsStorageKey,
  initializeWebMcpHeavyFallbackCounter,
  WEBMCP_APPLICATION_GUIDANCE,
  type SigmaWebMcpPorts,
  type SigmaWebMcpProposal,
  type WebMcpToolDefinition,
} from "@/lib/webmcp-tools";

export { WEBMCP_STATUS_EVENT, type WebMcpRegistrationState, type WebMcpUiStatus } from "../model/ui-status";

interface WebMcpModelContext {
  registerTool(tool: WebMcpToolDefinition, options?: { signal?: AbortSignal }): Promise<void>;
  provideContext?(context: { instructions: string }): Promise<void> | void;
}
type WebMcpDocument = Document & { modelContext?: WebMcpModelContext };

const WEBMCP_CONTEXT_DISCOVERY_TIMEOUT_MS = 10_000;
const WEBMCP_CONTEXT_DISCOVERY_RETRY_MS = 100;

async function waitForWebMcpModelContext(signal: AbortSignal): Promise<WebMcpModelContext | null> {
  const deadline = Date.now() + WEBMCP_CONTEXT_DISCOVERY_TIMEOUT_MS;
  while (!signal.aborted) {
    const modelContext = (window.document as WebMcpDocument).modelContext;
    if (typeof modelContext?.registerTool === "function") return modelContext;
    if (Date.now() >= deadline) return null;
    await new Promise<void>((resolve) => window.setTimeout(resolve, WEBMCP_CONTEXT_DISCOVERY_RETRY_MS));
  }
  return null;
}

export interface WebMcpBridgeProps {
  enabled: boolean;
  instructionScopeId: string;
  commitDocumentChange(change: (current: SigmaDocument) => SigmaDocument): void;
  getDocument: SigmaWebMcpPorts["getDocument"];
  getRevision: SigmaWebMcpPorts["getRevision"];
  getSelectedBlockId: SigmaWebMcpPorts["getSelectedBlockId"];
  getSelection: NonNullable<SigmaWebMcpPorts["getSelection"]>;
  navigateToTarget(target: { kind: "block" | "shape"; id: string }): void;
  onPreviewGroupsChange(groups: AiEditPreviewState[]): void;
  /** 決着したドラフトの記録。ページを開いているあいだだけのメモリ保持で、
   * 左上のAIタスクdockに「適用済み / 破棄」の結果行として出る。 */
  onHistoryChange(entries: WebMcpHistoryEntry[]): void;
}
export interface WebMcpBridgeHandle {
  applyProposalIds(proposalIds: string[]): Promise<AiProposalApplyOutcome | null>;
  dismissProposalIds(proposalIds: string[]): boolean;
}
interface PendingDraft extends SigmaWebMcpProposal {
  createdAt: number;
  conflictTargetIds: string[];
}

function staleDraftTargetIds(error: unknown): string[] {
  const detail = error instanceof Error ? error.message : String(error);
  const targets = /Changed target\(s\): ([^.]+)\./.exec(detail)?.[1];
  return detail.startsWith("STALE_DRAFT:") && targets
    ? targets.split(",").map((target) => target.trim()).filter(Boolean)
    : ["document"];
}

function isStaleDraftError(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).startsWith("STALE_DRAFT:");
}

const CONFLICT_TARGET_EXCERPT_LENGTH = 20;

function conflictTargetExcerpt(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > CONFLICT_TARGET_EXCERPT_LENGTH
    ? `${normalized.slice(0, CONFLICT_TARGET_EXCERPT_LENGTH)}…`
    : normalized;
}

export function formatWebMcpConflictTargets(
  document: SigmaDocument,
  targetIds: readonly string[],
  tShape: Translate<"shape">,
): string {
  const shapeDescriptions = new Map(
    collectOverlayShapeOutline(document, tShape).map((shape) => [shape.id, shape.description]),
  );
  return targetIds.map((targetId) => {
    const block = findBlock(document, targetId);
    if (block) {
      return conflictTargetExcerpt(blockToReferenceText(block)) || block.type;
    }
    return shapeDescriptions.get(targetId) ?? targetId;
  }).join(", ");
}

function publishStatus(status: WebMcpUiStatus): void {
  (window as typeof window & { __sigmaWebMcpStatus?: WebMcpUiStatus }).__sigmaWebMcpStatus = status;
  window.dispatchEvent(new CustomEvent<WebMcpUiStatus>(WEBMCP_STATUS_EVENT, { detail: status }));
}

export const WebMcpBridge = forwardRef<WebMcpBridgeHandle, WebMcpBridgeProps>(function WebMcpBridge(props, ref) {
  const t = useT("editor");
  const tShape = useT("shape");
  const [proposal, setProposal] = useState<PendingDraft | null>(null);
  const [registration, setRegistration] = useState<{ state: WebMcpRegistrationState; toolCount: number; failedToolNames: string[] }>({ state: "loading", toolCount: 0, failedToolNames: [] });
  const [history, setHistory] = useState<WebMcpHistoryEntry[]>([]);
  const historyEntrySequenceRef = useRef(0);
  const { enabled, instructionScopeId, commitDocumentChange, getDocument, getRevision, getSelectedBlockId, getSelection, navigateToTarget, onPreviewGroupsChange, onHistoryChange } = props;
  const previewGroups = useMemo<AiEditPreviewState[]>(() => proposal ? [{ targetId: proposal.previewDraft.operations[0]?.targetId ?? proposal.targetId, draft: proposal.previewDraft, createdAt: proposal.createdAt, proposalIds: [proposal.id], baseRevision: proposal.baseRevision, providers: ["chatgpt"], sessionLabel: "WebMCP", lockTargets: false }] : [], [proposal]);
  const liveRevision = getRevision();
  const conflictTargets = proposal?.conflictTargetIds.length
    ? formatWebMcpConflictTargets(getDocument(), proposal.conflictTargetIds, tShape)
    : "";

  useEffect(() => { initializeWebMcpHeavyFallbackCounter(window as typeof window & { __sigmaWebMcpHeavyFallbackCount?: number }); }, []);
  useEffect(() => { onPreviewGroupsChange(previewGroups); return () => onPreviewGroupsChange([]); }, [onPreviewGroupsChange, previewGroups]);
  useEffect(() => { onHistoryChange(history); return () => onHistoryChange([]); }, [history, onHistoryChange]);
  useEffect(() => { publishStatus({ state: registration.state, registeredToolCount: registration.toolCount, failedToolNames: registration.failedToolNames, operationCount: proposal?.operationCount ?? 0, changedIds: [...(proposal?.targetIds ?? [])], conflictTargetIds: [...(proposal?.conflictTargetIds ?? [])], conflictTargets }); }, [conflictTargets, proposal, registration]);
  useEffect(() => { setProposal(null); }, [instructionScopeId]);
  useEffect(() => {
    setProposal((current) => {
      if (!current) return null;
      try {
        return { ...current.refresh(getDocument()), createdAt: current.createdAt, conflictTargetIds: [] };
      } catch (error) {
        if (!isStaleDraftError(error)) {
          console.error("WebMCP proposal preview refresh failed", error);
        }
        return { ...current, conflictTargetIds: staleDraftTargetIds(error) };
      }
    });
  }, [getDocument, liveRevision]);

  // コメントは本文を書き換えないので提案ドラフトへ積まず、その場で文書へ入れる。
  // `commitDocumentChange` は EditorShell 側で作り直されうるので ref 越しに呼ぶ
  // (依存に入れるとツール登録がやり直しになり、登録済みツールが一瞬消える)。
  const commitDocumentChangeRef = useRef(commitDocumentChange);
  useLayoutEffect(() => { commitDocumentChangeRef.current = commitDocumentChange; }, [commitDocumentChange]);
  const commitComments = useCallback((mutate: (current: SigmaDocument) => SigmaDocument) => {
    commitDocumentChangeRef.current(mutate);
  }, []);

  const proposeDocumentChange = useCallback((next: SigmaWebMcpProposal) => {
    setProposal((current) => ({ ...next, createdAt: current?.createdAt ?? Date.now(), conflictTargetIds: [] }));
    const blockId = next.blockIds[0];
    const shapeId = next.shapeIds[0];
    if (blockId) window.requestAnimationFrame(() => navigateToTarget({ kind: "block", id: blockId }));
    else if (shapeId) window.requestAnimationFrame(() => navigateToTarget({ kind: "shape", id: shapeId }));
  }, [navigateToTarget]);
  const withdrawDocumentChange = useCallback(() => setProposal(null), []);
  const recordHistory = useCallback((resolved: PendingDraft, status: WebMcpHistoryEntry["status"]) => {
    historyEntrySequenceRef.current += 1;
    setHistory((current) => [
      { entryId: `webmcp_history_${historyEntrySequenceRef.current}`, id: resolved.id, status, operationCount: resolved.operationCount, targetIds: [...resolved.targetIds], resolvedAt: Date.now() },
      ...current,
    ].slice(0, WEBMCP_HISTORY_LIMIT));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setRegistration({ state: "loading", toolCount: 0, failedToolNames: [] });
    void waitForWebMcpModelContext(controller.signal).then(async (modelContext) => {
      if (controller.signal.aborted) return;
      if (!modelContext) {
        setRegistration({ state: "unavailable", toolCount: 0, failedToolNames: [] });
        return;
      }
      const storageKey = getWebMcpAgentInstructionsStorageKey(instructionScopeId);
      const getAgentInstructions = () => window.localStorage.getItem(storageKey) ?? "";
      const tools = createSigmaWebMcpTools({ getDocument, getRevision, getSelectedBlockId, getSelection, getAgentInstructions, proposeDocumentChange, withdrawDocumentChange, commitComments });
      const results = await Promise.allSettled(tools.map(async (tool) => {
        // Keep this explicit: WebMCP clients and challenge review inspect the browser API directly.
        await modelContext.registerTool(tool, { signal: controller.signal });
        return tool.name;
      }));
      if (controller.signal.aborted) return;
      const failedToolNames = results.flatMap((result, index) => result.status === "rejected" ? [tools[index]!.name] : []);
      const toolCount = tools.length - failedToolNames.length;
      if (failedToolNames.length > 0) {
        console.error("WebMCP tool registration failed", results.filter((result) => result.status === "rejected"));
      }
      setRegistration({
        state: failedToolNames.length === 0 ? "connected" : toolCount > 0 ? "partial" : "failed",
        toolCount,
        failedToolNames,
      });
      if (typeof modelContext.provideContext === "function") {
        void Promise.resolve(modelContext.provideContext({ instructions: WEBMCP_APPLICATION_GUIDANCE })).catch((error) => {
          console.error("WebMCP application guidance registration failed", error);
        });
      }
    });
    return () => { controller.abort(); };
  }, [commitComments, enabled, getDocument, getRevision, getSelectedBlockId, getSelection, instructionScopeId, proposeDocumentChange, withdrawDocumentChange]);

  const applyProposalIds = useCallback(async (ids: string[]): Promise<AiProposalApplyOutcome | null> => {
    if (!proposal || !ids.includes(proposal.id)) return null;
    if (proposal.conflictTargetIds.length > 0) {
      return { ok: false, reason: t("webMcpProposal.applyConflict", { targets: conflictTargets }) };
    }
    try {
      const before = getDocument();
      commitDocumentChange((current) => SigmaDocumentSchema.parse(proposal.apply(current).document));
      if (getDocument() === before) {
        return { ok: false, reason: t("webMcpProposal.applyRejected") };
      }
      proposal.accept();
      recordHistory(proposal, "applied");
      setProposal(null);
      return { ok: true };
    } catch (error) {
      console.error("WebMCP proposal application failed", error);
      const detail = error instanceof Error ? error.message : String(error);
      const targets = formatWebMcpConflictTargets(getDocument(), staleDraftTargetIds(error), tShape);
      const message = detail.startsWith("STALE_DRAFT:")
        ? t("webMcpProposal.applyConflict", { targets: targets ?? "document" })
        : detail.startsWith("PREVIEW_STALE:")
          ? t("webMcpProposal.previewStale")
          : t("webMcpProposal.applyFailed");
      return { ok: false, reason: message };
    }
  }, [commitDocumentChange, conflictTargets, getDocument, proposal, recordHistory, t, tShape]);
  const dismissProposalIds = useCallback((ids: string[]): boolean => {
    if (!proposal || !ids.includes(proposal.id)) return false;
    proposal.dismiss();
    recordHistory(proposal, "rejected");
    setProposal(null);
    return true;
  }, [proposal, recordHistory]);
  useImperativeHandle(ref, () => ({ applyProposalIds, dismissProposalIds }), [applyProposalIds, dismissProposalIds]);

  if (!enabled) return null;
  return (
    <div className="webmcp-proposal-status" role="status" aria-live="polite">
      {proposal?.conflictTargetIds.length
        ? t("webMcpProposal.previewConflict", { targets: conflictTargets })
        : proposal
          ? t("webMcpProposal.pendingOperationsAnnouncement", { operations: proposal.operationCount })
          : t("webMcpProposal.noPendingAnnouncement")}
    </div>
  );
});
