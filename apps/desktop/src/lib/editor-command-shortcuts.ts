import { normalizeLineHeight } from "@/features/document";
import { COMMAND_PALETTE_BINDING, PRINT_PREVIEW_BINDING } from "@/lib/editor-command-bindings";
import type { Translate } from "@/lib/i18n";

export type EditorShortcutPlatform = "mac" | "windows" | "other";

export interface EditorShortcutBinding {
  key: string;
  primary?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/**
 * コマンドのカテゴリ。表示名は `command.category.<id>` が持つ。
 * ここに日本語を置かないのが肝で、打鍵ごとに走る `findCommandByShortcut` を
 * 翻訳から切り離したままにできる。
 */
export type EditorCommandCategoryId =
  | "edit"
  | "textFormat"
  | "view"
  | "document"
  | "ai"
  | "settings"
  | "insert"
  | "paragraphFormat"
  | "font"
  | "shapeTool"
  | "shapeEdit"
  | "shapeAlign"
  | "shapeStyle"
  | "custom";

/**
 * コマンド定義は **データだけ**。表示名・説明は `command` namespace が持ち、
 * 表示するときだけ {@link resolveEditorCommandCatalog} で解決する。
 */
/**
 * コマンドの性質。「いまフォーカスがある面でこのコマンドを走らせてよいか」を決める。
 *
 * - `documentSurface` (既定) … 本文編集面のためのコマンド。入力欄やダイアログの中では走らせない。
 * - `editHistory` … 自前の編集履歴を持つ面にだけ譲り、それ以外では常に通す。
 *
 * **バインドが単一文字かどうかで推測しない。** ユーザーがキーを再割り当てした瞬間に
 * 破綻するので、性質はコマンド側が宣言する。
 */
export type EditorCommandTargetPolicy = "documentSurface" | "editHistory";

export interface EditorCommandShortcutDefinition {
  id: string;
  categoryId: EditorCommandCategoryId;
  defaultBinding: EditorShortcutBinding | null;
  targetPolicy?: EditorCommandTargetPolicy;
}

/** 表示用に文言を解決したコマンド。UI 層だけが受け取る。 */
export interface ResolvedEditorCommand extends EditorCommandShortcutDefinition {
  label: string;
  category: string;
  /** 検索用のシノニム (表示しない)。辞書に無ければ空文字。 */
  keywords: string;
  description: string;
}

export type EditorCustomCommandAction =
  | { type: "textFormat"; command: "bold" | "italic" | "underline" | "boxed" }
  | { type: "fontFamily"; value: string }
  | { type: "fontSize"; value: number }
  | { type: "lineHeight"; value: string }
  | { type: "textAlign"; value: "left" | "center" | "right" | "justify" }
  | { type: "blockStyle"; value: "paragraph" | "h1" | "h2" | "h3" }
  | { type: "textColor"; value: string }
  | { type: "textBackgroundColor"; value: string }
  | { type: "overlayStrokeColor"; value: string | null }
  | { type: "overlayFillColor"; value: string | null }
  | { type: "overlayLineDash"; value: "solid" | "dashed" | "dotted" }
  | { type: "overlayLineWidth"; value: "s" | "m" | "l" | "xl" };

export interface EditorCustomCommandDefinition extends EditorCommandShortcutDefinition {
  id: `custom.${string}`;
  categoryId: "custom";
  /** ユーザーが入力した名前。**翻訳しない**し、保存形式もこのまま。 */
  label: string;
  custom: true;
  action: EditorCustomCommandAction;
  defaultBinding: null;
}

export const EDITOR_SHORTCUT_STORAGE_KEY = "sigma-studio:command-shortcuts";
export const EDITOR_CUSTOM_COMMANDS_STORAGE_KEY = "sigma-studio:custom-commands";

export const EDITOR_COMMAND_SHORTCUTS: readonly EditorCommandShortcutDefinition[] = [
  { id: "edit.undo", categoryId: "edit", defaultBinding: { primary: true, key: "z" }, targetPolicy: "editHistory" },
  { id: "edit.redo", categoryId: "edit", defaultBinding: { primary: true, shift: true, key: "z" }, targetPolicy: "editHistory" },
  { id: "edit.search", categoryId: "edit", defaultBinding: { primary: true, key: "f" } },
  { id: "edit.selectAllWithShapes", categoryId: "edit", defaultBinding: { primary: true, shift: true, key: "a" } },
  { id: "edit.bold", categoryId: "textFormat", defaultBinding: null },
  { id: "edit.italic", categoryId: "textFormat", defaultBinding: { primary: true, key: "i" } },
  { id: "edit.underline", categoryId: "textFormat", defaultBinding: { primary: true, key: "u" } },
  { id: "edit.boxedText", categoryId: "textFormat", defaultBinding: null },
  { id: "view.toggleOutline", categoryId: "view", defaultBinding: { primary: true, key: "b" } },
  { id: "view.zoomIn", categoryId: "view", defaultBinding: { primary: true, key: "=" } },
  { id: "view.zoomOut", categoryId: "view", defaultBinding: { primary: true, key: "-" } },
  { id: "view.zoomReset", categoryId: "view", defaultBinding: { primary: true, key: "0" } },
  { id: "view.commandPalette", categoryId: "view", defaultBinding: COMMAND_PALETTE_BINDING },
  { id: "view.printPreview", categoryId: "view", defaultBinding: PRINT_PREVIEW_BINDING },
  { id: "view.comments", categoryId: "view", defaultBinding: null },
  { id: "view.outlineDialog", categoryId: "view", defaultBinding: null },
  { id: "document.new", categoryId: "document", defaultBinding: { primary: true, key: "n" } },
  { id: "document.library", categoryId: "document", defaultBinding: null },
  { id: "document.duplicate", categoryId: "document", defaultBinding: null },
  { id: "ai.chat", categoryId: "ai", defaultBinding: null },
  { id: "ai.resources", categoryId: "ai", defaultBinding: null },
  { id: "settings.aiAccount", categoryId: "settings", defaultBinding: null },
  { id: "settings.page", categoryId: "settings", defaultBinding: null },
  { id: "settings.commands", categoryId: "settings", defaultBinding: { primary: true, alt: true, key: "," } },
  { id: "insert.material", categoryId: "insert", defaultBinding: null },
  { id: "insert.paragraph", categoryId: "insert", defaultBinding: null },
  { id: "insert.heading", categoryId: "insert", defaultBinding: null },
  { id: "insert.problem", categoryId: "insert", defaultBinding: null },
  { id: "insert.inlineMath", categoryId: "insert", defaultBinding: { primary: true, shift: true, key: "m" } },
  { id: "format.block.paragraph", categoryId: "paragraphFormat", defaultBinding: null },
  { id: "format.block.h1", categoryId: "paragraphFormat", defaultBinding: null },
  { id: "format.block.h2", categoryId: "paragraphFormat", defaultBinding: null },
  { id: "format.block.h3", categoryId: "paragraphFormat", defaultBinding: null },
  { id: "format.align.left", categoryId: "paragraphFormat", defaultBinding: null },
  { id: "format.align.center", categoryId: "paragraphFormat", defaultBinding: null },
  { id: "format.align.right", categoryId: "paragraphFormat", defaultBinding: null },
  { id: "format.align.justify", categoryId: "paragraphFormat", defaultBinding: null },
  { id: "format.lineHeight.1", categoryId: "paragraphFormat", defaultBinding: null },
  { id: "format.lineHeight.1.15", categoryId: "paragraphFormat", defaultBinding: null },
  { id: "format.lineHeight.1.35", categoryId: "paragraphFormat", defaultBinding: null },
  { id: "format.lineHeight.1.5", categoryId: "paragraphFormat", defaultBinding: null },
  { id: "format.lineHeight.1.75", categoryId: "paragraphFormat", defaultBinding: null },
  { id: "format.lineHeight.2", categoryId: "paragraphFormat", defaultBinding: null },
  { id: "format.font.default", categoryId: "font", defaultBinding: null },
  { id: "format.font.mPlus1p", categoryId: "font", defaultBinding: null },
  { id: "format.font.hiraginoSans", categoryId: "font", defaultBinding: null },
  { id: "format.font.hiraginoMincho", categoryId: "font", defaultBinding: null },
  { id: "format.font.hiraginoMaru", categoryId: "font", defaultBinding: null },
  { id: "format.font.yuGothic", categoryId: "font", defaultBinding: null },
  { id: "format.font.yuMincho", categoryId: "font", defaultBinding: null },
  { id: "format.font.tsukushiARound", categoryId: "font", defaultBinding: null },
  { id: "format.font.tsukushiBRound", categoryId: "font", defaultBinding: null },
  { id: "format.font.tsukushiMincho", categoryId: "font", defaultBinding: null },
  { id: "format.font.klee", categoryId: "font", defaultBinding: null },
  { id: "format.font.monospace", categoryId: "font", defaultBinding: null },
  { id: "format.fontSize.13", categoryId: "font", defaultBinding: null },
  { id: "format.fontSize.14", categoryId: "font", defaultBinding: null },
  { id: "format.fontSize.15", categoryId: "font", defaultBinding: null },
  { id: "format.fontSize.16", categoryId: "font", defaultBinding: null },
  { id: "format.fontSize.18", categoryId: "font", defaultBinding: null },
  { id: "format.fontSize.20", categoryId: "font", defaultBinding: null },
  { id: "format.fontSize.22", categoryId: "font", defaultBinding: null },
  { id: "format.fontSize.24", categoryId: "font", defaultBinding: null },
  { id: "overlay.select", categoryId: "shapeTool", defaultBinding: { key: "v" } },
  { id: "overlay.text", categoryId: "shapeTool", defaultBinding: { key: "t" } },
  { id: "overlay.graph", categoryId: "shapeTool", defaultBinding: { key: "g" } },
  { id: "overlay.graph3d", categoryId: "shapeTool", defaultBinding: null },
  { id: "overlay.image", categoryId: "shapeTool", defaultBinding: null },
  { id: "overlay.rectangle", categoryId: "shapeTool", defaultBinding: { key: "r" } },
  { id: "overlay.circle", categoryId: "shapeTool", defaultBinding: { key: "o" } },
  { id: "overlay.triangle", categoryId: "shapeTool", defaultBinding: null },
  { id: "overlay.diamond", categoryId: "shapeTool", defaultBinding: null },
  { id: "overlay.pentagon", categoryId: "shapeTool", defaultBinding: null },
  { id: "overlay.arc", categoryId: "shapeTool", defaultBinding: null },
  { id: "overlay.sector", categoryId: "shapeTool", defaultBinding: null },
  { id: "overlay.threePointArc", categoryId: "shapeTool", defaultBinding: null },
  { id: "overlay.line", categoryId: "shapeTool", defaultBinding: { key: "l" } },
  { id: "overlay.polyline", categoryId: "shapeTool", defaultBinding: null },
  { id: "overlay.curve", categoryId: "shapeTool", defaultBinding: null },
  { id: "overlay.freehand", categoryId: "shapeTool", defaultBinding: null },
  { id: "overlay.arrow", categoryId: "shapeTool", defaultBinding: { key: "a" } },
  { id: "overlay.blockArrow", categoryId: "shapeTool", defaultBinding: null },
  { id: "overlay.highlight", categoryId: "shapeTool", defaultBinding: null },
  { id: "overlay.callout", categoryId: "shapeTool", defaultBinding: null },
  { id: "overlay.table", categoryId: "shapeTool", defaultBinding: null },
  { id: "overlay.duplicate", categoryId: "shapeEdit", defaultBinding: { primary: true, key: "d" } },
  { id: "overlay.delete", categoryId: "shapeEdit", defaultBinding: null },
  { id: "overlay.group", categoryId: "shapeEdit", defaultBinding: { primary: true, key: "g" } },
  { id: "overlay.ungroup", categoryId: "shapeEdit", defaultBinding: { primary: true, shift: true, key: "g" } },
  { id: "overlay.toggleLock", categoryId: "shapeEdit", defaultBinding: null },
  { id: "overlay.toggleHidden", categoryId: "shapeEdit", defaultBinding: null },
  { id: "overlay.arrange.front", categoryId: "shapeEdit", defaultBinding: { primary: true, shift: true, key: "ArrowUp" } },
  { id: "overlay.arrange.back", categoryId: "shapeEdit", defaultBinding: { primary: true, shift: true, key: "ArrowDown" } },
  { id: "overlay.arrange.forward", categoryId: "shapeEdit", defaultBinding: { primary: true, key: "ArrowUp" } },
  { id: "overlay.arrange.backward", categoryId: "shapeEdit", defaultBinding: { primary: true, key: "ArrowDown" } },
  { id: "overlay.align.left", categoryId: "shapeAlign", defaultBinding: null },
  { id: "overlay.align.center", categoryId: "shapeAlign", defaultBinding: null },
  { id: "overlay.align.right", categoryId: "shapeAlign", defaultBinding: null },
  { id: "overlay.align.top", categoryId: "shapeAlign", defaultBinding: null },
  { id: "overlay.align.middle", categoryId: "shapeAlign", defaultBinding: null },
  { id: "overlay.align.bottom", categoryId: "shapeAlign", defaultBinding: null },
  { id: "overlay.distribute.horizontal", categoryId: "shapeAlign", defaultBinding: null },
  { id: "overlay.distribute.vertical", categoryId: "shapeAlign", defaultBinding: null },
  { id: "overlay.stroke.black", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.stroke.red", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.stroke.blue", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.stroke.green", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.stroke.none", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.fill.none", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.fill.white", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.fill.yellow", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.fill.blue", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.fill.red", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.fill.green", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.line.solid", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.line.dashed", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.line.dotted", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.line.width.s", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.line.width.m", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.line.width.l", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.line.width.xl", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.start.none", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.start.arrow", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.start.triangle", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.start.openArrow", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.start.thinArrow", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.start.diamond", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.start.dot", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.start.bar", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.start.arrowSmall", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.start.triangleSmall", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.start.openArrowSmall", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.start.thinArrowSmall", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.start.diamondSmall", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.start.dotSmall", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.start.barSmall", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.end.none", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.end.arrow", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.end.triangle", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.end.openArrow", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.end.thinArrow", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.end.diamond", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.end.dot", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.end.bar", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.end.arrowSmall", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.end.triangleSmall", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.end.openArrowSmall", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.end.thinArrowSmall", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.end.diamondSmall", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.end.dotSmall", categoryId: "shapeStyle", defaultBinding: null },
  { id: "overlay.arrowhead.end.barSmall", categoryId: "shapeStyle", defaultBinding: null },
] as const;

export type EditorCommandId = string;
export type EditorShortcutOverrides = Record<EditorCommandId, EditorShortcutBinding | null | undefined>;

const EDITOR_COMMAND_IDS = new Set<string>(EDITOR_COMMAND_SHORTCUTS.map((command) => command.id));
const MODIFIER_KEYS = new Set(["alt", "altgraph", "control", "meta", "shift", "os"]);
const KEY_LABELS: Record<string, string> = {
  " ": "Space",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  backspace: "Backspace",
  delete: "Delete",
  enter: "Enter",
  escape: "Esc",
  tab: "Tab",
};

const KEY_ALIASES: Record<string, string> = {
  del: "delete",
  down: "arrowdown",
  esc: "escape",
  left: "arrowleft",
  return: "enter",
  right: "arrowright",
  space: " ",
  up: "arrowup",
};

const SHIFT_KEY_TO_BASE: Record<string, string> = {
  "!": "1",
  "\"": "'",
  "#": "3",
  "$": "4",
  "%": "5",
  "&": "7",
  "(": "9",
  ")": "0",
  "*": "8",
  "+": "=",
  ":": ";",
  "<": ",",
  ">": ".",
  "?": "/",
  "@": "2",
  "^": "6",
  "_": "-",
  "{": "[",
  "|": "\\",
  "}": "]",
  "~": "`",
};

const PHYSICAL_KEY_MAP: Record<string, string> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Equal: "=",
  KeyA: "a",
  KeyB: "b",
  KeyC: "c",
  KeyD: "d",
  KeyE: "e",
  KeyF: "f",
  KeyG: "g",
  KeyH: "h",
  KeyI: "i",
  KeyJ: "j",
  KeyK: "k",
  KeyL: "l",
  KeyM: "m",
  KeyN: "n",
  KeyO: "o",
  KeyP: "p",
  KeyQ: "q",
  KeyR: "r",
  KeyS: "s",
  KeyT: "t",
  KeyU: "u",
  KeyV: "v",
  KeyW: "w",
  KeyX: "x",
  KeyY: "y",
  KeyZ: "z",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

export function detectEditorShortcutPlatform(platform = getNavigatorPlatform()): EditorShortcutPlatform {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac") || normalized.includes("iphone") || normalized.includes("ipad")) {
    return "mac";
  }
  if (normalized.includes("win")) {
    return "windows";
  }
  return "other";
}

