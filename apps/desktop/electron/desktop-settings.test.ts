import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isAiWebSearchEnabled,
  readDesktopEditorPreferences,
  readDesktopSettingsSync,
  writeDesktopSettings,
} from "./desktop-settings";

describe("desktop-settings", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "sigma-desktop-settings-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists the editor font family without dropping existing settings", async () => {
    await writeDesktopSettings(dir, {
      codexBin: "/usr/local/bin/codex",
      claudeBin: "/usr/local/bin/claude",
      antigravityBin: "/usr/local/bin/agy",
    });
    await writeDesktopSettings(dir, {
      editorFontFamily: '"Yu Mincho", YuMincho, serif',
    });

    expect(readDesktopSettingsSync(dir)).toEqual({
      codexBin: "/usr/local/bin/codex",
      claudeBin: "/usr/local/bin/claude",
      antigravityBin: "/usr/local/bin/agy",
      editorFontFamily: '"Yu Mincho", YuMincho, serif',
    });
    expect(readDesktopEditorPreferences(dir)).toEqual({
      fontFamily: '"Yu Mincho", YuMincho, serif',
    });
  });

  it("persists command settings without dropping existing settings", async () => {
    await writeDesktopSettings(dir, {
      codexBin: "/usr/local/bin/codex",
      antigravityBin: "/usr/local/bin/agy",
      commandShortcuts: {
        "custom.yu-mincho": { primary: true, alt: true, key: "y" },
      },
      customCommands: [
        {
          id: "custom.yu-mincho",
          label: "游明朝にする",
          action: { type: "fontFamily", value: '"Yu Mincho", serif' },
        },
      ],
    });

    expect(readDesktopSettingsSync(dir)).toMatchObject({
      codexBin: "/usr/local/bin/codex",
      antigravityBin: "/usr/local/bin/agy",
      commandShortcuts: {
        "custom.yu-mincho": { primary: true, alt: true, key: "y" },
      },
      customCommands: [
        expect.objectContaining({
          id: "custom.yu-mincho",
          label: "游明朝にする",
        }),
      ],
    });
  });

  it("clears an invalid editor font family without clearing other settings", async () => {
    await writeDesktopSettings(dir, {
      codexBin: "/usr/local/bin/codex",
      antigravityBin: "/usr/local/bin/agy",
      editorFontFamily: '"Hiragino Mincho ProN", serif',
    });
    await writeDesktopSettings(dir, { editorFontFamily: "" });

    expect(readDesktopSettingsSync(dir)).toEqual({
      codexBin: "/usr/local/bin/codex",
      antigravityBin: "/usr/local/bin/agy",
    });
    expect(readDesktopEditorPreferences(dir)).toEqual({ fontFamily: null });
  });

  it("persists custom fonts and filters invalid entries", async () => {
    await writeDesktopSettings(dir, {
      codexBin: "/usr/local/bin/codex",
      customFonts: [
        {
          id: "font_valid",
          displayName: "Windows Mincho",
          fileName: "font_valid-windows-mincho.ttf",
          cssFamily: '"Sigma Custom Font font_valid"',
          importedAt: "2026-07-09T00:00:00.000Z",
        },
        {
          id: "../bad",
          displayName: "",
          fileName: "../bad.ttf",
          cssFamily: "",
          importedAt: "",
        },
      ],
    });

    expect(readDesktopSettingsSync(dir)).toEqual({
      codexBin: "/usr/local/bin/codex",
      customFonts: [
        {
          id: "font_valid",
          displayName: "Windows Mincho",
          fileName: "font_valid-windows-mincho.ttf",
          cssFamily: '"Sigma Custom Font font_valid"',
          importedAt: "2026-07-09T00:00:00.000Z",
        },
      ],
    });

    await writeDesktopSettings(dir, { customFonts: [] });

    expect(readDesktopSettingsSync(dir)).toEqual({
      codexBin: "/usr/local/bin/codex",
    });
  });

  it("persists aiAutoApplyVerifiedProposals and omits the key when false", async () => {
    await writeDesktopSettings(dir, {
      codexBin: "/usr/local/bin/codex",
      aiAutoApplyVerifiedProposals: true,
    });

    expect(readDesktopSettingsSync(dir)).toEqual({
      codexBin: "/usr/local/bin/codex",
      aiAutoApplyVerifiedProposals: true,
    });

    await writeDesktopSettings(dir, { aiAutoApplyVerifiedProposals: false });

    expect(readDesktopSettingsSync(dir)).toEqual({
      codexBin: "/usr/local/bin/codex",
    });
  });

  it("defaults aiAutoApplyVerifiedProposals to absent (falsy) when never set", async () => {
    await writeDesktopSettings(dir, { codexBin: "/usr/local/bin/codex" });

    const settings = readDesktopSettingsSync(dir);
    expect(settings.aiAutoApplyVerifiedProposals).toBeUndefined();
  });

  it("persists aiWebSearchEnabled only when false, and omits the key for the default (true)", async () => {
    await writeDesktopSettings(dir, {
      codexBin: "/usr/local/bin/codex",
      aiWebSearchEnabled: false,
    });

    expect(readDesktopSettingsSync(dir)).toEqual({
      codexBin: "/usr/local/bin/codex",
      aiWebSearchEnabled: false,
    });
    expect(isAiWebSearchEnabled(readDesktopSettingsSync(dir))).toBe(false);

    // 既定値 (true) を書くとキーごと消える (aiAutoApplyVerifiedProposals と極性が逆)。
    await writeDesktopSettings(dir, { aiWebSearchEnabled: true });

    expect(readDesktopSettingsSync(dir)).toEqual({
      codexBin: "/usr/local/bin/codex",
    });
    expect(isAiWebSearchEnabled(readDesktopSettingsSync(dir))).toBe(true);
  });

  it("treats an absent aiWebSearchEnabled key (including a missing settings.json) as enabled", async () => {
    // settings.json が存在しないディレクトリでも有効扱い。
    expect(isAiWebSearchEnabled(readDesktopSettingsSync(dir))).toBe(true);

    await writeDesktopSettings(dir, { codexBin: "/usr/local/bin/codex" });

    const settings = readDesktopSettingsSync(dir);
    expect(settings.aiWebSearchEnabled).toBeUndefined();
    expect(isAiWebSearchEnabled(settings)).toBe(true);
  });

  it("reads the legacy geminiBin setting as the Antigravity CLI path", async () => {
    await writeDesktopSettings(dir, {
      codexBin: "/usr/local/bin/codex",
    });
    await writeFile(
      path.join(dir, "settings.json"),
      `${JSON.stringify({ codexBin: "/usr/local/bin/codex", geminiBin: "/usr/local/bin/agy" }, null, 2)}\n`,
      "utf8",
    );

    expect(readDesktopSettingsSync(dir)).toEqual({
      codexBin: "/usr/local/bin/codex",
      antigravityBin: "/usr/local/bin/agy",
    });
  });

  it("persists the UI locale without dropping existing settings", async () => {
    await writeDesktopSettings(dir, { codexBin: "/usr/local/bin/codex" });
    await writeDesktopSettings(dir, { uiLocale: "en" });

    expect(readDesktopSettingsSync(dir)).toEqual({
      codexBin: "/usr/local/bin/codex",
      uiLocale: "en",
    });
  });

  it("persists an explicit Japanese choice instead of dropping the key", async () => {
    // 他の既定値と違い、キーの不在は「まだ選んでいない」を意味する (OSロケール検出に
    // 委ねる)。既定値だからと消すと、英語OSで日本語を選んでも次回起動で英語に戻る。
    await writeDesktopSettings(dir, { uiLocale: "en" });
    await writeDesktopSettings(dir, { uiLocale: "ja" });

    const raw = JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(raw.uiLocale).toBe("ja");
    expect(readDesktopSettingsSync(dir).uiLocale).toBe("ja");
  });

  it("leaves uiLocale absent until a language is actually chosen", async () => {
    await writeDesktopSettings(dir, { codexBin: "/usr/local/bin/codex" });

    const raw = JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    expect("uiLocale" in raw).toBe(false);
    expect(readDesktopSettingsSync(dir).uiLocale).toBeUndefined();
  });

  it("ignores an unsupported stored uiLocale", async () => {
    await writeFile(
      path.join(dir, "settings.json"),
      `${JSON.stringify({ uiLocale: "xx" }, null, 2)}\n`,
      "utf8",
    );

    expect(readDesktopSettingsSync(dir).uiLocale).toBeUndefined();
  });

  it("normalizes a stored regional uiLocale tag", async () => {
    await writeFile(
      path.join(dir, "settings.json"),
      `${JSON.stringify({ uiLocale: "en-US" }, null, 2)}\n`,
      "utf8",
    );

    expect(readDesktopSettingsSync(dir).uiLocale).toBe("en");
  });

  it("clears the uiLocale key when an unsupported value is written", async () => {
    await writeDesktopSettings(dir, { uiLocale: "en" });
    await writeDesktopSettings(dir, { uiLocale: "xx" as never });

    expect(readDesktopSettingsSync(dir).uiLocale).toBeUndefined();
  });
});
