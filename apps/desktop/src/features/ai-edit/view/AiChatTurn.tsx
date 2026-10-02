"use client";

import { AiEditPlanList } from "./AiChatPlan";
import { Check, Copy, File as FileIcon, FileText, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  dedupeAiSourceReferences,
  describeRevertBlockedReason,
  type AiAppliedTurnChange,
  type AiEditPreviewState,
} from "@/features/ai-edit/model/preview";
import { AiAppliedChangeCard, AiProposalActions } from "@/components/ui/ai";
import { IconButton } from "@/components/ui/Button";
import { Shimmer } from "@/components/ui/Shimmer";
import type { AiProposalApplyOutcome } from "@/features/ai-edit";
import {
  AiAppliedDocumentDiffView,
  AiSourceReferenceChips,
  AiStreamRenderer,
  type AiSourceReferenceOpenDocumentParams,
} from "@/features/ai-edit/view";
import { SELECTED_SHAPES_ATTACHMENT_PREFIX } from "@/lib/ai/ai-edit-attachment-names";
import { getAiEditReferenceKey, getReferenceDisplayLabel } from "@/lib/ai/ai-edit-reference";
import { type AiEditShapeOnlyPreview } from "@/lib/ai/ai-edit-shape-preview";
import { type AssistantTurn, type UserTurn } from "@/lib/ai/ai-run-controller";
import { deriveAppliedDraftFallback, type AiAppliedDocumentDiff } from "@/lib/ai/applied-document-diff";
import { useT } from "@/lib/i18n/react";
import type { DesktopAiSourceReference } from "@/types/desktop";
import { buildStoredOverlaySelectionPreview, isImageAttachment } from "../application/ai-chat-attachments";
import { UserAttachmentImage, UserOverlaySelectionImage } from "./AiChatPreviewImages";
import { AssistantActivity } from "./AiChatActivity";
export function UserTurnView({
  turn,
  turnRef,
  onResend,
}: {
  turn: UserTurn;
  turnRef?: (element: HTMLDivElement | null) => void;
  onResend?: (turn: UserTurn) => void;
}) {
  const t = useT("ai");
  const tEditor = useT("editor");
  const hasMeta = turn.references.length > 0 || turn.attachments.length > 0 || turn.mentionedDocuments.length > 0;
  const storedOverlayPreviews = useMemo(() => {
    const previewAttachments = turn.attachments.filter((attachment) => (
      attachment.dataUrl && attachment.name.startsWith(SELECTED_SHAPES_ATTACHMENT_PREFIX)
    ));
    const keyedAttachmentReferences = new Set(previewAttachments.flatMap((attachment) => (
      attachment.sourceReferenceKey ? [attachment.sourceReferenceKey] : []
    )));
    const legacyPreviewCount = previewAttachments.filter((attachment) => !attachment.sourceReferenceKey).length;
    const referencesWithoutKeyedPng = turn.references.filter((turnReference) => (
      turnReference.overlaySelection
      && !keyedAttachmentReferences.has(getAiEditReferenceKey(turnReference))
    ));

    return referencesWithoutKeyedPng.slice(legacyPreviewCount).flatMap((turnReference) => {
        const turnReferenceKey = getAiEditReferenceKey(turnReference);
        // sourceReferenceKey導入前のPNGは参照との対応を持たない。旧履歴では参照順と
        // 添付順が一致していたため、未対応PNGを先頭の図形参照から1件ずつ消費する。
        const preview = buildStoredOverlaySelectionPreview(turnReference.overlaySelection!);
        return preview
          ? [{
            key: turnReferenceKey,
            preview,
            shapeCount: turnReference.overlaySelection!.shapes.length,
          }]
          : [];
      });
  }, [turn.attachments, turn.references]);
  const fallbackText = turn.attachments.length > 0
    ? t("chat.attachmentsOnly")
    : turn.mentionedDocuments.length > 0
      ? t("chat.mentionsOnly")
      : "";
  return (
    <div className="ai-chat-turn user" ref={turnRef}>
      <div className="ai-chat-user-bubble">
        {turn.queued && (
          <span className="ai-chat-queued-pill" role="status">{t("chat.queued")}</span>
        )}
        {turn.queueFailed && (
          <span className="ai-chat-queued-pill ai-chat-queued-pill--failed" role="status">
            <span>{t("chat.unsent")}</span>
            {onResend && (
              <button type="button" className="ai-chat-queued-resend" onClick={() => onResend(turn)}>
                {t("chat.resend")}
              </button>
            )}
          </span>
        )}
        {hasMeta && (
          <div className="ai-chat-user-meta">
            {turn.references.map((turnReference) => (
              <span
                key={getAiEditReferenceKey(turnReference)}
                className="ai-chat-user-ref"
                data-reference-kind={turnReference.kind}
              >
                @{getReferenceDisplayLabel(turnReference, t, tEditor)}
              </span>
            ))}
            {turn.references.some((turnReference) => turnReference.overlaySelection) && (
              <span className="ai-chat-user-ref" data-reference-kind="overlay">
                {t("reference.shapeCount", { replace: {
                  count: turn.references.reduce((count, turnReference) => count + (turnReference.overlaySelection?.shapes.length ?? 0), 0),
                } })}
              </span>
            )}
            {turn.attachments.map((attachment) => (
              isImageAttachment(attachment)
                ? null
                : (
                  <span key={attachment.id} className="ai-chat-user-ref">
                    <FileIcon size={11} />
                    {attachment.name}
                  </span>
                )
            ))}
            {turn.mentionedDocuments.map((item) => (
              <span key={item.id} className="ai-chat-user-ref">
                <FileText size={11} />
                {item.title}
              </span>
            ))}
          </div>
        )}
        {(turn.attachments.some(isImageAttachment) || storedOverlayPreviews.length > 0) && (
          <div className="ai-chat-user-attachments" aria-label={t("attachment.image")}>
            {turn.attachments.map((attachment) => (
              isImageAttachment(attachment)
                ? <UserAttachmentImage key={attachment.id} attachment={attachment} />
                : null
            ))}
            {storedOverlayPreviews.map((storedOverlayPreview) => (
              <UserOverlaySelectionImage
                key={storedOverlayPreview.key}
                preview={storedOverlayPreview.preview}
                shapeCount={storedOverlayPreview.shapeCount}
              />
            ))}
          </div>
        )}
        <AiStreamRenderer className="ai-chat-user-text" text={turn.instruction || fallbackText} />
      </div>
    </div>
  );
}

