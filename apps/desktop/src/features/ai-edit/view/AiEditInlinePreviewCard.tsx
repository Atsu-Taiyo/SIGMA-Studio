"use client";

import { useId, useState } from "react";
import type { CSSProperties } from "react";

import { useIsFlowExtensionReplica } from "@/components/editor/page-canvas/flow-extension-replica";
import { AiProposalDecisionBar } from "@/components/ui/ai";
import type { MathFractionSizing } from "@/features/document";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import type { SigmaDocMutationOp } from "@/lib/ai/sigma-doc-edit-schema";
import type { DesktopAiSourceReference } from "@/types/desktop";
import {
  formatAiProposalProviderLabel,
  isOverlayOnlyAiEditPreview,
  isOverlayOwnedAiEditDraft,
  isOverlaySigmaDocMutationOp,
  type AiEditPreviewState,
  type McpEditProposalProvider,
} from "../model/preview";
import type { AiProposalContent, AiProposalContentHunk, AiProposalOperationKind } from "../model/proposal-content";
import {
  applyAiProposalCardDisplayPatch,
  DEFAULT_AI_PROPOSAL_DISPLAY_STATE,
  type AiProposalDisplayState,
} from "../model/proposal-display-state";
import type { AiProposalApplyOutcome } from "../application/proposal-action-model";
import { AiProposalContentView } from "./AiProposalContentView";
import {
  AiSourceReferenceChips,
  type AiSourceReferenceOpenDocumentParams,
} from "./AiSourceReferenceChips";

/** 浮かぶバーの要約は 3 行まで。残りは「ほかn件」の 1 行にまとめる。 */
export const OVERLAY_SUMMARY_MAX_LINES = 3;

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

