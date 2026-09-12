"use client";

import { History, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";

import {
  buildProblemAreaPrintUnits,
  PrintBlock,
  PrintProblemArea,
} from "@/components/print/print-static-blocks";
import { HeadingNumberingProvider } from "@/components/editor/text-flow/HeadingNumberingContext";
import { AiProposalActions } from "@/components/ui/ai";
import { buildShapeOnlyPreview, buildShapesSvgPreview } from "@/lib/ai/ai-edit-shape-preview";
import { findProblemAreaBlockLocation } from "@/lib/document-tree";
import {
  type ListItemNode,
  type MathFractionSizing,
  type OverlayAsset,
  type OverlayShape,
  type ProblemAreaKind,
  type SigmaBlock,
  type SigmaDocument,
} from "@/features/document";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import { formatProblemNumber, getProblemNumberMap } from "@/lib/problem-numbering";
import { getHeadingNumberMap } from "@/lib/heading-numbering";
import {
  createAiEditSessionDocumentDraft,
  primarySigmaDocMutationOpTargetId,
  type AiEditDraft,
  type SigmaDocMutationOp,
} from "@/lib/ai/sigma-doc-edit-schema";
import {
  formatAiProposalProviderLabel,
  isOverlayOwnedAiEditDraft,
  isOverlaySigmaDocMutationOp,
  overlayShapeNoun,
  resolveMutationOpAssets,
  resolveMutationOpShapeResults,
  resolveOverlayShapeAnchorBlockId,
  type AiEditPreviewState,
  type McpEditProposalProvider,
} from "../model/preview";
import type { AiProposalApplyOutcome } from "../application/proposal-action-model";
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
import type { DesktopAiSourceReference } from "@/types/desktop";

export interface AiEditInlineOperationEntry {
  kind: "operation";
  draft: AiEditDraft;
  operationIndex: number;
  operationCount: number;
  sessionSummary: string;
  /** SigmaDoc problem-area ownership of the real anchor. The candidate block
   * alone cannot tell whether a paragraph belongs to the prompt or solution,
   * so preserve that context while grouping the proposal. */
  problemArea?: ProblemAreaKind;
  problemNumber?: number;
  headingNumber?: string;
  headingNumbers?: ReadonlyMap<string, string>;
}

// mutationOperations (deleteBlocks/moveBlocks/updateOverlayShape/alignOverlayShapes/
// deleteOverlayShapes) don't carry a renderable block the way AiEditDraft operations
// do -- they render as a compact Japanese summary row (see AiEditInlineMutationPreview
// below), plus, for shape-visual ops, an SVG preview of the shapes' post-apply state.
export interface AiEditInlineMutationEntry {
  kind: "mutation";
  op: SigmaDocMutationOp;
  operationIndex: number;
  operationCount: number;
  sessionSummary: string;
  /** For updateOverlayShape / alignOverlayShapes: the affected shapes as they
   * will look AFTER the proposal is applied (patch merged with the real apply
   * semantics), so the card can show "適用したらこうなる" instead of only a
   * one-line summary. Absent when the op is not shape-visual or the live
   * document/shape wasn't available at grouping time. */
  afterShapes?: OverlayShape[];
  /** Overlay assets `afterShapes` needs to render — the live document's, with any
   * replacement the preceding ops carry already merged in. */
  assets?: Record<string, OverlayAsset>;
}

export type AiEditInlinePreviewEntry = AiEditInlineOperationEntry | AiEditInlineMutationEntry;

/** One run/proposal-group's entries anchored to a given block, alongside the
 * group itself (needed to scope apply/dismiss and provider/session labeling
 * to just that group when several runs propose edits at the same anchor). */
export interface AiEditPreviewGroupCard {
  preview: AiEditPreviewState;
  entries: AiEditInlinePreviewEntry[];
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

export function getAiEditInlinePreviewTitleId(entries: AiEditInlinePreviewEntry[]): AiPreviewTitleId {
  if (entries.length > 0 && entries.every((entry) => entry.kind === "mutation")) {
    const ids = new Set(entries.map((entry) => mutationOpTitleId((entry as AiEditInlineMutationEntry).op)));
    return ids.size === 1 ? [...ids][0] : "edit";
  }

  const operationEntries = entries.filter((entry): entry is AiEditInlineOperationEntry => entry.kind === "operation");
  if (operationEntries.length === 0) {
    return "edit";
  }

  if (operationEntries.every((entry) => entry.draft.operation === "insertAfter")) {
    return "insert";
  }

  if (operationEntries.every((entry) => entry.draft.operation === "insertTableShape")) {
    return "insertTable";
  }

  if (operationEntries.every((entry) => entry.draft.operation === "insertOverlayShape")) {
    return "insertShape";
  }

  return "edit";
}

export function getAiEditInlinePreviewTitle(
  entries: AiEditInlinePreviewEntry[],
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): string {
  return t(`card.title.${getAiEditInlinePreviewTitleId(entries)}` as never) as unknown as string;
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
 * Groups a single preview group's operations (and mutationOperations) by the
 * *anchor block* their preview card should hang off — keyed by an id that
 * exists (or will exist as a problem area) in the rendered document, NOT
 * necessarily the raw `targetId`.
 *
 * AI edits frequently insert a run of blocks by *chaining* `insertAfter`: op 0
 * targets a real block, op 1 targets op 0's freshly-inserted block, op 2 targets
 * op 1's, and so on. Those intermediate target ids do not exist in the current
 * document, so keying by raw `targetId` left every chained op after the first
 * with no block to render against — the preview then showed only the first
 * candidate while applying inserted the whole chain. Here we walk each op's
 * target back through the chain of ids created within this same draft until we
 * reach an id no operation creates (the real anchor), and fold the entire chain
 * into that anchor's card so every candidate is shown, in document order.
 *
 * mutationOperations (deleteBlocks/moveBlocks/overlay-shape ops) never mint a
 * new id, so they never extend the chain — they simply anchor to their own
 * primary affected id (which may or may not exist in the rendered text flow;
 * see `primarySigmaDocMutationOpTargetId`). When it doesn't, the entry is
 * still produced but has no block to render inline against — it stays
 * visible via the AI task dock / proposal list instead.
 */
function groupSinglePreviewEntries(
  preview: AiEditPreviewState,
  document?: SigmaDocument,
): Map<string, AiEditInlinePreviewEntry[]> {
  const entriesByAnchorId = new Map<string, AiEditInlinePreviewEntry[]>();
  const problemNumbers = resolvePreviewProblemNumbers(preview, document);
  const headingNumbers = resolvePreviewHeadingNumbers(preview, document);
  const allOperations = preview.draft.operations;
  const operations = allOperations.filter((operation) => !isOverlayOwnedAiEditDraft(operation, allOperations));
  const mutationOperations = (preview.draft.mutationOperations ?? []).filter(
    (operation) => !isOverlaySigmaDocMutationOp(operation),
  );
  const totalCount = operations.length + mutationOperations.length;

  // Map from an id this draft CREATES (an inserted block) → the target that op
  // inserted it after. Only `insertAfter` mints a new id; `replace` reuses the
  // target's own id, so it never becomes a chain link.
  const insertedIdToTarget = new Map<string, string>();
  operations.forEach((draft) => {
    if (draft.operation === "insertAfter") {
      insertedIdToTarget.set(draft.insertedBlock.id, draft.targetId);
    }
  });

  const resolveAnchorId = (targetId: string): string => {
    const visited = new Set<string>();
    let current = targetId;
    while (insertedIdToTarget.has(current) && !visited.has(current)) {
      visited.add(current);
      current = insertedIdToTarget.get(current)!;
    }
    return current;
  };

  const pushEntry = (anchorId: string, entry: AiEditInlinePreviewEntry) => {
    const entries = entriesByAnchorId.get(anchorId) ?? [];
    entries.push(entry);
    entriesByAnchorId.set(anchorId, entries);
  };

  operations.forEach((draft, operationIndex) => {
    const anchorId = resolveAnchorId(draft.targetId);
    const problemLocation = document ? findProblemAreaBlockLocation(document, anchorId) : null;
    const proposedBlock = draft.operation === "insertAfter" ? draft.insertedBlock
      : draft.operation === "replace" || draft.operation === undefined ? draft.replacementBlock
      : null;
    const proposedProblemId = proposedBlock?.type === "problem" ? proposedBlock.id : problemLocation?.problemId;
    pushEntry(anchorId, {
      kind: "operation",
      draft,
      operationIndex,
      operationCount: totalCount,
      sessionSummary: preview.draft.summary,
      headingNumber: proposedBlock ? headingNumbers.get(proposedBlock.id) : undefined,
      headingNumbers,
      ...(problemLocation ? {
        problemArea: problemLocation.area,
        problemNumber: proposedProblemId ? problemNumbers.get(proposedProblemId) : undefined,
      } : proposedProblemId && problemNumbers.has(proposedProblemId) ? {
        problemNumber: problemNumbers.get(proposedProblemId),
      } : {}),
    });
  });

  const overlaySnapshot = document?.pageLayout?.overlay?.overlaySnapshot;
  // Threaded through the ops below so a shape touched by several ops previews
  // each op against the previous op's result — the same sequential semantics
  // the real apply path uses. Assets are threaded for the same reason: an op can
  // replace a picture derived from the shape it updates, and the following ops
  // (and this op's own card) must draw the replacement, not the stored one.
  let shapesCursor = overlaySnapshot?.shapes ?? [];
  let assetsCursor = overlaySnapshot?.assets ?? {};

  mutationOperations.forEach((op, index) => {
    const rawAnchorId = primarySigmaDocMutationOpTargetId(op);
    if (!rawAnchorId) {
      return;
    }
    // Overlay-shape ops target a *shape* id, which never matches a body block,
    // so keyed as-is the card (and its 適用/破棄 buttons) would never mount in
    // the canvas. Resolve the shape's anchor block so the card hangs off the
    // block the shape is attached to; non-shape ids resolve to undefined and
    // keep the raw anchor.
    const shapeAnchorBlockId = document ? resolveOverlayShapeAnchorBlockId(document, rawAnchorId) : undefined;
    const afterShapes = shapesCursor.length > 0 ? resolveMutationOpShapeResults(op, shapesCursor) : null;
    if (afterShapes && afterShapes.length > 0) {
      const byId = new Map(afterShapes.map((shape) => [shape.id, shape]));
      shapesCursor = shapesCursor.map((shape) => byId.get(shape.id) ?? shape);
    }
    assetsCursor = resolveMutationOpAssets(op, assetsCursor);
    pushEntry(resolveAnchorId(shapeAnchorBlockId ?? rawAnchorId), {
      kind: "mutation",
      op,
      operationIndex: operations.length + index,
      operationCount: totalCount,
      sessionSummary: preview.draft.summary,
      ...(afterShapes && afterShapes.length > 0 ? { afterShapes, assets: assetsCursor } : {}),
    });
  });

  // Keep each anchor's chain in operation (document) order.
  for (const entries of entriesByAnchorId.values()) {
    entries.sort((a, b) => a.operationIndex - b.operationIndex);
  }

  return entriesByAnchorId;
}

function resolvePreviewProblemNumbers(
  preview: AiEditPreviewState,
  document?: SigmaDocument,
): Map<string, number> {
  if (!document) {
    return new Map();
  }

  try {
    const previewDocument = createAiEditSessionDocumentDraft(document, null, preview.draft).nextDocument;
    return getProblemNumberMap(previewDocument.content);
  } catch {
    // A stale proposal can fail to replay against the current document. Its
    // existing numbering is still more accurate than dropping the label.
    return getProblemNumberMap(document.content);
  }
}

function resolvePreviewHeadingNumbers(
  preview: AiEditPreviewState,
  document?: SigmaDocument,
): Map<string, string> {
  if (!document) {
    return new Map();
  }
  try {
    const previewDocument = createAiEditSessionDocumentDraft(document, null, preview.draft).nextDocument;
    return getHeadingNumberMap(previewDocument.content, previewDocument.metadata?.headingNumbering);
  } catch {
    return getHeadingNumberMap(document.content, document.metadata?.headingNumbering);
  }
}

/**
 * Merges the per-anchor entries of *every* current preview group (one per
 * run/proposal-group — see ai-edit-preview-types.ts's Decision B) into a
 * single map, keyed by anchor block id, of the group "cards" that should
 * render there. Two different runs proposing edits at the same block produce
 * two separate cards at that anchor (each keeping its own `preview` for
 * apply/dismiss), never one merged entries list — a rejected/applied
 * decision on one run's card must never affect another run's.
 */
export function groupAiEditPreviewEntries(
  previews: AiEditPreviewState[],
  document?: SigmaDocument,
): Map<string, AiEditPreviewGroupCard[]> {
  const cardsByAnchorId = new Map<string, AiEditPreviewGroupCard[]>();
  for (const preview of previews) {
    const perAnchor = groupSinglePreviewEntries(preview, document);
    for (const [anchorId, entries] of perAnchor) {
      const cards = cardsByAnchorId.get(anchorId) ?? [];
      cards.push({ preview, entries });
      cardsByAnchorId.set(anchorId, cards);
    }
  }
  return cardsByAnchorId;
}

/**
 * 本文フローに属するAI編集案を、適用後の内容と共通判断操作を備えたカードとして示す。
 * オーバーレイ専用案はここへ混ぜず、本文のページ計測を守る。
 *
 * 情報構造はサイドバーの提案カード (`.ai-chat-result-proposal`) を踏襲する:
 * 「提案された変更」見出し → 変更内容 → 参照元チップ → 判断アクション。プロバイダ名や
 * セッションラベルは意図的に出さない (サイドバー側が持つ帰属情報をここで二重に出さない)。
 * 適用後は本カード自体が消えるため、適用済みの差分・参照元・「元に戻す」といった
 * 事後情報はすべて会話側 (`AssistantTurnView`) に集約する — 「続けて修正」がその導線。
 */
export function AiEditInlinePreviewCard({
  entries,
  applying,
  mathFractionSizing,
  sourceReferences,
  onOpenConversation,
  onOpenSourceDocument,
  onApply,
  onDismiss,
}: {
  entries: AiEditInlinePreviewEntry[];
  providers: McpEditProposalProvider[];
  applying: boolean;
  mathFractionSizing?: MathFractionSizing;
  /** Attribution stays in the surrounding AI surfaces; the body widget itself
   * deliberately renders only the real diff and proposal actions. */
  sessionLabel?: string;
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
  // Defensive filtering: PageCanvasEditor already splits body and overlay
  // entries before mounting cards, but the card itself must never regress to
  // rendering a newly inserted shape/table inside body flow.
  const allOperationDrafts = useMemo(
    () => entries.flatMap((entry) => (entry.kind === "operation" ? [entry.draft] : [])),
    [entries],
  );
  const visibleEntries = useMemo(
    () => entries.filter((entry) => entry.kind === "operation"
      ? !isOverlayOwnedAiEditDraft(entry.draft, allOperationDrafts)
      : !isOverlaySigmaDocMutationOp(entry.op)),
    [allOperationDrafts, entries],
  );
  const operationDrafts = useMemo(
    () => visibleEntries.flatMap((entry) => (entry.kind === "operation" ? [entry.draft] : [])),
    [visibleEntries],
  );
  const shapeOnlyPreview = useMemo(
    () => (entries.every((entry) => entry.kind === "operation") ? buildShapeOnlyPreview(operationDrafts) : null),
    [entries, operationDrafts],
  );
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

  if (closed || visibleEntries.length === 0) {
    return null;
  }

  const title = getAiEditInlinePreviewTitle(visibleEntries, t);
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
      <div className="ai-inline-preview-scroll">
        {shapeOnlyPreview ? (
          <div className="ai-edit-shape-preview-viewport" aria-label={t("card.insertShapePreview")}>
            <div
              className="ai-edit-shape-preview-stage"
              dangerouslySetInnerHTML={{ __html: shapeOnlyPreview.svg }}
            />
          </div>
        ) : (
          <div className="ai-inline-preview-operation-list ai-inline-preview-paper" aria-label={title}>
            {visibleEntries.map((entry, index) => {
              const previousEntry = visibleEntries[index - 1];
              const previousProblemArea = previousEntry?.kind === "operation"
                ? previousEntry.problemArea
                : undefined;
              return (
                <AiEditInlineOperationPreview
                  key={entry.kind === "operation" ? `op:${entry.draft.targetId}:${entry.operationIndex}` : `mut:${entry.operationIndex}`}
                  entry={entry}
                  mathFractionSizing={mathFractionSizing}
                  showProblemAreaLabel={entry.kind === "operation" && Boolean(entry.problemArea) && entry.problemArea !== previousProblemArea}
                />
              );
            })}
          </div>
        )}
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

function AiEditInlineOperationPreview({
  entry,
  mathFractionSizing,
  showProblemAreaLabel = true,
}: {
  entry: AiEditInlinePreviewEntry;
  mathFractionSizing?: MathFractionSizing;
  showProblemAreaLabel?: boolean;
}) {
  const t = useT("ai");
  const tEditor = useT("editor");
  if (entry.kind === "mutation") {
    return <AiEditInlineMutationPreview entry={entry} />;
  }

  const { draft } = entry;
  const isTextDraft = draft.operation !== "insertOverlayShape" && draft.operation !== "insertTableShape";
  // An overlay insert (shape or table) never reaches this card: `AiEditInlinePreviewCard` filters
  // it out and the proposal is decided on the canvas, where the pending shape is drawn as a ghost
  // by the ordinary shape renderer -- for a table, `OverlayTableStaticView`. The card used to carry
  // its own `rows × columns` table renderer for this branch; it had no span expansion, so a merged
  // cell pushed the rest of its row past the table's edge. Rather than keep yet another table
  // renderer alive for output nobody can see, the branch degrades to naming the shape -- with the
  // same noun the change summary uses, not the internal shape type it used to print.
  const previewContent = isTextDraft ? (
    <AiStaticBlockPreview
      block={draft.operation === "insertAfter" ? draft.insertedBlock : draft.replacementBlock}
      problemNumber={entry.problemNumber}
      mathFractionSizing={mathFractionSizing}
      headingNumber={entry.headingNumber}
      headingNumbers={entry.headingNumbers}
    />
  ) : (
    <p className="ai-inline-preview-placeholder">
      {t("card.insertsShape", { replace: {
        noun: overlayShapeNoun(draft.operation === "insertTableShape" ? draft.tableShape : draft.overlayShape, t),
      } })}
    </p>
  );
  // The card deliberately shows ONLY the proposed "+" content. The current
  // (to-be-replaced) content is never repeated here: the body already marks it
  // with the pale-red generic change decoration, and showing the same
  // information twice made proposals harder to scan.

  return (
    <article
      className="ai-inline-preview-operation"
      data-operation={draft.operation ?? "replace"}
      data-problem-area={entry.problemArea}
    >
      <div className={`ai-inline-preview-content ai-inline-preview-diff-added ${isTextDraft ? "text-flow-editor" : ""} ${entry.problemArea ? "ai-inline-preview-problem-area-row" : ""}`}>
        {entry.problemArea && showProblemAreaLabel && (
          <span className="ai-inline-preview-problem-area-label">
            {problemAreaPreviewLabel(entry.problemArea, entry.problemNumber, tEditor)}
          </span>
        )}
        {entry.problemArea && !showProblemAreaLabel && (
          <span className="ai-inline-preview-problem-area-label continuation" aria-hidden="true" />
        )}
        {entry.problemArea ? (
          <div className="ai-inline-preview-problem-area-body">{previewContent}</div>
        ) : previewContent}
      </div>
    </article>
  );
}

/** Compact summary row for a deleteBlocks/moveBlocks/overlay-shape mutation
 * op — these don't carry a renderable block, only a Japanese `summary`
 * string. Defensive against a future op type this union doesn't know about
 * yet: falls back to a generic label instead of crashing. deleteBlocks /
 * deleteOverlayShapes get the pale-red "removed" diff treatment; the
 * remaining mutation ops (moveBlocks / updateOverlayShape / alignOverlayShapes)
 * change something in place, so they get a neutral "modified" treatment.
 * When the entry carries `afterShapes` (shape update/align), an SVG preview of
 * the shapes' post-apply state is rendered beneath the summary so the user can
 * see what applying will actually produce. */
function AiEditInlineMutationPreview({ entry }: { entry: AiEditInlineMutationEntry }) {
  const t = useT("ai");
  const { op } = entry;
  const summary = (op as { summary?: unknown }).summary;
  const text = typeof summary === "string" && summary.trim().length > 0 ? summary.trim() : t("card.title.edit");
  const operation = (op as { operation?: unknown }).operation;
  const isRemoval = operation === "deleteBlocks" || operation === "deleteOverlayShapes";
  const diffClass = isRemoval ? "ai-inline-preview-diff-removed" : "ai-inline-preview-diff-modified";
  const afterPreview = useMemo(
    () => (entry.afterShapes && entry.afterShapes.length > 0 ? buildShapesSvgPreview(entry.afterShapes, entry.assets ?? {}) : null),
    [entry],
  );
  return (
    <article className="ai-inline-preview-operation" data-operation="mutation">
      <div className={`ai-inline-preview-content ai-inline-preview-mutation ${diffClass}`}>
        <History size={13} aria-hidden="true" />
        <p className="ai-inline-preview-mutation-summary">{text}</p>
      </div>
      {afterPreview && (
        <div className="ai-edit-shape-preview-viewport" aria-label={t("card.updatedShapePreview")}>
          <div
            className="ai-edit-shape-preview-stage"
            dangerouslySetInnerHTML={{ __html: afterPreview.svg }}
          />
        </div>
      )}
    </article>
  );
}

const AI_PREVIEW_COLUMN_GAP_MM = 8;

function AiStaticBlockPreview({
  block,
  problemNumber,
  mathFractionSizing,
  headingNumber,
  headingNumbers,
}: {
  block: SigmaBlock | ListItemNode;
  problemNumber?: number;
  mathFractionSizing?: MathFractionSizing;
  headingNumber?: string;
  headingNumbers?: ReadonlyMap<string, string>;
}) {
  const resolvedHeadingNumbers = new Map(headingNumbers);
  if (headingNumber) {
    resolvedHeadingNumbers.set(block.id, headingNumber);
  }

  if (block.type === "problem") {
    return (
      <HeadingNumberingProvider numbers={resolvedHeadingNumbers}>
        {buildProblemAreaPrintUnits(block, problemNumber).map((unit) => (
          <PrintProblemArea
            key={unit.id}
            problemId={unit.problemId}
            area={unit.area}
            blocks={unit.blocks}
            minHeightMm={unit.minHeightMm}
            problemNumber={unit.problemNumber}
            numberFontSize={unit.numberFontSize}
            hasFrame={unit.hasFrame}
            frameStyleId={unit.frameStyleId}
            isFirstProblemArea={unit.isFirstProblemArea}
            isFirstProblemFrameArea={unit.isFirstProblemFrameArea}
            isLastProblemFrameArea={unit.isLastProblemFrameArea}
            columnGapMm={AI_PREVIEW_COLUMN_GAP_MM}
            mathFractionSizing={mathFractionSizing}
          />
        ))}
      </HeadingNumberingProvider>
    );
  }

  const printableBlock: SigmaBlock = block.type === "listItem"
    ? {
        id: block.id,
        type: "paragraph",
        children: block.children,
        align: block.align,
      }
    : block;

  return (
    <HeadingNumberingProvider numbers={resolvedHeadingNumbers}>
      <PrintBlock
        unit={{
          type: "block",
          id: printableBlock.id,
          block: printableBlock,
          pagination: printableBlock.pagination,
        }}
        columnGapMm={AI_PREVIEW_COLUMN_GAP_MM}
        mathFractionSizing={mathFractionSizing}
      />
    </HeadingNumberingProvider>
  );
}
/** 区分の呼び名は本文編集面と同じ語 (`editor.block.problem*` / `editor.pageCanvas.areaPrompt`)。 */
function problemAreaPreviewLabel(
  area: ProblemAreaKind,
  problemNumber: number | undefined,
  tEditor: Translate<"editor">,
): string {
  if (area === "lead") return tEditor("block.problemLead");
  if (area === "prompt") {
    return typeof problemNumber === "number"
      ? tEditor("pageCanvas.areaPrompt", { replace: { number: formatProblemNumber(problemNumber) } })
      : tEditor("block.problemPrompt");
  }
  if (area === "hints") return tEditor("block.problemHints");
  return tEditor("block.problemSolution");
}
