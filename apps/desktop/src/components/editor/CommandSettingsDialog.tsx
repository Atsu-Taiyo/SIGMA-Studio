"use client";

import { Keyboard, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { ColorPalette } from "@/components/editor/ColorPalette";
import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import { Button, IconButton } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { normalizeLineHeight } from "@/features/document";
import { useT } from "@/lib/i18n/react";

import { getSettingsEntrySurfaceState } from "./settings-catalog";
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

type CustomActionKind = EditorCustomCommandAction["type"];

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
  // パレットから「カスタムコマンド」を選んで来たときは畳まずに開く
  // (畳んだままだと anchor が DOM に無く、スクロール先が見つからない)。
  const [customOpen, setCustomOpen] = useState(
    () => getSettingsEntrySurfaceState(focusEntryId) === "custom-open",
  );
  const [customLabel, setCustomLabel] = useState("");
  const [customActionKind, setCustomActionKind] = useState<CustomActionKind>("fontFamily");
  const [customValue, setCustomValue] = useState(() => defaultCustomActionValue("fontFamily", fontFamilyOptions));
  const [customColor, setCustomColor] = useState("#111827");
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
    return groups;
  }, [filteredCommands]);

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

  const addCustomCommand = () => {
    const action = buildCustomCommandAction(
      customActionKind,
      customValue || defaultCustomActionValue(customActionKind, fontFamilyOptions),
      customColor,
    );
    const label = customLabel.trim();
    if (!label) {
      setMessage(t("commands.message.customNameRequired"));
      return;
    }
    if (!action) {
      setMessage(t("commands.message.customValueInvalid"));
      return;
    }

    const command = createEditorCustomCommandDefinition({ label, action });
    onCustomCommandsChange([...customCommands, command]);
    // 追加した直後にカスタムだけへ絞る。**表示中のカテゴリ名**で絞らないと、
    // 英語 UI では日本語の「カスタム」が一致せず空振りする。
    setQuery(tCommand("category.custom"));
    setCustomLabel("");
    setCustomValue(defaultCustomActionValue(customActionKind, fontFamilyOptions));
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
          <Button
            tone="secondary"
            className="command-settings-toolbar-action"
            aria-expanded={customOpen}
            aria-controls="custom-command-panel"
            onClick={() => setCustomOpen((current) => !current)}
          >
            <Plus size={15} />
            {t("commands.customCommand")}
          </Button>
        </div>

        {customOpen ? (
          <section id="custom-command-panel" className="custom-command-panel" aria-label={t("commands.customPanelAria")}>
            <label>
              <span>{t("commands.customName")}</span>
              <input
                value={customLabel}
                onChange={(event) => setCustomLabel(event.target.value)}
                placeholder={t("commands.customNamePlaceholder")}
              />
            </label>
            <label>
              <span>{t("commands.customKind")}</span>
              <Select
                aria-label={t("commands.customKind")}
                value={customActionKind}
                options={CUSTOM_ACTION_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t(`commands.action.${option.value}`),
                }))}
                onChange={(kind) => {
                  const nextKind = kind as CustomActionKind;
                  setCustomActionKind(nextKind);
                  setCustomValue(defaultCustomActionValue(nextKind, fontFamilyOptions));
                }}
              />
            </label>
            <div className="custom-command-value-field">
              <CustomCommandValueField
                actionKind={customActionKind}
                value={customValue}
                color={customColor}
                fontFamilyOptions={fontFamilyOptions}
                onValueChange={setCustomValue}
                onColorChange={setCustomColor}
              />
            </div>
            <Button tone="primary" onClick={addCustomCommand}>
              <Plus size={15} />
              {t("commands.add")}
            </Button>
          </section>
        ) : null}

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

// 表示ラベルは `settings.commands.action.<value>` が持つ。ここは並びだけ。
const CUSTOM_ACTION_OPTIONS: ReadonlyArray<{ value: CustomActionKind }> = [
  { value: "fontFamily" },
  { value: "fontSize" },
  { value: "lineHeight" },
  { value: "textAlign" },
  { value: "blockStyle" },
  { value: "textFormat" },
  { value: "textColor" },
  { value: "textBackgroundColor" },
  { value: "overlayStrokeColor" },
  { value: "overlayFillColor" },
  { value: "overlayLineDash" },
  { value: "overlayLineWidth" },
];