export function getEditorCommandCatalog(
  customCommands: readonly EditorCustomCommandDefinition[] = [],
): readonly EditorCommandShortcutDefinition[] {
  return customCommands.length === 0 ? EDITOR_COMMAND_SHORTCUTS : [...EDITOR_COMMAND_SHORTCUTS, ...customCommands];
}

/**
 * コマンドの `targetPolicy`。未宣言 (カスタムコマンドを含む) は `documentSurface`。
 *
 * 例外を作らないために既定を安全側 (入力欄では走らせない) に置いている。
 */
export function getCommandTargetPolicy(
  commandId: string,
  customCommands: readonly EditorCustomCommandDefinition[] = [],
): EditorCommandTargetPolicy {
  const definition = getEditorCommandCatalog(customCommands).find((command) => command.id === commandId);
  return definition?.targetPolicy ?? "documentSurface";
}

export function getCommandShortcutDefinition(
  commandId: EditorCommandId,
  customCommands: readonly EditorCustomCommandDefinition[] = [],
): EditorCommandShortcutDefinition {
  const definition = getEditorCommandCatalog(customCommands).find((command) => command.id === commandId);
  if (!definition) {
    throw new Error(`Unknown editor command: ${commandId}`);
  }
  return definition;
}

export function isEditorCommandId(value: string): value is EditorCommandId {
  return EDITOR_COMMAND_IDS.has(value) || value.startsWith("custom.");
}

