"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AiEditPreviewState,
  type StaleMcpProposalGroup,
} from "@/components/editor/ai-edit-preview-types";
import { AiConnectionGate, ClaudeConnectionGate, GeminiConnectionGate } from "@/components/editor/AiConnectionGate";
import { AiStaleProposalNotice } from "@/components/editor/AiStaleProposalNotice";
import type { AiEditAttachment } from "@/lib/ai/sigma-doc-agent-tools";
import { useAiConnection, useClaudeConnection, useGeminiConnection } from "@/lib/ai/ai-connection";
import { type AiEditReference } from "@/lib/ai/ai-edit-reference";
import { getAttachmentDefaultInstruction } from "@/lib/ai/ai-edit-runtime";
import { type AiEditShapeOnlyPreview } from "@/lib/ai/ai-edit-shape-preview";
import { saveAiModelPreferences } from "@/lib/ai/ai-model-preferences";
import { useAiChatModelController } from "@/features/ai-edit/application/use-ai-chat-model-controller";
import { toAiResourceProvider } from "@/lib/ai/ai-providers";
import {
  addChatRoom,
  aiChatRoomsStore,
  createAiRunAnchor,
  createEmptyChatRoom,
  enqueueFollowUp,
  fromDesktopChatRoom,
  hydrateChatRoomsFromDisk,
  isSameAiRunTarget,
  resolvePendingAssistantTurns,
  selectChatRoom as selectChatRoomInStore,
  startRun,
  updateChatRoom,
  useAiActiveRoomId,
  useAiChatRoomsForDocument,
  type AssistantTurn,
  type RunParams,
  type UserTurn,
} from "@/lib/ai/ai-run-controller";
import { aiRunSessionStore, isAiRunStatusActive, useAiRunSessions } from "@/lib/ai/ai-run-session-store";
import { type AiEditModel } from "@/lib/ai/sigma-doc-edit-schema";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { resolveDocumentTitle } from "@/lib/document-title";
import { useT } from "@/lib/i18n/react";
import { createAttachmentsWithSelectedOverlayPreview } from "@/features/ai-edit/application/ai-chat-attachments";
import { ChatRoomHistory } from "@/features/ai-edit/view/AiChatHistory";
import { ChatEmptyState } from "@/features/ai-edit/view/AiChatEmptyState";
import { UserTurnView, AssistantTurnView } from "@/features/ai-edit/view/AiChatTurn";
import { ProviderSwitch } from "@/features/ai-edit/view/AiChatProviderSwitch";
import type { AiEditPanelProps } from "@/features/ai-edit/application/ai-chat-panel-contracts";
import { tAiNow } from "@/features/ai-edit/application/ai-chat-translator";
import { useAiChatComposer } from "@/features/ai-edit/application/use-ai-chat-composer";
import { AiChatComposer } from "@/features/ai-edit/view/AiChatComposer";
import { AiChatInlineSurface } from "@/features/ai-edit/view/AiChatInlineSurface";
import {
  buildPendingProposalContent,
  type AiProposalContent,
} from "@/features/ai-edit/model/proposal-content";
import { resolveProposalMergePreview } from "@/features/ai-edit/model/proposal-merge-preview";
import { getPageMetrics, type OverlayAsset } from "@/features/document";

const EMPTY_PINNED_REFERENCES: AiEditReference[] = [];
const EMPTY_PINNED_REFERENCE_PREVIEWS: ReadonlyMap<string, AiEditShapeOnlyPreview> = new Map();
const EMPTY_OVERLAY_ASSETS: Readonly<Record<string, OverlayAsset>> = {};
const EMPTY_PENDING_ATTACHMENTS: AiEditAttachment[] = [];

export function findActiveRoomPreview(
  previewGroups: AiEditPreviewState[],
  activeRoomId: string | null,
): AiEditPreviewState | null {
  return activeRoomId
    ? previewGroups.find((group) => group.roomId === activeRoomId) ?? null
    : null;
}

/**
 * AI会話の履歴、実行状態、参照、提案結果、送信コンポーザーを一つの表示面へ調停する。
 * 提案の適用処理そのものは親へ委ね、ここでは会話と判断UIの対応だけを担当する。
 */
