"use client";

import { Keyboard, RotateCcw, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { Button, IconButton } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { useT } from "@/lib/i18n/react";

import { CustomCommandComposer } from "./CustomCommandComposer";
import { useSettingsEntryFocus } from "./settings-entry-focus";
import {
  assignShortcutOverride,
  clearShortcutOverride,
  createEditorCustomCommandDefinition,
  findShortcutConflict,
  formatShortcut,
  getEditorCommandCatalog,
  resolveEditorCommand,
  resolveEditorCommandCatalog,
  type ResolvedEditorCommand,
  getShortcutForCommand,
  resetAllShortcutOverrides,
  resetShortcutOverride,
  shortcutBindingFromEvent,
  type EditorCommandId,
  type EditorCommandShortcutDefinition,
  type EditorCustomCommandAction,
  type EditorCustomCommandDefinition,
  type EditorShortcutOverrides,
  type EditorShortcutPlatform,
} from "@/lib/editor-command-shortcuts";

interface FontFamilyOption {
  label: string;
  value: string;
}

interface CommandSettingsDialogProps {
  overrides: EditorShortcutOverrides;
  customCommands: EditorCustomCommandDefinition[];
  fontFamilyOptions: FontFamilyOption[];
  platform: EditorShortcutPlatform;
  onChange: (overrides: EditorShortcutOverrides) => void;
  onCustomCommandsChange: (commands: EditorCustomCommandDefinition[]) => void;
  onClose: () => void;
  /** 設定パレットから開いたときに見せたい項目 (`settings-catalog.ts` の id)。 */
  focusEntryId?: string;
}

/**
 * エディタ操作の検索、ショートカット記録、カスタムコマンド作成を一つの集中面で扱う。
 * モーダルのフォーカス制御や視覚階層は共通UIへ委ね、ショートカット設定の状態だけを所有する。
 */
export function CommandSettingsDialog({
  overrides,
  customCommands,
  fontFamilyOptions,
  platform,
  onChange,
  onCustomCommandsChange,
  onClose,
  focusEntryId,
}: CommandSettingsDialogProps) {
  const t = useT("settings");
  const tCommand = useT("command");
  useSettingsEntryFocus(focusEntryId);
  const [query, setQuery] = useState("");
  const [recordingCommandId, setRecordingCommandId] = useState<EditorCommandId | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 表示用に文言を解決したカタログ。打鍵ホットパスではないので `t` を持ち込んでよい。
  const commandCatalog = useMemo(
    () => resolveEditorCommandCatalog(getEditorCommandCatalog(customCommands), tCommand),
    [customCommands, tCommand],
  );

  const filteredCommands = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return commandCatalog;
    }

    return commandCatalog.filter((command) => (
      command.label.toLowerCase().includes(normalizedQuery) ||
      command.category.toLowerCase().includes(normalizedQuery) ||
      command.description.toLowerCase().includes(normalizedQuery) ||
      command.id.toLowerCase().includes(normalizedQuery)
    ));
  }, [commandCatalog, query]);

  const commandGroups = useMemo(() => {
    const groups: Array<{ category: string; commands: ResolvedEditorCommand[] }> = [];
    for (const command of filteredCommands) {
      const group = groups.find((item) => item.category === command.category);
      if (group) {
        group.commands = [...group.commands, command];
      } else {
        groups.push({ category: command.category, commands: [command] });
      }
    }
    // 作ったコマンドは 150 件ほどの組み込みの下に埋もれさせず、いちばん上に置く。
    return [
      ...groups.filter((group) => group.commands.some(isCustomCommand)),
      ...groups.filter((group) => !group.commands.some(isCustomCommand)),
    ];
  }, [filteredCommands]);

  // 「既存のコマンドを実行」で選べるのは組み込みだけ。カスタム同士の入れ子は作らない。
  const builtInCommands = useMemo(
    () => commandCatalog.filter((command) => !isCustomCommand(command)),
    [commandCatalog],
  );

  const startRecording = (commandId: EditorCommandId) => {
    setRecordingCommandId(commandId);
    setMessage(t("commands.message.recording"));
  };

  const assignShortcutFromKeyboardEvent = useCallback((commandId: EditorCommandId, event: KeyboardEvent) => {
    if (recordingCommandId !== commandId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      setRecordingCommandId(null);
      setMessage(t("commands.message.canceled"));
      return;
    }

    const nextBinding = shortcutBindingFromEvent(event, platform);
    if (!nextBinding) {
      setMessage(t("commands.message.modifierOnly"));
      return;
    }

    const command = commandCatalog.find((item) => item.id === commandId);
    const conflict = findShortcutConflict(overrides, commandId, nextBinding, customCommands);
    onChange(assignShortcutOverride(overrides, commandId, nextBinding, customCommands));
    setRecordingCommandId(null);
    setMessage(conflict
      ? t("commands.message.assignedOverConflict", { conflict: resolveEditorCommand(conflict, tCommand).label, command: command?.label ?? t("commands.message.fallbackCommandName") })
      : t("commands.message.assigned", { command: command?.label ?? t("commands.message.fallbackCommandName") }));
  }, [commandCatalog, customCommands, onChange, overrides, platform, recordingCommandId, t, tCommand]);

  const assignShortcut = (commandId: EditorCommandId, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    assignShortcutFromKeyboardEvent(commandId, event.nativeEvent);
  };

  useEffect(() => {
    if (!recordingCommandId) {
      return;
    }

    const recordShortcut = (event: KeyboardEvent) => {
      assignShortcutFromKeyboardEvent(recordingCommandId, event);
    };

    window.addEventListener("keydown", recordShortcut);
    return () => window.removeEventListener("keydown", recordShortcut);
  }, [assignShortcutFromKeyboardEvent, recordingCommandId]);

  const clearShortcut = (commandId: EditorCommandId) => {
    onChange(clearShortcutOverride(overrides, commandId));
    setRecordingCommandId(null);
    setMessage(t("commands.message.cleared"));
  };

  const resetShortcut = (commandId: EditorCommandId) => {
    onChange(resetShortcutOverride(overrides, commandId));
    setRecordingCommandId(null);
    setMessage(t("commands.message.resetOne"));
  };

  const resetAll = () => {
    onChange(resetAllShortcutOverrides());
    setRecordingCommandId(null);
    setMessage(t("commands.message.resetAll"));
  };

  const addCustomCommand = ({ label, actions }: { label: string; actions: EditorCustomCommandAction[] }) => {
    const command = createEditorCustomCommandDefinition({ label, actions });
    onCustomCommandsChange([...customCommands, command]);
    // 絞り込み中でも、いま作ったコマンドが一覧に見えるようにする。
    setQuery("");
    setMessage(t("commands.message.customAdded", { command: command.label }));
  };

  const removeCustomCommand = (commandId: EditorCommandId, label: string) => {
    onCustomCommandsChange(customCommands.filter((command) => command.id !== commandId));
    const next = { ...overrides };
    delete next[commandId];
    onChange(next);
    setRecordingCommandId(null);
    setMessage(t("commands.message.customDeleted", { command: label }));
  };

  return (
    <ModalFrame
      open
      onDismiss={onClose}
      closeOnEscape={!recordingCommandId}
      size="lg"
      ariaLabel={t("commands.title")}
      surfaceClassName="command-settings-dialog"
    >
      <ModalHeader
        title={(
          <span className="command-settings-title">
            <Keyboard size={18} aria-hidden="true" />
            <span>{t("commands.title")}</span>
          </span>
        )}
        description={<span role="status" aria-live="polite">{message ?? t("commands.message.idle")}</span>}
        onClose={onClose}
      />

      <ModalBody className="command-settings-content" padding="none" scroll="hidden">

        <div className="command-settings-toolbar">
          <label className="command-settings-search">
            <Search size={16} />
            <input
              data-modal-initial-focus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("commands.search")}
              aria-label={t("commands.search")}
            />
          </label>
          <Button tone="secondary" className="command-settings-toolbar-action" onClick={resetAll}>
            <RotateCcw size={15} />
            {t("commands.resetAll")}
          </Button>
        </div>

        <div id="custom-command-panel">
          <CustomCommandComposer
            fontFamilyOptions={fontFamilyOptions}
            builtInCommands={builtInCommands}
            onSubmit={addCustomCommand}
            onInvalid={() => setMessage(t("commands.message.customValueInvalid"))}
          />
        </div>

        <div id="command-shortcuts-table" className="command-shortcuts-table" role="table" aria-label={t("commands.tableAria")}>
          <div className="command-shortcuts-row header" role="row">
            <span role="columnheader">{t("commands.columnCommand")}</span>
            <span role="columnheader">{t("commands.columnKey")}</span>
            <span role="columnheader">{t("commands.columnDefault")}</span>
            <span role="columnheader">{t("commands.columnActions")}</span>
          </div>
          <div className="command-shortcuts-body">
            {commandGroups.length === 0 ? (
              <div className="command-shortcuts-empty">{t("commands.empty")}</div>
            ) : commandGroups.map((group) => (
              <div className="command-shortcuts-group" key={group.category}>
                <div className="command-shortcuts-category">{group.category}</div>
                {group.commands.map((command) => {
                  const commandId = command.id as EditorCommandId;
                  const activeBinding = getShortcutForCommand(overrides, commandId, customCommands);
                  const defaultBinding = command.defaultBinding;
                  const description = command.description;
                  const custom = isCustomCommand(command);
                  const recording = recordingCommandId === commandId;
                  return (
                    <div className="command-shortcuts-row" role="row" key={command.id}>
                      <div className="command-shortcuts-command" role="cell">
                        <strong>{command.label}</strong>
                        {description ? <span>{description}</span> : null}
                        <code aria-label={t("commands.commandId", { id: command.id })}>{command.id}</code>
                      </div>
                      <div role="cell">
                        <button
                          type="button"
                          className={`shortcut-capture-button ${recording ? "recording" : ""}`}
                          aria-label={t("commands.changeBinding", { command: command.label })}
                          onClick={() => startRecording(commandId)}
                          onKeyDown={(event) => assignShortcut(commandId, event)}
                        >
                          {recording ? (
                            <span className="shortcut-recording-text">{t("commands.recording")}</span>
                          ) : (
                            <ShortcutKeycaps binding={activeBinding} platform={platform} />
                          )}
                        </button>
                      </div>
                      <div role="cell">
                        <ShortcutKeycaps binding={defaultBinding} platform={platform} muted />
                      </div>
                      <div className="command-shortcuts-actions" role="cell">
                        <IconButton
                          label={t("commands.resetOne", { command: command.label })}
                          tooltip={{ label: t("commands.resetOneTooltip") }}
                          tone="ghost"
                          size="sm"
                          onClick={() => resetShortcut(commandId)}
                        >
                          <RotateCcw size={15} />
                        </IconButton>
                        <IconButton
                          label={t("commands.clearOne", { command: command.label })}
                          tone="danger"
                          size="sm"
                          disabled={activeBinding === null}
                          onClick={() => clearShortcut(commandId)}
                        >
                          <Trash2 size={15} />
                        </IconButton>
                        {custom ? (
                          <IconButton
                            label={t("commands.deleteOne", { command: command.label })}
                            tone="danger"
                            size="sm"
                            onClick={() => removeCustomCommand(commandId, command.label)}
                          >
                            <X size={15} />
                          </IconButton>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

      </ModalBody>
    </ModalFrame>
  );
}

function isCustomCommand(command: EditorCommandShortcutDefinition): command is EditorCustomCommandDefinition {
  return "custom" in command && command.custom === true;
}

function ShortcutKeycaps({
  binding,
  platform,
  muted = false,
}: {
  binding: Parameters<typeof formatShortcut>[0];
  platform: EditorShortcutPlatform;
  muted?: boolean;
}) {
  const t = useT("settings");
  const labels = formatShortcut(binding, platform);
  if (labels.length === 0) {
    return <span className={`shortcut-empty ${muted ? "muted" : ""}`}>{t("commands.unassigned")}</span>;
  }

  return (
    <span className={`shortcut-keycaps ${muted ? "muted" : ""}`} aria-label={labels.join(" ")}>
      {labels.map((label, index) => (
        <kbd key={`${label}-${index}`}>{label}</kbd>
      ))}
    </span>
  );
}