export function getShortcutForCommand(
  overrides: EditorShortcutOverrides,
  commandId: EditorCommandId,
  customCommands: readonly EditorCustomCommandDefinition[] = [],
): EditorShortcutBinding | null {
  if (Object.prototype.hasOwnProperty.call(overrides, commandId)) {
    return overrides[commandId] ?? null;
  }

  return getCommandShortcutDefinition(commandId, customCommands).defaultBinding;
}

export function assignShortcutOverride(
  overrides: EditorShortcutOverrides,
  commandId: EditorCommandId,
  binding: EditorShortcutBinding,
  customCommands: readonly EditorCustomCommandDefinition[] = [],
): EditorShortcutOverrides {
  const normalizedBinding = normalizeShortcutBinding(binding);
  const next: EditorShortcutOverrides = { ...overrides };

  for (const command of getEditorCommandCatalog(customCommands)) {
    if (command.id === commandId) {
      continue;
    }

    const currentBinding = getShortcutForCommand(next, command.id, customCommands);
    if (currentBinding && areShortcutBindingsEqual(currentBinding, normalizedBinding)) {
      next[command.id] = null;
    }
  }

  const defaultBinding = getCommandShortcutDefinition(commandId, customCommands).defaultBinding;
  if (defaultBinding && areShortcutBindingsEqual(defaultBinding, normalizedBinding)) {
    delete next[commandId];
  } else {
    next[commandId] = normalizedBinding;
  }

  return next;
}

