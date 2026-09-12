"use client";

import { FONT_FAMILY_GROUPS, LINE_HEIGHT_OPTIONS } from "@/components/editor/editor-shell/constants";
import { MaterialContentPreview } from "@/components/editor/MaterialPreview";
import { Select } from "@/components/ui/Select";
import  {
  MAX_LINE_HEIGHT,
  MIN_LINE_HEIGHT,
  normalizeLineHeight,
  stepLineHeight,
  type CodeBlockTheme,
  type LineHeight,
} from "@/features/document";
import { CODE_BLOCK_LANGUAGES } from "@/features/rendering/adapters";
import { type Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import { isOfficialMaterial } from "@/lib/official-materials";
import type { MaterialItem } from "@/types/material";
import  {
  Copy,
  Heading,
  ListChevronsUpDown,
  Minus,
  Moon,
  Plus,
  Settings2,
  Sun,
  Trash2,
  Type,
  X,
} from "lucide-react";
import  {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

import { getSlashCommandCandidateName, type ActiveSlashCommandQuery, type SlashCommandCandidate } from "./slash-command-model";

export { getSlashCommandCandidateName } from "./slash-command-model";
export type { ActiveSlashCommandQuery, SlashCommandCandidate } from "./slash-command-model";


export const SLASH_COMMAND_POPOVER_WIDTH = 300;

export const SLASH_COMMAND_POPOVER_MAX_HEIGHT = 320;

export const SLASH_COMMAND_PREVIEW_WIDTH = 260;

export const SLASH_COMMAND_PREVIEW_HEIGHT = 224;

export const SLASH_COMMAND_GAP = 10;

export const SLASH_COMMAND_MARGIN = 12;


export interface BoxActionDialogState {
  boxId: string;
  left: number;
  top: number;
}


export interface CodeBlockSettingsPopoverState {
  codeBlockId: string;
  language: string | null;
  theme: CodeBlockTheme;
  left: number;
  top: number;
}


export interface TextFormatContextMenuState {
  left: number;
  top: number;
  fontFamily: string;
  lineHeight: LineHeight;
  hasSelection: boolean;
  boxId: string | null;
}


export function TextFormatContextMenu({
  state,
  onClose,
  onBoxEditTitle,
  onBoxSettings,
  onBoxCopy,
  onBoxDelete,
  onFontFamilyChange,
  onLineHeightChange,
}: {
  state: TextFormatContextMenuState | null;
  onClose: () => void;
  onBoxEditTitle?: (boxId: string) => void;
  onBoxSettings?: (boxId: string) => void;
  onBoxCopy?: (boxId: string) => void;
  onBoxDelete?: (boxId: string) => void;
  onFontFamilyChange: (fontFamily: string) => void;
  onLineHeightChange: (lineHeight: LineHeight) => void;
}) {
  const t = useT("editor");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 12, top: 12 });

  useLayoutEffect(() => {
    if (!state) {
      return;
    }

    const repositionMenu = () => {
      const menu = menuRef.current;
      if (!menu) {
        return;
      }

      const margin = 12;
      const { width, height } = menu.getBoundingClientRect();
      const nextPosition = {
        left: Math.max(margin, Math.min(state.left, Math.max(margin, window.innerWidth - width - margin))),
        top: Math.max(margin, Math.min(state.top, Math.max(margin, window.innerHeight - height - margin))),
      };
      setMenuPosition((current) => (
        current.left === nextPosition.left && current.top === nextPosition.top ? current : nextPosition
      ));
    };

    repositionMenu();
    window.addEventListener("resize", repositionMenu);
    return () => window.removeEventListener("resize", repositionMenu);
  }, [state]);

  useEffect(() => {
    if (!state) {
      return;
    }

    const closeOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".text-format-context-menu")) {
        return;
      }
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, state]);

  if (!state || typeof document === "undefined") {
    return null;
  }

  const step = (direction: "increase" | "decrease") => {
    onLineHeightChange(stepLineHeight(state.lineHeight, direction));
  };
  const fontFamilyIsListed = FONT_FAMILY_GROUPS.some((group) => (
    group.options.some((option) => option.value === state.fontFamily)
  ));

  return createPortal(
    <div
      ref={menuRef}
      className="text-format-context-menu"
      role="dialog"
      aria-label={state.hasSelection ? t("textFormat.selectionAria") : t("box.actions")}
      style={{ left: menuPosition.left, top: menuPosition.top }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {state.hasSelection && (
        <div className="text-format-context-menu-title">
          <span>{t("textFormat.title")}</span>
          <button type="button" aria-label={t("common.close")} title={t("common.close")} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      )}
      {state.hasSelection && (
        <>
          <label className="text-format-context-field">
            <span><Type size={15} aria-hidden="true" />{t("textFormat.fontFamily")}</span>
            <Select
              aria-label={t("textFormat.fontFamily")}
              value={state.fontFamily}
              style={{ fontFamily: state.fontFamily }}
              options={[
                ...(fontFamilyIsListed ? [] : [{ value: state.fontFamily, label: t("textFormat.currentFont") }]),
                ...FONT_FAMILY_GROUPS.map((group) => ({
                  label: group.label,
                  options: group.options.map((option) => ({
                    value: option.value,
                    label: option.label,
                    style: { fontFamily: option.value },
                  })),
                })),
              ]}
              onChange={onFontFamilyChange}
            />
          </label>
          <div className="text-format-context-field">
            <span><ListChevronsUpDown size={15} aria-hidden="true" />{t("textFormat.lineHeight")}</span>
            <Select
              aria-label={t("textFormat.lineHeight")}
              value={LINE_HEIGHT_OPTIONS.some((option) => option.value === state.lineHeight) ? state.lineHeight : "custom"}
              options={[
                ...(LINE_HEIGHT_OPTIONS.some((option) => option.value === state.lineHeight)
                  ? []
                  : [{ value: "custom", label: t("textFormat.lineHeightValue", { lines: state.lineHeight }) }]),
                ...LINE_HEIGHT_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t("textFormat.lineHeightValue", { lines: option.value }),
                })),
              ]}
              onChange={(value) => {
                const lineHeight = normalizeLineHeight(value);
                if (lineHeight) {
                  onLineHeightChange(lineHeight);
                }
              }}
            />
            <div className="line-height-stepper text-format-context-stepper" role="group" aria-label={t("textFormat.lineHeightFine")}>
              <button
                type="button"
                aria-label={t("textFormat.lineHeightDecrease")}
                disabled={state.lineHeight === String(MIN_LINE_HEIGHT)}
                onClick={() => step("decrease")}
              >
                <Minus size={15} />
              </button>
              <output aria-live="polite">{t("textFormat.lineHeightValue", { lines: state.lineHeight })}</output>
              <button
                type="button"
                aria-label={t("textFormat.lineHeightIncrease")}
                disabled={state.lineHeight === String(MAX_LINE_HEIGHT)}
                onClick={() => step("increase")}
              >
                <Plus size={15} />
              </button>
            </div>
          </div>
        </>
      )}
      {state.boxId && onBoxEditTitle && (
        <button
          type="button"
          className="text-format-context-action"
          onClick={() => onBoxEditTitle(state.boxId!)}
        >
          <Heading size={15} aria-hidden="true" />
          <span>{t("box.editTitle")}</span>
        </button>
      )}
      {state.boxId && onBoxSettings && (
        <button
          type="button"
          className="text-format-context-action"
          onClick={() => onBoxSettings(state.boxId!)}
        >
          <Settings2 size={15} aria-hidden="true" />
          <span>{t("box.settings")}</span>
        </button>
      )}
      {state.boxId && onBoxCopy && (
        <button
          type="button"
          className="text-format-context-action"
          onClick={() => onBoxCopy(state.boxId!)}
        >
          <Copy size={15} aria-hidden="true" />
          <span>{t("box.copy")}</span>
        </button>
      )}
      {state.boxId && onBoxDelete && (
        <button
          type="button"
          className="text-format-context-action danger"
          onClick={() => onBoxDelete(state.boxId!)}
        >
          <Trash2 size={15} aria-hidden="true" />
          <span>{t("box.delete")}</span>
        </button>
      )}
    </div>,
    document.body,
  );
}