function defaultCustomActionValue(kind: CustomActionKind, fontFamilyOptions: readonly FontFamilyOption[]): string {
  if (kind === "fontFamily") {
    return fontFamilyOptions[0]?.value ?? "";
  }
  if (kind === "fontSize") return "16";
  if (kind === "lineHeight") return "1.75";
  if (kind === "textAlign") return "center";
  if (kind === "blockStyle") return "paragraph";
  if (kind === "textFormat") return "bold";
  if (kind === "overlayLineDash") return "dashed";
  if (kind === "overlayLineWidth") return "m";
  return "";
}

function buildCustomCommandAction(
  kind: CustomActionKind,
  value: string,
  color: string,
): EditorCustomCommandAction | null {
  if (kind === "fontFamily") {
    const fontFamily = value.trim();
    return fontFamily ? { type: "fontFamily", value: fontFamily } : null;
  }
  if (kind === "fontSize") {
    const size = Number(value);
    return Number.isFinite(size) ? { type: "fontSize", value: Math.min(96, Math.max(8, size)) } : null;
  }
  if (kind === "lineHeight") {
    const lineHeight = normalizeLineHeight(value);
    return lineHeight ? { type: "lineHeight", value: lineHeight } : null;
  }
  if (kind === "textAlign" && isTextAlignValue(value)) {
    return { type: "textAlign", value };
  }
  if (kind === "blockStyle" && isBlockStyleValue(value)) {
    return { type: "blockStyle", value };
  }
  if (kind === "textFormat" && isTextFormatCommand(value)) {
    return { type: "textFormat", command: value };
  }
  if (kind === "textColor") {
    return { type: "textColor", value: color };
  }
  if (kind === "textBackgroundColor") {
    return { type: "textBackgroundColor", value: color };
  }
  if (kind === "overlayStrokeColor") {
    return { type: "overlayStrokeColor", value: value === "none" ? null : color };
  }
  if (kind === "overlayFillColor") {
    return { type: "overlayFillColor", value: value === "none" ? null : color };
  }
  if (kind === "overlayLineDash" && isOverlayLineDashValue(value)) {
    return { type: "overlayLineDash", value };
  }
  if (kind === "overlayLineWidth" && isOverlayLineWidthValue(value)) {
    return { type: "overlayLineWidth", value };
  }
  return null;
}

