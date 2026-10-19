import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";

import {
  assignShortcutOverride,
  createAddedFontCommands,
  createEditorCustomCommandDefinition,
  findCommandByShortcut,
  findShortcutConflict,
  formatCustomCommandDescription,
  getEditorCommandCatalog,
  getShortcutForCommand,
  isEditorAddedFontCommand,
  parseEditorShortcutOverrides,
  resolveEditorCommand,
  resolveEditorCommandCatalog,
} from "@/lib/editor-command-shortcuts";

const fonts = [
  { id: "font_0123abcd", displayName: "しろくま明朝", cssFamily: "\"Sigma Custom Font font_0123abcd\"" },
  { id: "plugin-9f8e7d", displayName: "数研ゴシック", cssFamily: "\"Sigma Plugin Font 9f8e7d\"" },
];

describe("added font commands", () => {
  it("creates one font command per added font with a stable, storable id", () => {
    const commands = createAddedFontCommands([
      ...fonts,
      // 同じ書体が二重に来ても、壊れた行が来ても、1 書体 1 コマンドのまま。
      { ...fonts[0] },
      { id: "", displayName: "名前だけ", cssFamily: "\"X\"" },
      { id: "font_empty", displayName: "値なし", cssFamily: "  " },
      { id: "Font With Spaces", displayName: "", cssFamily: "\"Spaced\"" },
    ]);
    expect(commands.map((command) => command.id)).toEqual([
      "format.font.added.font_0123abcd",
      "format.font.added.plugin-9f8e7d",
      "format.font.added.font-with-spaces",
    ]);
    expect(commands[0]).toMatchObject({
      categoryId: "font",
      addedFont: true,
      fontLabel: "しろくま明朝",
      fontFamily: "\"Sigma Custom Font font_0123abcd\"",
      defaultBinding: null,
    });
    // 表示名が無ければ書体の値で読ませる (空の行を作らない)。
    expect(commands[2].fontLabel).toBe("\"Spaced\"");
    expect(commands.every(isEditorAddedFontCommand)).toBe(true);
  });

  it("keeps key assignments for added fonts when settings are read back, even before the fonts load", () => {
    const overrides = parseEditorShortcutOverrides(JSON.stringify({
      "format.font.added.plugin-9f8e7d": { key: "m", primary: true, alt: true },
      "format.font.added.font_0123abcd": null,
      "format.font.added.Bad Id": { key: "x" },
      "format.font.added.": { key: "y" },
    }));
    expect(overrides).toEqual({
      "format.font.added.plugin-9f8e7d": { key: "m", primary: true, alt: true },
      "format.font.added.font_0123abcd": null,
    });
  });

  it("finds, assigns and replaces keys across built-in, custom and added-font commands", () => {
    const fontCommands = createAddedFontCommands(fonts);
    const custom = createEditorCustomCommandDefinition({ label: "太字", actions: [{ type: "textFormat", command: "bold" }] });
    const runtime = [custom, ...fontCommands];
    expect(getEditorCommandCatalog(runtime).filter(isEditorAddedFontCommand)).toHaveLength(2);

    const binding = { key: "m", primary: true, alt: true };
    let overrides = assignShortcutOverride({}, fontCommands[1].id, binding, runtime);
    expect(getShortcutForCommand(overrides, fontCommands[1].id, runtime)).toEqual(binding);
    const event = { key: "m", code: "KeyM", metaKey: true, altKey: true, ctrlKey: false, shiftKey: false };
    expect(findCommandByShortcut(event, overrides, runtime, "mac")?.commandId).toBe(fontCommands[1].id);
    // 一覧に書体コマンドを渡さなければ (書体の読み込み前)、キーは何も起こさない。
    expect(findCommandByShortcut(event, overrides, [], "mac")).toBeNull();

    // 同じキーを別の書体へ付け替えると、前の書体からは外れる。
    expect(findShortcutConflict(overrides, fontCommands[0].id, binding, runtime)?.id).toBe(fontCommands[1].id);
    overrides = assignShortcutOverride(overrides, fontCommands[0].id, binding, runtime);
    expect(getShortcutForCommand(overrides, fontCommands[1].id, runtime)).toBeNull();
    expect(findCommandByShortcut(event, overrides, runtime, "mac")?.commandId).toBe(fontCommands[0].id);
  });

  it("names the command after the font in both locales without touching the 1:1 label table", () => {
    const [command] = createAddedFontCommands(fonts);
    expect(resolveEditorCommand(command, createTranslator("ja", "command"))).toMatchObject({
      label: "フォント: しろくま明朝",
      category: "フォント",
      description: "選択範囲のフォントを「しろくま明朝」にします",
    });
    expect(resolveEditorCommand(command, createTranslator("en", "command"))).toMatchObject({
      label: "Font: しろくま明朝",
      description: "Set the selected text to しろくま明朝",
    });
    const resolved = resolveEditorCommandCatalog(getEditorCommandCatalog(createAddedFontCommands(fonts)), createTranslator("ja", "command"));
    expect(resolved.filter((item) => item.label.startsWith("label.") || item.label.startsWith("addedFont."))).toEqual([]);
  });

  it("reads a custom command's font by its menu name instead of the CSS value", () => {
    const t = createTranslator("ja", "command");
    const actions = [{ type: "fontFamily" as const, value: fonts[1].cssFamily }];
    expect(formatCustomCommandDescription(actions, t)).toBe(`フォントを ${fonts[1].cssFamily} に変更`);
    expect(formatCustomCommandDescription(actions, t, {
      fontLabel: (value) => (value === fonts[1].cssFamily ? fonts[1].displayName : undefined),
    })).toBe("フォントを 数研ゴシック に変更");
  });
});