export function BoxActionDialog({
  state,
  onClose,
  onEditTitle,
  onSettings,
  onCopy,
  onDelete,
}: {
  state: BoxActionDialogState | null;
  onClose: () => void;
  onEditTitle: (boxId: string) => void;
  onSettings: (boxId: string) => void;
  onCopy: (boxId: string) => void;
  onDelete: (boxId: string) => void;
}) {
  const t = useT("editor");
  useEffect(() => {
    if (!state) {
      return;
    }

    const closeOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".box-action-dialog, .sigma-doc-box-action-button")) {
        return;
      }
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, state]);

  if (!state || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="box-action-dialog"
      role="dialog"
      aria-label={t("box.actions")}
      style={{ left: state.left, top: state.top }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="box-action-dialog-item"
        onClick={() => onEditTitle(state.boxId)}
      >
        <Heading size={15} />
        <span>{t("box.editTitle")}</span>
      </button>
      <button
        type="button"
        className="box-action-dialog-item"
        onClick={() => onSettings(state.boxId)}
      >
        <Settings2 size={15} />
        <span>{t("box.settings")}</span>
      </button>
      <button
        type="button"
        className="box-action-dialog-item"
        onClick={() => onCopy(state.boxId)}
      >
        <Copy size={15} />
        <span>{t("box.copy")}</span>
      </button>
      <button
        type="button"
        className="box-action-dialog-item danger"
        onClick={() => onDelete(state.boxId)}
      >
        <Trash2 size={15} />
        <span>{t("box.delete")}</span>
      </button>
    </div>,
    document.body,
  );
}


