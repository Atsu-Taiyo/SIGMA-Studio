"use client";
import { AiModelMenuContents } from "./ai-model-menu-contents";

// B案: a full-capability follow-up composer embedded directly in the in-body run
// widget's hover card. It mirrors what the sidebar composer can do — image/file
// attachments, @-mentions of other SigmaDocs, /-slash AI resources, and a
// think-level (reasoning effort) control — MINUS provider selection: a room is
// bound to its first run's provider (see ai-run-controller), so follow-ups from
// the card always run on that same provider.
//
// It deliberately does NOT reuse AiEditPanel's composer *state machine* (that is
// entangled with the sidebar/inline transcript surfaces); instead it reuses the
// standalone helpers/popovers AiEditPanel exports, and dispatches straight
// through the run controller — so the primary composer is untouched.

import { ArrowUp, ChevronDown, Paperclip, Plus } from "lucide-react";
import type { ChangeEvent, ClipboardEvent, FocusEvent, KeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { renderModelMark } from "@/components/branding/provider-logos";
import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import type { SigmaDocument } from "@/features/document";
import { createBlockAiEditReference } from "@/lib/ai/ai-edit-reference";
import { getAttachmentDefaultInstruction } from "@/lib/ai/ai-edit-runtime";
import  {
  cycleReasoningEffort,
  formatReasoningEffortLabel,
  getProviderReasoningEfforts,
  resolveAiModelOptions,
  resolveCatalogSelection,
} from "@/lib/ai/ai-model-catalog";
import { getAiModelPreferences, saveAiModelPreferences } from "@/lib/ai/ai-model-preferences";
import { aiProviderLabel, toAiResourceProvider, type AiProvider } from "@/lib/ai/ai-providers";
import { aiChatRoomsStore, createAiRunAnchor, enqueueFollowUp, startRun } from "@/lib/ai/ai-run-controller";
import { aiRunSessionStore, type AiRunAnchor } from "@/lib/ai/ai-run-session-store";
import type { AiEditAttachment, AiEditMentionedDocumentContext } from "@/lib/ai/sigma-doc-agent-tools";
import type { AiEditReasoningEffort } from "@/lib/ai/sigma-doc-edit-schema";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import type { DesktopAiModelCatalog, DesktopAiResourceManifestEntry, DesktopDocumentMetadata } from "@/types/desktop";

import { AiChatTextInput } from "./AiChatTextInput";
import  {
  AiResourceChip,
  AiResourceSlashPopover,
  AttachmentPreview,
  MAX_AI_EDIT_ATTACHMENTS,
  MAX_AI_EDIT_MENTIONED_DOCUMENTS,
  MentionedDocumentChip,
  SigmaDocMentionPopover,
  createAiEditAttachmentFromFile,
  createMentionedDocumentContext,
  filterAiResourceSlashCandidates,
  filterSigmaDocMentionCandidates,
  getActiveAiResourceSlashQuery,
  getActiveSigmaDocMentionQuery,
  getClipboardImageFiles,
  removeActiveTriggerRange,
  type ActiveMentionQuery,
  type ActiveSlashQuery,
} from "./AiEditPanel";

interface AiRunCardComposerProps {
  roomId: string;
  documentIdentityKey: string;
  document: SigmaDocument;
  /** 編集対象ドキュメントが属するワークスペースid(fileIdからの逆引き)。null/undefined
   * ならワークスペース不明(グローバルskillのみが候補になる)。実行時のbuildRunContextと
   * 同じスコープにskill候補(/-slash)を絞り込むために使う。 */
  documentWorkspaceId?: string | null;
  anchor: AiRunAnchor;
  /** The room's bound provider — the follow-up always runs on it. */
  provider: AiProvider;
  /** Called right after a follow-up is dispatched/queued (e.g. to reset UI). */
  onSent?: () => void;
  /** Called whenever the instruction text becomes non-empty/empty, so a host
   * that reveals this composer on demand (see AiEditInlinePreviewCard /
   * AiEditOverlayApprovalWidget) can hide its 適用/破棄 buttons while the user
   * is drafting a follow-up — the cockpit rule "typing means focus on chat". */
  onDraftStateChange?: (hasText: boolean) => void;
  /** Called when the composer should collapse: Esc pressed (no popover open),
   * or focus leaves the composer entirely while the draft is empty. The host
   * owns whether the composer is mounted at all (progressive disclosure). */
  onRequestClose?: () => void;
  /** Autofocuses the textarea on mount — the host mounts this component only
   * once revealed (e.g. via a "続けて修正" click), so mounting IS the reveal. */
  autoFocus?: boolean;
}

/**
 * 実行中カード内で、元のルーム設定を保ったまま追加指示を送る埋め込みコンポーザー。
 * 外側カードが面と影を持つため、このコンポーネントは入力と送信操作だけを担当する。
 */
export function AiRunCardComposer({
  roomId,
  documentIdentityKey,
  document,
  documentWorkspaceId = null,
  anchor,
  provider,
  onSent,
  onDraftStateChange,
  onRequestClose,
  autoFocus = false,
}: AiRunCardComposerProps) {
  const t = useT("ai");
  const [instruction, setInstruction] = useState("");
  const [attachments, setAttachments] = useState<AiEditAttachment[]>([]);
  const [mentionedDocuments, setMentionedDocuments] = useState<AiEditMentionedDocumentContext[]>([]);
  const [mentionQuery, setMentionQuery] = useState<ActiveMentionQuery | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<DesktopDocumentMetadata[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [aiResources, setAiResources] = useState<DesktopAiResourceManifestEntry[]>([]);
  const [selectedAiResourceIds, setSelectedAiResourceIds] = useState<string[]>([]);
  const [slashQuery, setSlashQuery] = useState<ActiveSlashQuery | null>(null);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [reasoningEffort, setReasoningEffort] = useState<AiEditReasoningEffort>(
    () => getAiModelPreferences().reasoningEffort,
  );
  const [selectedModel, setSelectedModel] = useState(() => {
    const prefs = getAiModelPreferences();
    return provider === "claude" ? prefs.claudeModel : provider === "antigravity" ? prefs.geminiModel : prefs.model;
  });
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelFlyout, setModelFlyout] = useState<"model" | "effort" | null>(null);
  const [runtimeModelCatalog, setRuntimeModelCatalog] = useState<DesktopAiModelCatalog | null>(null);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const contextMenuToggleRef = useRef<HTMLButtonElement | null>(null);
  const modelMenuButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (autoFocus) {
      const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
      return () => window.cancelAnimationFrame(frame);
    }
  }, [autoFocus]);

  useEffect(() => {
    if (!contextMenuOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)
        || contextMenuRef.current?.contains(target)
        || contextMenuToggleRef.current?.contains(target)) {
        return;
      }
      setContextMenuOpen(false);
    };
    window.document.addEventListener("pointerdown", handlePointerDown);
    return () => window.document.removeEventListener("pointerdown", handlePointerDown);
  }, [contextMenuOpen]);

  const hasDraftText = instruction.trim().length > 0;
  const modelOptions = useMemo(() => resolveAiModelOptions(provider, runtimeModelCatalog), [provider, runtimeModelCatalog]);
  const selectedModelOption = modelOptions.find((option) => option.id === selectedModel);
  const selectedModelLabel = selectedModelOption?.label ?? selectedModel;
  const selectedProviderLabel = aiProviderLabel(provider);
  const selectedReasoningEffortLabel = formatReasoningEffortLabel(reasoningEffort, t);
  const reasoningEfforts = getProviderReasoningEfforts(provider, modelOptions, selectedModel);
  const reasoningEffortSupported = reasoningEfforts.length > 0;

  useEffect(() => {
    const desktop = getDesktopBridge();
    const section = provider === "claude"
      ? desktop?.claude
      : provider === "antigravity"
        ? desktop?.gemini
        : desktop?.codex;
    const listModels = section?.listModels;
    if (!listModels) {
      return;
    }
    let cancelled = false;
    const startTimer = window.setTimeout(() => {
      setModelCatalogLoading(true);
      setModelCatalogError(null);
      listModels()
        .then((catalog) => {
          if (cancelled) return;
          const options = resolveAiModelOptions(provider, catalog);
          const prefs = getAiModelPreferences();
          const preferredModel = provider === "claude"
            ? prefs.claudeModel
            : provider === "antigravity"
              ? prefs.geminiModel
              : prefs.model;
          const selection = resolveCatalogSelection({
            models: options,
            model: preferredModel,
            reasoningEffort: prefs.reasoningEffort,
          });
          setRuntimeModelCatalog(catalog);
          setSelectedModel(selection.model);
          setReasoningEffort(selection.reasoningEffort);
        })
        .catch((loadError) => {
          if (!cancelled) {
            setModelCatalogError(loadError instanceof Error ? loadError.message : t("composer.modelCatalogFailed"));
          }
        })
        .finally(() => {
          if (!cancelled) setModelCatalogLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
    };
  }, [provider, t]);

  useEffect(() => {
    const preferences = getAiModelPreferences();
    saveAiModelPreferences({
      ...preferences,
      provider,
      reasoningEffort,
      ...(provider === "claude"
        ? { claudeModel: selectedModel }
        : provider === "antigravity"
          ? { geminiModel: selectedModel }
          : { model: selectedModel }),
    });
  }, [provider, reasoningEffort, selectedModel]);


  useEffect(() => {
    onDraftStateChange?.(hasDraftText);
    // Fires again on unmount so a host that doesn't bother resetting its own
    // "has text" state on close still ends up correct.
    return () => onDraftStateChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDraftText]);

  // Load the AI-resource manifest for /-slash suggestions. 候補はグローバルskill
  // (workspaceId未設定)と、編集対象ドキュメントが属するワークスペース専用skillだけ。
  // 実行時(buildRunContext)のスコープ判定と一致させておかないと、選べるのに実行時には
  // 無視されるskillが生まれる。
  useEffect(() => {
    const desktop = getDesktopBridge();
    if (!desktop?.aiResources) {
      return;
    }
    let cancelled = false;
    desktop.aiResources.getTree()
      .then((tree) => {
        if (cancelled) return;
        setAiResources(tree.resources.filter((resource) =>
          resource.enabled &&
          resource.kind === "skill" &&
          (resource.workspaceId == null || resource.workspaceId === documentWorkspaceId)));
      })
      .catch(() => {
        if (!cancelled) setAiResources([]);
      });
    return () => {
      cancelled = true;
    };
  }, [documentWorkspaceId]);

  // Search other SigmaDocs while an @-mention query is active.
  useEffect(() => {
    if (!mentionQuery) {
      return;
    }
    const desktop = getDesktopBridge();
    if (!desktop?.storage) {
      return;
    }
    let cancelled = false;
    desktop.storage.listFiles()
      .then((files) => {
        if (cancelled) return;
        setMentionCandidates(filterSigmaDocMentionCandidates({
          files,
          query: mentionQuery.query,
          currentFileId: documentIdentityKey,
          mentionedFileIds: mentionedDocuments.map((item) => item.fileId),
        }));
        setMentionActiveIndex(0);
      })
      .catch(() => {
        if (!cancelled) setMentionCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setMentionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [documentIdentityKey, mentionQuery, mentionedDocuments]);

  const slashCandidates = useMemo(
    () => filterAiResourceSlashCandidates({
      resources: aiResources,
      query: slashQuery?.query ?? "",
      selectedIds: selectedAiResourceIds,
      provider,
    }),
    [aiResources, provider, selectedAiResourceIds, slashQuery?.query],
  );
  const selectedAiResources = useMemo(() => {
    const providerKey = toAiResourceProvider(provider);
    return selectedAiResourceIds
      .map((id) => aiResources.find((resource) => resource.id === id))
      .filter((resource): resource is DesktopAiResourceManifestEntry =>
        resource !== undefined && resource.providers.includes(providerKey));
  }, [aiResources, provider, selectedAiResourceIds]);

  const mentionPopoverOpen = !!mentionQuery && (mentionLoading || mentionCandidates.length > 0);
  const slashPopoverOpen = !!slashQuery && slashCandidates.length > 0;
  const canSend = instruction.trim().length > 0 || attachments.length > 0;
  const hasChips = attachments.length > 0 || mentionedDocuments.length > 0 || selectedAiResources.length > 0;

  const updateQueriesFromInput = (value: string, cursor: number | null | undefined) => {
    const position = cursor ?? value.length;
    setMentionQuery(getActiveSigmaDocMentionQuery(value, position));
    setMentionCandidates([]);
    setMentionActiveIndex(0);
    setMentionLoading(Boolean(getActiveSigmaDocMentionQuery(value, position)));
    setSlashQuery(getActiveAiResourceSlashQuery(value, position));
    setSlashActiveIndex(0);
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setInstruction(event.currentTarget.value);
    updateQueriesFromInput(event.currentTarget.value, event.currentTarget.selectionStart);
  };

  const addFileAttachments = async (files: File[]) => {
    if (files.length === 0) {
      return;
    }
    const remaining = MAX_AI_EDIT_ATTACHMENTS - attachments.length;
    if (remaining <= 0) {
      setError(t("composer.attachmentLimit", { replace: { max: MAX_AI_EDIT_ATTACHMENTS } }));
      return;
    }
    try {
      const next = await Promise.all(
        files.slice(0, remaining).map((file) => createAiEditAttachmentFromFile(file, "file")),
      );
      setAttachments((current) => [...current, ...next].slice(0, MAX_AI_EDIT_ATTACHMENTS));
      setError(files.length > remaining ? t("composer.attachmentLimit", { replace: { max: MAX_AI_EDIT_ATTACHMENTS } }) : null);
    } catch {
      setError(t("composer.fileReadFailed"));
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = getClipboardImageFiles(event.clipboardData);
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    void addFileAttachments(imageFiles);
  };

  const selectMention = async (candidate: DesktopDocumentMetadata) => {
    const active = mentionQuery;
    if (!active) {
      return;
    }
    if (!mentionedDocuments.some((item) => item.fileId === candidate.fileId)
      && mentionedDocuments.length >= MAX_AI_EDIT_MENTIONED_DOCUMENTS) {
      setError(t("composer.mentionLimit", { replace: { max: MAX_AI_EDIT_MENTIONED_DOCUMENTS } }));
      setMentionQuery(null);
      return;
    }
    const desktop = getDesktopBridge();
    if (!desktop?.storage) {
      setMentionQuery(null);
      return;
    }
    setMentionLoading(true);
    try {
      const mentioned = await desktop.storage.loadDocument(candidate.fileId);
      if (!mentioned) {
        setError(t("composer.mentionLoadFailed"));
        return;
      }
      setMentionedDocuments((current) => current.some((item) => item.fileId === candidate.fileId)
        ? current
        : [...current, createMentionedDocumentContext(candidate, mentioned)].slice(0, MAX_AI_EDIT_MENTIONED_DOCUMENTS));
      // チップに一本化するため、@トリガーのテキストは挿入せず削除するだけ。
      setInstruction((current) => removeActiveTriggerRange(current, active));
      setError(null);
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(active.start, active.start);
      });
    } catch {
      setError(t("composer.mentionLoadFailed"));
    } finally {
      setMentionLoading(false);
      setMentionQuery(null);
      setMentionCandidates([]);
      setMentionActiveIndex(0);
    }
  };

  const selectSlash = (resource: DesktopAiResourceManifestEntry) => {
    const active = slashQuery;
    if (!active) {
      return;
    }
    setSelectedAiResourceIds((current) => current.includes(resource.id) ? current : [...current, resource.id]);
    // /トリガーのテキストも同様にチップだけ残して削除する。
    setInstruction((current) => removeActiveTriggerRange(current, active));
    setSlashQuery(null);
    setSlashActiveIndex(0);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(active.start, active.start);
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
      && reasoningEffortSupported && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      setReasoningEffort((current) => cycleReasoningEffort(
        reasoningEfforts,
        current,
        event.key === "ArrowUp" ? 1 : -1,
      ));
      return;
    }
    if (slashQuery && slashCandidates.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashActiveIndex((current) => (current + 1) % slashCandidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashActiveIndex((current) => (current - 1 + slashCandidates.length) % slashCandidates.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        selectSlash(slashCandidates[slashActiveIndex] ?? slashCandidates[0]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashQuery(null);
        return;
      }
    }
    if (mentionQuery && mentionCandidates.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionActiveIndex((current) => (current + 1) % mentionCandidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionActiveIndex((current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        void selectMention(mentionCandidates[mentionActiveIndex] ?? mentionCandidates[0]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    if (event.key === "Escape" && contextMenuOpen) {
      event.preventDefault();
      setContextMenuOpen(false);
      contextMenuToggleRef.current?.focus();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onRequestClose?.();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const handleBlur = (event: FocusEvent<HTMLTextAreaElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && (
      containerRef.current?.contains(next)
      || (next instanceof Element && next.closest(".ai-chat-model-menu"))
    )) {
      // Focus moved to another control inside this composer (attach button,
      // effort toggle, send button, or a body-portalled model item) — not a real "leave".
      return;
    }
    if (!canSend) {
      onRequestClose?.();
    }
  };

  const submit = () => {
    if (!canSend) {
      return;
    }
    const prefs = getAiModelPreferences();
    const nextPrefs = {
      ...prefs,
      provider,
      reasoningEffort,
      ...(provider === "claude"
        ? { claudeModel: selectedModel }
        : provider === "antigravity"
          ? { geminiModel: selectedModel }
          : { model: selectedModel }),
    };
    saveAiModelPreferences(nextPrefs);
    const turnAiResourceIds = selectedAiResources.map((resource) => resource.id);
    const turnReference = anchor.primaryBlockId
      ? createBlockAiEditReference(document, anchor.primaryBlockId)
      : null;
    const turnReferences = turnReference ? [turnReference] : [];
    const params = {
      runDocumentIdentityKey: documentIdentityKey,
      runAgentThreadId: aiChatRoomsStore.getRoom(roomId)?.agentThreadId ?? null,
      runDocument: document,
      turnReferences,
      turnAttachments: attachments,
      turnMentionedDocuments: mentionedDocuments,
      turnProvider: provider,
      turnAiResourceIds,
      turnInstruction: instruction.trim() || getAttachmentDefaultInstruction(attachments),
      turnModel: selectedModel,
      turnReasoningEffort: reasoningEffort,
      aiTargetId: anchor.primaryBlockId,
      anchor: createAiRunAnchor({
        primaryBlockId: anchor.primaryBlockId,
        documentId: documentIdentityKey,
        document,
        references: anchor.blockIds.length > 0 ? turnReferences : [],
        blockIds: anchor.blockIds,
        shapeIds: anchor.shapeIds,
        canvas: anchor.canvas,
        preferredTarget: anchor.preferredTarget,
      }),
    };

    if (aiRunSessionStore.isRunning(roomId)) {
      enqueueFollowUp(roomId, params);
    } else {
      startRun(roomId, params);
    }

    setInstruction("");
    setAttachments([]);
    setMentionedDocuments([]);
    setSelectedAiResourceIds([]);
    setMentionQuery(null);
    setSlashQuery(null);
    setError(null);
    onSent?.();
  };

  return (
    <div className="ai-run-card-composer" ref={containerRef}>
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        multiple
        onChange={(event) => {
          void addFileAttachments(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      <div className="ai-chat-input-shell">
        {hasChips && (
          <div className="ai-chat-context-row">
            {attachments.map((attachment) => (
              <AttachmentPreview
                key={attachment.id}
                attachment={attachment}
                onRemove={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
              />
            ))}
            {mentionedDocuments.map((item) => (
              <MentionedDocumentChip
                key={item.id}
                item={item}
                onRemove={() => setMentionedDocuments((current) => current.filter((doc) => doc.id !== item.id))}
              />
            ))}
            {selectedAiResources.map((item) => (
              <AiResourceChip
                key={item.id}
                item={item}
                onRemove={() => setSelectedAiResourceIds((current) => current.filter((id) => id !== item.id))}
              />
            ))}
          </div>
        )}
        {mentionPopoverOpen && (
          <SigmaDocMentionPopover
            candidates={mentionCandidates}
            loading={mentionLoading}
            activeIndex={mentionActiveIndex}
            onHover={setMentionActiveIndex}
            onSelect={(candidate) => void selectMention(candidate)}
          />
        )}
        {slashPopoverOpen && (
          <AiResourceSlashPopover
            candidates={slashCandidates}
            activeIndex={slashActiveIndex}
            onHover={setSlashActiveIndex}
            onSelect={selectSlash}
          />
        )}
        <AiChatTextInput
          ref={inputRef}
          rows={1}
          placeholder={t("composer.placeholder")}
          value={instruction}
          onChange={handleChange}
          onClick={(event) => updateQueriesFromInput(event.currentTarget.value, event.currentTarget.selectionStart)}
          onKeyUp={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === "Tab") {
              return;
            }
            updateQueriesFromInput(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onMouseDown={(event) => event.stopPropagation()}
          aria-label={t("composer.followUpAria")}
        />
        <div className="ai-chat-toolbar">
          <div className="ai-chat-add-wrap">
            <button
              ref={contextMenuToggleRef}
              type="button"
              className="ai-chat-icon-button"
              title={t("composer.addContext")}
              aria-label={t("composer.addContext")}
              aria-expanded={contextMenuOpen}
              onClick={() => setContextMenuOpen((open) => !open)}
            >
              <Plus size={16} />
            </button>
            {contextMenuOpen && (
              <div
                ref={contextMenuRef}
                className="ai-chat-context-menu"
                role="menu"
                aria-label={t("composer.addContext")}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setContextMenuOpen(false);
                    contextMenuToggleRef.current?.focus();
                  }
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setContextMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                >
                  <Paperclip size={15} />
                  <span>{t("composer.addFile")}</span>
                </button>
              </div>
            )}
          </div>
          <div className="ai-chat-model-wrap ai-run-card-model-wrap">
            <button
              ref={modelMenuButtonRef}
              type="button"
              className="ai-chat-model-button"
              title={t("composer.modelButtonTitle", { replace: {
                provider: selectedProviderLabel,
                model: selectedModelLabel,
                effort: reasoningEffortSupported
                  ? t("composer.effortWithId", { replace: { label: selectedReasoningEffortLabel, id: reasoningEffort } })
                  : t("composer.effortUnsupported"),
              } })}
              aria-label={t("composer.modelButtonAria", { replace: {
                provider: selectedProviderLabel,
                model: selectedModelLabel,
                effort: reasoningEffortSupported
                  ? t("composer.effortWithLabel", { replace: { label: selectedReasoningEffortLabel } })
                  : t("composer.effortUnsupported"),
              } })}
              aria-haspopup="menu"
              aria-expanded={modelMenuOpen}
              onClick={() => {
                setModelMenuOpen((open) => !open);
                setModelFlyout(null);
              }}
            >
              {renderModelMark(selectedModel, provider, { size: 13 })}
              <span className="ai-chat-model-button-label">
                <span>{selectedProviderLabel}</span>
                <span className="ai-chat-model-button-divider" aria-hidden="true">·</span>
                <span>{selectedModelLabel}</span>
                <span className="ai-chat-model-button-divider" aria-hidden="true">·</span>
                <span>{reasoningEffortSupported ? selectedReasoningEffortLabel : t("composer.effortUnsupported")}</span>
              </span>
              <ChevronDown size={12} />
            </button>
            {modelMenuOpen && (
              <ToolbarPopover
                open
                anchorRef={modelMenuButtonRef}
                onClose={() => {
                  setModelMenuOpen(false);
                  setModelFlyout(null);
                }}
                align="right"
                placement="top"
                gap={8}
                zIndex={4900}
                className="ai-chat-model-menu"
                role="menu"
                ariaLabel={t("composer.modelAndEffort")}
                onMouseLeave={() => setModelFlyout(null)}
              >
                <AiModelMenuContents
                  t={t} provider={provider} selectedProviderLabel={selectedProviderLabel}
                  selectedModel={selectedModel} selectedModelLabel={selectedModelLabel}
                  reasoningEffort={reasoningEffort} selectedReasoningEffortLabel={selectedReasoningEffortLabel}
                  reasoningEffortSupported={reasoningEffortSupported} reasoningEfforts={reasoningEfforts}
                  modelOptions={modelOptions} modelCatalogLoading={modelCatalogLoading && !runtimeModelCatalog}
                  modelCatalogError={modelCatalogError} modelFlyout={modelFlyout}
                  setModelFlyout={setModelFlyout} setModelMenuOpen={setModelMenuOpen}
                  onSelectEffort={(item) => setReasoningEffort(item as AiEditReasoningEffort)}
                  onSelectModel={(item) => {
                          setSelectedModel(item.id);
                          const efforts = getProviderReasoningEfforts(provider, modelOptions, item.id);
                          if (efforts.length > 0 && !efforts.includes(reasoningEffort)) {
                            setReasoningEffort((item.defaultReasoningEffort && efforts.includes(item.defaultReasoningEffort)
                              ? item.defaultReasoningEffort
                              : efforts[0]) as AiEditReasoningEffort);
                          }
                          }}
                />
              </ToolbarPopover>
            )}
          </div>
          <button
            type="button"
            className="ai-chat-send-button"
            disabled={!canSend}
            title={t("composer.send")}
            aria-label={t("composer.send")}
            onClick={submit}
          >
            <ArrowUp size={16} strokeWidth={2.5} aria-hidden="true" />
          </button>
        </div>
      </div>
      {error && <p className="ai-run-card-composer-error">{error}</p>}
    </div>
  );
}
