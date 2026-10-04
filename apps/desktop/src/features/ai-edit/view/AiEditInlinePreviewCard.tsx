"use client";

import { X } from "lucide-react";
import { useState } from "react";
import type { CSSProperties } from "react";

import { AiProposalActions } from "@/components/ui/ai";
import type { MathFractionSizing } from "@/features/document";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import type { SigmaDocMutationOp } from "@/lib/ai/sigma-doc-edit-schema";
import type { DesktopAiSourceReference } from "@/types/desktop";
import {
  formatAiProposalProviderLabel,
  type AiEditPreviewState,
  type McpEditProposalProvider,
} from "../model/preview";
import type { AiProposalContent, AiProposalOperationKind } from "../model/proposal-content";
import type { AiProposalApplyOutcome } from "../application/proposal-action-model";
import { AiProposalContentView } from "./AiProposalContentView";
import {
  AiSourceReferenceChips,
  type AiSourceReferenceOpenDocumentParams,
} from "./AiSourceReferenceChips";

/** Splits an overlay widget's compact change list into visible rows and remainder. */
function splitChangeSummaryLines(lines: string[], maxLines: number): { shown: string[]; moreCount: number } {
  if (lines.length <= maxLines) {
    return { shown: lines, moreCount: 0 };
  }
  return { shown: lines.slice(0, maxLines), moreCount: lines.length - maxLines };
}

/**
 * `t` を省略したときの解決器。**呼び出し時点の表示言語**で引く。
 * 固定ロケールにすると渡し忘れが静かに日本語で出るバグになるため (WI-7 で実測)。
 * `window` の無い環境では既定ロケール (日本語) に落ちるので既存の期待値は不変。
 */
const DEFAULT_AI_TRANSLATE = createCurrentLocaleTranslator("ai");

/**
 * 提案カードの見出しの id。**文言ではない。**
 *
 * 見出しは「並んだ操作が全部同じ種類か」を Set で数えて決める。以前はここが訳文
 * だったので、**訳語がたまたま一致した 2 種類が 1 種類に見える**作りだった。
 * id で数えて、文にするのは最後だけにする。文言は `ai.card.title.<id>`。
 */
export const AI_PREVIEW_TITLE_IDS = [
  "edit",
  "delete",
  "move",
  "updateShape",
  "alignShape",
  "deleteShape",
  "insert",
  "insertTable",
  "insertShape",
  "insertGraph",
  "insertImage",
  "replaceTable",
  "replaceGraph",
  "replaceShape",
  "shapeEdit",
] as const;

export type AiPreviewTitleId = (typeof AI_PREVIEW_TITLE_IDS)[number];

function mutationOpTitleId(op: SigmaDocMutationOp | Record<string, unknown>): AiPreviewTitleId {
  const operation = (op as { operation?: unknown }).operation;
  if (operation === "deleteBlocks") return "delete";
  if (operation === "moveBlocks") return "move";
  if (operation === "updateOverlayShape") return "updateShape";
  if (operation === "alignOverlayShapes") return "alignShape";
  if (operation === "deleteOverlayShapes") return "deleteShape";
  return "edit";
}

/** Normalizes the discard popover's free-text reason: trims whitespace and
 * treats a blank reason as "no reason" (undefined) so a reason-less discard
 * behaves exactly like clicking 破棄 always did. */
