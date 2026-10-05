"use client";

import { WandSparkles } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  AiEditInlinePreviewCard,
  AiEditOverlayApprovalWidget,
  getAiProposalSessionLabel,
  OVERLAY_SUMMARY_MAX_LINES,
  type AiSourceReferenceOpenDocumentParams,
} from "./view";
import {
  PageCanvasEditor,
  type PageCanvasEditorProps,
} from "@/components/editor/PageCanvasEditor";
import {
  deriveAiEditPreviewDiff,
  deriveAiEditPreviewOverlayShapes,
  deriveAiEditPreviewShapeUpdates,
  getAiEditPreviewBeforeShapeIds,
  hasBodyAiEditChanges,
  isOverlayOnlyAiEditPreview,
  summarizeAiEditPreviewChanges,
  type AiApplyAnimationState,
  type AiEditPreviewDiff,
  type AiEditPreviewState,
} from "./model/preview";
import { readAiProposalDisplayState, type AiProposalDisplayState } from "./model/proposal-display-state";
import { useAiProposalDisplayStates } from "./application/use-ai-proposal-display-states";
import { useStableIdSet } from "./application/use-stable-id-set";
import {
  collectMergedUpdatedShapes,
  collectPendingRemovedBlockIds,
  groupPendingProposalContentByAnchor,
  resolveShapesKeptByMerge,
  withMergedShapes,
  type AiProposalAnchorCard,
} from "./model/proposal-content";
import { resolveProposalMergePreview, retainProposalMergePreviewFallbacks } from "./model/proposal-merge-preview";
import { AiRunAnchorLayer, type AiRunCardOpenRequest } from "@/components/editor/ai-run-anchor-layer";
import {
  getNarrowColumnBounds,
  placeCenteredWidget,
} from "@/components/editor/page-canvas/extension-placement";
import {
  getShapesSelectionBounds,
  resolveShapesPosition,
  type MeasuredBlock,
  type OverlayBlockGapMap,
} from "@/features/drawing";
import { getRenderableShapes } from "@/features/rendering/core";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import { countPerformanceEvent } from "@/lib/performance";
import type { OverlayShape } from "@/features/document";
import type {
  PageCanvasEditorExtension,
  PageCanvasGhostShape,
  PageCanvasInlineContent,
  PageCanvasOverlayPresentation,
  PageCanvasOverlayPresentationContext,
  PageCanvasSelectionAction,
  PageCanvasSelectionExtension,
  PageCanvasSelectionSource,
} from "@/components/editor/page-canvas/editor-extension";
import type { SelectionActionPopoverPosition } from "@/components/editor/page-canvas/popover-anchors";
import {
  createBlockAiEditReference,
  createInlineMathAiEditReference,
  createOverlaySelectionAiEditReference,
  createCanvasRegionAiEditReference,
  createTextSelectionAiEditReference,
  type AiEditReference,
} from "@/lib/ai/ai-edit-reference";
import { getSelectionActionKey } from "./selection-action-key";
import { buildShapesSvgPreview, type AiEditShapeOnlyPreview } from "@/lib/ai/ai-edit-shape-preview";
import { PAGE_GAP_PX } from "@/features/document";
import { mergeEditorExtensionSets } from "@/components/editor/webmcp/webmcp-editor-extensions";
import type { EditorExtensionContextValue } from "@/components/editor/editor-extension-context";

import { RegionCaptureLayer } from "@/components/editor/region-capture/RegionCaptureLayer";

import { useAiEditorExtensions } from "./editor-extensions";
import { AiScreenshotAskButton, type AiScreenshotRequestHandler } from "./view/AiScreenshotAskButton";
import { ProblemFrameChatNotices } from "./view/ProblemFrameChatNotices";
import type { AiProposalApplyOutcome } from "./application/proposal-action-model";

/** 浮かぶバーの幅。見出しと操作が 1 行に並ぶ幅 (段が狭ければ段に収める)。 */
const OVERLAY_APPROVAL_WIDGET_WIDTH = 320;
const OVERLAY_APPROVAL_WIDGET_GAP = 8;
const OVERLAY_APPROVAL_WIDGET_MARGIN = 12;

export interface AiPageCanvasEditorProps extends Omit<PageCanvasEditorProps, "pageExtension"> {
  /**
   * Keeps the canonical page editor available to hosts that do not provide the
   * desktop AI runtime. When disabled, no AI editor extension or selection
   * action is composed into the page editor.
   */
  aiEnabled?: boolean;
  aiEditPreviewGroups: AiEditPreviewState[];
  aiEditPreviewApplying: boolean;
  aiApplyAnimation?: AiApplyAnimationState | null;
  onAiReferenceRequest?: (
    reference: AiEditReference,
    anchor?: { left: number; top: number },
    overlayPreview?: AiEditShapeOnlyPreview,
  ) => void;
  onAiReferenceCandidateChange?: (reference: AiEditReference | null) => void;
  /** 範囲スクリーンショットの「AIに聞く」。撮った画像と、パネルを出す基準の位置が届く。 */
  onAiScreenshotRequest?: AiScreenshotRequestHandler;
  onAiEditPreviewApply?: (proposalIds: string[]) => Promise<AiProposalApplyOutcome>;
  onAiEditPreviewDismiss?: (proposalIds: string[], reason?: string) => void;
  onOpenSourceDocument?: (params: AiSourceReferenceOpenDocumentParams) => void;
  pinAiTextSelectionReference?: boolean;
  onInlineRunPortalReady?: (portal: HTMLElement | null) => void;
  documentIdentityKey?: string;
  /** True only while an approval/dismissal IPC is replacing the whole document. */
  aiDocumentWriteInProgress?: boolean;
  documentWorkspaceId?: string | null;
  onFocusAiSession?: (roomId: string) => void;
}

function AiPageCanvasEditorImpl(props: AiPageCanvasEditorProps) {
  countPerformanceEvent("AiPageCanvasEditor.render");
  if (props.aiEnabled === false) {
    return <PageCanvasEditor {...props} />;
  }

  return <AiEnabledPageCanvasEditor {...props} />;
}