export function CodeBlockSettingsPopover({
  state,
  onClose,
  onLanguageChange,
  onThemeChange,
}: {
  state: CodeBlockSettingsPopoverState | null;
  onClose: () => void;
  onLanguageChange: (language: string | null) => void;
  onThemeChange: (theme: CodeBlockTheme) => void;
}) {
  const t = useT("editor");
  const popoverRef = useRef<HTMLDivElement>(null);
  const codeBlockId = state?.codeBlockId;

  useEffect(() => {
    if (!codeBlockId) {
      return;
    }

    const languageControl = () => popoverRef.current?.querySelector<HTMLButtonElement>('[role="combobox"]');
    const languageMenu = () => {
      const menuId = languageControl()?.getAttribute("aria-controls");
      return menuId ? document.getElementById(menuId) : null;
    };
    const focusFrame = window.requestAnimationFrame(() => {
      languageControl()?.focus({ preventScroll: true });
    });
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const actionButton = target?.closest<HTMLElement>("[data-code-block-action-button='true']");
      if (
        target?.closest(".code-block-settings-popover")
        || (target && languageMenu()?.contains(target))
        || actionButton?.dataset.codeBlockId === codeBlockId
      ) {
        return;
      }
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      // The nested language picker handles its own Escape before the settings close.
      if (event.key !== "Escape" || languageMenu()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [onClose, codeBlockId]);

  if (!state || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      ref={popoverRef}
      className="code-block-settings-popover"
      role="dialog"
      aria-label={t("codeBlock.settings")}
      style={{ left: state.left, top: state.top }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <label className="code-block-settings-field">
        <span>{t("codeBlock.language")}</span>
        <Select
          aria-label={t("codeBlock.languageAria")}
          value={state.language ?? ""}
          menuWidth="trigger"
          options={[
            { value: "", label: t("codeBlock.auto") },
            ...CODE_BLOCK_LANGUAGES.map((option) => ({
              value: option.value,
              label: option.labelKey ? t(option.labelKey) : option.label,
            })),
          ]}
          onChange={(value) => onLanguageChange(value || null)}
        />
      </label>
      <fieldset className="code-block-settings-field">
        <legend>{t("codeBlock.background")}</legend>
        <div className="code-block-theme-options" role="radiogroup" aria-label={t("codeBlock.backgroundAria")}>
          <button
            type="button"
            role="radio"
            aria-checked={state.theme === "light"}
            className={state.theme === "light" ? "selected" : ""}
            onClick={() => onThemeChange("light")}
          >
            <Sun size={15} aria-hidden="true" />
            <span>{t("codeBlock.light")}</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={state.theme === "dark"}
            className={state.theme === "dark" ? "selected" : ""}
            onClick={() => onThemeChange("dark")}
          >
            <Moon size={15} aria-hidden="true" />
            <span>{t("codeBlock.dark")}</span>
          </button>
        </div>
      </fieldset>
    </div>,
    document.body,
  );
}


export function SlashCommandPopover({
  query,
  candidates,
  activeIndex,
  onHover,
  onSelect,
}: {
  query: ActiveSlashCommandQuery | null;
  candidates: SlashCommandCandidate[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (candidate: SlashCommandCandidate) => void;
}) {
  const t = useT("editor");
  if (!query || typeof document === "undefined" || typeof window === "undefined") {
    return null;
  }

  const position = getSlashCommandPopoverPosition(query.rect.left, query.rect.bottom);
  const style: CSSProperties = {
    position: "fixed" as const,
    top: position.top,
    left: position.left,
    zIndex: 240,
  };
  const activeCandidate = candidates[activeIndex] ?? candidates[0] ?? null;
  const activeMaterial = activeCandidate?.kind === "material" ? activeCandidate.material : null;
  const previewStyle = activeMaterial
    ? getSlashCommandPreviewStyle(position.left, position.top)
    : undefined;

  return createPortal(
    <>
      <div className="slash-command-popover" role="listbox" aria-label={t("slash.candidates")} style={style}>
        <div className="slash-command-title">{t("slash.title")}</div>
        {candidates.length === 0 ? (
          <div className="slash-command-empty">{t("slash.empty")}</div>
        ) : (
          candidates.map((candidate, index) => (
            <button
              key={getSlashCommandCandidateKey(candidate)}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className="slash-command-option"
              data-command-kind={candidate.kind}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(candidate);
              }}
            >
              <span className="slash-command-row">
                <span className="slash-command-name">{getSlashCommandCandidateName(candidate)}</span>
                <span className="slash-command-kind">{getSlashCommandCandidateKindLabel(candidate, t)}</span>
              </span>
              <span className="slash-command-meta">{getSlashCommandCandidateMeta(candidate, t)}</span>
            </button>
          ))
        )}
      </div>
      {activeMaterial && previewStyle && (
        <aside className="slash-command-preview" style={previewStyle} aria-hidden="true">
          <MaterialContentPreview content={activeMaterial.content} title={activeMaterial.name} box={isOfficialMaterial(activeMaterial)} />
          <div className="slash-command-preview-caption">
            <strong>{activeMaterial.name}</strong>
            <span>{getMaterialSummaryLabel(activeMaterial, t)}</span>
          </div>
        </aside>
      )}
    </>,
    document.body,
  );
}


export function getSlashCommandPopoverPosition(left: number, bottom: number): { left: number; top: number } {
  const popoverWidth = getSlashCommandPopoverWidth();
  const popoverHeight = getSlashCommandPopoverHeight();
  const maxLeft = Math.max(SLASH_COMMAND_MARGIN, window.innerWidth - popoverWidth - SLASH_COMMAND_MARGIN);
  const maxTop = Math.max(SLASH_COMMAND_MARGIN, window.innerHeight - popoverHeight - SLASH_COMMAND_MARGIN);
  return {
    left: clampNumber(left, SLASH_COMMAND_MARGIN, maxLeft),
    top: clampNumber(bottom + 6, SLASH_COMMAND_MARGIN, maxTop),
  };
}


export function getSlashCommandPreviewStyle(popoverLeft: number, popoverTop: number): CSSProperties {
  const popoverWidth = getSlashCommandPopoverWidth();
  const preferredLeft = popoverLeft + popoverWidth + SLASH_COMMAND_GAP;
  const left = preferredLeft + SLASH_COMMAND_PREVIEW_WIDTH <= window.innerWidth - SLASH_COMMAND_MARGIN
    ? preferredLeft
    : Math.max(SLASH_COMMAND_MARGIN, popoverLeft - SLASH_COMMAND_PREVIEW_WIDTH - SLASH_COMMAND_GAP);
  const maxTop = Math.max(SLASH_COMMAND_MARGIN, window.innerHeight - SLASH_COMMAND_PREVIEW_HEIGHT - SLASH_COMMAND_MARGIN);
  return {
    position: "fixed",
    left,
    top: clampNumber(popoverTop, SLASH_COMMAND_MARGIN, maxTop),
    zIndex: 241,
  };
}


export function getSlashCommandPopoverWidth(): number {
  return Math.min(SLASH_COMMAND_POPOVER_WIDTH, Math.max(120, window.innerWidth - SLASH_COMMAND_MARGIN * 2));
}


export function getSlashCommandPopoverHeight(): number {
  return Math.min(SLASH_COMMAND_POPOVER_MAX_HEIGHT, Math.max(120, window.innerHeight - SLASH_COMMAND_MARGIN * 2));
}


export function getSlashCommandCandidateKey(candidate: SlashCommandCandidate): string {
  if (candidate.kind === "problem") {
    return `problem:${candidate.problem.id}`;
  }
  if (candidate.kind === "block") {
    return `block:${candidate.block.id}`;
  }
  if (candidate.kind === "heading") {
    return `heading:${candidate.heading.id}`;
  }
  return candidate.kind === "box" ? `box:${candidate.box.id}` : `material:${candidate.material.id}`;
}


export function getSlashCommandCandidateMeta(candidate: SlashCommandCandidate, t: Translate<"editor">): string {
  if (candidate.kind === "problem") {
    return candidate.problem.description;
  }
  if (candidate.kind === "block") {
    return candidate.block.description;
  }
  if (candidate.kind === "heading") {
    return candidate.heading.description;
  }
  return candidate.kind === "box" ? candidate.box.description : getMaterialSummaryLabel(candidate.material, t);
}


export function getSlashCommandCandidateKindLabel(candidate: SlashCommandCandidate, t: Translate<"editor">): string {
  if (candidate.kind === "box") {
    return t("slash.kindBox");
  }
  if (candidate.kind === "block") {
    return t("slash.kindBlock");
  }
  if (candidate.kind === "problem") return t("slash.kindProblem");
  if (candidate.kind === "heading") return t("slash.kindHeading");
  return t("slash.kindMaterial");
}


export function getMaterialSummaryLabel(material: MaterialItem, t: Translate<"editor">): string {
  const prefix = isOfficialMaterial(material) ? t("material.official") : "";
  if (material.description) {
    return prefix ? `${prefix} \u30fb ${material.description}` : material.description;
  }
  const blockCount = material.content.blocks.length;
  const shapeCount = material.content.overlaySnapshot.shapes.length;
  const detail = blockCount > 0 && shapeCount > 0
    ? t("material.summaryBoth", { blocks: blockCount, shapes: shapeCount })
    : blockCount > 0
      ? t("material.summaryBlocks", { blocks: blockCount })
      : t("material.summaryShapes", { shapes: shapeCount });
  return prefix ? `${prefix} / ${detail}` : detail;
}


export function clampNumber(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}