"use client";
import { useRef } from "react";
import type { AiProvider } from "@/lib/ai/ai-providers";
import { AiModelMenuContents } from "@/components/editor/ai-model-menu-contents";
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  FileText,
  PanelRight,
  Paperclip,
  Plus,
  Search,
  Sparkles,
  SquarePen,
  X,
} from "lucide-react";
import { AntigravityMark, ClaudeMark, OpenAiMark, renderModelMark } from "@/components/branding/provider-logos";
import { AiChatTextInput } from "@/components/editor/AiChatTextInput";
import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import { Shimmer } from "@/components/ui/Shimmer";
import { getAiEditReferenceKey, getReferenceDisplayLabel } from "@/lib/ai/ai-edit-reference";
import {
  cycleReasoningEffort,
  formatReasoningEffortLabel,
  getProviderReasoningEfforts,
  resolveAiModelOptions,
} from "@/lib/ai/ai-model-catalog";
import type { useAiChatModelController } from "@/features/ai-edit/application/use-ai-chat-model-controller";
import { aiProviderLabel, claudeModelLabel, geminiModelLabel } from "@/lib/ai/ai-providers";
import { resolveAiResourceDisplayMetadata } from "@/lib/ai/ai-resource-display";
import { type AiEditModel, type AiEditReasoningEffort } from "@/lib/ai/sigma-doc-edit-schema";
import { useT } from "@/lib/i18n/react";
import { MAX_AI_EDIT_MENTIONED_DOCUMENTS } from "@/features/ai-edit/application/ai-chat-context";
import { buildAiActionPresets } from "@/features/ai-edit/view/ai-chat-presets";
import { ComposerOverlaySelectionPreview } from "@/features/ai-edit/view/AiChatPreviewImages";
import {
  MentionedDocumentChip,
  AiResourceChip,
  SigmaDocMentionPopover,
  AiResourceSlashPopover,
  AttachmentPreview,
} from "@/features/ai-edit/view/AiChatComposerParts";
import type { AiEditPanelProps } from "@/features/ai-edit/application/ai-chat-panel-contracts";
import type { AiChatComposerController } from "../application/use-ai-chat-composer";
export interface AiChatComposerProps {
 controller: AiChatComposerController;
 models: ReturnType<typeof useAiChatModelController>;
 pinnedReferences: NonNullable<AiEditPanelProps["pinnedReferences"]>;
 onRemovePinnedReference: AiEditPanelProps["onRemovePinnedReference"];
 lockedProvider: AiProvider | null;
 composerVariant: "inline" | "sidebar";
 inlineSessionId: number;
 onPromoteToSidebar: AiEditPanelProps["onPromoteToSidebar"];
 historyLoading: boolean;
 isRunning: boolean;
 hasTurns: boolean;
 onSubmit: () => Promise<void>;
}
export function AiChatComposer({ controller, models, pinnedReferences,onRemovePinnedReference,lockedProvider,composerVariant,inlineSessionId,onPromoteToSidebar,historyLoading,isRunning,hasTurns,onSubmit:runEdit }: AiChatComposerProps) {
 const modelMenuButtonRef = useRef<HTMLButtonElement | null>(null);
 const t=useT("ai");const tEditor=useT("editor");const tCommon=useT("common");
 const {provider,setProvider,model,setModel,claudeModel,setClaudeModel,geminiModel,setGeminiModel,reasoningEffort,setReasoningEffort,runtimeModelCatalogs,modelCatalogLoadingProvider,modelCatalogErrors}=models;
 const {
    instruction,
    setInstruction,
    attachments,
    mentionedDocuments,
    mentionQuery,
    setMentionQuery,
    mentionCandidates,
    setMentionCandidates,
    mentionLoading,
    mentionActiveIndex,
    setMentionActiveIndex,
    selectedAiResourceIds,
    slashQuery,
    setSlashQuery,
    slashActiveIndex,
    setSlashActiveIndex,
    contextMenuOpen,
    setContextMenuOpen,
    contextPickerQuery,
    setContextPickerQuery,
    contextPickerDocLoading,
    contextPickerActiveIndex,
    setContextPickerActiveIndex,
    modelMenuOpen,
    setModelMenuOpen,
    modelFlyout,
    setModelFlyout,
    mediaInputRef,
    contextPickerRef,
    contextPickerSearchRef,
    contextPickerToggleRef,
    composerRef,
    showReferenceChip,
    activeReference,
    selectedOverlayImageCount,
    selectedOverlayNonImageShapeCount,
    overlayComposerPreviews,
    handleAttachmentFiles,
    handleInstructionPaste,
    removeAttachment,
    removeMentionedDocument,
    removeSelectedAiResource,
    updateMentionQueryFromInput,
    handleInstructionChange,
    handleMentionCandidateSelect,
    handleAiResourceSelect,
    selectContextPickerItem,
    dismissReferenceChip,
    toggleContextMenu,
    toggleModelMenu,
    mentionPopoverOpen,
    slashCandidates,
    slashPopoverOpen,
    contextPickerDocCandidates,
    contextPickerSkillCandidates,
    contextPickerItems,
    selectedAiResources
  }=controller.view;
  const hasChipRow = pinnedReferences.length > 0
    || showReferenceChip
    || overlayComposerPreviews.length > 0
    || attachments.length > 0
    || mentionedDocuments.length > 0
    || selectedAiResources.length > 0;
  const selectedProviderModel = provider === "claude" ? claudeModel : provider === "antigravity" ? geminiModel : model;
  const activeModelOptions = resolveAiModelOptions(provider, runtimeModelCatalogs[provider]);
  const selectedModelOption = activeModelOptions.find((option) => option.id === selectedProviderModel);
  const selectedModelLabel = selectedModelOption?.label ?? (
    provider === "claude" ? claudeModelLabel(claudeModel) : provider === "antigravity" ? geminiModelLabel(geminiModel) : model
  );
  const selectedProviderLabel = aiProviderLabel(provider);
  const selectedReasoningEffortLabel = formatReasoningEffortLabel(reasoningEffort, t);
  const activeReasoningEfforts = getProviderReasoningEfforts(
    provider,
    activeModelOptions,
    selectedProviderModel,
  );
  const reasoningEffortSupported = activeReasoningEfforts.length > 0;
  const modelCatalogLoading = modelCatalogLoadingProvider === provider;
  const modelCatalogError = modelCatalogErrors[provider];

  // The composer (text field + chips + @/slash popovers + toolbar) is rendered
  // verbatim in both the docked sidebar and the inline editor so the input UI is
  // identical; only the wrapper layout differs via the --inline modifier.
  return (
    <div
      className={`ai-chat-composer ${composerVariant === "inline" ? "ai-chat-composer--inline" : ""}`.trim()}
      aria-label={t("composer.instructionAria")}
    >
      <input
        ref={mediaInputRef}
        className="visually-hidden"
        type="file"
        multiple
        onChange={(event) => {
          handleAttachmentFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      <div
        key={composerVariant === "inline" ? `inline-${inlineSessionId}` : "sidebar"}
        className="ai-chat-input-shell ai-chat-input-shell--enter"
      >
        {hasChipRow && (
          <div className="ai-chat-context-row">
            {pinnedReferences.map((pinnedReference) => {
              const pinnedKey = getAiEditReferenceKey(pinnedReference);
              return (
                <span key={pinnedKey} className="ai-chat-chip" data-reference-kind={pinnedReference.kind}>
                  <AtSign size={11} />
                  <span className="ai-chat-chip-label">{getReferenceDisplayLabel(pinnedReference, t, tEditor)}</span>
                  {onRemovePinnedReference && (
                    <button
                      type="button"
                      className="ai-chat-chip-remove"
                      title={t("reference.clear")}
                      aria-label={t("reference.clear")}
                      onClick={() => onRemovePinnedReference(pinnedKey)}
                    >
                      <X size={12} />
                    </button>
                  )}
                </span>
              );
            })}
            {overlayComposerPreviews.map((overlayPreview) => (
              <ComposerOverlaySelectionPreview
                key={overlayPreview.referenceKey}
                preview={overlayPreview.preview}
                shapeCount={overlayPreview.shapeCount}
              />
            ))}
            {showReferenceChip && activeReference && (
              <span className="ai-chat-chip" data-reference-kind={activeReference.kind}>
                <AtSign size={11} />
                <span className="ai-chat-chip-label">{getReferenceDisplayLabel(activeReference, t, tEditor)}</span>
                {selectedOverlayImageCount > 0 && (
                  <span className="ai-chat-chip-meta">{t("reference.plusImages", { replace: { count: selectedOverlayImageCount } })}</span>
                )}
                {selectedOverlayNonImageShapeCount > 0 && (
                  <span className="ai-chat-chip-meta">{t("reference.plusShapes", { replace: { count: selectedOverlayNonImageShapeCount } })}</span>
                )}
                <button
                  type="button"
                  className="ai-chat-chip-remove"
                  title={t("reference.clear")}
                  aria-label={t("reference.clear")}
                  onClick={dismissReferenceChip}
                >
                  <X size={12} />
                </button>
              </span>
            )}
            {attachments.map((attachment) => (
              <AttachmentPreview
                key={attachment.id}
                attachment={attachment}
                onRemove={() => removeAttachment(attachment.id)}
              />
            ))}
            {mentionedDocuments.map((item) => (
              <MentionedDocumentChip
                key={item.id}
                item={item}
                onRemove={() => removeMentionedDocument(item.id)}
              />
            ))}
            {selectedAiResources.map((item) => (
              <AiResourceChip
                key={item.id}
                item={item}
                onRemove={() => removeSelectedAiResource(item.id)}
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
            onSelect={(candidate) => void handleMentionCandidateSelect(candidate)}
          />
        )}
        {slashPopoverOpen && (
          <AiResourceSlashPopover
            candidates={slashCandidates}
            activeIndex={slashActiveIndex}
            onHover={setSlashActiveIndex}
            onSelect={handleAiResourceSelect}
          />
        )}
        <AiChatTextInput
          ref={composerRef}
          id="ai-edit-instruction"
          aria-label={t("composer.instructionAria")}
          rows={1}
          value={instruction}
          onChange={handleInstructionChange}
          onClick={(event) => updateMentionQueryFromInput(event.currentTarget.value, event.currentTarget.selectionStart)}
          onSelect={(event) => updateMentionQueryFromInput(event.currentTarget.value, event.currentTarget.selectionStart)}
          onKeyUp={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === "Tab") {
              return;
            }
            updateMentionQueryFromInput(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          onPaste={handleInstructionPaste}
          onKeyDown={(event) => {
            if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
              && reasoningEffortSupported && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
              event.preventDefault();
              setReasoningEffort((current) => cycleReasoningEffort(
                activeReasoningEfforts,
                current,
                event.key === "ArrowUp" ? 1 : -1,
              ));
              return;
            }
            if (slashQuery) {
              if (event.key === "Escape") {
                event.preventDefault();
                setSlashQuery(null);
                setSlashActiveIndex(0);
                return;
              }
              if (slashCandidates.length > 0 && event.key === "ArrowDown") {
                event.preventDefault();
                setSlashActiveIndex((current) => (current + 1) % slashCandidates.length);
                return;
              }
              if (slashCandidates.length > 0 && event.key === "ArrowUp") {
                event.preventDefault();
                setSlashActiveIndex((current) => (current - 1 + slashCandidates.length) % slashCandidates.length);
                return;
              }
              if (slashCandidates.length > 0 && (event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                handleAiResourceSelect(slashCandidates[slashActiveIndex] ?? slashCandidates[0]);
                return;
              }
            }
            if (mentionQuery) {
              if (event.key === "Escape") {
                event.preventDefault();
                setMentionQuery(null);
                setMentionCandidates([]);
                setMentionActiveIndex(0);
                return;
              }
              if (mentionCandidates.length > 0 && event.key === "ArrowDown") {
                event.preventDefault();
                setMentionActiveIndex((current) => (current + 1) % mentionCandidates.length);
                return;
              }
              if (mentionCandidates.length > 0 && event.key === "ArrowUp") {
                event.preventDefault();
                setMentionActiveIndex((current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length);
                return;
              }
              if (mentionCandidates.length > 0 && (event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                void handleMentionCandidateSelect(mentionCandidates[mentionActiveIndex] ?? mentionCandidates[0]);
                return;
              }
            }
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void runEdit();
            }
          }}
          placeholder={hasTurns ? t("composer.placeholder") : t("composer.placeholderFirst")}
        />
        <div
          className={`ai-chat-toolbar${composerVariant === "inline" && onPromoteToSidebar ? " ai-chat-toolbar--inline" : ""}`.trim()}
        >
          <div className="ai-chat-add-wrap">
            <button
              ref={contextPickerToggleRef}
              type="button"
              className="ai-chat-icon-button"
              title={t("composer.addContext")}
              aria-label={t("composer.addContext")}
              aria-expanded={contextMenuOpen}
              onClick={toggleContextMenu}
            >
              <Plus size={16} />
            </button>
            {contextMenuOpen && (
              <div
                ref={contextPickerRef}
                className="ai-chat-context-menu ai-chat-context-picker"
                role="menu"
                aria-label={t("composer.addContext")}
                onKeyDown={(event) => {
                  // Esc closes regardless of which element inside the picker currently has
                  // focus (e.g. after clicking a toggle option button, not just from the
                  // search input's own handler below).
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setContextMenuOpen(false);
                    contextPickerToggleRef.current?.focus();
                  }
                }}
              >
                <div className="ai-chat-context-picker-heading">{tCommon("actions.add")}</div>
                <button
                  type="button"
                  role="menuitem"
                  className="ai-chat-context-file-action"
                  onClick={() => {
                    setContextMenuOpen(false);
                    mediaInputRef.current?.click();
                  }}
                >
                  <Paperclip size={15} />
                  <span>{t("composer.addFile")}</span>
                </button>
                <div className="ai-chat-menu-divider" />
                <div className="ai-chat-context-picker-search">
                  <Search size={13} />
                  <input
                    ref={contextPickerSearchRef}
                    type="text"
                    value={contextPickerQuery}
                    onChange={(event) => {
                      setContextPickerQuery(event.currentTarget.value);
                      setContextPickerActiveIndex(0);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setContextMenuOpen(false);
                        contextPickerToggleRef.current?.focus();
                        return;
                      }
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setContextPickerActiveIndex((current) =>
                          contextPickerItems.length === 0 ? 0 : (current + 1) % contextPickerItems.length);
                        return;
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setContextPickerActiveIndex((current) =>
                          contextPickerItems.length === 0 ? 0 : (current - 1 + contextPickerItems.length) % contextPickerItems.length);
                        return;
                      }
                      if (event.key === "Enter") {
                        event.preventDefault();
                        const activeItem = contextPickerItems[contextPickerActiveIndex];
                        if (activeItem) {
                          selectContextPickerItem(activeItem);
                        }
                      }
                    }}
                    placeholder={t("composer.searchDocsAndSkills")}
                    aria-label={t("composer.searchContext")}
                  />
                </div>
                <div className="ai-chat-context-picker-list">
                  <div className="ai-chat-menu-title">{t("composer.documents")}</div>
                  {contextPickerDocLoading && contextPickerDocCandidates.length === 0 ? (
                    <div className="ai-chat-mention-empty"><Shimmer>{t("composer.searching")}</Shimmer></div>
                  ) : contextPickerDocCandidates.length === 0 ? (
                    <div className="ai-chat-mention-empty">{t("composer.noCandidates")}</div>
                  ) : (
                    contextPickerDocCandidates.map((candidate, index) => {
                      const selected = mentionedDocuments.some((item) => item.fileId === candidate.fileId);
                      const capReached = !selected && mentionedDocuments.length >= MAX_AI_EDIT_MENTIONED_DOCUMENTS;
                      return (
                        <button
                          key={candidate.fileId}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={selected}
                          className="ai-chat-mention-option"
                          data-active={index === contextPickerActiveIndex}
                          disabled={capReached}
                          title={capReached ? t("composer.mentionLimitShort", { replace: { max: MAX_AI_EDIT_MENTIONED_DOCUMENTS } }) : undefined}
                          onMouseEnter={() => setContextPickerActiveIndex(index)}
                          onClick={() => selectContextPickerItem({ kind: "doc", candidate })}
                        >
                          <FileText size={15} />
                          <span className="ai-chat-mention-main">
                            <span className="ai-chat-mention-name">{candidate.title}</span>
                          </span>
                          {selected ? <Check size={14} /> : null}
                        </button>
                      );
                    })
                  )}
                  <div className="ai-chat-menu-divider" />
                  <div className="ai-chat-menu-title">{t("composer.skills")}</div>
                  {contextPickerSkillCandidates.length === 0 ? (
                    <div className="ai-chat-mention-empty">{t("composer.noCandidates")}</div>
                  ) : (
                    contextPickerSkillCandidates.map((candidate, skillIndex) => {
                      const flatIndex = contextPickerDocCandidates.length + skillIndex;
                      const selected = selectedAiResourceIds.includes(candidate.id);
                      const display = resolveAiResourceDisplayMetadata(candidate, t);
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={selected}
                          className="ai-chat-mention-option"
                          data-active={flatIndex === contextPickerActiveIndex}
                          onMouseEnter={() => setContextPickerActiveIndex(flatIndex)}
                          onClick={() => selectContextPickerItem({ kind: "skill", candidate })}
                        >
                          <Sparkles size={15} />
                          <span className="ai-chat-mention-main">
                            <span className="ai-chat-mention-name">{display.title}</span>
                            <span className="ai-chat-mention-path">{display.description}</span>
                          </span>
                          {selected ? <Check size={14} /> : <span className="ai-chat-mention-revision">{t("composer.skills")}</span>}
                        </button>
                      );
                    })
                  )}
                  <div className="ai-chat-menu-divider" />
                  <div className="ai-chat-menu-title">Actions</div>
                  {buildAiActionPresets(t).map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setInstruction((current) => (current.trim() ? `${current.trim()}\n${preset.prompt}` : preset.prompt));
                        setContextMenuOpen(false);
                        composerRef.current?.focus();
                      }}
                    >
                      <SquarePen size={14} />
                      <span>{preset.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="ai-chat-model-wrap">
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
              aria-label={t("composer.providerModelAria", { replace: {
                provider: selectedProviderLabel,
                model: selectedModelLabel,
                effort: reasoningEffortSupported
                  ? t("composer.effortWithLabel", { replace: { label: selectedReasoningEffortLabel } })
                  : t("composer.effortUnsupported"),
              } })}
              aria-haspopup="menu"
              aria-expanded={modelMenuOpen}
              onClick={toggleModelMenu}
              disabled={isRunning}
            >
              {renderModelMark(selectedProviderModel, provider, { size: 13 })}
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
                ariaLabel={t("composer.providerAndModel")}
                onMouseLeave={() => setModelFlyout(null)}
              >
                {/* Provider stays selectable only until the room is bound to one
                    (its first run). Afterwards a conversation is locked to its
                    provider — only model/effort remain adjustable. */}
                {!lockedProvider && (
                  <>
                    <div className="ai-chat-menu-title">{t("composer.provider")}</div>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={provider === "chatgpt"}
                      aria-label="ChatGPT"
                      title="ChatGPT"
                      className="ai-chat-model-menu-item"
                      onClick={() => {
                        setProvider("chatgpt");
                        setModelFlyout(null);
                      }}
                    >
                      <OpenAiMark size={13} />
                      <span>ChatGPT</span>
                      {provider === "chatgpt" && <Check size={13} />}
                    </button>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={provider === "claude"}
                      aria-label="Claude"
                      title="Claude"
                      className="ai-chat-model-menu-item"
                      onClick={() => {
                        setProvider("claude");
                        setModelFlyout(null);
                      }}
                    >
                      <ClaudeMark size={13} />
                      <span>Claude</span>
                      {provider === "claude" && <Check size={13} />}
                    </button>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={provider === "antigravity"}
                      aria-label="Antigravity"
                      title="Antigravity"
                      className="ai-chat-model-menu-item"
                      onClick={() => {
                        setProvider("antigravity");
                        setModelFlyout(null);
                      }}
                    >
                      <AntigravityMark size={13} />
                      <span>Antigravity</span>
                      {provider === "antigravity" && <Check size={13} />}
                    </button>
                    <div className="ai-chat-menu-divider" />
                  </>
                )}
                <AiModelMenuContents
                  t={t} provider={provider} selectedProviderLabel={selectedProviderLabel}
                  selectedModel={selectedProviderModel} selectedModelLabel={selectedModelLabel}
                  reasoningEffort={reasoningEffort} selectedReasoningEffortLabel={selectedReasoningEffortLabel}
                  reasoningEffortSupported={reasoningEffortSupported} reasoningEfforts={activeReasoningEfforts}
                  modelOptions={activeModelOptions} modelCatalogLoading={modelCatalogLoading && !runtimeModelCatalogs[provider]}
                  modelCatalogError={modelCatalogError} modelFlyout={modelFlyout}
                  setModelFlyout={setModelFlyout} setModelMenuOpen={setModelMenuOpen}
                  onSelectEffort={(item) => setReasoningEffort(item as AiEditReasoningEffort)}
                  onSelectModel={(item) => {
                            if (provider === "claude") {
                              setClaudeModel(item.id);
                            } else if (provider === "antigravity") {
                              setGeminiModel(item.id);
                            } else {
                              setModel(item.id as AiEditModel);
                            }
                            if (provider !== "antigravity") {
                              const efforts = item.supportedReasoningEfforts?.map((option) => option.id) ?? [];
                              if (efforts.length > 0 && !efforts.includes(reasoningEffort)) {
                                setReasoningEffort((item.defaultReasoningEffort && efforts.includes(item.defaultReasoningEffort)
                                  ? item.defaultReasoningEffort
                                  : efforts[0]) as AiEditReasoningEffort);
                              }
                            }
                            }}
                />
              </ToolbarPopover>
            )}
          </div>
          {composerVariant === "inline" && onPromoteToSidebar && (
            <button
              type="button"
              className="ai-chat-icon-button ai-inline-to-sidebar"
              title={t("run.openInSideChat")}
              aria-label={t("run.openInSideChat")}
              onClick={onPromoteToSidebar}
            >
              <PanelRight size={14} />
            </button>
          )}
          <button
            type="button"
            className="ai-chat-send-button"
            disabled={historyLoading}
            // R3: stays enabled while the room is running — sending queues a
            // follow-up turn instead of blocking on the in-flight run.
            title={historyLoading ? t("chat.historyLoading") : isRunning ? t("composer.sendQueued") : t("composer.send")}
            aria-label={historyLoading ? t("chat.historyLoading") : isRunning ? t("composer.sendQueued") : t("composer.send")}
            onClick={() => void runEdit()}
          >
            <ArrowUp size={16} strokeWidth={2.5} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );

}