/**
 * memo は「親が別の理由で描画されたときに紙面を巻き込まない」ための蓋。
 *
 * **今はまだ完全には効かない** — EditorShell から渡るハンドラのうち `onDelete` / `onInsertBodyBlock` /
 * `onPageLayoutChange` / `onOverlayChange` など数点がまだ毎レンダー作り直されており、そこが
 * 安定するまでは親の描画ごとに bail out する。打鍵の主効果はユニット単位の memo 側にあるので、
 * 残りの安定化 (ストア移管を含む) は follow-up。
 */
export const AiPageCanvasEditor = memo(AiPageCanvasEditorImpl);

function AiEnabledPageCanvasEditor({
  aiEditPreviewGroups,
  aiEditPreviewApplying,
  aiApplyAnimation = null,
  onAiReferenceRequest,
  onAiReferenceCandidateChange,
  onAiScreenshotRequest,
  onAiEditPreviewApply,
  onAiEditPreviewDismiss,
  onOpenSourceDocument,
  pinAiTextSelectionReference = false,
  onInlineRunPortalReady,
  documentIdentityKey,
  aiDocumentWriteInProgress = false,
  documentWorkspaceId = null,
  onFocusAiSession,
  ...pageEditorProps
}: AiPageCanvasEditorProps) {
  const documentShapes = useMemo(
    () => pageEditorProps.document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [],
    [pageEditorProps.document.pageLayout?.overlay?.overlaySnapshot?.shapes],
  );
  const aiEditorExtensions = useAiEditorExtensions({
    documentIdentityKey,
    previewGroups: aiEditPreviewGroups,
    documentWriteInProgress: aiDocumentWriteInProgress,
    shapes: documentShapes,
  });
  const { extension, beforeHiddenShapeIds } = useAiPageCanvasExtension({
    document: pageEditorProps.document,
    previewGroups: aiEditPreviewGroups,
    applying: aiEditPreviewApplying,
    applyAnimation: aiApplyAnimation,
    onReferenceRequest: onAiReferenceRequest,
    onReferenceCandidateChange: onAiReferenceCandidateChange,
    onApply: onAiEditPreviewApply,
    onDismiss: onAiEditPreviewDismiss,
    onOpenSourceDocument,
    retainTextSelectionReference: pinAiTextSelectionReference,
    onPortalReady: onInlineRunPortalReady,
    documentIdentityKey,
    documentWorkspaceId,
    onFocusSession: onFocusAiSession,
  });
  // 利用者がバーで隠した変更前の図形は、選べず編集もできない (見えない図形を動かさない)。
  const beforeHiddenExtensions = useMemo(
    () => buildAiBeforeHiddenEditorExtensions(beforeHiddenShapeIds),
    [beforeHiddenShapeIds],
  );
  const editorExtensions = useMemo(
    () => mergeEditorExtensionSets(
      mergeEditorExtensionSets(aiEditorExtensions, beforeHiddenExtensions),
      pageEditorProps.editorExtensions,
    ),
    [aiEditorExtensions, beforeHiddenExtensions, pageEditorProps.editorExtensions],
  );

  const screenshotActions = useMemo(
    () => onAiScreenshotRequest ? <AiScreenshotAskButton onRequest={onAiScreenshotRequest} /> : undefined,
    [onAiScreenshotRequest],
  );

  return (
    <>
      <PageCanvasEditor
        {...pageEditorProps}
        editorExtensions={editorExtensions}
        pageExtension={extension}
      />
      <RegionCaptureLayer actions={screenshotActions} />
      <ProblemFrameChatNotices
        documentIdentityKey={documentIdentityKey}
        document={pageEditorProps.document}
        onChange={pageEditorProps.onChange}
      />
    </>
  );
}

interface UseAiPageCanvasExtensionOptions {
  document: PageCanvasEditorProps["document"];
  previewGroups: AiEditPreviewState[];
  applying: boolean;
  applyAnimation: AiApplyAnimationState | null;
  onReferenceRequest?: AiPageCanvasEditorProps["onAiReferenceRequest"];
  onReferenceCandidateChange?: AiPageCanvasEditorProps["onAiReferenceCandidateChange"];
  onApply?: AiPageCanvasEditorProps["onAiEditPreviewApply"];
  onDismiss?: AiPageCanvasEditorProps["onAiEditPreviewDismiss"];
  onOpenSourceDocument?: AiPageCanvasEditorProps["onOpenSourceDocument"];
  retainTextSelectionReference: boolean;
  onPortalReady?: AiPageCanvasEditorProps["onInlineRunPortalReady"];
  documentIdentityKey?: string;
  documentWorkspaceId: string | null;
  onFocusSession?: AiPageCanvasEditorProps["onFocusAiSession"];
}

/** 提案が無いときに配り回す固定の空コレクション (identity を動かさないため)。 */
const EMPTY_PREVIEW_CARDS_BY_TARGET_ID: ReadonlyMap<string, AiProposalAnchorCard[]> = new Map();
const EMPTY_ID_SET: ReadonlySet<string> = new Set();
const EMPTY_INLINE_CONTENT: ReadonlyMap<string, PageCanvasInlineContent[]> = new Map();

