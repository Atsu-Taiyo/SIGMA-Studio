import type { TextAlign } from "@/features/document";
import type {
  EditorCommandId,
  EditorCustomCommandAction,
  EditorCustomCommandDefinition,
} from "@/lib/editor-command-shortcuts";
import type { Translate } from "@/lib/i18n";

import { SELECT_BODY_WITH_SHAPES_EVENT } from "../text-flow/body-shape-selection";
import type { OverlayActionRequestInput, OverlayCommand, OverlaySelectionStylePatch } from "../page-overlay-types";
import {
  DEFAULT_FONT_FAMILY_VALUE,
  KEYBOARD_ZOOM_STEP,
  SHORTCUT_ARROWHEAD_VALUES,
  SHORTCUT_BLOCK_STYLES,
  SHORTCUT_FILL_COLORS,
  SHORTCUT_FONT_FAMILIES,
  SHORTCUT_FONT_SIZES,
  SHORTCUT_LINE_DASHES,
  SHORTCUT_LINE_HEIGHTS,
  SHORTCUT_LINE_WIDTHS,
  SHORTCUT_OVERLAY_ALIGN_ACTIONS,
  SHORTCUT_OVERLAY_ARRANGE_ACTIONS,
  SHORTCUT_OVERLAY_DISTRIBUTE_ACTIONS,
  SHORTCUT_STROKE_COLORS,
  SHORTCUT_TEXT_ALIGNS,
} from "./constants";
import { normalizeToolbarFontFamily } from "./toolbar-formatting";

/** Commands request edits through the existing host operations; they do not own document state. */
export interface EditorCommandTextPorts {
  runEditCommand(command: "bold" | "italic" | "underline" | "boxed" | "undo" | "redo"): void;
  toggleBoxedText(): void;
  applyTextStyle(style: string): void;
  applyTextAlign(align: TextAlign): void;
  applyLineHeight(value: string): boolean;
  applyInlineFormat(command: "color" | "backgroundColor" | "fontFamily" | "fontSize" | "lineHeight", value: string): void;
  getActiveTextTarget(): "document" | "overlay" | "comment";
  insertInlineMath(tex: string, target: "document" | "overlay" | "comment"): void;
  setFontFamily(value: string): void;
  setTextFontSize(value: number): void;
  setTextColor(value: string): void;
  setTextBackgroundColor(value: string): void;
}

/** Selection-sensitive patches remain host operations, including the current fill opacity policy. */
export interface EditorCommandOverlayPorts {
  runOverlayCommand(command: OverlayCommand): void;
  requestOverlayAction(request: OverlayActionRequestInput): void;
  applyOverlayStyle(style: OverlaySelectionStylePatch): void;
  fillColorPatch(color: string): OverlaySelectionStylePatch;
  setStrokeColor(value: string | null): void;
  imageInputRef: { readonly current: Pick<HTMLInputElement, "click"> | null };
}

/** The command layer decides which surface follows an action; the host owns each surface's state. */
export interface EditorCommandMenuPorts {
  closeTransientCommandSurfaces(): void;
  setFontFamilyMenuOpen(open: boolean): void;
  setLineHeightMenuOpen(open: boolean): void;
  setLineHeightCustomOpen(open: boolean): void;
  setTextAlignMenuOpen(open: boolean): void;
  setLineDashMenuOpen(open: boolean): void;
  setLineWidthMenuOpen(open: boolean): void;
  setLineEndpointMenu(endpoint: "start" | "end" | null): void;
}

export interface EditorCommandApplicationPorts {
  undoDocumentChange(): void;
  redoDocumentChange(): void;
  createDocumentTab(): void;
  openDocumentListDialog(): void;
  duplicateActiveDocument(): void;
  addBlock(type: "paragraph" | "heading" | "problem"): void;
  setSearchOpen(open: boolean): void;
  setOutlineOpen(update: boolean | ((current: boolean) => boolean)): void;
  applyZoom(update: number | ((current: number) => number)): void;
  resetZoom(): void;
  setSettingsFocusEntryId(id: string | undefined): void;
  setCommandPaletteOpen(open: boolean): void;
  openPrintPreview(): void;
  toggleCommentsPanel(): void;
  setOutlineDialogOpen(open: boolean): void;
  promoteAiToSidebar(): void;
  setAiSettingsOpen(open: boolean): void;
  setPageSettingsOpen(open: boolean): void;
  openCommandSettings(): boolean;
  setMaterialLibraryOpen(open: boolean): void;
  setStatusMessage(message: string): void;
  tEditor: Translate<"editor">;
}