export function resolveDismissReason(rawReason: string): string | undefined {
  const trimmed = rawReason.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const MUTATION_TITLE_IDS: Partial<Record<AiProposalOperationKind, AiPreviewTitleId>> = {
  deleteBlocks: "delete",
  moveBlocks: "move",
};

/**
 * 本文カードの見出しの id。塊が持つ操作の種類から決める: 全部が中身を持たない操作なら
 * その種類 (1 種類のときだけ。混ざれば汎用)、ブロックを足す/置き換える操作が全部挿入なら
 * 「挿入案」、それ以外は汎用の「編集案」。
 */
export function getAiEditInlinePreviewTitleId(content: AiProposalContent): AiPreviewTitleId {
  const kinds = content.hunks.flatMap((hunk) => hunk.operations);
  const blockKinds = kinds.filter((kind) => kind === "replace" || kind === "insertAfter");
  if (kinds.length > 0 && blockKinds.length === 0) {
    const ids = new Set(kinds.map((kind) => MUTATION_TITLE_IDS[kind] ?? "edit"));
    return ids.size === 1 ? [...ids][0] : "edit";
  }
  if (blockKinds.length > 0 && blockKinds.every((kind) => kind === "insertAfter")) {
    return "insert";
  }
  return "edit";
}

export function getAiEditInlinePreviewTitle(
  content: AiProposalContent,
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): string {
  return t(`card.title.${getAiEditInlinePreviewTitleId(content)}` as never) as unknown as string;
}

export function getAiEditOverlayApprovalTitleId(preview: AiEditPreviewState): AiPreviewTitleId {
  const operations = preview.draft.operations;
  const mutationOperations = preview.draft.mutationOperations ?? [];

  if ((preview.shapeReplacements?.length ?? 0) > 0) {
    const replacementOperations = operations.filter((operation) =>
      operation.operation === "insertTableShape" || operation.operation === "insertOverlayShape");
    if (replacementOperations.length > 0 && replacementOperations.every((operation) => operation.operation === "insertTableShape")) {
      return "replaceTable";
    }
    if (replacementOperations.length > 0 && replacementOperations.every((operation) =>
      operation.operation === "insertOverlayShape" && operation.overlayShape.type === "graph2dShape")) {
      return "replaceGraph";
    }
    return "replaceShape";
  }

  if (operations.length > 0 && mutationOperations.length === 0 && operations.every((operation) => operation.operation === "insertTableShape")) {
    return "insertTable";
  }

  if (operations.length > 0 && mutationOperations.length === 0 && operations.every((operation) => operation.operation === "insertOverlayShape")) {
    const shapeTypes = new Set(operations.map((operation) => operation.overlayShape.type));
    if (shapeTypes.size === 1 && shapeTypes.has("graph2dShape")) {
      return "insertGraph";
    }
    if (shapeTypes.size === 1 && shapeTypes.has("image")) {
      return "insertImage";
    }
    return "insertShape";
  }

  if (operations.length === 0 && mutationOperations.length > 0) {
    const ids = new Set(mutationOperations.map(mutationOpTitleId));
    if (ids.size === 1) {
      return [...ids][0];
    }
  }

  return "shapeEdit";
}

export function getAiEditOverlayApprovalTitle(
  preview: AiEditPreviewState,
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): string {
  return t(`card.title.${getAiEditOverlayApprovalTitleId(preview)}` as never) as unknown as string;
}

function getAiProposalSessionLabel({
  providers,
  sessionLabel,
}: {
  providers: McpEditProposalProvider[];
  sessionLabel?: string;
}): string | null {
  const providerLabel = formatAiProposalProviderLabel([...new Set(providers)]);
  const trimmedSessionLabel = sessionLabel?.trim();
  return trimmedSessionLabel && trimmedSessionLabel !== providerLabel ? trimmedSessionLabel : null;
}

/**
 * 本文フローに属するAI編集案を、適用後の内容と共通判断操作を備えたカードとして示す。
 * 内容は `AiProposalContentView` (`surface="page"`) が描き、ここはカードの外枠だけを持つ。
 * オーバーレイ専用案はここへ混ぜず (内容に本文の塊が無ければ何も出さない)、本文のページ計測を守る。
 *
 * 情報構造はサイドバーの提案カード (`.ai-chat-result-proposal`) を踏襲する:
 * 「提案された変更」見出し → 変更内容 → 参照元チップ → 判断アクション。プロバイダ名や
 * セッションラベルは意図的に出さない (サイドバー側が持つ帰属情報をここで二重に出さない)。
 * 適用後は本カード自体が消えるため、適用済みの差分・参照元・「元に戻す」といった
 * 事後情報はすべて会話側 (`AssistantTurnView`) に集約する — 「続けて修正」がその導線。
 */
export function AiEditInlinePreviewCard({
  content,
  applying,
  mathFractionSizing,
  sourceReferences,
  onOpenConversation,
  onOpenSourceDocument,
  onApply,
  onDismiss,
}: {
  /** このアンカーに置く本文の塊 (`groupPendingProposalContentByAnchor`)。図形は描かない。 */
  content: AiProposalContent;
  applying: boolean;
  mathFractionSizing?: MathFractionSizing;
  /** Phase 1: Agentic RAG. Past materials/docs/web pages this proposal's run
   * consulted, rendered as a compact chip row (see AiSourceReferenceChips). */
  sourceReferences?: DesktopAiSourceReference[];
  /** Opens the proposal's room in the shared floating conversation card,
   * anchored to the clicked action button. */
  onOpenConversation?: (anchorElement: HTMLElement) => void;
  onOpenSourceDocument?: (params: AiSourceReferenceOpenDocumentParams) => void;
  onApply?: () => Promise<AiProposalApplyOutcome>;
  /** Reason is the (optional, ≤200 chars) text the user typed in the discard
   * popover before confirming — undefined for a reason-less discard. */
  onDismiss?: (reason?: string) => void;
}) {
  const t = useT("ai");
  const tCommon = useT("common");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const runApply = async () => {
    if (!onApply) {
      return;
    }
    setApplyError(null);
    try {
      const result = await onApply();
      if (!result.ok) {
        setApplyError(result.reason);
      }
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : t("card.applyFailed"));
    }
  };

  // 本文の塊が無い (図形だけの) 内容はキャンバス側で決める。本文カードは出さない。
  if (closed || content.hunks.length === 0) {
    return null;
  }

  const bodyContent: AiProposalContent = content.shapes.length === 0 ? content : { hunks: content.hunks, shapes: [] };
  const title = getAiEditInlinePreviewTitle(bodyContent, t);
  return (
    <section
      className="ai-inline-preview-dialog"
      role="dialog"
      aria-modal="false"
      aria-label={t("card.dialogAria", { replace: { title } })}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          setClosed(true);
        }
      }}
    >
      <div className="ai-inline-preview-header">
        <p className="ai-inline-preview-diff-heading">{t("card.proposedChanges")}</p>
        <button
          type="button"
          className="ai-inline-card-icon"
          aria-label={tCommon("actions.close")}
          title={tCommon("actions.close")}
          onClick={() => setClosed(true)}
        >
          <X size={15} />
        </button>
      </div>
      <div className="ai-inline-preview-scroll" aria-label={title}>
        <AiProposalContentView content={bodyContent} surface="page" mathFractionSizing={mathFractionSizing} />
      </div>
      {sourceReferences && (
        <AiSourceReferenceChips
          sourceReferences={sourceReferences}
          onOpenDocument={onOpenSourceDocument}
        />
      )}
      <AiProposalActions
        applying={applying}
        className="ai-inline-preview-actions"
        dismissReasonPlaceholder={t("card.dismissReasonExampleText")}
        onOpenConversation={onOpenConversation}
        onApply={onApply ? () => void runApply() : undefined}
        onDismiss={onDismiss}
      />
      {applyError && <p className="ai-chat-error">{applyError}</p>}
    </section>
  );
}