/** インライン会話とサイドバーで共通の承認・破棄操作。 */
export function AiTurnProposalActions({
  proposal,
  proposalBusy,
  onApplyProposal,
  onDismissProposal,
}: {
  proposal: AiEditPreviewState;
  proposalBusy: boolean;
  onApplyProposal?: (proposalIds: string[]) => Promise<AiProposalApplyOutcome>;
  onDismissProposal?: (proposalIds: string[]) => void;
}) {
  const t = useT("ai");
  const [applyError, setApplyError] = useState<string | null>(null);
  const runApply = async () => {
    if (!onApplyProposal || !proposal) {
      return;
    }
    setApplyError(null);
    try {
      const result = await onApplyProposal(proposal.proposalIds);
      if (!result.ok) {
        setApplyError(result.reason);
      }
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : t("card.applyFailed"));
    }
  };

  return (
    <>
      <AiProposalActions
        applying={proposalBusy}
        className="ai-chat-result-proposal-actions"
        actionClassName="ai-chat-result-proposal-action"
        showDismiss={Boolean(onDismissProposal)}
        showApply={Boolean(onApplyProposal)}
        onDismiss={onDismissProposal ? () => onDismissProposal(proposal.proposalIds) : undefined}
        onApply={onApplyProposal ? () => void runApply() : undefined}
      />
      {applyError && <p className="ai-chat-error">{applyError}</p>}
    </>
  );
}