export interface EditorCommandActionPorts {
  text: EditorCommandTextPorts;
  overlay: EditorCommandOverlayPorts;
  menus: EditorCommandMenuPorts;
  application: EditorCommandApplicationPorts;
}

/** Build a runner for one render; keyboard, menu and palette share the host's published runner ref. */
export function createEditorCommandRunner(
  customCommands: readonly EditorCustomCommandDefinition[],
  { text, overlay, menus, application }: EditorCommandActionPorts,
): (commandId: EditorCommandId) => void {
  const {
    runEditCommand, toggleBoxedText, applyTextStyle, applyTextAlign, applyLineHeight,
    applyInlineFormat, getActiveTextTarget, insertInlineMath, setFontFamily, setTextFontSize,
    setTextColor, setTextBackgroundColor,
  } = text;
  const { runOverlayCommand, requestOverlayAction, applyOverlayStyle, fillColorPatch, setStrokeColor, imageInputRef } = overlay;
  const {
    closeTransientCommandSurfaces, setFontFamilyMenuOpen, setLineHeightMenuOpen,
    setLineHeightCustomOpen, setTextAlignMenuOpen, setLineDashMenuOpen, setLineWidthMenuOpen,
    setLineEndpointMenu,
  } = menus;
  const {
    undoDocumentChange, redoDocumentChange, createDocumentTab, openDocumentListDialog,
    duplicateActiveDocument, addBlock, setSearchOpen, setOutlineOpen, applyZoom, resetZoom,
    setSettingsFocusEntryId, setCommandPaletteOpen, openPrintPreview, toggleCommentsPanel,
    setOutlineDialogOpen, promoteAiToSidebar, setAiSettingsOpen, setPageSettingsOpen,
    openCommandSettings, setMaterialLibraryOpen, setStatusMessage, tEditor,
  } = application;

  const executeCustomCommandAction = (action: EditorCustomCommandAction) => {
    if (action.type === "textFormat") {
      if (action.command === "boxed") {
        toggleBoxedText();
      } else {
        runEditCommand(action.command);
      }
      return;
    }
    if (action.type === "fontFamily") {
      setFontFamily(normalizeToolbarFontFamily(action.value || DEFAULT_FONT_FAMILY_VALUE));
      applyInlineFormat("fontFamily", action.value);
      setFontFamilyMenuOpen(false);
      return;
    }
    if (action.type === "fontSize") {
      setTextFontSize(action.value);
      applyInlineFormat("fontSize", String(action.value));
      return;
    }
    if (action.type === "lineHeight") {
      applyLineHeight(action.value);
      setLineHeightMenuOpen(false);
      setLineHeightCustomOpen(false);
      return;
    }
    if (action.type === "textAlign") {
      applyTextAlign(action.value);
      setTextAlignMenuOpen(false);
      return;
    }
    if (action.type === "blockStyle") {
      applyTextStyle(action.value);
      return;
    }
    if (action.type === "textColor") {
      setTextColor(action.value);
      applyInlineFormat("color", action.value);
      return;
    }
    if (action.type === "textBackgroundColor") {
      setTextBackgroundColor(action.value);
      applyInlineFormat("backgroundColor", action.value);
      return;
    }
    if (action.type === "overlayStrokeColor") {
      if (action.value === null) {
        setStrokeColor(null);
        applyOverlayStyle({ strokeOpacity: 0 });
      } else {
        setStrokeColor(action.value);
        applyOverlayStyle({ color: action.value, strokeOpacity: 1 });
      }
      return;
    }
    if (action.type === "overlayFillColor") {
      if (action.value === null) {
        applyOverlayStyle({ fill: "none" });
      } else {
        applyOverlayStyle(fillColorPatch(action.value));
      }
      return;
    }
    if (action.type === "overlayLineDash") {
      applyOverlayStyle({ dash: action.value });
      setLineDashMenuOpen(false);
      return;
    }
    if (action.type === "overlayLineWidth") {
      applyOverlayStyle({ size: action.value });
      setLineWidthMenuOpen(false);
    }
  };

  return (commandId: EditorCommandId) => {
    closeTransientCommandSurfaces();

    const customCommand = customCommands.find((command) => command.id === commandId);
    if (customCommand) {
      executeCustomCommandAction(customCommand.action);
      return;
    }

    if (commandId === "edit.undo") {
      undoDocumentChange();
      return;
    }
    if (commandId === "edit.redo") {
      redoDocumentChange();
      return;
    }
    if (commandId === "edit.search") {
      setSearchOpen(true);
      return;
    }
    if (commandId === "edit.selectAllWithShapes") {
      window.dispatchEvent(new CustomEvent(SELECT_BODY_WITH_SHAPES_EVENT));
      return;
    }
    if (commandId === "edit.bold") {
      runEditCommand("bold");
      return;
    }
    if (commandId === "edit.italic") {
      runEditCommand("italic");
      return;
    }
    if (commandId === "edit.underline") {
      runEditCommand("underline");
      return;
    }
    if (commandId === "edit.boxedText") {
      toggleBoxedText();
      return;
    }
    if (commandId === "view.toggleOutline") {
      setOutlineOpen((current) => !current);
      return;
    }
    if (commandId === "view.zoomIn") {
      applyZoom((current) => current + KEYBOARD_ZOOM_STEP);
      return;
    }
    if (commandId === "view.zoomOut") {
      applyZoom((current) => current - KEYBOARD_ZOOM_STEP);
      return;
    }
    if (commandId === "view.zoomReset") {
      resetZoom();
      return;
    }
    if (commandId === "view.commandPalette") {
      setSettingsFocusEntryId(undefined);
      setCommandPaletteOpen(true);
      return;
    }
    if (commandId === "view.printPreview") {
      openPrintPreview();
      return;
    }
    if (commandId === "view.comments") {
      toggleCommentsPanel();
      return;
    }
    if (commandId === "view.outlineDialog") {
      setOutlineDialogOpen(true);
      return;
    }
    if (commandId === "document.new") {
      void createDocumentTab();
      return;
    }
    if (commandId === "document.library") {
      void openDocumentListDialog();
      return;
    }
    if (commandId === "document.duplicate") {
      void duplicateActiveDocument();
      return;
    }
    if (commandId === "ai.chat") {
      promoteAiToSidebar();
      return;
    }
    if (commandId === "ai.resources") {
      setAiSettingsOpen(true);
      return;
    }
    if (commandId === "settings.aiAccount") {
      setAiSettingsOpen(true);
      return;
    }
    if (commandId === "settings.page") {
      setPageSettingsOpen(true);
      return;
    }
    if (commandId === "settings.commands") {
      openCommandSettings();
      return;
    }
    if (commandId === "insert.material") {
      setMaterialLibraryOpen(true);
      return;
    }
    if (commandId === "insert.paragraph") {
      addBlock("paragraph");
      return;
    }
    if (commandId === "insert.heading") {
      addBlock("heading");
      return;
    }
    if (commandId === "insert.problem") {
      addBlock("problem");
      return;
    }
    if (commandId === "insert.inlineMath") {
      insertInlineMath("", getActiveTextTarget());
      setStatusMessage(tEditor("status.mathAdded"));
      return;
    }

    const blockStyle = SHORTCUT_BLOCK_STYLES[commandId];
    if (blockStyle) {
      applyTextStyle(blockStyle);
      return;
    }

    const textAlign = SHORTCUT_TEXT_ALIGNS[commandId];
    if (textAlign) {
      applyTextAlign(textAlign);
      setTextAlignMenuOpen(false);
      return;
    }

    const lineHeightValue = SHORTCUT_LINE_HEIGHTS[commandId];
    if (lineHeightValue) {
      applyLineHeight(lineHeightValue);
      setLineHeightMenuOpen(false);
      setLineHeightCustomOpen(false);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(SHORTCUT_FONT_FAMILIES, commandId)) {
      const fontValue = SHORTCUT_FONT_FAMILIES[commandId];
      setFontFamily(normalizeToolbarFontFamily(fontValue || DEFAULT_FONT_FAMILY_VALUE));
      applyInlineFormat("fontFamily", fontValue);
      setFontFamilyMenuOpen(false);
      return;
    }

    const fontSizeValue = SHORTCUT_FONT_SIZES[commandId];
    if (fontSizeValue) {
      setTextFontSize(fontSizeValue);
      applyInlineFormat("fontSize", String(fontSizeValue));
      return;
    }

    if (commandId === "overlay.image") {
      imageInputRef.current?.click();
      return;
    }
    if (commandId === "overlay.duplicate") {
      requestOverlayAction({ type: "duplicate" });
      return;
    }
    if (commandId === "overlay.delete") {
      requestOverlayAction({ type: "delete" });
      return;
    }
    if (commandId === "overlay.group") {
      requestOverlayAction({ type: "group" });
      return;
    }
    if (commandId === "overlay.ungroup") {
      requestOverlayAction({ type: "ungroup" });
      return;
    }
    if (commandId === "overlay.toggleLock") {
      requestOverlayAction({ type: "toggleLock" });
      return;
    }
    if (commandId === "overlay.toggleHidden") {
      requestOverlayAction({ type: "toggleHidden" });
      return;
    }

    const arrangeAction = SHORTCUT_OVERLAY_ARRANGE_ACTIONS[commandId];
    if (arrangeAction) {
      requestOverlayAction({ type: "arrange", action: arrangeAction });
      return;
    }

    const alignAction = SHORTCUT_OVERLAY_ALIGN_ACTIONS[commandId];
    if (alignAction) {
      requestOverlayAction({ type: "align", action: alignAction });
      return;
    }

    const distributeAxis = SHORTCUT_OVERLAY_DISTRIBUTE_ACTIONS[commandId];
    if (distributeAxis) {
      requestOverlayAction({ type: "distribute", axis: distributeAxis });
      return;
    }

    if (Object.prototype.hasOwnProperty.call(SHORTCUT_STROKE_COLORS, commandId)) {
      const color = SHORTCUT_STROKE_COLORS[commandId];
      if (color === null) {
        setStrokeColor(null);
        applyOverlayStyle({ strokeOpacity: 0 });
      } else {
        setStrokeColor(color);
        applyOverlayStyle({ color, strokeOpacity: 1 });
      }
      return;
    }

    if (Object.prototype.hasOwnProperty.call(SHORTCUT_FILL_COLORS, commandId)) {
      const color = SHORTCUT_FILL_COLORS[commandId];
      if (color === null) {
        applyOverlayStyle({ fill: "none" });
      } else {
        applyOverlayStyle(fillColorPatch(color));
      }
      return;
    }

    const lineDash = SHORTCUT_LINE_DASHES[commandId];
    if (lineDash) {
      applyOverlayStyle({ dash: lineDash });
      setLineDashMenuOpen(false);
      return;
    }

    const lineWidth = SHORTCUT_LINE_WIDTHS[commandId];
    if (lineWidth) {
      applyOverlayStyle({ size: lineWidth });
      setLineWidthMenuOpen(false);
      return;
    }

    const arrowheadValue = SHORTCUT_ARROWHEAD_VALUES[commandId];
    if (arrowheadValue) {
      if (commandId.startsWith("overlay.arrowhead.start.")) {
        applyOverlayStyle({ arrowheadStart: arrowheadValue });
      } else {
        applyOverlayStyle({ arrowheadEnd: arrowheadValue });
      }
      setLineEndpointMenu(null);
      return;
    }

    const overlayCommand = commandId.replace("overlay.", "") as OverlayCommand;
    runOverlayCommand(overlayCommand);
  };
}