export function clearShortcutOverride(
  overrides: EditorShortcutOverrides,
  commandId: EditorCommandId,
): EditorShortcutOverrides {
  return {
    ...overrides,
    [commandId]: null,
  };
}

export function resetShortcutOverride(
  overrides: EditorShortcutOverrides,
  commandId: EditorCommandId,
): EditorShortcutOverrides {
  const next = { ...overrides };
  delete next[commandId];
  return next;
}

export function resetAllShortcutOverrides(): EditorShortcutOverrides {
  return {};
}

export function findShortcutConflict(
  overrides: EditorShortcutOverrides,
  commandId: EditorCommandId,
  binding: EditorShortcutBinding,
  customCommands: readonly EditorCustomCommandDefinition[] = [],
): EditorCommandShortcutDefinition | null {
  const normalizedBinding = normalizeShortcutBinding(binding);
  return getEditorCommandCatalog(customCommands).find((command) => (
    command.id !== commandId &&
    getShortcutForCommand(overrides, command.id, customCommands) !== null &&
    areShortcutBindingsEqual(getShortcutForCommand(overrides, command.id, customCommands), normalizedBinding)
  )) ?? null;
}

export function findCommandByShortcut(
  event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  overrides: EditorShortcutOverrides,
  customCommands: readonly EditorCustomCommandDefinition[] = [],
): { commandId: EditorCommandId; binding: EditorShortcutBinding } | null {
  for (const command of getEditorCommandCatalog(customCommands)) {
    const binding = getShortcutForCommand(overrides, command.id, customCommands);
    if (binding && shortcutMatchesEvent(binding, event)) {
      return { commandId: command.id, binding };
    }
  }

  return null;
}

