import { describe, expect, it } from "vitest";

import {
  EDITOR_COMMAND_SHORTCUTS,
  formatShortcutText,
  getShortcutForCommand,
  resolveEditorCommandCatalog,
} from "@/lib/editor-command-shortcuts";
import { createTranslator } from "@/lib/i18n";

import {
  buildPaletteEntries,
  filterPaletteEntries,
  flattenPaletteGroups,
  groupPaletteEntries,
  normalizeForSearch,
  scorePaletteEntry,
  type PaletteEntry,
} from "./command-palette-model";

function entriesFor(locale: "ja" | "en"): readonly PaletteEntry[] {
  const tCommand = createTranslator(locale, "command");
  const tSettings = createTranslator(locale, "settings");
  return buildPaletteEntries({
    commands: resolveEditorCommandCatalog(EDITOR_COMMAND_SHORTCUTS, tCommand),
    resolveShortcut: (commandId) => getShortcutForCommand({}, commandId),
    formatShortcut: (binding) => formatShortcutText(binding, "mac"),
    translateSetting: (key) => tSettings(key as never) as string,
    settingsGroupLabel: tCommand("palette.groupSetting"),
    hiddenCommandIds: ["view.commandPalette"],
  });
}

describe("command palette model", () => {
  it("includes both commands and settings", () => {
    const entries = entriesFor("ja");
    expect(entries.some((entry) => entry.kind === "command")).toBe(true);
    expect(entries.some((entry) => entry.kind === "setting")).toBe(true);
    // パレット自身は候補に出さない (開いている状態でもう一度出ても意味がない)。
    expect(entries.some((entry) => entry.id === "view.commandPalette")).toBe(false);
  });

  it("puts the PDF preview command first for `pdf`", () => {
    const filtered = filterPaletteEntries(entriesFor("ja"), "pdf", "ja");
    expect(filtered[0]?.id).toBe("view.printPreview");
  });

  it("finds the language setting by its Japanese name", () => {
    const filtered = filterPaletteEntries(entriesFor("ja"), "言語", "ja");
    expect(filtered.map((entry) => entry.id)).toContain("settings.app.language");
  });

  it("finds the language setting by its English name in English", () => {
    const filtered = filterPaletteEntries(entriesFor("en"), "language", "en");
    expect(filtered.map((entry) => entry.id)).toContain("settings.app.language");
  });

  it("searches the commands in the current UI language", () => {
    // 英語ロケールでは英語で探せること (受入基準)。日本語のままだと当たらない。
    expect(filterPaletteEntries(entriesFor("en"), "bold", "en")[0]?.id).toBe("edit.bold");
    expect(filterPaletteEntries(entriesFor("ja"), "太字", "ja")[0]?.id).toBe("edit.bold");
  });

  it("matches full-width input", () => {
    // 日本語入力のまま打つ事故は普通に起きる。
    expect(normalizeForSearch("ｆｏｎｔ", "en")).toBe("font");
    const wide = filterPaletteEntries(entriesFor("en"), "ｆｏｎｔ", "en");
    const half = filterPaletteEntries(entriesFor("en"), "font", "en");
    // 全角で打っても半角と同じ結果になること (順序込み)。
    expect(wide.map((entry) => entry.id)).toEqual(half.map((entry) => entry.id));
    expect(wide[0]?.label.toLowerCase()).toContain("font");
  });

  it("returns everything for an empty query, in catalog order", () => {
    const entries = entriesFor("ja");
    const filtered = filterPaletteEntries(entries, "   ", "ja");
    expect(filtered).toHaveLength(entries.length);
    expect(filtered[0]?.id).toBe(entries[0]?.id);
  });

  it("keeps both same-named commands, told apart by their group", () => {
    // `ai.resources` と `settings.aiAccount` はどちらも「AI設定を開く」。
    const filtered = filterPaletteEntries(entriesFor("ja"), "AI設定を開く", "ja");
    const ids = filtered.map((entry) => entry.id);
    expect(ids).toContain("ai.resources");
    expect(ids).toContain("settings.aiAccount");
    const groups = filtered
      .filter((entry) => entry.id === "ai.resources" || entry.id === "settings.aiAccount")
      .map((entry) => entry.group);
    expect(new Set(groups).size).toBe(2);
  });

  it("ranks an exact label above a partial match", () => {
    const exact = scorePaletteEntry(
      { kind: "command", id: "a", label: "太字", groupId: "textFormat", group: "文字書式", shortcut: null },
      "太字",
      "ja",
    );
    const partial = scorePaletteEntry(
      { kind: "command", id: "b", label: "太字にする", groupId: "textFormat", group: "文字書式", shortcut: null },
      "太字",
      "ja",
    );
    expect(exact).toBeGreaterThan(partial);
  });

  it("carries the shortcut label for bound commands", () => {
    const undo = entriesFor("ja").find((entry) => entry.id === "edit.undo");
    expect(undo?.kind).toBe("command");
    expect(undo?.kind === "command" ? undo.shortcut : null).toBeTruthy();
  });

  it("carries the settings surface so the palette can open the right dialog", () => {
    const language = entriesFor("ja").find((entry) => entry.id === "settings.app.language");
    expect(language?.kind).toBe("setting");
    expect(language?.kind === "setting" ? language.surface : null).toBe("desktopApp");
    expect(language?.kind === "setting" ? language.anchorId : null).toBe("desktop-settings-language-row");
  });

  it("groups entries in first-seen order", () => {
    const groups = groupPaletteEntries(filterPaletteEntries(entriesFor("ja"), "", "ja"));
    expect(groups.length).toBeGreaterThan(1);
    expect(groups[0]?.group).toBe("編集");
    expect(groups.at(-1)?.group).toBe("設定項目");
  });

  it("drops entries that match nothing", () => {
    expect(filterPaletteEntries(entriesFor("ja"), "zzzznotacommand", "ja")).toHaveLength(0);
  });

  it("keeps the ↑↓ order identical to the rendered order", () => {
    // ここがずれると ArrowDown が画面の行を飛ばす。絞り込み結果 (= 選択の出典) と
    // グループ化して平坦に戻したもの (= 画面の並び) は、常に同じ列でなければならない。
    for (const query of ["", "図形", "せ", "font", "ai"]) {
      const filtered = filterPaletteEntries(entriesFor("ja"), query, "ja");
      const rendered = flattenPaletteGroups(groupPaletteEntries(filtered));
      expect(rendered.map((entry) => entry.id), `query=${query}`).toEqual(filtered.map((entry) => entry.id));
      // グループは連続していること (同じ見出しが 2 度出ない)。
      const groupIds = groupPaletteEntries(filtered).map((group) => group.groupId);
      expect(new Set(groupIds).size, `query=${query}`).toBe(groupIds.length);
    }
  });

  it("finds a command by a synonym that is not in its label", () => {
    // 「印刷」は PDF プレビューのラベルにも説明にも出てこない語。
    const ja = filterPaletteEntries(entriesFor("ja"), "印刷", "ja").map((entry) => entry.id);
    expect(ja).toContain("view.printPreview");
    const en = filterPaletteEntries(entriesFor("en"), "print", "en").map((entry) => entry.id);
    expect(en).toContain("view.printPreview");
  });

  it("folds katakana so the query works before conversion", () => {
    const katakana = filterPaletteEntries(entriesFor("ja"), "プレビュー", "ja").map((entry) => entry.id);
    const hiragana = filterPaletteEntries(entriesFor("ja"), "ぷれびゅー", "ja").map((entry) => entry.id);
    expect(hiragana).toEqual(katakana);
    expect(katakana).toContain("view.printPreview");
  });

  it("drops settings surfaces the host cannot open", () => {
    const tCommand = createTranslator("ja", "command");
    const tSettings = createTranslator("ja", "settings");
    const embedded = buildPaletteEntries({
      commands: [],
      resolveShortcut: () => null,
      formatShortcut: () => "",
      translateSetting: (key) => tSettings(key as never) as string,
      settingsGroupLabel: tCommand("palette.groupSetting"),
      isSettingsSurfaceAvailable: (surface) => surface !== "desktopApp",
    });
    expect(embedded.some((entry) => entry.id === "settings.app.language")).toBe(false);
    expect(embedded.length).toBeGreaterThan(0);
  });

  it("keeps command ids and settings ids disjoint", () => {
    // 衝突すると DOM id が重複し、2 行が同時にハイライトされる。
    const entries = entriesFor("ja");
    const ids = entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