function useAiPageCanvasExtension({
  document,
  previewGroups,
  applying,
  applyAnimation,
  onReferenceRequest,
  onReferenceCandidateChange,
  onApply,
  onDismiss,
  onOpenSourceDocument,
  retainTextSelectionReference,
  onPortalReady,
  documentIdentityKey,
  documentWorkspaceId,
  onFocusSession,
}: UseAiPageCanvasExtensionOptions): { extension: PageCanvasEditorExtension; beforeHiddenShapeIds: ReadonlySet<string> } {
  const t = useT("ai");
  // 承認・破棄で保留中でなくなった提案の、退避を数え済みという記録を捨てる (MISS R3)。
  useEffect(() => {
    retainProposalMergePreviewFallbacks(previewGroups);
  }, [previewGroups]);
  const inlinePreviewGroups = useMemo(
    () => previewGroups.filter(hasBodyAiEditChanges),
    [previewGroups],
  );
  // 提案が 1 つも無いときは文書が変わっても結果は空。ここで毎回新しい Map を作ると
  // その先の `inlineContentByTargetId` → `pageExtension` まで打鍵ごとに新品になる。
  // 承認が文書を差し替えている間 (applying) は、承認済みの提案が承認後の文書に重ねて描かれるので、
  // プレビューの代わりの経路を数えない。
  const previewCardsByTargetId = useMemo(
    () => inlinePreviewGroups.length === 0
      ? EMPTY_PREVIEW_CARDS_BY_TARGET_ID
      : groupPendingProposalContentByAnchor(inlinePreviewGroups, document, { countFallbacks: !applying }),
    [applying, document, inlinePreviewGroups],
  );
  // カードが 1 枚も無い提案 (図形だけ・本文を置ける場所が無い) は、紙面に浮かぶバーで決める。
  // カードのある提案はカードのバー 1 本で決める (図形の変更があっても浮かべない)。
  const floatingPreviewGroups = useMemo(() => {
    const previewsWithCards = new Set([...previewCardsByTargetId.values()].flat().map((card) => card.preview));
    return selectAiFloatingDecisionPreviews(previewGroups, previewsWithCards);
  }, [previewCardsByTargetId, previewGroups]);
  // 浮かぶバーの提案のうち、内容を人の編集と合成したもの (バーに一言を添える)。図形だけの提案も、
  // base を持てば合成のプレビューを作るので、人が直した図形があれば入る。提案ごとに覚えた結果を
  // 引くだけなので打鍵では軽い。
  const mergedFloatingKeys = useStableIdSet(floatingPreviewGroups.flatMap((preview) => (
    resolveProposalMergePreview(document, preview, { countFallbacks: !applying }).humanEditedUnits.length > 0
      ? [getAiProposalConversationKey(preview)]
      : []
  )));
  const roomIdsWithCards = useMemo(
    () => new Set(previewGroups.flatMap((preview) => preview.roomId ? [preview.roomId] : [])),
    [previewGroups],
  );
  const liveDisplayKeys = useMemo(() => {
    const live = new Map<string, readonly string[]>();
    for (const preview of previewGroups) {
      live.set(getAiProposalConversationKey(preview), preview.proposalIds);
    }
    for (const [targetId, cards] of previewCardsByTargetId) {
      for (const card of cards) {
        live.set(getAiProposalCardKey(targetId, card.preview), card.preview.proposalIds);
      }
    }
    return live;
  }, [previewCardsByTargetId, previewGroups]);
  const [displayStates, updateDisplayState] = useAiProposalDisplayStates(liveDisplayKeys);
  const runCardRequestIdRef = useRef(0);
  const [runCardOpenRequest, setRunCardOpenRequest] = useState<AiRunCardOpenRequest | null>(null);
  const openProposalConversation = useCallback((preview: AiEditPreviewState, anchorElement: HTMLElement) => {
    if (!preview.roomId) {
      return;
    }
    runCardRequestIdRef.current += 1;
    setRunCardOpenRequest({
      requestId: runCardRequestIdRef.current,
      roomId: preview.roomId,
      anchorElement,
      provider: preview.providers[0] ?? "chatgpt",
      anchorBlockId: preview.targetId || null,
    });
  }, []);
  const activeRunCardOpenRequest = runCardOpenRequest
    && roomIdsWithCards.has(runCardOpenRequest.roomId)
    ? runCardOpenRequest
    : null;

  const inlineContentByTargetId = useMemo(() => {
    if (previewCardsByTargetId.size === 0) {
      return EMPTY_INLINE_CONTENT;
    }
    const result = new Map<string, PageCanvasInlineContent[]>();
    for (const [targetId, cards] of previewCardsByTargetId) {
      result.set(targetId, cards.map((card) => {
        const { preview } = card;
        const key = getAiProposalCardKey(targetId, preview);
        const conversationKey = getAiProposalConversationKey(preview);
        // カードの状態と、提案ごとの「変更前を隠す」(同じ提案の図形すべてに効く) を合わせて渡す。
        const displayState: AiProposalDisplayState = {
          ...readAiProposalDisplayState(displayStates, key, preview.proposalIds),
          beforeHidden: readAiProposalDisplayState(displayStates, conversationKey, preview.proposalIds).beforeHidden,
        };
        return {
          key,
          measureRevision: getAiProposalCardMeasureRevision(card, document.metadata.mathFractionSizing, displayState),
          content: (
            <AiEditInlinePreviewCard
              content={card.content}
              mathFractionSizing={document.metadata.mathFractionSizing}
              sourceReferences={preview.sourceReferences}
              applying={applying}
              displayState={displayState}
              onDisplayStateChange={({ beforeHidden, ...cardPatch }) => {
                if (beforeHidden !== undefined) {
                  updateDisplayState(conversationKey, preview.proposalIds, { beforeHidden });
                }
                if (Object.keys(cardPatch).length > 0) {
                  updateDisplayState(key, preview.proposalIds, cardPatch);
                }
              }}
              hasBeforeShapes={getAiEditPreviewBeforeShapeIds(preview).length > 0}
              mergedWithHumanEdits={card.mergedWithHumanEdits}
              onOpenConversation={preview.roomId
                ? (anchorElement) => openProposalConversation(preview, anchorElement)
                : undefined}
              onOpenSourceDocument={onOpenSourceDocument}
              onApply={onApply ? () => onApply(preview.proposalIds) : undefined}
              onDismiss={onDismiss ? (reason) => onDismiss(preview.proposalIds, reason) : undefined}
            />
          ),
        };
      }));
    }
    return result;
  }, [applying, displayStates, document.metadata.mathFractionSizing, onApply, onDismiss, onOpenSourceDocument, openProposalConversation, previewCardsByTargetId, updateDisplayState]);

  const previewDiff = useMemo(
    () => deriveAiEditPreviewDiff(previewGroups, document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? []),
    [document.pageLayout?.overlay?.overlaySnapshot?.shapes, previewGroups],
  );
  // 本文の赤い下地は、カードの削除側と同じ合成後の内容から作る。AI が消すブロックを人が直して合成で
  // 残るなら塗らない (draft から数えると承認の規則を二重に持つ。MISS R17)。カードは打鍵のたびに
  // 作り直されるので、中身が同じなら同じ集合を使う (各本文ユニットの props を動かさない)。
  const removedBlockIds = useStableIdSet(collectPendingRemovedBlockIds(previewCardsByTargetId));
  const textFlowChangeDecorationState = useMemo(() => {
    const removedIds = [...removedBlockIds];
    const removingIds = applyAnimation?.removingBlockIds ?? [];
    const addedIds = applyAnimation?.addedBlockIds ?? [];
    return removedIds.length === 0 && removingIds.length === 0 && addedIds.length === 0
      ? undefined
      : { removedIds, removingIds, addedIds };
  }, [applyAnimation, removedBlockIds]);
  // 図形の赤い削除表示も同じく、合成で残る図形 (人が直した図形) には付けない。図形を消す提案だけが、
  // 提案ごとに覚えた結果を引く (合成と図形の並びが同じなら作り直さない)。
  const mergeKeptShapeIdList = useMemo(
    () => previewGroups.flatMap((preview) => [...resolveShapesKeptByMerge(document, preview, { countFallbacks: !applying })]),
    [applying, document, previewGroups],
  );
  const mergeKeptShapeIds = useStableIdSet(mergeKeptShapeIdList);
  // 図形の変更後の姿 (ゴースト) も、base を持つ提案は合成後の文書の図形で描く (MISS R17)。提案ごとに
  // 覚えた合成を引くので、中身が同じなら同じ Map を配る (紙面の拡張を打鍵のたびに作り直さない)。
  const mergedUpdatedShapeList = useMemo(
    () => collectMergedUpdatedShapes(previewGroups, document, { countFallbacks: !applying }),
    [applying, document, previewGroups],
  );
  const mergedUpdatedShapesKey = useMemo(() => JSON.stringify(mergedUpdatedShapeList), [mergedUpdatedShapeList]);
  const mergedUpdatedShapes = useMemo<ReadonlyMap<string, OverlayShape>>(
    () => new Map(mergedUpdatedShapeList.map((shape) => [shape.id, shape])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mergedUpdatedShapesKey],
  );
  // 中身が同じなら同じ集合 (図形の印・編集の方針・紙面の拡張を作り直さない)。
  const beforeHiddenShapeIds = useStableIdSet(previewGroups.flatMap((preview) => (
    readAiProposalDisplayState(displayStates, getAiProposalConversationKey(preview), preview.proposalIds).beforeHidden
      ? getAiEditPreviewBeforeShapeIds(preview)
      : []
  )));
  const overlayShapeClassNames = useMemo(
    () => deriveAiOverlayShapeClassNames({ previewGroups, previewDiff, applyAnimation, beforeHiddenShapeIds, mergeKeptShapeIds }),
    [applyAnimation, beforeHiddenShapeIds, mergeKeptShapeIds, previewDiff, previewGroups],
  );

  const resolveOverlayPresentation = useCallback((
    context: PageCanvasOverlayPresentationContext,
  ): PageCanvasOverlayPresentation => {
    const replacementShapeIds = new Set(
      previewGroups.flatMap((preview) => (preview.shapeReplacements ?? []).map((pair) => pair.removedShapeId)),
    );
    const finalShapeUpdates = new Map(
      withMergedShapes(deriveAiEditPreviewShapeUpdates(previewGroups, context.overlayShapes), mergedUpdatedShapes)
        .map((update) => [update.shapeId, update]),
    );
    const addedShapeIds = new Set(previewDiff.addedShapes.map((entry) => entry.shape.id));
    const unresolvedGhosts: PageCanvasGhostShape[] = [
      ...previewDiff.addedShapes.map((entry) => ({
        key: `ai-diff-ghost-${entry.shape.id}`,
        shape: entry.shape,
        assets: entry.assets,
        className: replacementShapeIds.has(entry.shape.id)
          ? "ai-diff-added-shape ai-diff-after-shape ai-diff-ghost-shape"
          : "ai-diff-added-shape ai-diff-ghost-shape",
      })),
      ...[...finalShapeUpdates.values()].filter((update) => !addedShapeIds.has(update.shapeId)).map((update) => ({
        key: `ai-diff-ghost-${update.after.id}`,
        shape: update.after,
        // 派生画像を差し替える更新は、その画像も一緒に運んでくる。文書側のassetsだけで描くと
        // 「新しい図形に古い絵」というプレビューになる。
        assets: update.replacedAssets
          ? { ...context.overlayAssets, ...update.replacedAssets }
          : context.overlayAssets,
        className: "ai-diff-after-shape ai-diff-ghost-shape",
      })),
    ];
    const ghostEntriesById = new Map(unresolvedGhosts.map((entry) => [entry.shape.id, entry]));
    const resolvedGhostShapes = resolveAiEditGhostShapes(
      unresolvedGhosts.map((entry) => entry.shape),
      context.overlayShapes,
      context.blockRects,
      context.blockGaps,
    ).flatMap((shape) => {
      const source = ghostEntriesById.get(shape.id);
      return source ? [{ ...source, shape }] : [];
    });

    const pageBounds = { left: 0, right: context.pageWidthPx, width: context.pageWidthPx };
    const floating = floatingPreviewGroups.map((preview) => {
      const conversationKey = getAiProposalConversationKey(preview);
      const displayState = readAiProposalDisplayState(displayStates, conversationKey, preview.proposalIds);
      const changeLines = summarizeAiEditPreviewChanges(preview, context.overlayShapes, t, mergeKeptShapeIds);
      // 本文も変える提案は、図形の要約だけでは何の提案か分からない (余白の変更など) ので、AI の要約を先に添える。
      const draftSummary = preview.draft.summary.trim();
      const summaryLines = !isOverlayOnlyAiEditPreview(preview) && draftSummary
        ? [draftSummary, ...changeLines]
        : changeLines;
      const insertionAnchorBlockId = getOverlayInsertionAnchorBlockId(preview);
      const insertionColumnBounds = insertionAnchorBlockId
        ? getNarrowColumnBounds(context.blockRects.get(insertionAnchorBlockId), context.contentWidthPx)
        : null;
      const request: FloatingDecisionBarRequest = {
        key: conversationKey,
        bounds: resolveAiProposalShapeBounds(preview, context),
        horizontalBounds: insertionColumnBounds ?? pageBounds,
        heightPx: estimateFloatingDecisionBarHeight({
          summaryLineCount: Math.min(summaryLines.length, OVERLAY_SUMMARY_MAX_LINES) + (summaryLines.length > OVERLAY_SUMMARY_MAX_LINES ? 1 : 0),
          hasSessionLabel: Boolean(getAiProposalSessionLabel(preview)),
          hasApplyError: Boolean(displayState.applyError),
        }),
      };
      return { preview, conversationKey, displayState, summaryLines, request };
    });
    const placements = placeFloatingDecisionBars(floating.map((entry) => entry.request), {
      pageWidthPx: context.pageWidthPx,
      pageStridePx: context.pageHeightPx + PAGE_GAP_PX,
      desiredWidthPx: OVERLAY_APPROVAL_WIDGET_WIDTH,
      gapPx: OVERLAY_APPROVAL_WIDGET_GAP,
      marginPx: OVERLAY_APPROVAL_WIDGET_MARGIN,
    });
    const widgets = floating.map(({ preview, conversationKey, displayState, summaryLines }, index) => {
      const placement = placements[index];
      return (
        <AiEditOverlayApprovalWidget
          key={conversationKey}
          preview={preview}
          applying={applying}
          placement={placement.placement}
          style={{
            left: `${placement.left}px`,
            top: `${placement.top}px`,
            width: `${placement.width}px`,
          }}
          changeSummaryLines={summaryLines}
          displayState={displayState}
          onDisplayStateChange={(patch) => updateDisplayState(conversationKey, preview.proposalIds, patch)}
          hasBeforeShapes={getAiEditPreviewBeforeShapeIds(preview).length > 0}
          mergedWithHumanEdits={mergedFloatingKeys.has(conversationKey)}
          onOpenConversation={preview.roomId
            ? (anchorElement) => openProposalConversation(preview, anchorElement)
            : undefined}
          onApply={onApply ? () => onApply(preview.proposalIds) : undefined}
          onDismiss={onDismiss ? (reason) => onDismiss(preview.proposalIds, reason) : undefined}
        />
      );
    });

    return {
      ghostShapes: resolvedGhostShapes,
      floatingContent: widgets,
    };
  }, [applying, displayStates, floatingPreviewGroups, mergeKeptShapeIds, mergedFloatingKeys, mergedUpdatedShapes, onApply, onDismiss, openProposalConversation, previewDiff, previewGroups, t, updateDisplayState]);

  // 参照系のコールバックは ref 経由で最新を読む。identity を deps に入れると、親が 1 回
  // 描画するたびに selection 拡張が作り直され、PageCanvasEditor 側の選択 effect が再 arm
  // される。その effect の state 更新がまた親を描画するので、何もしていなくても回り続ける。
  // 代入は layout effect で行う (レンダー中の代入は react-hooks/refs 違反)。paint 前・
  // 次の入力処理前に走るので、イベント時に読む値は常に最新になる。
  const onReferenceRequestRef = useRef(onReferenceRequest);
  const onReferenceCandidateChangeRef = useRef(onReferenceCandidateChange);
  useLayoutEffect(() => {
    onReferenceRequestRef.current = onReferenceRequest;
    onReferenceCandidateChangeRef.current = onReferenceCandidateChange;
  }, [onReferenceCandidateChange, onReferenceRequest]);
  const hasReferenceRequest = Boolean(onReferenceRequest);

  const documentRef = useRef(document);
  useLayoutEffect(() => {
    documentRef.current = document;
  }, [document]);
  /**
   * 選択拡張は文書に追従させる (`document` を deps に残す)。
   *
   * `createAction` は**レンダー中に呼ばれる経路がある** (紙面の選択ポップオーバーの memo) ので、
   * ここで ref だけに頼ると 1 コミット古い文書を見て「AIに追加」ボタンが出ないことがある。
   * 一方、いったん state に入ったアクションは差し替わらない (鍵は場所ベース) ので、押した
   * 瞬間の参照づくりは `getDocument()` で最新から作り直す。**両方必要**。
   */
  const selection = useMemo<PageCanvasSelectionExtension | undefined>(() => {
    if (!hasReferenceRequest) {
      return undefined;
    }
    return {
      createAction: (source) => createSelectionAction({
        document,
        getDocument: () => documentRef.current,
        source,
        t,
        onReferenceRequest: (reference, anchor, overlayPreview) => {
          onReferenceRequestRef.current?.(reference, anchor, overlayPreview);
        },
        onReferenceCandidateChange: (reference) => {
          onReferenceCandidateChangeRef.current?.(reference);
        },
      }),
      clearCandidate: () => onReferenceCandidateChangeRef.current?.(null),
      retainCandidateOnTextSelectionClear: retainTextSelectionReference,
    };
  }, [document, hasReferenceRequest, retainTextSelectionReference, t]);

  const renderCanvasLayer = useCallback<NonNullable<PageCanvasEditorExtension["renderCanvasLayer"]>>((context) => {
    if (!documentIdentityKey || !onFocusSession) {
      return null;
    }
    return (
      <AiRunAnchorLayer
        documentIdentityKey={documentIdentityKey}
        document={context.document}
        documentWorkspaceId={documentWorkspaceId}
        blockRects={context.blockRects}
        blockIdsWithProposalCards={context.inlineContentTargetIds}
        roomIdsWithProposalCards={roomIdsWithCards}
        canvasElement={context.canvasElement}
        openCardRequest={activeRunCardOpenRequest}
        onFocusSession={onFocusSession}
      />
    );
  }, [activeRunCardOpenRequest, documentIdentityKey, documentWorkspaceId, onFocusSession, roomIdsWithCards]);
  const portal = useMemo(() => ({
    className: "ai-inline-run-portal",
    onReady: onPortalReady,
  }), [onPortalReady]);

  const extension = useMemo<PageCanvasEditorExtension>(() => ({
    inlineContentByTargetId,
    textFlowChangeDecorationState,
    overlayShapeClassNames,
    resolveOverlayPresentation,
    selection,
    renderCanvasLayer,
    portal,
  }), [
    inlineContentByTargetId,
    overlayShapeClassNames,
    portal,
    renderCanvasLayer,
    resolveOverlayPresentation,
    selection,
    textFlowChangeDecorationState,
  ]);
  return { extension, beforeHiddenShapeIds };
}