export function shouldDispatchOverlayArrangeShortcut(
  commandId: string,
  state: {
    hasUnlockedOverlaySelection: boolean;
    editingOverlayTextOrTable: boolean;
    editingTextTarget: boolean;
  },
): boolean {
  if (!commandId.startsWith("overlay.arrange.")) {
    return true;
  }
  return state.hasUnlockedOverlaySelection
    && !state.editingOverlayTextOrTable
    && !state.editingTextTarget;
}

export function shortcutBindingFromEvent(
  event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform: EditorShortcutPlatform,
): EditorShortcutBinding | null {
  const key = getNormalizedEventKey(event);
  if (!key || MODIFIER_KEYS.has(key)) {
    return null;
  }

  const binding: EditorShortcutBinding = { key };
  const primaryPressed = isPrimaryShortcutKeyPressed(event, platform);

  if (primaryPressed) {
    binding.primary = true;
  }
  if (event.ctrlKey && !primaryPressed) {
    binding.ctrl = true;
  }
  if (event.metaKey && !primaryPressed) {
    binding.meta = true;
  }
  if (event.altKey) {
    binding.alt = true;
  }
  if (event.shiftKey) {
    binding.shift = true;
  }

  return normalizeShortcutBinding(binding);
}

export function shortcutMatchesEvent(
  binding: EditorShortcutBinding,
  event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
): boolean {
  const normalizedBinding = normalizeShortcutBinding(binding);
  if (!shortcutModifiersMatchEvent(normalizedBinding, event)) {
    return false;
  }

  return getEventKeyCandidates(event).includes(normalizedBinding.key);
}

export function areShortcutBindingsEqual(
  first: EditorShortcutBinding | null | undefined,
  second: EditorShortcutBinding | null | undefined,
): boolean {
  if (!first || !second) {
    return first === second;
  }

  return shortcutBindingKey(first) === shortcutBindingKey(second);
}

export function formatShortcut(
  binding: EditorShortcutBinding | null,
  platform: EditorShortcutPlatform,
): string[] {
  if (!binding) {
    return [];
  }

  const normalized = normalizeShortcutBinding(binding);
  const parts: string[] = [];
  if (normalized.primary) {
    parts.push(platform === "mac" ? "⌘" : "Ctrl");
  }
  if (normalized.ctrl) {
    parts.push(platform === "mac" ? "⌃" : "Ctrl");
  }
  if (normalized.meta) {
    parts.push("⌘");
  }
  if (normalized.alt) {
    parts.push(platform === "mac" ? "⌥" : "Alt");
  }
  if (normalized.shift) {
    parts.push(platform === "mac" ? "⇧" : "Shift");
  }
  parts.push(formatShortcutKey(normalized.key, normalized.shift === true));
  return parts;
}

/**
 * Electron の accelerator 表記 (`CmdOrCtrl+Shift+P`)。
 *
 * `formatShortcut` は画面表示用の記号 (⌘⇧P) を返すので、ネイティブメニューには使えない。
 * 同じ操作のキーが `EDITOR_COMMAND_SHORTCUTS` と `electron/main.ts` の 2 箇所に
 * 別々に書かれているのが ⌘P 衝突の構造的な原因だったので、突き合わせられる形を用意する
 * (`electron/menu-accelerator-parity.test.ts`)。
 */
/**
 * `main.ts` は今も accelerator を手書きしている。**ここから生成しないのは、
 * electron 側のバンドル (esbuild) が `@/…` のレンダラモジュールを引き込めないため**で、
 * 好みの問題ではない。だから「二重書きを不可能にする」のではなく
 * 「ずれたら落とす」(`electron/menu-accelerator-parity.test.ts`) 側で閉じている。
 * 本番コードからの参照が無いのはそのため。
 */
