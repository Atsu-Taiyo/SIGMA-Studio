"use client";

import { ArrowUp, Check, ChevronDown, Square, X } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { renderModelMark, renderProviderMark } from "@/components/branding/provider-logos";
import { AiChatTextInput } from "@/components/editor/AiChatTextInput";
import { AiModelMenuContents } from "@/components/editor/ai-model-menu-contents";
import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import type { AiConnectionStateKind } from "@/lib/ai/ai-connection";
import { AI_PROVIDER_LABELS, type AiProvider } from "@/lib/ai/ai-providers";
import { useT } from "@/lib/i18n/react";

import type { AiModelSelection } from "../application/use-ai-model-selection";
import styles from "./ProblemFrameChat.module.css";

const PROVIDERS: readonly AiProvider[] = ["chatgpt", "claude", "antigravity"];

interface ComposerProps {
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  running: boolean;
  /** No AI can run (none connected, or not the desktop app). */
  unavailable: boolean;
  /** The chosen AI is still being checked: the input works, sending waits. */
  waiting: boolean;
  placeholder: string;
  selection: AiModelSelection;
  connections: Record<AiProvider, AiConnectionStateKind>;
  /** Shown as a removable chip while the AI would start from the problem's current frame. */
  reviseFromCurrent: boolean;
  onRemoveRevise: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

/**
 * The chat input of the frame conversation. It is the same surface, the same model menu and the
 * same send button as the AI chat, so choosing a provider, a model and how hard it thinks works the
 * way people already know.
 */
export function ProblemFrameChatComposer({
  draft,
  onDraftChange,
  onSubmit,
  onStop,
  running,
  unavailable,
  waiting,
  placeholder,
  selection,
  connections,
  reviseFromCurrent,
  onRemoveRevise,
  inputRef,
}: ComposerProps) {
  const t = useT("settings");
  const tAi = useT("ai");
  const [menuOpen, setMenuOpen] = useState(false);
  const [flyout, setFlyout] = useState<"model" | "effort" | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const { provider, providerLabel, modelLabel, reasoningEffort, reasoningEffortLabel, reasoningEffortSupported } = selection;
  const effortText = reasoningEffortSupported
    ? tAi("composer.effortWithLabel", { replace: { label: reasoningEffortLabel } })
    : tAi("composer.effortUnsupported");

  const statusLabel = (kind: AiConnectionStateKind): string => {
    if (kind === "checking") return t("problem.custom.aiStatusChecking");
    if (kind === "loggedOut") return t("problem.custom.aiStatusLoggedOut");
    return t("problem.custom.aiStatusUnavailable");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!running) {
        onSubmit();
      }
    }
  };

  return (
    <div className={`ai-chat-input-shell ${styles.composer}`} data-testid="problem-custom-frame-ai-composer">
      {reviseFromCurrent && (
        <div className={styles.contextRow}>
          <span className={styles.contextChip}>
            {t("problem.custom.chat.reviseChip")}
            <button
              type="button"
              className={styles.contextChipRemove}
              aria-label={t("problem.custom.chat.reviseChipRemove")}
              onClick={onRemoveRevise}
            >
              <X size={11} aria-hidden="true" />
            </button>
          </span>
        </div>
      )}
      <AiChatTextInput
        ref={inputRef}
        rows={1}
        placeholder={placeholder}
        value={draft}
        disabled={unavailable}
        aria-label={t("problem.custom.chat.inputAria")}
        data-testid="problem-custom-frame-ai-prompt"
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className={styles.toolbar}>
        <div className="ai-chat-model-wrap">
          <button
            ref={menuButtonRef}
            type="button"
            className="ai-chat-model-button"
            data-testid="problem-custom-frame-ai-model-button"
            disabled={unavailable}
            title={tAi("composer.modelButtonTitle", { replace: { provider: providerLabel, model: modelLabel, effort: effortText } })}
            aria-label={tAi("composer.modelButtonAria", { replace: { provider: providerLabel, model: modelLabel, effort: effortText } })}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((open) => !open);
              setFlyout(null);
            }}
          >
            {renderModelMark(selection.model, provider, { size: 13 })}
            <span className="ai-chat-model-button-label">
              <span>{providerLabel}</span>
              <span className="ai-chat-model-button-divider" aria-hidden="true">·</span>
              <span>{modelLabel}</span>
              <span className="ai-chat-model-button-divider" aria-hidden="true">·</span>
              <span>{reasoningEffortSupported ? reasoningEffortLabel : tAi("composer.effortUnsupported")}</span>
            </span>
            <ChevronDown size={12} />
          </button>
          {menuOpen && (
            <ToolbarPopover
              open
              anchorRef={menuButtonRef}
              onClose={() => {
                setMenuOpen(false);
                setFlyout(null);
              }}
              align="left"
              placement="top"
              gap={8}
              zIndex={4900}
              className="ai-chat-model-menu"
              role="menu"
              ariaLabel={tAi("composer.providerAndModel")}
              onMouseLeave={() => setFlyout(null)}
            >
              <div className="ai-chat-menu-title">{tAi("composer.provider")}</div>
              {PROVIDERS.map((candidate) => {
                const connected = connections[candidate] === "loggedIn";
                return (
                  <button
                    key={candidate}
                    type="button"
                    role="menuitemradio"
                    aria-checked={provider === candidate}
                    disabled={!connected}
                    title={connected ? AI_PROVIDER_LABELS[candidate] : statusLabel(connections[candidate])}
                    data-testid={`problem-custom-frame-ai-provider-${candidate}`}
                    className="ai-chat-model-menu-item"
                    onClick={() => {
                      selection.selectProvider(candidate);
                      setFlyout(null);
                    }}
                  >
                    {renderProviderMark(candidate, { size: 13 })}
                    <span className="ai-chat-model-submenu-copy">
                      <span>{AI_PROVIDER_LABELS[candidate]}</span>
                      {!connected && <small>{statusLabel(connections[candidate])}</small>}
                    </span>
                    {provider === candidate && <Check size={13} />}
                  </button>
                );
              })}
              <div className="ai-chat-menu-divider" />
              <AiModelMenuContents
                t={tAi}
                provider={provider}
                selectedProviderLabel={providerLabel}
                selectedModel={selection.model}
                selectedModelLabel={modelLabel}
                reasoningEffort={reasoningEffort}
                selectedReasoningEffortLabel={reasoningEffortLabel}
                reasoningEffortSupported={reasoningEffortSupported}
                reasoningEfforts={selection.reasoningEfforts}
                modelOptions={selection.modelOptions}
                modelCatalogLoading={selection.modelCatalogLoading}
                modelCatalogError={selection.modelCatalogError}
                modelFlyout={flyout}
                setModelFlyout={setFlyout}
                setModelMenuOpen={setMenuOpen}
                onSelectEffort={selection.selectEffort}
                onSelectModel={selection.selectModel}
              />
            </ToolbarPopover>
          )}
        </div>
        {running ? (
          <button
            type="button"
            className="ai-chat-send-button"
            data-testid="problem-custom-frame-ai-stop"
            title={tAi("composer.stop")}
            aria-label={tAi("composer.stop")}
            onClick={onStop}
          >
            <Square size={13} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="ai-chat-send-button"
            data-testid="problem-custom-frame-ai-generate"
            disabled={unavailable || waiting || draft.trim().length === 0}
            title={t("problem.custom.chat.send")}
            aria-label={t("problem.custom.chat.send")}
            onClick={onSubmit}
          >
            <ArrowUp size={16} strokeWidth={2.5} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