function createSelectionAction({
  document,
  getDocument,
  source,
  t,
  onReferenceRequest,
  onReferenceCandidateChange,
}: {
  /** 「AIに追加」ボタンの読み上げ。描画中に決まるので hook ではなく引数で受ける。 */
  t: Translate<"ai">;
  /**
   * このアクションを作った時点の文書。**ボタンを出すかどうか**の判定に使う (この関数は
   * レンダー中にも呼ばれるので、ここで ref を読むと 1 コミット古い文書を見てしまう)。
   */
  document: PageCanvasEditorProps["document"];
  /**
   * 押した瞬間の文書。アクションの鍵は場所ベースなので、同じ場所を選んだまま本文が変わっても
   * state のアクションは差し替わらない。古い本文が AI へ渡らないよう、参照はここで作り直す。
   */
  getDocument: () => PageCanvasEditorProps["document"];
  source: PageCanvasSelectionSource;
  onReferenceRequest: NonNullable<AiPageCanvasEditorProps["onAiReferenceRequest"]>;
  onReferenceCandidateChange?: AiPageCanvasEditorProps["onAiReferenceCandidateChange"];
}): PageCanvasSelectionAction | null {
  const buildReference = (
    documentAtUse: PageCanvasEditorProps["document"],
  ): { reference: AiEditReference | null; overlayPreview?: AiEditShapeOnlyPreview } => {
    const document = documentAtUse;
    let reference: AiEditReference | null = null;
    let overlayPreview: AiEditShapeOnlyPreview | undefined;
    if (source.kind === "textRange") {
      reference = createTextSelectionAiEditReference({
        document,
        targetId: source.targetId,
        selectedText: source.selectedText,
        mathTex: source.mathTex,
        textRange: source.textRange,
      });
    } else if (source.kind === "inlineMath") {
      reference = createInlineMathAiEditReference({
        document,
        targetId: source.targetId,
        mathInlineId: source.mathInlineId,
        tex: source.tex,
      });
    } else if (source.kind === "block") {
      reference = createBlockAiEditReference(document, source.targetId);
    } else {
      reference = source.selection.region
        ? createCanvasRegionAiEditReference(source.selection.region)
        : createOverlaySelectionAiEditReference({
        document,
        targetId: source.targetId,
        selectedShapeIds: source.selection.selectedShapeIds,
        shapes: source.selection.selectedShapes,
        assets: source.selection.selectedAssets,
      });
      if (source.selection.selectedShapes.length > 0) {
        overlayPreview = buildShapesSvgPreview(source.selection.selectedShapes, source.selection.selectedAssets, {
          paddingPx: 10,
          minWidthPx: 48,
          minHeightPx: 48,
        }) ?? undefined;
      }
    }
    return { reference, overlayPreview };
  };

  const built = buildReference(document);
  if (!built.reference) {
    return null;
  }

  const referenceKind = built.reference.kind;
  return {
    key: getSelectionActionKey(source, built.reference),
    notifyCandidate: source.kind === "textRange"
      ? () => onReferenceCandidateChange?.(buildReference(getDocument()).reference)
      : undefined,
    render: (position: SelectionActionPopoverPosition) => (
      <button
        type="button"
        title={t("reference.addToAi")}
        aria-label={t("reference.addToAi")}
        data-reference-kind={referenceKind}
        className="selection-action-labeled"
        onClick={(event) => {
          event.stopPropagation();
          const latest = buildReference(getDocument());
          if (!latest.reference) {
            return;
          }
          onReferenceRequest(
            latest.reference,
            position,
            latest.reference.overlaySelection ? latest.overlayPreview : undefined,
          );
        }}
      >
        <WandSparkles size={16} aria-hidden="true" />
        <span>{t("reference.addToAiShort")}</span>
      </button>
    ),
  };
}