export function formatElectronAccelerator(binding: EditorShortcutBinding | null): string | null {
  if (!binding) {
    return null;
  }
  const normalized = normalizeShortcutBinding(binding);
  const parts: string[] = [];
  // Electron は修飾キーの順番を問わないが、読み比べやすいよう Electron 公式の並びに揃える。
  if (normalized.primary) {
    parts.push("CmdOrCtrl");
  }
  if (normalized.ctrl) {
    parts.push("Ctrl");
  }
  if (normalized.meta) {
    parts.push("Command");
  }
  if (normalized.alt) {
    parts.push("Alt");
  }
  if (normalized.shift) {
    parts.push("Shift");
  }
  parts.push(formatElectronAcceleratorKey(normalized.key));
  return parts.join("+");
}

function formatElectronAcceleratorKey(key: string): string {
  const named: Record<string, string> = {
    arrowdown: "Down",
    arrowleft: "Left",
    arrowright: "Right",
    arrowup: "Up",
    " ": "Space",
    escape: "Esc",
    enter: "Return",
  };
  const normalized = key.toLowerCase();
  if (named[normalized]) {
    return named[normalized];
  }
  return normalized.length === 1 ? normalized.toUpperCase() : key;
}

export function formatShortcutText(
  binding: EditorShortcutBinding | null,
  platform: EditorShortcutPlatform,
): string {
  return formatShortcut(binding, platform).join(platform === "mac" ? "" : "+");
}

export function isSingleCharacterShortcut(binding: EditorShortcutBinding): boolean {
  const normalized = normalizeShortcutBinding(binding);
  return (
    normalized.key.length === 1 &&
    !normalized.primary &&
    !normalized.ctrl &&
    !normalized.meta &&
    !normalized.alt
  );
}

export function loadEditorShortcutOverrides(storage = getLocalStorage()): EditorShortcutOverrides {
  if (!storage) {
    return {};
  }
  return parseEditorShortcutOverrides(storage.getItem(EDITOR_SHORTCUT_STORAGE_KEY));
}

export function saveEditorShortcutOverrides(
  overrides: EditorShortcutOverrides,
  storage = getLocalStorage(),
): void {
  if (!storage) {
    return;
  }

  const keys = Object.keys(overrides);
  if (keys.length === 0) {
    storage.removeItem(EDITOR_SHORTCUT_STORAGE_KEY);
    return;
  }

  storage.setItem(EDITOR_SHORTCUT_STORAGE_KEY, JSON.stringify(overrides));
}

export function loadEditorCustomCommands(storage = getLocalStorage()): EditorCustomCommandDefinition[] {
  if (!storage) {
    return [];
  }
  return parseEditorCustomCommands(storage.getItem(EDITOR_CUSTOM_COMMANDS_STORAGE_KEY));
}

export function saveEditorCustomCommands(
  commands: readonly EditorCustomCommandDefinition[],
  storage = getLocalStorage(),
): void {
  if (!storage) {
    return;
  }

  if (commands.length === 0) {
    storage.removeItem(EDITOR_CUSTOM_COMMANDS_STORAGE_KEY);
    return;
  }

  storage.setItem(EDITOR_CUSTOM_COMMANDS_STORAGE_KEY, JSON.stringify(commands));
}

export function parseEditorShortcutOverrides(raw: string | null): EditorShortcutOverrides {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const overrides: EditorShortcutOverrides = {};
    for (const [commandId, value] of Object.entries(parsed)) {
      if (!isEditorCommandId(commandId)) {
        continue;
      }
      if (value === null) {
        overrides[commandId] = null;
        continue;
      }
      if (isShortcutBindingLike(value)) {
        overrides[commandId] = normalizeShortcutBinding(value);
      }
    }
    return overrides;
  } catch {
    return {};
  }
}

export function parseEditorCustomCommands(raw: string | null): EditorCustomCommandDefinition[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const commands: EditorCustomCommandDefinition[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const command = parseEditorCustomCommand(item);
      if (!command || seen.has(command.id)) {
        continue;
      }
      seen.add(command.id);
      commands.push(command);
    }
    return commands;
  } catch {
    return [];
  }
}

export function createEditorCustomCommandDefinition(input: {
  label: string;
  action: EditorCustomCommandAction;
}): EditorCustomCommandDefinition {
  const id = `custom.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}` as `custom.${string}`;
  return {
    id,
    label: input.label.trim(),
    categoryId: "custom",
    custom: true,
    action: input.action,
    defaultBinding: null,
  };
}

/**
 * 表示のために文言を解決する。**UI で描くときだけ呼ぶこと。**
 * `findCommandByShortcut` などの打鍵ホットパスからは絶対に呼ばない
 * (打鍵 13ms/文字の予算に直撃する)。
 */
export function resolveEditorCommandCatalog(
  catalog: readonly EditorCommandShortcutDefinition[],
  t: Translate<"command">,
): readonly ResolvedEditorCommand[] {
  return catalog.map((command) => resolveEditorCommand(command, t));
}