/**
 * Compact decision toolbar for proposals that live wholly in the overlay
 * layer. Its parent positions it beside the proposed shape, so it never takes
 * part in body-flow measurement or pagination.
 */
export function AiEditOverlayApprovalWidget({
  preview,
  applying,
  placement,
  style,
  changeSummaryLines,
  onOpenConversation,
  onApply,
  onDismiss,
}: {
  preview: AiEditPreviewState;
  applying: boolean;
  placement: "above" | "below";
  style: CSSProperties;
  /** Short "what changed" lines (see `summarizeAiEditPreviewChanges`) — the
   * widget has no other surface to describe the change, so up to 3 render
   * verbatim, with any rest folded into "ほかn件". */
  changeSummaryLines?: string[];
  /** Opens this proposal's room in the shared floating conversation card. */
  onOpenConversation?: (anchorElement: HTMLElement) => void;
  onApply?: () => Promise<AiProposalApplyOutcome>;
  onDismiss?: (reason?: string) => void;
}) {
  const t = useT("ai");
  const [applyError, setApplyError] = useState<string | null>(null);
  const visibleSessionLabel = getAiProposalSessionLabel({
    providers: preview.providers,
    sessionLabel: preview.sessionLabel,
  });
  const title = getAiEditOverlayApprovalTitle(preview, t);
  const { shown: summaryShown, moreCount: summaryMoreCount } = splitChangeSummaryLines(changeSummaryLines ?? [], 3);
  const runApply = async () => {
    if (!onApply) {
      return;
    }
    setApplyError(null);
    try {
      const result = await onApply();
      if (!result.ok) {
        setApplyError(result.reason);
      }
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : t("card.applyFailed"));
    }
  };
  return (
    <section
      className="ai-overlay-approval-widget"
      data-placement={placement}
      style={style}
      role="dialog"
      aria-modal="false"
      aria-label={t("card.overlayDialogAria", { replace: { title } })}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="ai-overlay-approval-copy">
        {visibleSessionLabel && <span className="ai-overlay-approval-label">{visibleSessionLabel}</span>}
        <span className="ai-overlay-approval-title">{title}</span>
        {summaryShown.length > 0 && (
          <ul className="ai-overlay-approval-summary-list">
            {summaryShown.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
            {summaryMoreCount > 0 && (
              <li className="ai-overlay-approval-summary-more">{t("card.summaryMore", { replace: { count: summaryMoreCount } })}</li>
            )}
          </ul>
        )}
      </div>
      <AiProposalActions
        applying={applying}
        className="ai-overlay-approval-actions"
        dismissReasonPlaceholder={t("card.dismissReasonExampleShape")}
        onOpenConversation={onOpenConversation}
        onApply={onApply ? () => void runApply() : undefined}
        onDismiss={onDismiss}
      />
      {applyError && <p className="ai-chat-error">{applyError}</p>}
    </section>
  );
}