/** 提案が触れる図形 (適用後の姿) の囲み。図形に触れない提案や、位置が決まらないときは null。 */
function resolveAiProposalShapeBounds(
  preview: AiEditPreviewState,
  context: PageCanvasOverlayPresentationContext,
): { x: number; y: number; w: number; h: number } | null {
  const affectedShapes = deriveAiEditPreviewOverlayShapes(preview, context.overlayShapes);
  if (affectedShapes.length === 0) {
    return null;
  }
  const shapesById = new Map(context.overlayShapes.map((shape) => [shape.id, shape]));
  affectedShapes.forEach((shape) => shapesById.set(shape.id, shape));
  const resolvedById = new Map(
    resolveShapesPosition([...shapesById.values()], context.blockRects, context.blockGaps)
      .map((shape) => [shape.id, shape]),
  );
  return getShapesSelectionBounds(affectedShapes.flatMap((shape) => {
    const resolved = resolvedById.get(shape.id);
    return resolved ? [resolved] : [];
  })) ?? null;
}

/**
 * 提案プレビューのゴースト図形を、適用後とまったく同じ経路で解決する。
 *
 * - 既存図形と **まとめて** `resolveShapesPosition` に通す。`type:"shape"` アンカーの
 *   親は同一配列内でしか探されないため、ゴーストだけを渡すと既存図形を親に持つ
 *   ゴーストが未解決のまま描かれる。
 * - `getRenderableShapes` を通し、group / 非表示図形の扱いを適用後と揃える。
 */