export function resolveEditorCommand(
  command: EditorCommandShortcutDefinition,
  t: Translate<"command">,
): ResolvedEditorCommand {
  const category = t(`category.${command.categoryId}`);
  if (isEditorCustomCommand(command)) {
    return {
      ...command,
      // 名前はユーザー入力、説明は保存値ではなく毎回 action から組み立て直す
      // (UI に説明の入力欄が無いので、失われるユーザー入力は存在しない)。
      label: command.label,
      category,
      description: formatCustomCommandActionDescription(command.action, t),
      // シノニムはカタログ側の概念。ユーザーが作ったコマンドには無い。
      keywords: "",
    };
  }
  return {
    ...command,
    // `as never`: `EditorCommandId` は string なのでテンプレートリテラル型が効かず、
    // 辞書キーの静的検査に載せられない。網羅は `editor-command-shortcuts.test.ts` が
    // **`t()` 越しに**実行時で固定する (辞書オブジェクトを直接見ると生キーを見逃す)。
    label: t(`label.${command.id}` as never),
    category,
    description: t(`description.${command.id}` as never, { defaultValue: "" }) as string,
    keywords: t(`keywords.${command.id}` as never, { defaultValue: "" }) as string,
  };
}

export function isEditorCustomCommand(
  command: EditorCommandShortcutDefinition,
): command is EditorCustomCommandDefinition {
  return "custom" in command && (command as EditorCustomCommandDefinition).custom === true;
}

export function formatCustomCommandActionDescription(
  action: EditorCustomCommandAction,
  t: Translate<"command">,
): string {
  switch (action.type) {
    case "textFormat":
      return t("customAction.textFormat", { value: action.command });
    case "fontFamily":
      return action.value
        ? t("customAction.fontFamily", { value: action.value })
        : t("customAction.fontFamilyDefault");
    case "fontSize":
      return t("customAction.fontSize", { value: action.value });
    case "lineHeight":
      return t("customAction.lineHeight", { value: action.value });
    case "textAlign":
      return t("customAction.textAlign", { value: action.value });
    case "blockStyle":
      return t("customAction.blockStyle", { value: action.value });
    case "textColor":
      return t("customAction.textColor", { value: action.value });
    case "textBackgroundColor":
      return t("customAction.textBackgroundColor", { value: action.value });
    case "overlayStrokeColor":
      return action.value
        ? t("customAction.overlayStrokeColor", { value: action.value })
        : t("customAction.overlayStrokeColorNone");
    case "overlayFillColor":
      return action.value
        ? t("customAction.overlayFillColor", { value: action.value })
        : t("customAction.overlayFillColorNone");
    case "overlayLineDash":
      return t("customAction.overlayLineDash", { value: action.value });
    case "overlayLineWidth":
      return t("customAction.overlayLineWidth", { value: action.value });
  }
}

function parseEditorCustomCommand(value: unknown): EditorCustomCommandDefinition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && /^custom\.[a-z0-9._-]+$/i.test(record.id) ? record.id : null;
  const label = typeof record.label === "string" ? record.label.trim() : "";
  const action = parseEditorCustomCommandAction(record.action);
  if (!id || !label || !action) {
    return null;
  }

  // 保存済みの `description` は **読み捨てる**。表示のたびに action から組み立て直すので、
  // 既存ユーザーのカスタムコマンドも言語切替に追随する (UI に説明の入力欄は無い)。
  return {
    id: id as `custom.${string}`,
    label,
    categoryId: "custom",
    custom: true,
    action,
    defaultBinding: null,
  };
}

function parseEditorCustomCommandAction(value: unknown): EditorCustomCommandAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const action = value as Record<string, unknown>;
  if (action.type === "textFormat" && isOneOf(action.command, ["bold", "italic", "underline", "boxed"])) {
    return { type: "textFormat", command: action.command };
  }
  if (action.type === "fontFamily" && typeof action.value === "string") {
    return { type: "fontFamily", value: action.value };
  }
  if (action.type === "fontSize" && typeof action.value === "number" && Number.isFinite(action.value)) {
    return { type: "fontSize", value: clampNumber(action.value, 8, 96) };
  }
  if (action.type === "lineHeight" && typeof action.value === "string") {
    const lineHeight = normalizeLineHeight(action.value);
    return lineHeight ? { type: "lineHeight", value: lineHeight } : null;
  }
  if (action.type === "textAlign" && isOneOf(action.value, ["left", "center", "right", "justify"])) {
    return { type: "textAlign", value: action.value };
  }
  if (action.type === "blockStyle" && isOneOf(action.value, ["paragraph", "h1", "h2", "h3"])) {
    return { type: "blockStyle", value: action.value };
  }
  if (action.type === "textColor" && isCssHexColor(action.value)) {
    return { type: "textColor", value: action.value };
  }
  if (action.type === "textBackgroundColor" && isCssHexColor(action.value)) {
    return { type: "textBackgroundColor", value: action.value };
  }
  if (action.type === "overlayStrokeColor" && (action.value === null || isCssHexColor(action.value))) {
    return { type: "overlayStrokeColor", value: action.value };
  }
  if (action.type === "overlayFillColor" && (action.value === null || isCssHexColor(action.value))) {
    return { type: "overlayFillColor", value: action.value };
  }
  if (action.type === "overlayLineDash" && isOneOf(action.value, ["solid", "dashed", "dotted"])) {
    return { type: "overlayLineDash", value: action.value };
  }
  if (action.type === "overlayLineWidth" && isOneOf(action.value, ["s", "m", "l", "xl"])) {
    return { type: "overlayLineWidth", value: action.value };
  }

  return null;
}

