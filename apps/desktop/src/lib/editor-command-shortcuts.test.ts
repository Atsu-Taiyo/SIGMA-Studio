import { describe, expect, it } from "vitest";

import { COMMAND_PALETTE_BINDING, PRINT_PREVIEW_BINDING } from "@/lib/editor-command-bindings";
import { createTranslator } from "@/lib/i18n";
import { command as enCommand } from "@/lib/i18n/dictionaries/en/command";
import { command as jaCommand } from "@/lib/i18n/dictionaries/ja/command";

import {
  assignShortcutOverride,
  clearShortcutOverride,
  detectEditorShortcutPlatform,
  EDITOR_COMMAND_SHORTCUTS,
  findCommandByShortcut,
  formatCustomCommandActionDescription,
  formatShortcutText,
  getShortcutForCommand,
  parseEditorCustomCommands,
  parseEditorShortcutOverrides,
  resolveEditorCommandCatalog,
  type ResolvedEditorCommand,
  shouldDispatchOverlayArrangeShortcut,
  shortcutBindingFromEvent,
} from "@/lib/editor-command-shortcuts";

describe("editor command shortcuts", () => {
  it("keeps the expanded command catalog unique and broad enough for classroom editing", () => {
    const ids = EDITOR_COMMAND_SHORTCUTS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(EDITOR_COMMAND_SHORTCUTS.length).toBeGreaterThanOrEqual(100);
    expect(EDITOR_COMMAND_SHORTCUTS.some((command) => command.id === "format.font.yuMincho")).toBe(true);
    expect(EDITOR_COMMAND_SHORTCUTS.some((command) => command.id === "overlay.text")).toBe(true);
    expect(EDITOR_COMMAND_SHORTCUTS.some((command) => command.id === "overlay.align.middle")).toBe(true);
    expect(EDITOR_COMMAND_SHORTCUTS.some((command) => command.id === "overlay.fill.yellow")).toBe(true);
  });

  it("resolves a real label for every command id through t(), in both locales", () => {
    // **辞書オブジェクトを直接見てはいけない。** 「辞書に書いてある」ことと
    // 「画面に出るときに引ける」ことは別で、i18next のキー解決は途中で
    // オブジェクトに当たると打ち切るため、書いてあるのに引けない id が生まれる
    // (実測: 入れ子構造だと `overlay.line.solid` 系 11 件が日英とも生キーになった)。
    // ここは必ず resolve 経路を通す。
    for (const locale of ["ja", "en"] as const) {
      const resolved = resolveEditorCommandCatalog(
        EDITOR_COMMAND_SHORTCUTS,
        createTranslator(locale, "command"),
      );
      const broken = resolved
        .filter((command) => !command.label || command.label === `label.${command.id}`)
        .map((command) => command.id);
      expect(broken, `${locale} で label が引けない`).toEqual([]);
      // カテゴリ名も同じ経路。こちらが生キーだとグループ見出しが壊れる。
      const brokenCategory = resolved
        .filter((command) => !command.category || command.category === `category.${command.categoryId}`)
        .map((command) => command.id);
      expect(brokenCategory, `${locale} で category が引けない`).toEqual([]);
      // 説明は任意だが、書いてあるなら引けること (生キーを漏らさない)。
      const brokenDescription = resolved
        .filter((command) => command.description === `description.${command.id}`)
        .map((command) => command.id);
      expect(brokenDescription, `${locale} で description が生キー`).toEqual([]);
    }
  });

  it("has no dictionary entry without a command", () => {
    // 逆向き。コマンドを消したのに辞書に残ると、パレットに «実行できない項目» が並ぶ。
    const ids = new Set(EDITOR_COMMAND_SHORTCUTS.map((command) => command.id));
    for (const dictionary of [jaCommand, enCommand]) {
      expect(Object.keys(dictionary.label).filter((id) => !ids.has(id))).toEqual([]);
      expect(Object.keys(dictionary.description).filter((id) => !ids.has(id))).toEqual([]);
    }
  });

  it("keeps every categoryId inside the declared union", () => {
    const known = new Set(Object.keys(jaCommand.category));
    const unknown = [...new Set(EDITOR_COMMAND_SHORTCUTS.map((command) => command.categoryId))]
      .filter((categoryId) => !known.has(categoryId));
    expect(unknown).toEqual([]);
  });

  it("resolves labels in the current locale", () => {
    const ja = resolveEditorCommandCatalog(EDITOR_COMMAND_SHORTCUTS, createTranslator("ja", "command"));
    const en = resolveEditorCommandCatalog(EDITOR_COMMAND_SHORTCUTS, createTranslator("en", "command"));
    const findLabel = (catalog: readonly ResolvedEditorCommand[], id: string) =>
      catalog.find((command) => command.id === id);
    expect(findLabel(ja, "edit.bold")?.label).toBe("太字");
    expect(findLabel(en, "edit.bold")?.label).toBe("Bold");
    expect(findLabel(ja, "edit.bold")?.category).toBe("文字書式");
    expect(findLabel(en, "edit.bold")?.category).toBe("Text format");
    // 説明の無いコマンドは空文字 (生キーを漏らさない)。
    expect(findLabel(en, "view.zoomIn")?.description).toBe("");
  });

  it("keeps the command palette and the PDF preview on different keys", () => {
    // ⌘P の取り合いは 2 定数で決まる (editor-command-bindings.ts)。
    const palette = EDITOR_COMMAND_SHORTCUTS.find((command) => command.id === "view.commandPalette");
    const print = EDITOR_COMMAND_SHORTCUTS.find((command) => command.id === "view.printPreview");
    // 定数をそのまま参照している (カタログが自前の値を書いていないこと)。
    expect(palette?.defaultBinding).toBe(COMMAND_PALETTE_BINDING);
    expect(print?.defaultBinding).toBe(PRINT_PREVIEW_BINDING);
    expect(formatShortcutText(palette?.defaultBinding ?? null, "windows"))
      .not.toBe(formatShortcutText(print?.defaultBinding ?? null, "windows"));
  });

  it("does not ship duplicate default shortcut bindings", () => {
    const defaults = EDITOR_COMMAND_SHORTCUTS
      .map((command) => command.defaultBinding && formatShortcutText(command.defaultBinding, "windows"))
      .filter((binding): binding is string => Boolean(binding));
    const duplicate = defaults.find((binding, index) => (
      defaults.findIndex((otherBinding) => otherBinding === binding) !== index
    ));

    expect(duplicate).toBeUndefined();
  });

  it("matches default primary shortcuts", () => {
    expect(findCommandByShortcut(keyEvent({ key: "z", metaKey: true }), {})?.commandId).toBe("edit.undo");
    expect(findCommandByShortcut(keyEvent({ key: "Z", metaKey: true, shiftKey: true }), {})?.commandId).toBe("edit.redo");
    expect(findCommandByShortcut(keyEvent({ key: "=", ctrlKey: true }), {})?.commandId).toBe("view.zoomIn");
    expect(findCommandByShortcut(keyEvent({ key: "+", ctrlKey: true, shiftKey: true }), {})?.commandId).toBe("view.zoomIn");
    expect(findCommandByShortcut(keyEvent({ key: "b", metaKey: true }), {})?.commandId).toBe("view.toggleOutline");
    expect(findCommandByShortcut(keyEvent({ key: "i", metaKey: true }), {})?.commandId).toBe("edit.italic");
    expect(findCommandByShortcut(keyEvent({ key: "d", metaKey: true }), {})?.commandId).toBe("overlay.duplicate");
    expect(findCommandByShortcut(keyEvent({ key: "ArrowUp", metaKey: true, shiftKey: true }), {})?.commandId)
      .toBe("overlay.arrange.front");
  });

  it("does not claim arrange shortcuts without an editable overlay selection", () => {
    expect(shouldDispatchOverlayArrangeShortcut("overlay.arrange.front", {
      hasUnlockedOverlaySelection: false,
      editingOverlayTextOrTable: false,
      editingTextTarget: false,
    })).toBe(false);
    expect(shouldDispatchOverlayArrangeShortcut("overlay.arrange.front", {
      hasUnlockedOverlaySelection: true,
      editingOverlayTextOrTable: true,
      editingTextTarget: false,
    })).toBe(false);
    expect(shouldDispatchOverlayArrangeShortcut("overlay.arrange.front", {
      hasUnlockedOverlaySelection: true,
      editingOverlayTextOrTable: false,
      editingTextTarget: true,
    })).toBe(false);
    expect(shouldDispatchOverlayArrangeShortcut("overlay.arrange.front", {
      hasUnlockedOverlaySelection: true,
      editingOverlayTextOrTable: false,
      editingTextTarget: false,
    })).toBe(true);
  });

  it("records platform primary keys and formats them for display", () => {
    const macBinding = shortcutBindingFromEvent(keyEvent({ key: "k", metaKey: true, altKey: true }), "mac");
    const windowsBinding = shortcutBindingFromEvent(keyEvent({ key: "k", ctrlKey: true, shiftKey: true }), "windows");

    expect(macBinding).toEqual({ primary: true, alt: true, key: "k" });
    expect(windowsBinding).toEqual({ primary: true, shift: true, key: "k" });
    expect(formatShortcutText(macBinding, "mac")).toBe("⌘⌥K");
    expect(formatShortcutText(windowsBinding, "windows")).toBe("Ctrl+Shift+K");
  });

  it("clears conflicting assignments when assigning a shortcut", () => {
    const overrides = assignShortcutOverride({}, "insert.heading", { primary: true, key: "z" });

    expect(getShortcutForCommand(overrides, "insert.heading")).toEqual({ primary: true, key: "z" });
    expect(getShortcutForCommand(overrides, "edit.undo")).toBeNull();

    const shiftedEqualOverrides = assignShortcutOverride({}, "insert.problem", { primary: true, shift: true, key: "=" });
    expect(getShortcutForCommand(shiftedEqualOverrides, "insert.problem")).toEqual({ primary: true, shift: true, key: "=" });
    expect(getShortcutForCommand(shiftedEqualOverrides, "view.zoomIn")).toBeNull();
  });

  it("can clear and parse saved overrides", () => {
    const overrides = clearShortcutOverride({}, "overlay.graph");
    const parsed = parseEditorShortcutOverrides(JSON.stringify({
      ...overrides,
      "overlay.text": { key: "x", shift: true },
      unknown: { key: "q" },
    }));

    expect(getShortcutForCommand(parsed, "overlay.graph")).toBeNull();
    expect(getShortcutForCommand(parsed, "overlay.text")).toEqual({ shift: true, key: "x" });
    expect(findCommandByShortcut(keyEvent({ key: "G" }), parsed)).toBeNull();
  });

  it("loads custom commands and includes them in assignment and shortcut lookup", () => {
    const customCommands = parseEditorCustomCommands(JSON.stringify([
      {
        id: "custom.yu-mincho",
        label: "游明朝にする",
        action: { type: "fontFamily", value: "\"Yu Mincho\", serif" },
      },
      { id: "custom.bad", label: "", action: { type: "fontSize", value: 16 } },
    ]));

    expect(customCommands).toHaveLength(1);
    // 説明は保存値ではなく action から組み立て直す (保存済み JSON にあっても読み捨てる)。
    expect(formatCustomCommandActionDescription(customCommands[0].action, createTranslator("ja", "command")))
      .toContain("Yu Mincho");

    const overrides = assignShortcutOverride(
      {},
      "custom.yu-mincho",
      { primary: true, alt: true, key: "m" },
      customCommands,
    );

    expect(getShortcutForCommand(overrides, "custom.yu-mincho", customCommands)).toEqual({
      primary: true,
      alt: true,
      key: "m",
    });
    expect(findCommandByShortcut(keyEvent({ key: "m", metaKey: true, altKey: true }), overrides, customCommands)?.commandId)
      .toBe("custom.yu-mincho");
  });

  it("normalizes custom line-height commands and drops invalid values", () => {
    const customCommands = parseEditorCustomCommands(JSON.stringify([
      {
        id: "custom.line-height-valid",
        label: "行間を少し広げる",
        action: { type: "lineHeight", value: "1.20" },
      },
      {
        id: "custom.line-height-too-small",
        label: "行間を狭くしすぎる",
        action: { type: "lineHeight", value: "0.2" },
      },
      {
        id: "custom.line-height-too-large",
        label: "行間を広げすぎる",
        action: { type: "lineHeight", value: "999" },
      },
    ]));

    expect(customCommands).toHaveLength(1);
    expect(customCommands[0].action).toEqual({ type: "lineHeight", value: "1.2" });
  });

  it("detects the shortcut platform from navigator platform text", () => {
    expect(detectEditorShortcutPlatform("MacIntel")).toBe("mac");
    expect(detectEditorShortcutPlatform("Win32")).toBe("windows");
    expect(detectEditorShortcutPlatform("Linux x86_64")).toBe("other");
  });
});

function keyEvent({
  key,
  code = "",
  altKey = false,
  ctrlKey = false,
  metaKey = false,
  shiftKey = false,
}: {
  key: string;
  code?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey"> {
  return {
    altKey,
    code,
    ctrlKey,
    key,
    metaKey,
    shiftKey,
  };
}