export function resolveAiEditGhostShapes<T extends OverlayShape>(
  ghostShapes: T[],
  existingShapes: readonly OverlayShape[],
  blockRects: Map<string, MeasuredBlock>,
  blockGaps: OverlayBlockGapMap,
): T[] {
  if (ghostShapes.length === 0) {
    return [];
  }
  const ghostIds = new Set(ghostShapes.map((shape) => shape.id));
  const resolved = resolveShapesPosition(
    [...existingShapes.filter((shape) => !ghostIds.has(shape.id)), ...ghostShapes],
    blockRects,
    blockGaps,
  );
  return getRenderableShapes(resolved).filter((shape): shape is T => ghostIds.has(shape.id));
}

/**
 * 提案のまとまり (プレビュー) の名前。同じ部屋の追加ターンは同じまとまりに足される
 * (`groupMcpProposalsForPreview`) ので、提案 id の並びではなく部屋 → run → 最初の提案で決める。
 * これを key にすれば、追加ターンでカードやウィジェットが作り直されない。
 */
export function getAiProposalConversationKey(preview: AiEditPreviewState): string {
  if (preview.roomId) return `room:${preview.roomId}`;
  if (preview.runId) return `run:${preview.runId}`;
  return `proposal:${preview.proposalIds[0] ?? ""}`;
}