function isOneOf<const Value extends string>(value: unknown, candidates: readonly Value[]): value is Value {
  return typeof value === "string" && candidates.includes(value as Value);
}

function isCssHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeShortcutBinding(binding: EditorShortcutBinding): EditorShortcutBinding {
  const normalized: EditorShortcutBinding = {
    key: normalizeShortcutKey(binding.key),
  };

  if (binding.primary) normalized.primary = true;
  if (binding.ctrl) normalized.ctrl = true;
  if (binding.meta) normalized.meta = true;
  if (binding.alt) normalized.alt = true;
  if (binding.shift) normalized.shift = true;
  return normalized;
}

function normalizeShortcutKey(key: string): string {
  const lower = key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

function shortcutBindingKey(binding: EditorShortcutBinding): string {
  const normalized = normalizeShortcutBinding(binding);
  const shift = normalized.key === "=" ? false : normalized.shift;
  return [
    normalized.primary ? "primary" : "",
    normalized.ctrl ? "ctrl" : "",
    normalized.meta ? "meta" : "",
    normalized.alt ? "alt" : "",
    shift ? "shift" : "",
    normalized.key,
  ].join("+");
}

function shortcutModifiersMatchEvent(
  binding: EditorShortcutBinding,
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
): boolean {
  if (event.altKey !== Boolean(binding.alt)) {
    return false;
  }

  const expectedShift = Boolean(binding.shift);
  if (event.shiftKey !== expectedShift && !allowsShiftedEqualFallback(binding, event)) {
    return false;
  }

  if (binding.primary) {
    const hasPrimary = event.ctrlKey || event.metaKey;
    if (!hasPrimary) {
      return false;
    }
    if (!binding.ctrl && !binding.meta && event.ctrlKey && event.metaKey) {
      return false;
    }
    if (binding.ctrl && !event.ctrlKey) {
      return false;
    }
    if (binding.meta && !event.metaKey) {
      return false;
    }
    return true;
  }

  return event.ctrlKey === Boolean(binding.ctrl) && event.metaKey === Boolean(binding.meta);
}

function allowsShiftedEqualFallback(
  binding: EditorShortcutBinding,
  event: Pick<KeyboardEvent, "key" | "shiftKey">,
): boolean {
  return binding.key === "=" && !binding.shift && event.shiftKey && getNormalizedEventKey(event) === "=";
}

function getEventKeyCandidates(
  event: Pick<KeyboardEvent, "code" | "key" | "shiftKey">,
): string[] {
  const eventKey = getNormalizedEventKey(event);
  const candidates = eventKey ? [eventKey] : [];

  if (eventKey.length === 1 && /^[\x20-\x7e]$/.test(eventKey)) {
    return candidates;
  }

  const physicalKey = PHYSICAL_KEY_MAP[event.code];
  if (physicalKey && !candidates.includes(physicalKey)) {
    candidates.push(physicalKey);
  }
  return candidates;
}

function getNormalizedEventKey(event: Pick<KeyboardEvent, "key" | "shiftKey">): string {
  const lower = normalizeShortcutKey(event.key);
  if (event.shiftKey && SHIFT_KEY_TO_BASE[lower]) {
    return SHIFT_KEY_TO_BASE[lower];
  }
  return lower;
}

function formatShortcutKey(key: string, shifted: boolean): string {
  if (key === "=" && shifted) {
    return "+";
  }
  if (KEY_LABELS[key]) {
    return KEY_LABELS[key];
  }
  if (/^f([1-9]|1\d|2[0-4])$/.test(key)) {
    return key.toUpperCase();
  }
  return key.length === 1 ? key.toUpperCase() : key;
}

function isPrimaryShortcutKeyPressed(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">,
  platform: EditorShortcutPlatform,
): boolean {
  if (platform === "mac") {
    return event.metaKey;
  }
  return event.ctrlKey || event.metaKey;
}

function isShortcutBindingLike(value: unknown): value is EditorShortcutBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<EditorShortcutBinding>;
  return (
    typeof candidate.key === "string" &&
    candidate.key.length > 0 &&
    candidate.key.length <= 24 &&
    isOptionalBoolean(candidate.primary) &&
    isOptionalBoolean(candidate.ctrl) &&
    isOptionalBoolean(candidate.meta) &&
    isOptionalBoolean(candidate.alt) &&
    isOptionalBoolean(candidate.shift)
  );
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function getNavigatorPlatform(): string {
  if (typeof navigator === "undefined") {
    return "";
  }
  return navigator.platform || navigator.userAgent || "";
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
