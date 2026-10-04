"use client";
import { PanelRight, X } from "lucide-react";
import { createPortal } from "react-dom";
import { renderProviderMark } from "@/components/branding/provider-logos";
import { type AiEditPreviewState } from "@/features/ai-edit/model/preview";
import { AiStreamRenderer } from "@/features/ai-edit/view";
import { type AssistantTurn } from "@/lib/ai/ai-run-controller";
import { useT } from "@/lib/i18n/react";
import { AiTurnProposalDecision, AiTurnShapeContent } from "@/features/ai-edit/view/AiChatTurn";
import { AssistantActivity } from "@/features/ai-edit/view/AiChatActivity";
import { AiEditPlanList } from "@/features/ai-edit/view/AiChatPlan";
import type { AiEditPanelProps } from "@/features/ai-edit/application/ai-chat-panel-contracts";
import type { ReactNode } from "react";
import type { AiProvider } from "@/lib/ai/ai-providers";
import type { ChatTurn } from "@/lib/ai/ai-run-controller";
export interface AiChatInlineSurfaceProps {
 surface: Pick<AiEditPanelProps, "inlineOpen" | "inlineAnchor" | "inlineRunAnchor" | "inlineRunAnchorCanvas" | "inlineRunPortalTarget" | "onPromoteToSidebar" | "onCloseInline">;
 conversation: {provider: AiProvider; lockedProvider: AiProvider | null; visibleTurns: ChatTurn[]; latestAssistant: AssistantTurn | null; activeRoomId: string | null; inlineRunTurnId: string | null; inlineBaselineTurnId: string | null; isRunning: boolean; clockNow: number};
 proposals: Pick<AiEditPanelProps, "previewGroups" | "busy" | "onApplyGroup" | "onDismissGroup" | "insertedShapePreviewsByTurnId"> & {activeRoomPreview: AiEditPreviewState | null};
 composer: ReactNode;
 composerError: string | null;
 hasOpenMenu: boolean;
 retryTurn: (turnId: string) => void;
 dismissTurn: (turnId: string) => void;
}
export function AiChatInlineSurface({surface,conversation,proposals,composer,composerError,hasOpenMenu,retryTurn,dismissTurn}: AiChatInlineSurfaceProps) {
 const t=useT("ai");const tCommon=useT("common");
 const {inlineOpen=false,inlineAnchor=null,inlineRunAnchor=null,inlineRunAnchorCanvas=null,inlineRunPortalTarget=null,onPromoteToSidebar,onCloseInline}=surface;
 const {provider,lockedProvider,visibleTurns,latestAssistant,activeRoomId,inlineRunTurnId,inlineBaselineTurnId,isRunning,clockNow}=conversation;
 const latestAssistantId=latestAssistant?.id??null;
 const {previewGroups=[],busy=false,onApplyGroup,onDismissGroup,insertedShapePreviewsByTurnId,activeRoomPreview}=proposals;
    const inlineProvider = lockedProvider ?? provider;
    const activeRunTurnId = inlineRunAnchor ? inlineRunTurnId : null;
    const runTurn = activeRunTurnId
      ? visibleTurns.find((turn): turn is AssistantTurn => turn.id === activeRunTurnId && turn.role === "assistant")
      : undefined;
    const anchorsMatch = !!(
      inlineAnchor &&
      inlineRunAnchor &&
      inlineAnchor.left === inlineRunAnchor.left &&
      inlineAnchor.top === inlineRunAnchor.top
    );
    const runTurnDetached = !!inlineRunAnchor && (!inlineOpen || !anchorsMatch);
    const runTurnWorking = !!(
      runTurn && (runTurn.isRunning || (runTurn.id === activeRunTurnId && isRunning))
    );
    const runTurnPending = !!(
      runTurn && (
        (runTurn.result && !runTurn.applied && !runTurn.dismissed)
        || (runTurn.error && !runTurn.dismissed)
      )
    );
    const runTurnActive = runTurnWorking || runTurnPending;
    const pinnedRunTurn = runTurn
      && (
        (runTurn.result && !runTurn.applied && !runTurn.dismissed)
        || (runTurn.error && !runTurn.dismissed)
      )
      ? runTurn
      : null;
    const inlineResultTurn = pinnedRunTurn && runTurnDetached
      ? null
      : pinnedRunTurn ?? (latestAssistant && latestAssistant.id !== inlineBaselineTurnId
        ? latestAssistant
        : null);
    const runningTurn = runTurnWorking ? runTurn : (latestAssistant?.isRunning ? latestAssistant : null);
    const hasInlineResult = !!(inlineResultTurn?.result && !inlineResultTurn.applied && !inlineResultTurn.dismissed);
    const inlineErrorShown = !!(inlineResultTurn?.error && !inlineResultTurn.dismissed);
    const isWorking = isRunning || !!runningTurn?.isRunning;

    const renderInlineProposalActions = (turn: AssistantTurn) => {
      const proposal = previewGroups.find((preview) => (
        preview.roomId === activeRoomId && preview.turnId === turn.id
      )) ?? (turn.id === latestAssistantId && !activeRoomPreview?.turnId ? activeRoomPreview : null);
      if (!proposal || turn.applied || turn.dismissed) return null;
      // 内容は紙面のカード (またはこの上の図形のサムネ) が見せているので、ここはバーだけ。
      return (
        <AiTurnProposalDecision
          key={proposal.proposalIds.join(",")}
          proposal={proposal}
          surface="inline"
          proposalBusy={busy}
          onApplyProposal={onApplyGroup}
          onDismissProposal={onDismissGroup}
        />
      );
    };

    const renderInlineResultControls = (turnId: string) => (
      <div className="ai-inline-result-actions" aria-label={t("panel.resultActionsAria")}>
        {onPromoteToSidebar && (
          <button
            type="button"
            className="ai-inline-card-icon"
            title={t("run.openInSideChat")}
            aria-label={t("run.openInSideChat")}
            onClick={onPromoteToSidebar}
          >
            <PanelRight size={15} />
          </button>
        )}
        <button
          type="button"
          className="ai-inline-card-icon"
          title={tCommon("actions.close")}
          aria-label={tCommon("actions.close")}
          onClick={() => {
            dismissTurn(turnId);
            onCloseInline?.();
          }}
        >
          <X size={15} />
        </button>
      </div>
    );

    const renderInlineRunSurface = (turn: AssistantTurn) => {
      const runTurnWorking = turn.isRunning || (turn.id === activeRunTurnId && isRunning);
      // R2: the shimmering "AI is working" badge that used to render here (fixed
      // at the frozen `inlineRunAnchorCanvas` position) has been retired in favor
      // of `AiRunAnchorLayer`, which anchors a per-session widget to the actual
      // target block and follows reflow/scroll. Nothing renders for the
      // in-progress state here anymore — only the settled result/error surfaces
      // below remain, so there is exactly one "AI is working" indicator on screen.
      if (runTurnWorking) {
        return null;
      }

      if (turn.result && !turn.applied && !turn.dismissed) {
        return (
          <div className="ai-edit-panel ai-inline-edit" data-variant="inline">
            <div className="ai-inline-result">
              {renderInlineResultControls(turn.id)}
              <div className="ai-inline-result-head">
                <span className="ai-inline-logo" aria-hidden="true">{renderProviderMark(inlineProvider, { size: 15 })}</span>
                <AiStreamRenderer className="ai-inline-summary" text={turn.result.draft.summary} />
              </div>
              {insertedShapePreviewsByTurnId?.get(turn.id) && (
                <AiTurnShapeContent
                  content={insertedShapePreviewsByTurnId.get(turn.id)!}
                  outcome={turn.applied ? "applied" : turn.dismissed ? "dismissed" : "pending"}
                />
              )}
              {turn.events.some((event) => event.images?.some((image) => image.generatedImage)) && (
                <AssistantActivity turn={turn} clockNow={clockNow} />
              )}
              {renderInlineProposalActions(turn)}
              {turn.result.draft.warnings.length > 0 && (
                <AiEditPlanList title={t("panel.warnings")} items={turn.result.draft.warnings} compact />
              )}
            </div>
          </div>
        );
      }

      if (turn.error && !turn.dismissed) {
        return (
          <div className="ai-edit-panel ai-inline-edit" data-variant="inline">
            <div className="ai-inline-error-row">
              <span className="ai-inline-logo" aria-hidden="true">{renderProviderMark(inlineProvider, { size: 15 })}</span>
              <span className="ai-chat-error">{turn.error}</span>
              <button type="button" className="button" onClick={() => retryTurn(turn.id)}>
                <span>{tCommon("actions.retry")}</span>
              </button>
            </div>
          </div>
        );
      }

      return null;
    };

    // Keep the running surface attached to the page canvas, so scroll/zoom changes
    // move it with the document position where the run started.
    const shouldRenderRunPortal = !!(
      runTurn &&
      inlineRunAnchorCanvas &&
      inlineRunPortalTarget &&
      (runTurnWorking || (runTurnDetached && runTurnActive))
    );
    const runPortal = shouldRenderRunPortal && runTurn && inlineRunAnchorCanvas && inlineRunPortalTarget
      ? createPortal(
          <div
            className="ai-inline-run-overlay"
            style={{
              left: `${Math.max(0, inlineRunAnchorCanvas.left)}px`,
              top: `${Math.max(0, inlineRunAnchorCanvas.top)}px`,
            }}
          >
            {renderInlineRunSurface(runTurn)}
          </div>,
          inlineRunPortalTarget,
        )
      : null;

    if (!inlineOpen) {
      const detachedSurface = runTurn && runTurnActive ? renderInlineRunSurface(runTurn) : null;
      if (runPortal) {
        return <>{runPortal}</>;
      }
      if (detachedSurface) {
        return <>{detachedSurface}</>;
      }
      return null;
    }

    if (isWorking) {
      if (runPortal) {
        return <>{runPortal}</>;
      }
      if (runningTurn) {
        return <>{renderInlineRunSurface(runningTurn)}</>;
      }
    }

    const showInlineComposer = !hasInlineResult && !inlineErrorShown;

    return (
      <>
        {runPortal}
        <div
          className={`ai-edit-panel ai-inline-edit ai-inline-edit--enter ${showInlineComposer ? "ai-inline-edit--bare" : ""}`.trim()}
          data-variant="inline"
          onKeyDown={(event) => {
            if (
              event.key === "Escape" &&
              !hasOpenMenu
            ) {
              onCloseInline?.();
            }
          }}
        >
          {hasInlineResult && inlineResultTurn ? (
            <div className="ai-inline-result">
              {renderInlineResultControls(inlineResultTurn.id)}
              <div className="ai-inline-result-head">
                <span className="ai-inline-logo" aria-hidden="true">{renderProviderMark(inlineProvider, { size: 15 })}</span>
                <AiStreamRenderer className="ai-inline-summary" text={inlineResultTurn.result!.draft.summary} />
              </div>
              {insertedShapePreviewsByTurnId?.get(inlineResultTurn.id) && (
                <AiTurnShapeContent
                  content={insertedShapePreviewsByTurnId.get(inlineResultTurn.id)!}
                  outcome={inlineResultTurn.applied ? "applied" : inlineResultTurn.dismissed ? "dismissed" : "pending"}
                />
              )}
              {inlineResultTurn.events.some((event) => event.images?.some((image) => image.generatedImage)) && (
                <AssistantActivity turn={inlineResultTurn} clockNow={clockNow} />
              )}
              {renderInlineProposalActions(inlineResultTurn)}
              {inlineResultTurn.result!.draft.warnings.length > 0 && (
                <AiEditPlanList title={t("panel.warnings")} items={inlineResultTurn.result!.draft.warnings} compact />
              )}
            </div>
          ) : inlineErrorShown && inlineResultTurn ? (
            <div className="ai-inline-error-row">
              <span className="ai-inline-logo" aria-hidden="true">{renderProviderMark(inlineProvider, { size: 15 })}</span>
              <span className="ai-chat-error">{inlineResultTurn.error}</span>
              <button type="button" className="button" onClick={() => retryTurn(inlineResultTurn.id)}>
                <span>{tCommon("actions.retry")}</span>
              </button>
            </div>
          ) : (
            composer
          )}
          {composerError && <p className="ai-chat-error ai-inline-message">{composerError}</p>}
        </div>
      </>
    );
}
