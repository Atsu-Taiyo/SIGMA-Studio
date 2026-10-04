"use client";

import { WandSparkles } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  AiEditInlinePreviewCard,
  AiEditOverlayApprovalWidget,
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
import {
  patchAiProposalDisplayState,
  pruneAiProposalDisplayStates,
  readAiProposalDisplayState,
  type AiProposalDisplayState,
  type AiProposalDisplayStates,
} from "./model/proposal-display-state";
import { groupPendingProposalContentByAnchor, type AiProposalAnchorCard } from "./model/proposal-content";
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

import { RegionCaptureLayer } from "@/components/editor/region-capture/RegionCaptureLayer";

import { useAiEditorExtensions } from "./editor-extensions";
import { AiScreenshotAskButton, type AiScreenshotRequestHandler } from "./view/AiScreenshotAskButton";
import { ProblemFrameChatNotices } from "./view/ProblemFrameChatNotices";
import type { AiProposalApplyOutcome } from "./application/proposal-action-model";

/** 図形のそばのバーの幅。見出しと操作が 1 行に並ぶ幅 (段が狭ければ段に収める)。 */
const OVERLAY_APPROVAL_WIDGET_WIDTH = 320;
/** 上に置けるかの判定に使う高さの見積もり (バー + 要約 3 行)。 */
const OVERLAY_APPROVAL_WIDGET_ESTIMATED_HEIGHT = 96;
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
  const editorExtensions = useMemo(
    () => mergeEditorExtensionSets(aiEditorExtensions, pageEditorProps.editorExtensions),
    [aiEditorExtensions, pageEditorProps.editorExtensions],
  );
  const extension = useAiPageCanvasExtension({
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
const EMPTY_INLINE_CONTENT: ReadonlyMap<string, PageCanvasInlineContent[]> = new Map();
const EMPTY_DISPLAY_STATES: AiProposalDisplayStates = new Map();

/**
 * 提案の表示状態 (内容を隠した・適用の失敗・破棄理由・変更前を隠した) をカードの外に持つ。
 * 紙面のカードは改ページで切れると続きが別のインスタンスで描かれ、key は会話単位で固定なので、
 * カードの state にすると食い違ったり追加ターンに残ったりする (`model/proposal-display-state.ts`)。
 *
 * 場所の key: 紙面のカードはカードの key、図形のそばのバーと「変更前を隠す」は会話の key。
 * 状態は提案 id の組と一緒に覚え、今の場所・提案に無いものは書き換えのたびに捨てる。
 */
function useAiProposalDisplayStates(live: ReadonlyMap<string, readonly string[]>) {
  const [states, setStates] = useState<AiProposalDisplayStates>(EMPTY_DISPLAY_STATES);
  const liveRef = useRef(live);
  useLayoutEffect(() => {
    liveRef.current = live;
  }, [live]);
  const update = useCallback((key: string, proposalIds: readonly string[], patch: Partial<AiProposalDisplayState>) => {
    setStates((previous) => patchAiProposalDisplayState(
      pruneAiProposalDisplayStates(previous, liveRef.current),
      key,
      proposalIds,
      patch,
    ));
  }, []);
  return [states, update] as const;
}

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
}: UseAiPageCanvasExtensionOptions): PageCanvasEditorExtension {
  const t = useT("ai");
  // 図形のそばにバーを付けるのは図形だけの提案。本文も変える提案はカードのバー 1 本で決める。
  const overlayPreviewGroups = useMemo(
    () => previewGroups.filter(isOverlayOnlyAiEditPreview),
    [previewGroups],
  );
  const inlinePreviewGroups = useMemo(
    () => previewGroups.filter(hasBodyAiEditChanges),
    [previewGroups],
  );
  // 提案が 1 つも無いときは文書が変わっても結果は空。ここで毎回新しい Map を作ると
  // その先の `inlineContentByTargetId` → `pageExtension` まで打鍵ごとに新品になる。
  const previewCardsByTargetId = useMemo(
    () => inlinePreviewGroups.length === 0
      ? EMPTY_PREVIEW_CARDS_BY_TARGET_ID
      : groupPendingProposalContentByAnchor(inlinePreviewGroups, document),
    [document, inlinePreviewGroups],
  );
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
  const textFlowChangeDecorationState = useMemo(() => {
    const removedIds = [...previewDiff.removedBlockIds];
    const removingIds = applyAnimation?.removingBlockIds ?? [];
    const addedIds = applyAnimation?.addedBlockIds ?? [];
    return removedIds.length === 0 && removingIds.length === 0 && addedIds.length === 0
      ? undefined
      : { removedIds, removingIds, addedIds };
  }, [applyAnimation, previewDiff]);
  const beforeHiddenShapeIds = useMemo(() => new Set(previewGroups.flatMap((preview) => (
    readAiProposalDisplayState(displayStates, getAiProposalConversationKey(preview), preview.proposalIds).beforeHidden
      ? getAiEditPreviewBeforeShapeIds(preview)
      : []
  ))), [displayStates, previewGroups]);
  const overlayShapeClassNames = useMemo(
    () => deriveAiOverlayShapeClassNames({ previewGroups, previewDiff, applyAnimation, beforeHiddenShapeIds }),
    [applyAnimation, beforeHiddenShapeIds, previewDiff, previewGroups],
  );

  const resolveOverlayPresentation = useCallback((
    context: PageCanvasOverlayPresentationContext,
  ): PageCanvasOverlayPresentation => {
    const replacementShapeIds = new Set(
      previewGroups.flatMap((preview) => (preview.shapeReplacements ?? []).map((pair) => pair.removedShapeId)),
    );
    const finalShapeUpdates = new Map(
      deriveAiEditPreviewShapeUpdates(previewGroups, context.overlayShapes).map((update) => [update.shapeId, update]),
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

    const pageStride = context.pageHeightPx + PAGE_GAP_PX;
    const collisionCounts = new Map<string, number>();
    const widgets = overlayPreviewGroups.flatMap((preview) => {
      const affectedShapes = deriveAiEditPreviewOverlayShapes(preview, context.overlayShapes);
      if (affectedShapes.length === 0) {
        return [];
      }
      const shapesById = new Map(context.overlayShapes.map((shape) => [shape.id, shape]));
      affectedShapes.forEach((shape) => shapesById.set(shape.id, shape));
      const resolvedById = new Map(
        resolveShapesPosition([...shapesById.values()], context.blockRects, context.blockGaps)
          .map((shape) => [shape.id, shape]),
      );
      const bounds = getShapesSelectionBounds(affectedShapes.flatMap((shape) => {
        const resolved = resolvedById.get(shape.id);
        return resolved ? [resolved] : [];
      }));
      if (!bounds) {
        return [];
      }

      const pageIndex = Math.max(0, Math.floor(bounds.y / pageStride));
      const pageTop = pageIndex * pageStride;
      const roomAbove = bounds.y - pageTop;
      const placement = roomAbove >= OVERLAY_APPROVAL_WIDGET_ESTIMATED_HEIGHT + OVERLAY_APPROVAL_WIDGET_GAP
        ? "above" as const
        : "below" as const;
      const insertionAnchorBlockId = getOverlayInsertionAnchorBlockId(preview);
      const insertionColumnBounds = insertionAnchorBlockId
        ? getNarrowColumnBounds(context.blockRects.get(insertionAnchorBlockId), context.contentWidthPx)
        : null;
      const horizontalBounds = insertionColumnBounds ?? {
        left: 0,
        right: context.pageWidthPx,
        width: context.pageWidthPx,
      };
      const widgetPlacement = placeCenteredWidget(
        bounds.x + bounds.w / 2,
        OVERLAY_APPROVAL_WIDGET_WIDTH,
        horizontalBounds,
        OVERLAY_APPROVAL_WIDGET_MARGIN,
      );
      const left = widgetPlacement.center;
      const baseTop = placement === "above"
        ? bounds.y - OVERLAY_APPROVAL_WIDGET_GAP
        : bounds.y + bounds.h + OVERLAY_APPROVAL_WIDGET_GAP;
      const collisionKey = `${placement}:${Math.round(left / 24)}:${Math.round(baseTop / 24)}`;
      const stackIndex = collisionCounts.get(collisionKey) ?? 0;
      collisionCounts.set(collisionKey, stackIndex + 1);
      const stackOffset = stackIndex * (OVERLAY_APPROVAL_WIDGET_ESTIMATED_HEIGHT + 4);
      const conversationKey = getAiProposalConversationKey(preview);

      return [(
        <AiEditOverlayApprovalWidget
          key={conversationKey}
          preview={preview}
          applying={applying}
          placement={placement}
          style={{
            left: `${left}px`,
            top: `${placement === "above" ? baseTop - stackOffset : baseTop + stackOffset}px`,
            width: `${widgetPlacement.width}px`,
          }}
          changeSummaryLines={summarizeAiEditPreviewChanges(preview, context.overlayShapes, t)}
          displayState={readAiProposalDisplayState(displayStates, conversationKey, preview.proposalIds)}
          onDisplayStateChange={(patch) => updateDisplayState(conversationKey, preview.proposalIds, patch)}
          hasBeforeShapes={getAiEditPreviewBeforeShapeIds(preview).length > 0}
          onOpenConversation={preview.roomId
            ? (anchorElement) => openProposalConversation(preview, anchorElement)
            : undefined}
          onApply={onApply ? () => onApply(preview.proposalIds) : undefined}
          onDismiss={onDismiss ? (reason) => onDismiss(preview.proposalIds, reason) : undefined}
        />
      )];
    });

    return {
      ghostShapes: resolvedGhostShapes,
      floatingContent: widgets,
    };
  }, [applying, displayStates, onApply, onDismiss, openProposalConversation, overlayPreviewGroups, previewDiff, previewGroups, t, updateDisplayState]);

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

  return useMemo(() => ({
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
}: {
  previewGroups: readonly AiEditPreviewState[];
  previewDiff: AiEditPreviewDiff;
  applyAnimation: AiApplyAnimationState | null;
  beforeHiddenShapeIds: ReadonlySet<string>;
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