/** 浮かぶバーに出すセッション名 (プロバイダ名と同じなら出さない)。 */
export function getAiProposalSessionLabel({
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
 * 紙面のカードとサイドバー・⌘K のバーに出す見出しの id を、提案の操作から決める。
 * 図形だけの提案は図形のそばのバーと同じ名前 (`getAiEditOverlayApprovalTitleId`)、本文を含む提案は
 * 本文の操作の種類で決める (紙面のカードの `getAiEditInlinePreviewTitleId` と同じ規則)。
 */
export function getAiProposalTitleId(preview: AiEditPreviewState): AiPreviewTitleId {
  if (isOverlayOnlyAiEditPreview(preview)) {
    return getAiEditOverlayApprovalTitleId(preview);
  }
  const operations = preview.draft.operations;
  const kinds: AiProposalOperationKind[] = [
    ...operations
      .filter((operation) => !isOverlayOwnedAiEditDraft(operation, operations))
      .map((operation): AiProposalOperationKind => (operation.operation === "insertAfter" ? "insertAfter" : "replace")),
    ...(preview.draft.mutationOperations ?? [])
      .filter((operation) => !isOverlaySigmaDocMutationOp(operation))
      .map((operation): AiProposalOperationKind => {
        const kind = (operation as { operation?: unknown }).operation;
        return kind === "deleteBlocks" || kind === "moveBlocks" ? kind : "other";
      }),
  ];
  return getAiEditInlinePreviewTitleId({ hunks: [{ ...EMPTY_TITLE_HUNK, operations: kinds }], shapes: [] });
}

const EMPTY_TITLE_HUNK: AiProposalContentHunk = {
  anchorBlockId: "",
  removed: [],
  added: [],
  notes: [],
  operations: [],
  numbering: {
    removed: { problems: new Map(), headings: new Map() },
    added: { problems: new Map(), headings: new Map() },
  },
};

export function getAiProposalTitle(preview: AiEditPreviewState, t: Translate<"ai"> = DEFAULT_AI_TRANSLATE): string {
  return t(`card.title.${getAiProposalTitleId(preview)}` as never) as unknown as string;
}

/**
 * 承認バーに添える一言: 提案の内容が、提案の後に人が直した対象を承認と同じ三者マージで合わせた
 * ものであること (`resolveProposalMergePreview` の `humanEditedUnits` が空でない)。紙面のカード・
 * 図形のそばのバー・サイドバー・⌘K のパネルで同じ文言を出す。
 */
export function AiProposalMergeNotice() {
  const t = useT("ai");
  return <span data-ai-proposal-merge-notice="">{t("card.mergedWithYourEdits")}</span>;
}

/**
 * 適用後だけを見せている紙面のカードのうち、その姿を紙面に組めないもの (変更前を本文から畳めない・移動など)
 * に添える一言 (`AiProposalResultLayout.complete`)。
 */
function AiProposalResultNotice() {
  const t = useT("ai");
  return <span data-ai-proposal-result-notice="">{t("card.resultNotLaidOut")}</span>;
}

/**
 * 表示状態を、持ち主 (紙面の拡張) から受け取るか自分で持つか。どちらでも同じ形で読み書きする。
 * 紙面のカードは改ページで切れると続きの複製が別のインスタンスで描かれるので、持ち主が持つ
 * (`model/proposal-display-state.ts`)。単独で描くとき (テストなど) は自分で持つ。
 */
function useProposalDisplayState(
  displayState: AiProposalDisplayState | undefined,
  onDisplayStateChange: ((patch: Partial<AiProposalDisplayState>) => void) | undefined,
): [AiProposalDisplayState, (patch: Partial<AiProposalDisplayState>) => void] {
  const [ownState, setOwnState] = useState<AiProposalDisplayState>(DEFAULT_AI_PROPOSAL_DISPLAY_STATE);
  if (displayState && onDisplayStateChange) {
    return [displayState, onDisplayStateChange];
  }
  return [ownState, (patch) => setOwnState((previous) => applyAiProposalCardDisplayPatch(previous, patch))];
}

/**
 * 表示状態をバーの props へ写す (適用後だけ・内容を隠す・失敗の理由・破棄理由・変更前を隠す)。適用後だけは
 * 紙面のカードだけが出す (`offerAfterOnly`)。その間は変更前の図形も隠れているので「変更前を隠す」は出さない。
 */
function decisionBarStateProps(
  state: AiProposalDisplayState,
  update: (patch: Partial<AiProposalDisplayState>) => void,
  options: { hasContent: boolean; hasBeforeShapes: boolean; offerAfterOnly?: boolean; contentId?: string },
) {
  const afterOnly = Boolean(options.offerAfterOnly) && state.afterOnly;
  return {
    ...(options.offerAfterOnly
      ? { afterOnly, onAfterOnlyChange: (next: boolean) => update({ afterOnly: next }) }
      : {}),
    ...(options.hasContent
      ? {
        contentHidden: state.contentHidden,
        onContentHiddenChange: (contentHidden: boolean) => update({ contentHidden }),
        contentId: options.contentId,
      }
      : {}),
    ...(options.hasBeforeShapes && !afterOnly
      ? { beforeHidden: state.beforeHidden, onBeforeHiddenChange: (beforeHidden: boolean) => update({ beforeHidden }) }
      : {}),
    applyError: state.applyError,
    onApplyErrorChange: (applyError: string | null) => update({ applyError }),
    dismissReasonOpen: state.dismissReasonOpen,
    onDismissReasonOpenChange: (dismissReasonOpen: boolean) => update({ dismissReasonOpen }),
    dismissReason: state.dismissReason,
    onDismissReasonChange: (dismissReason: string) => update({ dismissReason }),
  };
}

export interface AiEditInlinePreviewCardProps {
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
  /** 表示状態 (カードの外に持つ)。`onDisplayStateChange` と一緒に渡す。省略時はカードが自分で持つ。 */
  displayState?: AiProposalDisplayState;
  onDisplayStateChange?: (patch: Partial<AiProposalDisplayState>) => void;
  /** 本文と一緒に図形の変更前/変更後もある提案。バーに「変更前を隠す」を出す。 */
  hasBeforeShapes?: boolean;
  /** 内容が人の編集と合成したもの。バーの下に一言を添える (`AiProposalMergeNotice`)。 */
  mergedWithHumanEdits?: boolean;
  /**
   * 適用後だけを見せるとき、変更前を畳んでこの内容を置けば適用後の紙面になるか
   * (`AiProposalResultLayout.complete`)。組めなければ、その間バーの下に一言を添える。既定は組める。
   */
  resultLaidOut?: boolean;
}

/**
 * 本文フローに置く AI 編集案のカード。先頭の行が承認バー (`AiProposalDecisionBar`)、その下に
 * 提案の内容を紙面と同じ段幅・同じ組版で描く (`AiProposalContentView` の `page`)。カードは幅も
 * 高さも上限を持たず、内部でスクロールしない (長ければページ割りが次のページへ続ける)。
 *
 * - バーを最初の行に置くので、改ページで切れても操作は最初の帯 (正本) に残る。続きの複製では
 *   バーを同じ寸法で描くが見せない (`useIsFlowExtensionReplica`)。
 * - 「内容を隠す」は内容だけを隠してバーを残す。表示状態は持ち主から受け取る。
 * - 「適用後だけを表示」は内容を印なしで描く (`AiProposalContentView` の `after`)。本文の変更前を畳むのと
 *   図形の変更前を隠すのは持ち主 (紙面の拡張) が同じ状態から行う。
 * - 図形は描かない (紙面に変更前/変更後を直接描く)。本文の塊が無ければ何も出さない。
 * - プロバイダ名やセッションラベルは出さない (会話側が持つ帰属情報を二重に出さない)。適用後は
 *   カードごと消え、適用済みの差分・「元に戻す」は会話側 (`AssistantTurnView`) が持つ。
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
  displayState,
  onDisplayStateChange,
  hasBeforeShapes = false,
  mergedWithHumanEdits = false,
  resultLaidOut = true,
}: AiEditInlinePreviewCardProps) {
  const t = useT("ai");
  const replica = useIsFlowExtensionReplica();
  const contentId = useId();
  const [state, update] = useProposalDisplayState(displayState, onDisplayStateChange);

  // 本文の塊が無い (図形だけの) 内容はキャンバス側で決める。本文カードは出さない。
  if (content.hunks.length === 0) {
    return null;
  }

  const bodyContent: AiProposalContent = content.shapes.length === 0 ? content : { hunks: content.hunks, shapes: [] };
  const title = getAiEditInlinePreviewTitle(bodyContent, t);
  // 複製は同じ id を持たない (支援技術・aria-controls が正本だけを指す)。
  const ownContentId = replica ? undefined : contentId;
  const resultOnly = state.afterOnly;
  const notices = [
    mergedWithHumanEdits && <AiProposalMergeNotice key="merged" />,
    resultOnly && !resultLaidOut && <AiProposalResultNotice key="result" />,
  ].filter(Boolean);
  return (
    <section
      className="ai-proposal-card ai-proposal-card--page"
      data-ai-proposal-card="page"
      data-content-hidden={state.contentHidden ? "" : undefined}
      data-ai-proposal-result-only={resultOnly ? "" : undefined}
      aria-label={t("card.dialogAria", { replace: { title } })}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && !state.contentHidden) {
          event.stopPropagation();
          update({ contentHidden: true });
        }
      }}
    >
      <AiProposalDecisionBar
        surface="page"
        title={title}
        applying={applying}
        replica={replica}
        notice={notices.length > 0 ? notices : undefined}
        references={sourceReferences && sourceReferences.length > 0 && (
          <AiSourceReferenceChips sourceReferences={sourceReferences} onOpenDocument={onOpenSourceDocument} />
        )}
        dismissReasonPlaceholder={t("card.dismissReasonExampleText")}
        onOpenConversation={onOpenConversation}
        onApply={onApply}
        onDismiss={onDismiss}
        {...decisionBarStateProps(state, update, { hasContent: true, hasBeforeShapes, offerAfterOnly: true, contentId: ownContentId })}
      />
      <div id={ownContentId} className="ai-proposal-card-content" hidden={state.contentHidden}>
        <AiProposalContentView
          content={bodyContent}
          surface="page"
          presentation={resultOnly ? "after" : "diff"}
          mathFractionSizing={mathFractionSizing}
        />
      </div>
    </section>
  );
}

export interface AiEditOverlayApprovalWidgetProps {
  preview: AiEditPreviewState;
  applying: boolean;
  /** 図形の上に置くか下に置くか (上に余白があれば上)。 */
  placement: "above" | "below";
  style: CSSProperties;
  /** Short "what changed" lines (see `summarizeAiEditPreviewChanges`) — up to 3
   * render verbatim, with any rest folded into "ほかn件". */
  changeSummaryLines?: string[];
  /** Opens this proposal's room in the shared floating conversation card. */
  onOpenConversation?: (anchorElement: HTMLElement) => void;
  onApply?: () => Promise<AiProposalApplyOutcome>;
  onDismiss?: (reason?: string) => void;
  displayState?: AiProposalDisplayState;
  onDisplayStateChange?: (patch: Partial<AiProposalDisplayState>) => void;
  /** 変更前/変更後が両方描かれる図形がある (更新・整列・置き換え)。バーに「変更前を隠す」を出す。 */
  hasBeforeShapes?: boolean;
  /** 内容が人の編集と合成したもの (本文も変える提案)。バーの下に一言を添える。 */
  mergedWithHumanEdits?: boolean;
}

/**
 * 図形だけの提案の承認バー。本文フローを持たない (ホワイトボードにはそもそも無い) ので、紙面の
 * カードと同じバーを図形の囲みのそばに付ける。親が overlay 層の中で絶対配置するので、本文の計測や
 * 改ページには加わらない。変更前 (赤い破線) と変更後 (緑) は紙面に常に描かれ、時間では切り替わらない。
 * 重なって読みにくいときはバーの「変更前を隠す」で出し分ける。
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
  displayState,
  onDisplayStateChange,
  hasBeforeShapes = false,
  mergedWithHumanEdits = false,
}: AiEditOverlayApprovalWidgetProps) {
  const t = useT("ai");
  const contentId = useId();
  const [state, update] = useProposalDisplayState(displayState, onDisplayStateChange);
  const visibleSessionLabel = getAiProposalSessionLabel(preview);
  const title = getAiProposalTitle(preview, t);
  const { shown: summaryShown, moreCount: summaryMoreCount } = splitChangeSummaryLines(changeSummaryLines ?? [], OVERLAY_SUMMARY_MAX_LINES);
  const hasContent = Boolean(visibleSessionLabel) || summaryShown.length > 0;
  return (
    <section
      className="ai-proposal-card ai-proposal-card--overlay"
      data-ai-proposal-card="overlay"
      data-placement={placement}
      style={style}
      aria-label={t("card.overlayDialogAria", { replace: { title } })}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <AiProposalDecisionBar
        surface="overlay"
        title={title}
        applying={applying}
        notice={mergedWithHumanEdits ? <AiProposalMergeNotice /> : undefined}
        dismissReasonPlaceholder={t("card.dismissReasonExampleShape")}
        onOpenConversation={onOpenConversation}
        onApply={onApply}
        onDismiss={onDismiss}
        {...decisionBarStateProps(state, update, { hasContent, hasBeforeShapes, contentId })}
      />
      {hasContent && (
        <div id={contentId} className="ai-overlay-approval-copy" hidden={state.contentHidden}>
          {visibleSessionLabel && <span className="ai-overlay-approval-label">{visibleSessionLabel}</span>}
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
      )}
    </section>
  );
}