export function AiEditPanel({
  document,
  documentIdentityKey,
  controlledRoomId,
  documentWorkspaceId = null,
  selectedId,
  reference,
  pinnedReferences = EMPTY_PINNED_REFERENCES,
  pinnedReferencePreviews = EMPTY_PINNED_REFERENCE_PREVIEWS,
  onRemovePinnedReference,
  pendingAttachments = EMPTY_PENDING_ATTACHMENTS,
  onRemovePendingAttachment,
  onPendingAttachmentsSent,
  overlaySelection,
  variant = "sidebar",
  inlineSessionId = 0,
  inlineOpen = false,
  inlineAnchor = null,
  inlineRunAnchor = null,
  inlineRunAnchorCanvas = null,
  inlineRunPortalTarget = null,
  previewClearRequest = { seq: 0, outcome: "dismissed" },
  previewGroups = [],
  busy = false,
  onApplyGroup,
  onDismissGroup,
  onInlineDecisionShownChange,
  staleProposalGroups,
  sourceReferencesByTurnId,
  insertedShapePreviewsByTurnId,
  appliedChangesByTurnId,
  onRevertAppliedChange,
  restorableProposalsByTurnId,
  onRestoreProposal,
  onOpenSourceDocument,
  onDiscardStaleProposals,
  onRebaseStaleProposals,
  onForceApplyStaleProposals,
  onOpenAiSettings,
  onCloseInline,
  onPromoteToSidebar,
  onInlineRunAnchorChange,
  focusRoomRequest = null,
}: AiEditPanelProps) {
  const t = useT("ai");
  const connection = useAiConnection();
  const claudeConnection = useClaudeConnection();
  const geminiConnection = useGeminiConnection();
  const models = useAiChatModelController();
  const { provider, setProvider, model, claudeModel, geminiModel, reasoningEffort } = models;
  const composer = useAiChatComposer({ document, documentIdentityKey, documentWorkspaceId, selectedId, reference, pinnedReferences, pinnedReferencePreviews, pendingAttachments, onRemovePendingAttachment, onPendingAttachmentsSent, overlaySelection, provider, refreshRuntimeModels: models.refreshRuntimeModels });
  const {
    instruction,
    attachments,
    mentionedDocuments,
    selectedAiResourceIds,
    aiResources,
    overlayComposerPreviews,
    activeReferenceKey,
    hasAttachableSelectedImages,
    turnReferences,
    aiTargetId,
    overlaySelectionContext
  } = composer.draft;
  const {
    setInstruction,
    setComposerError,
    applyActionPreset,
    clearComposerAfterSubmit,
    resetComposerState: resetDraft,
    focus: focusComposer,
    capture
  } = composer.actions;
  const { composerRef, composerError } = composer;
  // R5: rooms and the active-room selection live in the module-level
  // controller store (ai-run-controller.ts), not component state, so an
  // in-flight run's transcript updates survive this panel being remounted
  // (promoting inline → sidebar moves it across a portal boundary, which
  // React treats as an unmount+mount).
  const chatRooms = useAiChatRoomsForDocument(documentIdentityKey);
  const storedActiveRoomId = useAiActiveRoomId(documentIdentityKey);
  const activeRoomId = controlledRoomId ?? storedActiveRoomId;
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  // The turn id present when the inline editor was (re)opened. The inline editor
  // shows a result only for a turn created after this baseline, so reopening starts
  // on a fresh input instead of an older turn's apply/dismiss card.
  const [inlineBaselineTurnId, setInlineBaselineTurnId] = useState<string | null>(null);
  const [inlineRunTurnId, setInlineRunTurnId] = useState<string | null>(null);
  const [threadTailSpacerHeight, setThreadTailSpacerHeight] = useState(0);
  const resolvedDocumentTitle = useMemo(() => resolveDocumentTitle(document), [document]);
  const documentTitleRef = useRef(resolvedDocumentTitle);
  const activeRoomIdRef = useRef<string | null>(null);
  const previousPreviewClearRequestRef = useRef(previewClearRequest);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const userTurnElementsRef = useRef(new Map<string, HTMLDivElement>());
  const pendingSubmittedUserTurnIdRef = useRef<string | null>(null);
  const lastRoomAutoScrolledRef = useRef<string | null>(null);
  useEffect(() => {
    documentTitleRef.current = resolvedDocumentTitle;
  }, [resolvedDocumentTitle]);

  useEffect(() => {
    activeRoomIdRef.current = activeRoomId;
  }, [activeRoomId]);

  const focusedRoomRequestSeqRef = useRef(0);
  useEffect(() => {
    if (!focusRoomRequest || focusRoomRequest.seq === focusedRoomRequestSeqRef.current) {
      return;
    }
    focusedRoomRequestSeqRef.current = focusRoomRequest.seq;
    // Selecting through the store marks the selection as explicit, so the
    // async room-list load resolving after this (panel remount races the
    // focus request against `listChatRooms`) can no longer clobber it with
    // its "default to the newest room" behavior.
    selectChatRoomInStore(documentIdentityKey, focusRoomRequest.roomId);
  }, [documentIdentityKey, focusRoomRequest]);

  const clearInlineRunAnchor = useCallback(() => {
    setInlineRunTurnId(null);
    onInlineRunAnchorChange?.(null);
  }, [onInlineRunAnchorChange]);

  const resetComposerState = useCallback((options: { focusComposer?: boolean } = {}) => {
    pendingSubmittedUserTurnIdRef.current = null;
    setThreadTailSpacerHeight(0);
    resetDraft(options);
  }, [resetDraft]);

  useEffect(() => {
    // Seed the controller's rooms store from disk. Rooms already known to the
    // store in this session (e.g. one being mutated by an in-flight run when
    // this panel remounted) are authoritative and left untouched — the disk
    // read only fills in rooms this session has not seen yet, and only picks
    // the default active room when nothing has been explicitly selected.
    let cancelled = false;
    const ensureFallbackRoom = () => {
      if (aiChatRoomsStore.getRoomsForDocument(documentIdentityKey).length === 0) {
        // Like the room a run would create, this fallback is only persisted
        // once it actually receives a turn.
        addChatRoom(createEmptyChatRoom(documentIdentityKey, documentTitleRef.current, tAiNow), { makeActive: true, persist: false });
      }
    };
    const timeoutId = window.setTimeout(() => {
      if (cancelled) {
        return;
      }
      resetComposerState();
      setHistoryLoading(true);
      setHistoryError(null);

      const desktop = getDesktopBridge();
      if (!desktop?.aiEdit?.listChatRooms) {
        ensureFallbackRoom();
        setHistoryLoading(false);
        return;
      }

      desktop.aiEdit.listChatRooms(documentIdentityKey)
        .then((rooms) => {
          if (cancelled) return;
          hydrateChatRoomsFromDisk(documentIdentityKey, rooms.map((room) => fromDesktopChatRoom(room)));
          ensureFallbackRoom();
          setHistoryError(null);
        })
        .catch((error) => {
          if (cancelled) return;
          ensureFallbackRoom();
          setHistoryError(error instanceof Error ? error.message : t("chat.historyLoadFailed"));
        })
        .finally(() => {
          if (!cancelled) {
            setHistoryLoading(false);
          }
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [documentIdentityKey, resetComposerState, t]);

  // R5: run status is derived from the single-source-of-truth run-session
  // store, keyed per room, instead of a component-local flag. This is what
  // lets multiple rooms run concurrently (R1) without any of them ever
  // rendering a stale "stopped" state after a room switch.
  const runSessions = useAiRunSessions();
  const activeRoomRunSession = activeRoomId ? runSessions.get(activeRoomId) ?? null : null;
  const isRunning = isAiRunStatusActive(activeRoomRunSession?.status);

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setClockNow(Date.now());
    }, 500);
    return () => window.clearInterval(intervalId);
  }, [isRunning]);

  const activeRoom = useMemo(
    () => chatRooms.find((room) => room.id === activeRoomId) ?? null,
    [activeRoomId, chatRooms],
  );
  const activeRoomPreview = useMemo(
    () => findActiveRoomPreview(previewGroups, activeRoomId),
    [activeRoomId, previewGroups],
  );
  const scopedAgentThreadId = activeRoom?.agentThreadId ?? null;
  // A room is bound to the provider of its first run (see ai-run-controller):
  // follow-ups must stay on that provider so a thread never switches models
  // mid-conversation. Only the model/reasoning-effort within it stay adjustable.
  const lockedProvider = activeRoom?.provider ?? null;
  // Keep the composer's provider in step with the active room's locked provider.
  // Adjusting state during render (React's documented pattern for "reset/adjust
  // state when a value changes") rather than in an effect: the guard makes it
  // idempotent, and it avoids a wasted commit + the set-state-in-effect rule.
  if (lockedProvider && lockedProvider !== provider) {
    setProvider(lockedProvider);
  }
  const visibleTurns = useMemo(() => activeRoom?.turns ?? [], [activeRoom]);
  // 適用済みの図形は今の文書の画像で描く (渡さないと画像・3D の絵が欠ける)。
  const currentOverlayAssets = document.pageLayout?.overlay?.overlaySnapshot?.assets ?? EMPTY_OVERLAY_ASSETS;
  // 提案内容はこの段幅で組んでからパネルの幅へ縮める (紙面と同じ改行で読める)。
  const paperWidthPx = useMemo(() => getPageMetrics(document.pageLayout).flow.columnWidthPx, [document.pageLayout]);
  // Build proposal contents once per input change. The render path only reads the map. The
  // after-document is the approval's merging replay, shared with the page cards (remembered per
  // proposal and the units it touches), so the composer's keystrokes and the page do not replay the
  // same proposal twice.
  const pendingContents = useMemo(() => {
    const contents = new Map<AiEditPreviewState, { content: AiProposalContent; mergedWithHumanEdits: boolean }>();
    for (const candidate of previewGroups) {
      // 承認が文書を差し替えている間 (busy) は、プレビューの代わりの経路を数えない。
      const merged = resolveProposalMergePreview(document, candidate, { countFallbacks: !busy });
      contents.set(candidate, {
        content: buildPendingProposalContent(document, merged.afterDocument, candidate),
        mergedWithHumanEdits: merged.humanEditedUnits.length > 0,
      });
    }
    return contents;
  }, [busy, previewGroups, document]);
  const isMergedWithHumanEdits = useCallback(
    (preview: AiEditPreviewState) => pendingContents.get(preview)?.mergedWithHumanEdits ?? false,
    [pendingContents],
  );

  const latestAssistant = useMemo<AssistantTurn | null>(() => {
    for (let i = visibleTurns.length - 1; i >= 0; i -= 1) {
      const turn = visibleTurns[i];
      if (turn.role === "assistant") {
        return turn;
      }
    }
    return null;
  }, [visibleTurns]);

  const latestAssistantId = latestAssistant?.id ?? null;
  // Re-baseline when the inline editor is (re)opened, using React's "adjust state
  // during render from a previous value" pattern (avoids a set-state-in-effect).
  const [inlineBaselineSession, setInlineBaselineSession] = useState(inlineSessionId);
  if (inlineSessionId !== inlineBaselineSession) {
    setInlineBaselineSession(inlineSessionId);
    setInlineBaselineTurnId(latestAssistantId);
  }

  const lastInlineChatSessionRef = useRef(0);
  useEffect(() => {
    if (variant !== "inline" || inlineSessionId === 0 || inlineSessionId === lastInlineChatSessionRef.current) {
      return;
    }
    lastInlineChatSessionRef.current = inlineSessionId;
    // R1: every inline (⌘K-style) invocation gets a brand-new room and can run
    // concurrently with any other room's in-flight run — no longer gated on
    // whether the currently active room happens to be running.
    const nextRoom = createEmptyChatRoom(documentIdentityKey, documentTitleRef.current, tAiNow);
    addChatRoom(nextRoom, { makeActive: true });
    activeRoomIdRef.current = nextRoom.id;
    resetComposerState({ focusComposer: true });
  }, [documentIdentityKey, inlineSessionId, resetComposerState, variant]);

  useEffect(() => {
    // Focus the inline composer when it is shown: on (re)open and after a run that
    // was in flight at reopen finishes and the input returns. No-op when a result
    // card or the running badge is shown (composer unmounted, ref is null).
    if (inlineSessionId === 0 || variant !== "inline" || !inlineOpen) {
      return;
    }
    if (isRunning || latestAssistant?.isRunning) {
      return;
    }
    const handle = window.setTimeout(() => composerRef.current?.focus(), 0);
    return () => window.clearTimeout(handle);
  }, [inlineSessionId, variant, inlineOpen, isRunning, latestAssistant?.isRunning, composerRef]);

  const setUserTurnElement = useCallback((turnId: string, element: HTMLDivElement | null) => {
    if (element) {
      userTurnElementsRef.current.set(turnId, element);
      return;
    }
    userTurnElementsRef.current.delete(turnId);
  }, []);

  const scrollSubmittedUserTurnToTop = useCallback((turnId: string) => {
    const thread = threadRef.current;
    const turnElement = userTurnElementsRef.current.get(turnId);
    if (!thread || !turnElement) {
      return false;
    }

    const threadRect = thread.getBoundingClientRect();
    const turnRect = turnElement.getBoundingClientRect();
    const threadStyle = window.getComputedStyle(thread);
    const topInset = Number.parseFloat(threadStyle.paddingTop) || 0;
    const targetScrollTop = Math.max(0, thread.scrollTop + turnRect.top - threadRect.top - topInset);
    thread.scrollTo({ top: targetScrollTop, behavior: "smooth" });
    return true;
  }, []);

  useEffect(() => {
    const pendingTurnId = pendingSubmittedUserTurnIdRef.current;
    if (pendingTurnId) {
      // 送信でroomが新規作成された場合、この時点ではまだ下の「room切替時の最下部スクロール」を
      // 消費していない。ピン留め成功後にturnsが更新されるとそちらが後から発火し、末尾スペーサー
      // (空白) の最下部までジャンプして応答と差分が画面外に消えてしまうため、ピン留めした
      // roomは消費済みとして扱う。
      if (activeRoomId) {
        lastRoomAutoScrolledRef.current = activeRoomId;
      }
      const frameId = window.requestAnimationFrame(() => {
        if (scrollSubmittedUserTurnToTop(pendingTurnId)) {
          pendingSubmittedUserTurnIdRef.current = null;
        }
      });
      return () => window.cancelAnimationFrame(frameId);
    }

    const thread = threadRef.current;
    if (!thread || !activeRoomId || lastRoomAutoScrolledRef.current === activeRoomId) {
      return;
    }
    lastRoomAutoScrolledRef.current = activeRoomId;
    const frameId = window.requestAnimationFrame(() => {
      thread.scrollTop = thread.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [activeRoomId, scrollSubmittedUserTurnToTop, threadTailSpacerHeight, visibleTurns]);

  useEffect(() => {
    if (previousPreviewClearRequestRef.current.seq === previewClearRequest.seq) {
      return;
    }

    previousPreviewClearRequestRef.current = previewClearRequest;
    // 提案groupのroom/turn帰属に従い、解決したturnだけを確定する。targetsなしは
    // inline閉じる等のlegacy経路なのでactive roomの未解決turn全件へfallbackする。
    const requestedTargets = previewClearRequest.targets?.length
      ? previewClearRequest.targets
      : [{ roomId: previewClearRequest.roomId ?? activeRoomIdRef.current ?? undefined }];
    const targetsByRoom = new Map<string, Set<string> | null>();
    for (const target of requestedTargets) {
      const roomId = target.roomId ?? activeRoomIdRef.current;
      if (!roomId) {
        continue;
      }
      const current = targetsByRoom.get(roomId);
      if (!target.turnId) {
        targetsByRoom.set(roomId, null);
      } else if (current !== null) {
        const turnIds = current ?? new Set<string>();
        turnIds.add(target.turnId);
        targetsByRoom.set(roomId, turnIds);
      }
    }
    for (const [roomId, turnIds] of targetsByRoom) {
      updateChatRoom(roomId, (room) => ({
        ...room,
        turns: resolvePendingAssistantTurns(
          room.turns,
          previewClearRequest.outcome,
          turnIds ?? undefined,
          { includeResolved: previewClearRequest.includeResolved },
        ),
        updatedAt: new Date().toISOString(),
      }));
    }
  }, [previewClearRequest]);

  // Snapshots the live composer state into a self-contained request. Both an
  // immediate run and a later queued-follow-up dispatch (R3) go through this
  // same snapshot shape so a follow-up replays exactly what the user composed,
  // even if the live composer state has since moved on to something else.
  const buildRunParams = useCallback(async (): Promise<RunParams> => {
    const turnAttachments = await createAttachmentsWithSelectedOverlayPreview({
      attachments,
      overlayPreviews: overlayComposerPreviews,
      overlaySelection,
      activeReferenceKey,
    });
    // A room bound to a provider always runs on it, even if the composer's
    // `provider` state hasn't caught up to a just-selected room yet.
    const runProvider = lockedProvider ?? provider;
    const turnAiResourceProvider = toAiResourceProvider(runProvider);
    const turnAiResourceIds = selectedAiResourceIds.filter((id) => {
      const resource = aiResources.find((item) => item.id === id);
      return resource?.providers.includes(turnAiResourceProvider);
    });
    return {
      runDocumentIdentityKey: documentIdentityKey,
      runAgentThreadId: scopedAgentThreadId,
      runDocument: document,
      turnReferences,
      turnAttachments,
      turnMentionedDocuments: mentionedDocuments,
      turnProvider: runProvider,
      turnAiResourceIds,
      turnInstruction: instruction.trim() || getAttachmentDefaultInstruction(turnAttachments),
      turnModel: runProvider === "claude" ? claudeModel : runProvider === "antigravity" ? geminiModel : model,
      turnReasoningEffort: reasoningEffort,
      aiTargetId,
      anchor: createAiRunAnchor({
        primaryBlockId: aiTargetId === "CANVAS" ? null : aiTargetId,
        documentId: documentIdentityKey,
        document,
        references: turnReferences,
        shapeIds: overlaySelectionContext?.selectedShapeIds,
        canvas: variant === "inline" && inlineAnchor ? { left: inlineAnchor.left, top: inlineAnchor.top } : undefined,
        preferredTarget: (overlaySelectionContext || turnReferences.some((item) => item.overlaySelection?.region)) && variant === "inline" && inlineAnchor ? "canvas" : "block",
      }),
    };
  }, [
    activeReferenceKey, aiResources, aiTargetId, attachments, claudeModel, document, documentIdentityKey, geminiModel,
    inlineAnchor, instruction, lockedProvider, mentionedDocuments, model, overlayComposerPreviews, overlaySelection, overlaySelectionContext, provider, reasoningEffort,
    scopedAgentThreadId, selectedAiResourceIds, turnReferences, variant,
  ]);

  const runEdit = useCallback(async () => {
    const runRoom = activeRoom;
    if (historyLoading || !runRoom) {
      return;
    }

    const trimmedInstruction = instruction.trim();
    if (!trimmedInstruction && attachments.length === 0 && !hasAttachableSelectedImages) {
      setComposerError(t("composer.instructionRequired"));
      return;
    }

    const runRoomId = runRoom.id;
    const submission = capture();
    const params = await buildRunParams();
    if (!submission.isCurrent()) return;
    saveAiModelPreferences({
      provider: params.turnProvider,
      model: params.turnProvider === "chatgpt" ? params.turnModel as AiEditModel : model,
      claudeModel: params.turnProvider === "claude" ? params.turnModel : claudeModel,
      geminiModel: params.turnProvider === "antigravity" ? params.turnModel : geminiModel,
      reasoningEffort: params.turnReasoningEffort,
    });

    if (aiRunSessionStore.isRunning(runRoomId)) {
      const liveAnchor = aiRunSessionStore.getSession(runRoomId)?.anchor ?? null;
      if (!isSameAiRunTarget(liveAnchor, params.anchor)) {
        // 別箇所 (走行中runと異なるブロック/図形) への依頼は、走行中runの完了を待たずに
        // 新しい部屋で即座に並列開始する — 同一箇所は従来どおり下のキュー (R3) 行き。
        // 新しい部屋は新しい会話なので、走行中の部屋の agentThreadId は引き継がない。
        const nextRoom = createEmptyChatRoom(documentIdentityKey, documentTitleRef.current, tAiNow);
        addChatRoom(nextRoom, { makeActive: true });
        activeRoomIdRef.current = nextRoom.id;
        clearComposerAfterSubmit();
        const { userTurnId } = startRun(nextRoom.id, { ...params, runAgentThreadId: null });
        pendingSubmittedUserTurnIdRef.current = userTurnId;
        setThreadTailSpacerHeight(threadRef.current?.clientHeight ?? 0);
        setClockNow(Date.now());
        if (variant === "inline" && overlaySelectionContext) {
          onCloseInline?.();
        }
        return;
      }
      // R3: the room already has an active run — queue this message instead of
      // starting a second concurrent run in the same room. It renders
      // immediately as a "送信待ち" (queued) turn and is dispatched
      // automatically by the controller (merged with any other queued
      // messages) once the in-flight run completes.
      const queuedTurnId = enqueueFollowUp(runRoomId, params);
      if (runRoomId === activeRoomIdRef.current) {
        pendingSubmittedUserTurnIdRef.current = queuedTurnId;
        setThreadTailSpacerHeight(threadRef.current?.clientHeight ?? 0);
      }
      clearComposerAfterSubmit();
      if (variant === "inline" && overlaySelectionContext) {
        onCloseInline?.();
      }
      return;
    }

    clearComposerAfterSubmit();
    // The run's execution and all of its transcript/session effects live in
    // the controller (module scope), so it survives this panel being
    // remounted (e.g. promoting inline → sidebar mid-run). Only the
    // per-surface presentation side effects stay here.
    const { userTurnId, assistantTurnId } = startRun(runRoomId, params);
    if (runRoomId === activeRoomIdRef.current) {
      pendingSubmittedUserTurnIdRef.current = userTurnId;
      setThreadTailSpacerHeight(threadRef.current?.clientHeight ?? 0);
      setClockNow(Date.now());
    }
    if (variant === "inline" && runRoomId === activeRoomIdRef.current && inlineAnchor) {
      setInlineRunTurnId(assistantTurnId);
      onInlineRunAnchorChange?.(inlineAnchor);
    }
    if (variant === "inline" && overlaySelectionContext) {
      onCloseInline?.();
    }
  }, [activeRoom, historyLoading, instruction, attachments.length, hasAttachableSelectedImages,
    t, buildRunParams, model, claudeModel, geminiModel, documentIdentityKey,
    setComposerError, capture, clearComposerAfterSubmit, variant, overlaySelectionContext, onCloseInline, inlineAnchor, onInlineRunAnchorChange]);

  const dismissTurn = useCallback((turnId: string) => {
    const roomId = activeRoom?.id ?? null;
    if (!roomId) {
      return;
    }
    updateChatRoom(roomId, (room) => ({
      ...room,
      turns: room.turns.map((item) =>
        item.id === turnId && item.role === "assistant" ? { ...item, dismissed: true } : item,
      ),
      updatedAt: new Date().toISOString(),
    }));
    if (turnId === inlineRunTurnId) {
      clearInlineRunAnchor();
    }
  }, [
    activeRoom?.id,
    clearInlineRunAnchor,
    inlineRunTurnId,
  ]);

  const wasInlineOpenRef = useRef(inlineOpen);
  useEffect(() => {
    // Closing the inline composer must not cancel an in-flight run. The detached
    // run badge keeps showing at the original anchor until the turn finishes.
    wasInlineOpenRef.current = inlineOpen;
  }, [inlineOpen]);

  const retryTurn = useCallback((assistantTurnId: string) => {
    const roomId = activeRoom?.id ?? null;
    const turns = activeRoom?.turns ?? [];
    const assistantIndex = turns.findIndex((item) => item.id === assistantTurnId);
    if (assistantIndex < 0) {
      return;
    }
    let userTurn: UserTurn | null = null;
    for (let index = assistantIndex - 1; index >= 0; index -= 1) {
      const candidate = turns[index];
      if (candidate.role === "user") {
        userTurn = candidate;
        break;
      }
    }
    if (!userTurn) {
      return;
    }
    setInstruction(userTurn.instruction);
    setComposerError(null);
    // Dismiss the original result so its still-live "適用" can't apply the stale
    // draft after the user edits the restored instruction.
    if (roomId) {
      updateChatRoom(roomId, (room) => ({
        ...room,
        turns: room.turns.map((item) =>
          item.id === assistantTurnId && item.role === "assistant" ? { ...item, dismissed: true } : item,
        ),
        updatedAt: new Date().toISOString(),
      }));
    }
    focusComposer();
  }, [activeRoom?.id, activeRoom?.turns, setInstruction, setComposerError, focusComposer]);

  // R3: affordance for a queued message whose run never got a chance to start
  // because the run it was waiting behind failed. Restores its text to the
  // composer (clearing the "未送信" flag) so the user can review/resend it.
  const resendQueuedTurn = useCallback((turn: UserTurn) => {
    const roomId = activeRoom?.id;
    if (roomId) {
      updateChatRoom(roomId, (room) => ({
        ...room,
        turns: room.turns.map((item) =>
          item.id === turn.id && item.role === "user" ? { ...item, queueFailed: false } : item,
        ),
        updatedAt: new Date().toISOString(),
      }));
    }
    setInstruction(turn.instruction);
    setComposerError(null);
    focusComposer();
  }, [activeRoom?.id, setInstruction, setComposerError, focusComposer]);

  const hasTurns = visibleTurns.length > 0;
  const activeReference = composer.view.activeReference;

  const startNewChatRoom = () => {
    // R1: creating a new room never has to wait for the active room's run —
    // rooms run independently.
    if (activeRoom && activeRoom.turns.length === 0) {
      resetComposerState({ focusComposer: true });
      return;
    }
    const nextRoom = createEmptyChatRoom(documentIdentityKey, documentTitleRef.current, tAiNow);
    addChatRoom(nextRoom, { makeActive: true });
    activeRoomIdRef.current = nextRoom.id;
    resetComposerState({ focusComposer: true });
  };

  const selectChatRoom = (roomId: string) => {
    // R1: switching rooms never interrupts a run — each room's run is tracked
    // independently in the run-session store, keyed by room id, not by which
    // room is currently visible.
    if (roomId === activeRoomId) {
      return;
    }
    activeRoomIdRef.current = roomId;
    selectChatRoomInStore(documentIdentityKey, roomId);
    resetComposerState({ focusComposer: true });
  };

  const prepareStaleProposalReRequest = (group: StaleMcpProposalGroup) => {
    if (group.roomId) {
      selectChatRoom(group.roomId);
    } else if (!activeRoomIdRef.current) {
      startNewChatRoom();
    }
    setInstruction((current) => current.trim()
      ? current
      : t("prompt.reRequest", { replace: { summary: group.summary } }));
    focusComposer();
  };

  const renderComposer = (composerVariant: "inline" | "sidebar") => (
    <AiChatComposer controller={composer} models={models} pinnedReferences={pinnedReferences}
      onRemovePinnedReference={onRemovePinnedReference} lockedProvider={lockedProvider}
      composerVariant={composerVariant} inlineSessionId={inlineSessionId}
      onPromoteToSidebar={onPromoteToSidebar} historyLoading={historyLoading}
      isRunning={isRunning} hasTurns={hasTurns} onSubmit={runEdit} />
  );

  // Block the chat experience until the selected provider is connected, surfacing
  // an in-context sign-in path. A provider switch stays visible so the user can
  // flip to the other provider (which may already be connected) while gated.
  const activeConnectionState = provider === "claude"
    ? claudeConnection.state
    : provider === "antigravity"
    ? geminiConnection.state
    : connection.state;
  const connectionReady = activeConnectionState.kind === "loggedIn";
  if (!connectionReady) {
    return (
      <div className={`ai-edit-panel ${variant === "inline" ? "ai-inline-edit" : ""}`} data-gated="true" data-variant={variant}>
        <ProviderSwitch provider={provider} onChange={setProvider} disabled={isRunning} />
        {provider === "claude" ? (
          <ClaudeConnectionGate connection={claudeConnection} onOpenSettings={onOpenAiSettings} />
        ) : provider === "antigravity" ? (
          <GeminiConnectionGate connection={geminiConnection} onOpenSettings={onOpenAiSettings} />
        ) : (
          <AiConnectionGate connection={connection} onOpenSettings={onOpenAiSettings} />
        )}
      </div>
    );
  }

  if (variant === "inline") {
    return <AiChatInlineSurface
      surface={{inlineOpen,inlineAnchor,inlineRunAnchor,inlineRunAnchorCanvas,inlineRunPortalTarget,onPromoteToSidebar,onCloseInline}}
      conversation={{provider,lockedProvider,visibleTurns,latestAssistant,activeRoomId,inlineRunTurnId,inlineBaselineTurnId,isRunning,clockNow}}
      proposals={{previewGroups,busy,onApplyGroup,onDismissGroup,insertedShapePreviewsByTurnId,activeRoomPreview,isMergedWithHumanEdits,onInlineDecisionShownChange}}
      composer={renderComposer("inline")} composerError={composerError} hasOpenMenu={composer.hasOpenMenu}
      retryTurn={retryTurn} dismissTurn={dismissTurn}
    />;
  }

  return (
    <div className="ai-edit-panel" data-variant={variant}>
      <ChatRoomHistory
        rooms={chatRooms}
        activeRoomId={activeRoomId}
        loading={historyLoading}
        runSessions={runSessions}
        onNewRoom={startNewChatRoom}
        onSelectRoom={selectChatRoom}
        onOpenSettings={onOpenAiSettings}
      />
      <div className="ai-chat-thread" ref={threadRef}>
        {historyError && <p className="ai-chat-error">{historyError}</p>}
        {!hasTurns ? (
          <ChatEmptyState
            reference={activeReference}
            onSelectPreset={applyActionPreset}
          />
        ) : (
          visibleTurns.map((turn) => {
            if (turn.role === "user") {
              return (
                <UserTurnView
                  key={turn.id}
                  turn={turn}
                  turnRef={(element) => setUserTurnElement(turn.id, element)}
                  onResend={resendQueuedTurn}
                />
              );
            }
            const exactPreview = previewGroups.find((preview) => (
              preview.roomId === activeRoomId && preview.turnId === turn.id
            ));
            const proposal = exactPreview
              ?? (turn.id === latestAssistantId && !activeRoomPreview?.turnId ? activeRoomPreview : null);
            // 承認する前に「何が消えて何が足されるのか」を、承認後の適用済みカードと同じ
            // 部品で先出しする (「見た目で分かって承認できる」体験にする)。キャッシュ経由なので、
            // コンポーザーへの入力など無関係な再レンダーではproposal/documentが同じ限り再計算されない。
            const pending = proposal ? pendingContents.get(proposal) : undefined;
            return (
              <AssistantTurnView
                key={turn.id}
                turn={turn}
                clockNow={clockNow}
                sourceReferences={sourceReferencesByTurnId?.get(turn.id)}
                shapeContent={insertedShapePreviewsByTurnId?.get(turn.id)}
                appliedChange={appliedChangesByTurnId?.get(turn.id)}
                onRevertAppliedChange={onRevertAppliedChange}
                onOpenSourceDocument={onOpenSourceDocument}
                restorable={restorableProposalsByTurnId?.get(turn.id)}
                onRestoreProposal={onRestoreProposal}
                proposal={proposal}
                proposalContent={pending?.content}
                proposalMergedWithHumanEdits={pending?.mergedWithHumanEdits ?? false}
                proposalBusy={busy}
                onApplyProposal={onApplyGroup}
                onDismissProposal={onDismissGroup}
                overlayAssets={currentOverlayAssets}
                paperWidthPx={paperWidthPx}
                mathFractionSizing={document.metadata.mathFractionSizing}
              />
            );
          })
        )}
        {composerError && <p className="ai-chat-error">{composerError}</p>}
        {threadTailSpacerHeight > 0 && (
          <div
            className="ai-chat-thread-tail-spacer"
            style={{ height: threadTailSpacerHeight }}
            aria-hidden="true"
          />
        )}
      </div>

      <AiStaleProposalNotice
        groups={staleProposalGroups}
        onDiscard={onDiscardStaleProposals}
        onRebase={onRebaseStaleProposals}
        onForceApply={onForceApplyStaleProposals}
        onReRequest={prepareStaleProposalReRequest}
      />

      {renderComposer("sidebar")}
    </div>
  );
}

export { MAX_AI_EDIT_MENTIONED_DOCUMENTS, MAX_SIGMA_DOC_MENTION_CANDIDATES, type ActiveMentionQuery, type ActiveSlashQuery, type ContextPickerItem, getReferenceContextText, getActiveSigmaDocMentionQuery, getActiveAiResourceSlashQuery, removeActiveTriggerRange, filterAiResourceSlashCandidates, toggleAiResourceSelection, upsertMentionedDocument, removeMentionedDocumentByFileId, filterSigmaDocMentionCandidates, createMentionedDocumentContext } from "@/features/ai-edit/application/ai-chat-context";

export { MAX_AI_EDIT_ATTACHMENTS, buildSelectedOverlayShapePreview, buildStoredOverlaySelectionPreview, hasSelectedOverlayImageAttachments, isImageFile, isImageAttachment, getClipboardImageFiles, createAttachmentId, createAttachmentName, createAiEditAttachmentFromFile, readFileAsDataUrl, readImageDimensions } from "@/features/ai-edit/application/ai-chat-attachments";

export { AI_ACTION_PRESET_IDS } from "@/features/ai-edit/view/ai-chat-presets";

export { ChatRoomHistory, ChatHistoryRoomItem } from "@/features/ai-edit/view/AiChatHistory";

export { ChatEmptyState } from "@/features/ai-edit/view/AiChatEmptyState";

export { MentionedDocumentChip, AiResourceChip, SigmaDocMentionPopover, AiResourceSlashPopover, AttachmentPreview } from "@/features/ai-edit/view/AiChatComposerParts";

export { UserTurnView, AssistantTurnView, AiTurnShapeContent } from "@/features/ai-edit/view/AiChatTurn";

export { AssistantActivity } from "@/features/ai-edit/view/AiChatActivity";

export { AssistantPlanChecklist } from "@/features/ai-edit/view/AiChatPlan";

export { ProviderSwitch } from "@/features/ai-edit/view/AiChatProviderSwitch";

export { resolvePendingAssistantTurns, resolveQueuedRunAgentThreadId, type AiEditChatRoom, type AssistantTurn, type ChatTurn, type UserTurn } from "@/lib/ai/ai-run-controller";