/** 紙面のカード (フロー内の拡張ノード) の key。ページ全体で一意: 対象 × まとまり。 */
export function getAiProposalCardKey(anchorBlockId: string, preview: AiEditPreviewState): string {
  return `ai-proposal:${anchorBlockId}:${getAiProposalConversationKey(preview)}`;
}

/**
 * カードの中身の版 (`PageCanvasInlineContent.measureRevision`)。中身が同じなら同じ値で、高さが
 * 変わらない書き換え (行の位置だけが変わる) でも値が変わり、紙面が行を測り直す。カードの高さを
 * 変える表示状態 (内容を隠した・適用の失敗) も含める。
 */
export function getAiProposalCardMeasureRevision(
  card: AiProposalAnchorCard,
  mathFractionSizing: string | undefined,
  displayState?: Partial<AiProposalDisplayState>,
): string {
  const source = JSON.stringify(
    [
      mathFractionSizing ?? "",
      card.preview.sourceReferences ?? [],
      card.content.hunks,
      card.mergedWithHumanEdits,
      displayState?.contentHidden ?? false,
      displayState?.applyError ?? null,
    ],
    (_key, value: unknown) => (value instanceof Map ? [...value.entries()] : value),
  );
  // FNV-1a (32bit)。属性に載せるので短い印にする。
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${source.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

/**
 * 紙面の図形に付ける提案の印。変更前 (今の図形) は赤い破線、変更後はゴースト (`resolveOverlayPresentation`)。
 * どちらも常に描き、時間では切り替えない。利用者がバーで隠した変更前だけ `ai-diff-before-hidden` を足す。
 */
export function deriveAiOverlayShapeClassNames({
  previewGroups,
  previewDiff,
  applyAnimation,
  beforeHiddenShapeIds,
  mergeKeptShapeIds = EMPTY_ID_SET,
}: {
  previewGroups: readonly AiEditPreviewState[];
  previewDiff: AiEditPreviewDiff;
  applyAnimation: AiApplyAnimationState | null;
  beforeHiddenShapeIds: ReadonlySet<string>;
  /** AI が消す図形のうち、人が直したので承認の合成で残るもの (`collectShapesKeptByMerge`)。削除の印を付けない。 */
  mergeKeptShapeIds?: ReadonlySet<string>;
}): Map<string, string> {
  const result = new Map<string, string>();
  const replacementShapeIds = new Set(
    previewGroups.flatMap((preview) => (preview.shapeReplacements ?? []).map((pair) => pair.removedShapeId)),
  );
  const beforeClassName = (id: string, base: string) => (
    beforeHiddenShapeIds.has(id) ? `${base} ai-diff-before-hidden` : base
  );
  for (const id of previewDiff.modifiedShapeIds) {
    result.set(id, beforeClassName(id, "ai-diff-modified-shape ai-diff-before-shape"));
  }
  for (const id of previewDiff.removedShapeIds) {
    if (mergeKeptShapeIds.has(id)) {
      continue;
    }
    result.set(id, replacementShapeIds.has(id)
      ? beforeClassName(id, "ai-diff-removed-shape ai-diff-before-shape")
      : "ai-diff-removed-shape");
  }
  for (const id of applyAnimation?.removingShapeIds ?? []) {
    result.set(id, "ai-apply-removing-shape");
  }
  for (const id of applyAnimation?.addedShapeIds ?? []) {
    result.set(id, "ai-apply-added-shape");
  }
  return result;
}

/**
 * 紙面に浮かぶバーで決める提案: 本文フローにカードが 1 枚も無い提案すべて。図形だけの提案に限らず、
 * 本文の変更が置けない場所 (文書に無いブロック・対象ブロックを持たない操作など) にしかない提案も
 * ここに入る。そうしないと紙面のどこにも承認・破棄の操作が出ない。カードがある提案はカードの
 * バー 1 本で決める (図形の変更があっても浮かべない)。
 */
/**
 * 利用者がバーで隠した変更前の図形 (`ai-diff-before-hidden`) を、紙面で選べず編集もできない図形にする。
 * 見えないまま選ばれて動かされると、利用者の知らないうちに文書が変わる (提案の対象を鍵で守らない
 * 提案 (WebMCP) でも同じ)。
 */
export function buildAiBeforeHiddenEditorExtensions(
  beforeHiddenShapeIds: ReadonlySet<string>,
): EditorExtensionContextValue | undefined {
  if (beforeHiddenShapeIds.size === 0) {
    return undefined;
  }
  return {
    overlayEditPolicy: {
      lockedShapeIds: beforeHiddenShapeIds,
      unselectableShapeIds: beforeHiddenShapeIds,
    },
  };
}

export function selectAiFloatingDecisionPreviews(
  previewGroups: readonly AiEditPreviewState[],
  previewsWithCards: ReadonlySet<AiEditPreviewState>,
): AiEditPreviewState[] {
  return previewGroups.filter((preview) => !previewsWithCards.has(preview));
}

/** 浮かぶバーの高さの見積もりに使う寸法 (CSS の値に合わせる)。 */
const FLOATING_BAR_ROW_PX = 30; // 操作ボタン (sm) 1 行
const FLOATING_BAR_CHROME_PX = 2 * 8 + 2; // 上下の padding (--space-sm) と枠線
const FLOATING_BAR_ROW_GAP_PX = 4; // 行の間 (--space-xs)
const FLOATING_BAR_LABEL_LINE_PX = 13; // セッション名 (10px × 1.3)
const FLOATING_BAR_SUMMARY_LINE_PX = 15; // 要約 1 行 (11px × 1.35)
const FLOATING_BAR_SUMMARY_MARGIN_PX = 2;
const FLOATING_BAR_ERROR_PX = 18 + 3 * 19; // 失敗の理由 (padding と枠線 + 3 行まで)
/** 重ねて置くときのバーの間。 */
const FLOATING_BAR_STACK_GAP_PX = 4;

/**
 * 浮かぶバーの高さの見積もり (実際の高さ以上)。バーは 1 行で折り返さないので、その下に並ぶ行
 * (セッション名・要約・失敗の理由) の数で決まる。重ね置きで隣のバーを覆わないために使う。
 */
export function estimateFloatingDecisionBarHeight({
  summaryLineCount,
  hasSessionLabel,
  hasApplyError,
}: {
  summaryLineCount: number;
  hasSessionLabel: boolean;
  hasApplyError: boolean;
}): number {
  let height = FLOATING_BAR_CHROME_PX + FLOATING_BAR_ROW_PX;
  if (hasApplyError) {
    height += FLOATING_BAR_ROW_GAP_PX + FLOATING_BAR_ERROR_PX;
  }
  if (hasSessionLabel || summaryLineCount > 0) {
    height += FLOATING_BAR_ROW_GAP_PX
      + (hasSessionLabel ? FLOATING_BAR_LABEL_LINE_PX : 0)
      + (summaryLineCount > 0 ? FLOATING_BAR_SUMMARY_MARGIN_PX + summaryLineCount * FLOATING_BAR_SUMMARY_LINE_PX : 0);
  }
  return Math.ceil(height);
}

export interface FloatingDecisionBarRequest {
  key: string;
  /** バーを添える図形の囲み (紙面の座標)。無ければ 1 ページ目の上端に置く。 */
  bounds: { x: number; y: number; w: number; h: number } | null;
  /** 横に収める範囲 (段組みの段など)。 */
  horizontalBounds: { left: number; right: number; width: number };
  heightPx: number;
}

export interface FloatingDecisionBarPlacement {
  key: string;
  /** `above`: `top` がバーの下端 (図形の上に置く)。`below`: `top` がバーの上端。 */
  placement: "above" | "below";
  /** バーの横の中心。 */
  left: number;
  top: number;
  width: number;
}

/**
 * 浮かぶバーを置く。図形の上に余白があれば上、無ければ下。図形が無ければ 1 ページ目の上端の右寄せ
 * (本文の先頭のブロックの選択ポップオーバーは中央に出るので、それと重ならない側)。
 * 先に置いたバーと重なるときは、見積もった高さで重ならないところまで (上に置くものは上へ、
 * 下に置くものは下へ) ずらす。
 */
export function placeFloatingDecisionBars(
  requests: readonly FloatingDecisionBarRequest[],
  frame: { pageWidthPx: number; pageStridePx: number; desiredWidthPx: number; gapPx: number; marginPx: number },
): FloatingDecisionBarPlacement[] {
  const placedRects: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  return requests.map((request) => {
    const { bounds, heightPx } = request;
    const horizontal = placeCenteredWidget(
      bounds ? bounds.x + bounds.w / 2 : request.horizontalBounds.right - frame.marginPx - frame.desiredWidthPx / 2,
      frame.desiredWidthPx,
      request.horizontalBounds,
      frame.marginPx,
    );
    let placement: "above" | "below" = "below";
    let top = frame.marginPx;
    if (bounds) {
      const pageTop = Math.max(0, Math.floor(bounds.y / frame.pageStridePx)) * frame.pageStridePx;
      placement = bounds.y - pageTop >= heightPx + frame.gapPx ? "above" : "below";
      top = placement === "above" ? bounds.y - frame.gapPx : bounds.y + bounds.h + frame.gapPx;
    }
    const rectAt = (nextTop: number) => ({
      left: horizontal.center - horizontal.width / 2,
      right: horizontal.center + horizontal.width / 2,
      top: placement === "above" ? nextTop - heightPx : nextTop,
      bottom: placement === "above" ? nextTop : nextTop + heightPx,
    });
    for (let attempt = 0; attempt <= placedRects.length; attempt += 1) {
      const rect = rectAt(top);
      const blocker = placedRects.find((other) => (
        rect.left < other.right && other.left < rect.right && rect.top < other.bottom && other.top < rect.bottom
      ));
      if (!blocker) {
        break;
      }
      top = placement === "above" ? blocker.top - FLOATING_BAR_STACK_GAP_PX : blocker.bottom + FLOATING_BAR_STACK_GAP_PX;
    }
    placedRects.push(rectAt(top));
    return { key: request.key, placement, left: horizontal.center, top, width: horizontal.width };
  });
}

export function getOverlayInsertionAnchorBlockId(preview: AiEditPreviewState): string | null {
  if ((preview.shapeReplacements?.length ?? 0) > 0 || (preview.draft.mutationOperations?.length ?? 0) > 0) {
    return null;
  }
  const operations = preview.draft.operations;
  if (
    operations.length === 0 ||
    !operations.every((operation) =>
      operation.operation === "insertOverlayShape" || operation.operation === "insertTableShape")
  ) {
    return null;
  }
  const blockIds = new Set(operations.map((operation) => {
    const shape = operation.operation === "insertOverlayShape"
      ? operation.overlayShape
      : operation.tableShape;
    return shape.anchor?.type === "block" ? shape.anchor.blockId : operation.targetId;
  }).filter(Boolean));
  return blockIds.size === 1 ? [...blockIds][0] : null;
}