/** AIの返答、成果物、提案判断、適用後の状態を一つの時系列項目として表示する。 */
export function AssistantTurnView({
  turn,
  clockNow,
  sourceReferences,
  shapePreview,
  appliedChange,
  onRevertAppliedChange,
  onOpenSourceDocument,
  restorable,
  onRestoreProposal,
  proposal,
  proposalDiff,
  proposalBusy = false,
  onApplyProposal,
  onDismissProposal,
}: {
  turn: AssistantTurn;
  clockNow: number;
  /** Phase 1: Agentic RAG. Already deduped by the caller (EditorShell); this
   * view dedupes again defensively since it's cheap and the invariant isn't
   * guaranteed across all future callers. */
  sourceReferences?: DesktopAiSourceReference[];
  shapePreview?: AiEditShapeOnlyPreview;
  appliedChange?: AiAppliedTurnChange;
  onRevertAppliedChange?: (proposalIds: string[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onOpenSourceDocument?: (params: AiSourceReferenceOpenDocumentParams) => void;
  /** Set only when this turn's latest proposal ended up rejected/reverted, i.e.
   * can be revived with a single click (see buildRestorableProposalsByTurnId). */
  restorable?: { proposalIds: string[] };
  onRestoreProposal?: (proposalIds: string | string[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
  proposal?: AiEditPreviewState | null;
  /** 承認前に「適用したら何が消えて何が足されるか」を同じGitHub風差分表示で見せるための
   * pending diff (see derivePendingDocumentDiff)。まだ承認されていないので、これが実際の
   * 適用後差分と一致する保証はない(人手の編集やAIの後続提案で状況が変わりうる)。 */
  proposalDiff?: AiAppliedDocumentDiff;
  proposalBusy?: boolean;
  onApplyProposal?: (proposalIds: string[]) => Promise<AiProposalApplyOutcome>;
  onDismissProposal?: (proposalIds: string[]) => void;
}) {
  const t = useT("ai");
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const fallbackAppliedDiff = useMemo(
    () => deriveAppliedDraftFallback(turn.result ? [turn.result.draft] : []),
    [turn.result],
  );

  const runRestore = async () => {
    if (!onRestoreProposal || !restorable) {
      return;
    }
    setRestoring(true);
    setRestoreError(null);
    try {
      const result = await onRestoreProposal(restorable.proposalIds);
      if (!result.ok) {
        setRestoreError(result.reason);
      }
    } finally {
      setRestoring(false);
    }
  };

  const runRevert = async () => {
    if (!onRevertAppliedChange || !appliedChange?.canRevert || appliedChange.revertProposalIds.length === 0) {
      return;
    }
    setReverting(true);
    setRevertError(null);
    try {
      const result = await onRevertAppliedChange(appliedChange.revertProposalIds);
      if (!result.ok) {
        setRevertError(result.reason);
      }
    } catch (error) {
      setRevertError(error instanceof Error ? error.message : t("panel.revertFailed"));
    } finally {
      setReverting(false);
    }
  };

  const showAppliedChange = Boolean(appliedChange || (turn.applied && !restorable));

  return (
    <div className="ai-chat-turn assistant">
      <AssistantActivity turn={turn} clockNow={clockNow} />

      {turn.error && <p className="ai-chat-error">{turn.error}</p>}

      {turn.result && (
        <div className="ai-chat-result">
          <AiStreamRenderer className="ai-chat-assistant-text" text={turn.result.draft.summary} />
          {turn.result.draft.summary.trim().length > 0 && (
            <div className="ai-chat-result-tools">
              <AiCopyTextButton text={turn.result.draft.summary} />
            </div>
          )}

          {proposal && (onApplyProposal || onDismissProposal) && (
            <div className="ai-chat-result-proposal" aria-label={t("panel.proposalActionsAria")}>
              {proposalDiff && (proposalDiff.body.length > 0 || proposalDiff.shapes.length > 0) && (
                <div className="ai-chat-result-proposal-diff" aria-label={t("card.proposedChanges")}>
                  <p className="ai-chat-result-proposal-diff-heading">{t("card.proposedChanges")}</p>
                  <AiAppliedDocumentDiffView diff={proposalDiff} />
                </div>
              )}
              <AiTurnProposalActions
                proposal={proposal}
                proposalBusy={proposalBusy}
                onApplyProposal={onApplyProposal}
                onDismissProposal={onDismissProposal}
              />
            </div>
          )}

          {!proposal && !showAppliedChange && (
            <AiChatShapeArtifact
              preview={shapePreview}
              outcome={restorable && turn.applied
                ? "reverted"
                : turn.applied
                  ? "applied"
                  : turn.dismissed
                    ? "dismissed"
                    : "pending"}
            />
          )}

          {turn.result.draft.plan.length > 0 && (
            <AiEditPlanList title={t("panel.plan")} items={turn.result.draft.plan} />
          )}
          {turn.result.draft.warnings.length > 0 && (
            <AiEditPlanList title={t("panel.warnings")} items={turn.result.draft.warnings} />
          )}
          {(turn.result.questions?.length ?? 0) > 0 && (
            <AiEditPlanList title={t("panel.checks")} items={turn.result.questions ?? []} />
          )}
          {/* appliedChange が無い間 (提案の読み込み前 / 適用済みの記録が残っていない turn) は
              取り消し可否そのものが不明なので、無効なボタンも理由も出さない — 「戻せません」と
              言い切ると、実際には戻せる turn について嘘になる。 */}
          {showAppliedChange && (
            <AiAppliedChangeCard
              autoApplied={appliedChange?.autoApplied}
              canRevert={Boolean(appliedChange?.canRevert && onRevertAppliedChange)}
              reverting={reverting}
              revertBlockedReason={appliedChange
                ? describeRevertBlockedReason(appliedChange.revertBlockedReason, t)
                : undefined}
              onRevert={onRevertAppliedChange && appliedChange ? () => void runRevert() : undefined}
            >
              <AiAppliedDocumentDiffView diff={appliedChange?.diff ?? fallbackAppliedDiff} />
            </AiAppliedChangeCard>
          )}
          {sourceReferences && sourceReferences.length > 0 && (
            <AiSourceReferenceChips
              sourceReferences={dedupeAiSourceReferences(sourceReferences)}
              onOpenDocument={onOpenSourceDocument}
            />
          )}
          {revertError && <p className="ai-chat-error">{revertError}</p>}
          {(restorable || turn.dismissed || turn.restored) && (
            <div className="ai-chat-result-status">
              {restorable && turn.applied ? (
                <span>{t("panel.reverted")}</span>
              ) : turn.dismissed ? (
                <span>{t("panel.discarded")}</span>
              ) : turn.restored ? (
                <span>{t("chat.history")}</span>
              ) : null}
              {restorable && onRestoreProposal && (
                <button
                  type="button"
                  className="ai-chat-result-restore"
                  disabled={restoring}
                  onClick={() => void runRestore()}
                  title={t("panel.restoreTooltip")}
                >
                  <RotateCcw size={12} />
                  {restoring ? <Shimmer>{t("panel.restoring")}</Shimmer> : t("panel.restore")}
                </button>
              )}
            </div>
          )}
          {restoreError && <p className="ai-chat-error">{restoreError}</p>}
        </div>
      )}
    </div>
  );
}

/** 返答の文章をクリップボードへ写す。ふだんは目立たず、返答にカーソルを置いたときだけ現れる。 */
function AiCopyTextButton({ text }: { text: string }) {
  const t = useT("ai");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      className="ai-chat-copy-button"
      label={copied ? t("chat.copied") : t("chat.copyReply")}
      tone="ghost"
      size="sm"
      data-copied={copied}
      onClick={() => {
        // クリップボードが使えない環境では何も起こさない(コピー済みの表示も出さない)。
        void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined);
      }}
    >
      {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.75} />}
    </IconButton>
  );
}

export function AiChatShapeArtifact({
  preview,
  outcome,
}: {
  preview?: AiEditShapeOnlyPreview;
  outcome: "pending" | "applied" | "dismissed" | "reverted";
}) {
  const t = useT("ai");
  if (!preview) {
    return null;
  }
  const label = outcome === "applied"
    ? t("panel.insertedShapes")
    : outcome === "reverted"
      ? t("panel.revertedShapes")
    : outcome === "dismissed"
      ? t("panel.discardedShapes")
      : t("panel.shapesToInsert");
  return (
    <figure className="ai-chat-shape-artifact" data-outcome={outcome}>
      <div
        className="ai-chat-shape-artifact-stage"
        role="img"
        aria-label={label}
        dangerouslySetInnerHTML={{ __html: preview.svg }}
      />
      <figcaption>{label}</figcaption>
    </figure>
  );
}