function CustomCommandValueField({
  actionKind,
  value,
  color,
  fontFamilyOptions,
  onValueChange,
  onColorChange,
}: {
  actionKind: CustomActionKind;
  value: string;
  color: string;
  fontFamilyOptions: readonly FontFamilyOption[];
  onValueChange: (value: string) => void;
  onColorChange: (value: string) => void;
}) {
  const t = useT("settings");
  if (actionKind === "fontFamily") {
    return (
      <label>
        <span>{t("commands.field.fontFamily")}</span>
        <input
          list="custom-command-font-families"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder='"Yu Mincho", serif'
        />
        <datalist id="custom-command-font-families">
          {fontFamilyOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </datalist>
      </label>
    );
  }

  if (actionKind === "fontSize") {
    return (
      <label>
        <span>{t("commands.field.fontSize")}</span>
        <input
          type="number"
          min={8}
          max={96}
          step={1}
          value={value || "16"}
          onChange={(event) => onValueChange(event.target.value)}
        />
      </label>
    );
  }

  if (actionKind === "lineHeight") {
    return (
      <label>
        <span>{t("commands.field.lineHeight")}</span>
        <input
          type="number"
          min={0.8}
          max={3}
          step={0.05}
          value={value || "1.75"}
          onChange={(event) => onValueChange(event.target.value)}
        />
      </label>
    );
  }

  if (actionKind === "textColor" || actionKind === "textBackgroundColor") {
    return <ColorValueField color={color} onColorChange={onColorChange} />;
  }

  if (actionKind === "overlayStrokeColor" || actionKind === "overlayFillColor") {
    return (
      <>
        <label>
          <span>{actionKind === "overlayStrokeColor" ? t("commands.field.stroke") : t("commands.field.fill")}</span>
          <Select
            aria-label={actionKind === "overlayStrokeColor" ? t("commands.field.stroke") : t("commands.field.fill")}
            value={value || "color"}
            options={[
              { value: "color", label: t("commands.field.colorSpecify") },
              { value: "none", label: t("commands.field.colorNone") },
            ]}
            onChange={onValueChange}
          />
        </label>
        {(value || "color") === "color" ? <ColorValueField color={color} onColorChange={onColorChange} /> : null}
      </>
    );
  }

  if (actionKind === "textAlign") {
    return (
      <SelectValueField
        label={t("commands.field.textAlign")}
        value={value || "center"}
        onValueChange={onValueChange}
        options={[
          { value: "left", label: t("commands.value.alignLeft") },
          { value: "center", label: t("commands.value.alignCenter") },
          { value: "right", label: t("commands.value.alignRight") },
          { value: "justify", label: t("commands.value.alignJustify") },
        ]}
      />
    );
  }

  if (actionKind === "blockStyle") {
    return (
      <SelectValueField
        label={t("commands.field.blockStyle")}
        value={value || "paragraph"}
        onValueChange={onValueChange}
        options={[
          { value: "paragraph", label: t("commands.value.blockParagraph") },
          { value: "h1", label: t("commands.value.blockH1") },
          { value: "h2", label: t("commands.value.blockH2") },
          { value: "h3", label: t("commands.value.blockH3") },
        ]}
      />
    );
  }

  if (actionKind === "textFormat") {
    return (
      <SelectValueField
        label={t("commands.field.textFormat")}
        value={value || "bold"}
        onValueChange={onValueChange}
        options={[
          { value: "bold", label: t("commands.value.formatBold") },
          { value: "italic", label: t("commands.value.formatItalic") },
          { value: "underline", label: t("commands.value.formatUnderline") },
          { value: "boxed", label: t("commands.value.formatBoxed") },
        ]}
      />
    );
  }

  if (actionKind === "overlayLineDash") {
    return (
      <SelectValueField
        label={t("commands.field.lineDash")}
        value={value || "dashed"}
        onValueChange={onValueChange}
        options={[
          { value: "solid", label: t("commands.value.dashSolid") },
          { value: "dashed", label: t("commands.value.dashDashed") },
          { value: "dotted", label: t("commands.value.dashDotted") },
        ]}
      />
    );
  }

  return (
    <SelectValueField
      label={t("commands.field.lineWidth")}
      value={value || "m"}
      onValueChange={onValueChange}
      options={[
        { value: "s", label: t("commands.value.widthS") },
        { value: "m", label: t("commands.value.widthM") },
        { value: "l", label: t("commands.value.widthL") },
        { value: "xl", label: t("commands.value.widthXl") },
      ]}
    />
  );
}

/**
 * 色はOSのカラーパネルではなく、アプリ内の見本 + 色作成ダイアログから選ぶ
 * (docs/design-rules.md > Controls > Selects And Pickers)。
 */
function ColorValueField({
  color,
  onColorChange,
}: {
  color: string;
  onColorChange: (value: string) => void;
}) {
  const t = useT("settings");
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  return (
    <label className="custom-command-color-field">
      <span>{t("commands.field.color")}</span>
      <button
        ref={buttonRef}
        type="button"
        className="custom-command-color-button"
        aria-label={t("commands.field.color")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="custom-command-color-swatch" style={{ backgroundColor: color }} aria-hidden="true" />
        <code>{color}</code>
      </button>
      <ToolbarPopover
        open={open}
        anchorRef={buttonRef}
        onClose={() => setOpen(false)}
        className="color-popover"
        ariaLabel={t("commands.field.color")}
        zIndex="var(--z-modal-nested)"
      >
        <ColorPalette
          value={color}
          onChange={(next) => {
            if (next) onColorChange(next);
            setOpen(false);
          }}
        />
      </ToolbarPopover>
    </label>
  );
}

function SelectValueField({
  value,
  options,
  onValueChange,
  label,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onValueChange: (value: string) => void;
  label?: string;
}) {
  return (
    <label>
      <span>{label}</span>
      <Select aria-label={label} value={value} options={options} onChange={onValueChange} />
    </label>
  );
}

function isTextAlignValue(value: string): value is "left" | "center" | "right" | "justify" {
  return value === "left" || value === "center" || value === "right" || value === "justify";
}

function isBlockStyleValue(value: string): value is "paragraph" | "h1" | "h2" | "h3" {
  return value === "paragraph" || value === "h1" || value === "h2" || value === "h3";
}

function isTextFormatCommand(value: string): value is "bold" | "italic" | "underline" | "boxed" {
  return value === "bold" || value === "italic" || value === "underline" || value === "boxed";
}

function isOverlayLineDashValue(value: string): value is "solid" | "dashed" | "dotted" {
  return value === "solid" || value === "dashed" || value === "dotted";
}

function isOverlayLineWidthValue(value: string): value is "s" | "m" | "l" | "xl" {
  return value === "s" || value === "m" || value === "l" || value === "xl";
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
