import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isAiWebSearchEnabled,
  readDesktopEditorPreferences,
  readDesktopSettingsSync,
  readNewDocumentPageSetup,
  writeDesktopSettings,
} from "./desktop-settings";
import { getDefaultPageLayout } from "@/features/document";

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

  it("keeps keys assigned to added fonts' commands across a save and reload", async () => {
    await writeDesktopSettings(dir, {
      commandShortcuts: {
        "format.font.added.plugin-9f8e7d": { primary: true, alt: true, key: "m" },
        "format.font.added.font_0123abcd": null,
      },
    });

    expect(readDesktopSettingsSync(dir).commandShortcuts).toEqual({
      "format.font.added.plugin-9f8e7d": { primary: true, alt: true, key: "m" },
      "format.font.added.font_0123abcd": null,
    });
  });

  it("remembers the page setup for new materials and forgets it on null", async () => {
    await writeDesktopSettings(dir, { codexBin: "/usr/local/bin/codex" });
    await writeDesktopSettings(dir, {
      newDocumentPageSetup: {
        pageLayout: { ...getDefaultPageLayout("B5"), marginsMm: { top: 10, right: 10, bottom: 10, left: 10 } },
        headingNumbering: { enabled: true },
      },
    });

    expect(readNewDocumentPageSetup(dir)).toMatchObject({
      pageLayout: { preset: "B5", marginsMm: { top: 10, right: 10, bottom: 10, left: 10 } },
      headingNumbering: { enabled: true },
    });
    expect(readDesktopSettingsSync(dir).codexBin).toBe("/usr/local/bin/codex");
    expect(readDesktopEditorPreferences(dir)).toEqual({ fontFamily: null });

    await writeDesktopSettings(dir, { newDocumentPageSetup: undefined });
    expect(readNewDocumentPageSetup(dir)).toBeNull();
    expect(readDesktopSettingsSync(dir).codexBin).toBe("/usr/local/bin/codex");
  });

  it("never remembers a whiteboard or a corrupt page setup", async () => {
    await writeDesktopSettings(dir, { newDocumentPageSetup: { pageLayout: getDefaultPageLayout("whiteboard") } });
    expect(readNewDocumentPageSetup(dir)).toBeNull();

    await writeFile(path.join(dir, "settings.json"), JSON.stringify({ codexBin: "/bin/codex", newDocumentPageSetup: { pageLayout: "B5" } }));
    expect(readNewDocumentPageSetup(dir)).toBeNull();
    expect(readDesktopSettingsSync(dir)).toEqual({ codexBin: "/bin/codex" });
  });

  it("drops header images rather than letting the settings file grow without bound", async () => {
    const hugeLogo = `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`;
    const layout = getDefaultPageLayout("A4");
    await writeDesktopSettings(dir, {
      newDocumentPageSetup: {
        pageLayout: {
          ...layout,
          header: {
            ...layout.header!,
            enabled: true,
            blocks: [{ type: "paragraph", id: "school", children: [{ type: "text", text: "○○高校" }] }],
            overlay: { overlaySnapshot: { version: 1, shapes: [{ id: "logo", type: "image", x: 0, y: 0, rotation: 0, props: { assetId: "asset_logo", w: 10, h: 10 } }], assets: { asset_logo: { id: "asset_logo", type: "image", props: { w: 10, h: 10, name: "logo", isAnimated: false, mimeType: "image/png", src: hugeLogo, fileSize: 1 } } } } },
          },
        },
      },
    });

    const remembered = readNewDocumentPageSetup(dir);
    expect(remembered?.pageLayout.header?.blocks).toEqual([{ type: "paragraph", id: "school", children: [{ type: "text", text: "○○高校" }] }]);
    expect(remembered?.pageLayout.header?.overlay).toBeUndefined();
    expect((await readFile(path.join(dir, "settings.json"), "utf8")).length).toBeLessThan(64 * 1024);
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

  it("keeps complete large font catalogs across save, reopening and unrelated settings writes", async () => {
    const fonts = Array.from({ length: 512 }, (_, index) => {
      const hash = index.toString(16).padStart(64, "0");
      return { id: `plugin-${hash}`, displayName: `Font ${index}`, fileName: `plugin-${hash}.ttf`,
        cssFamily: `"Sigma Plugin Font ${hash}"`, importedAt: "2026-10-19T00:00:00.000Z" };
    });
    await writeDesktopSettings(dir, { customFonts: fonts });
    expect(readDesktopSettingsSync(dir).customFonts).toEqual(fonts);
    await writeDesktopSettings(dir, { editorFontFamily: fonts.at(-1)!.cssFamily });
    expect(readDesktopSettingsSync(dir).customFonts).toEqual(fonts);
    expect(JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8")).customFonts).toHaveLength(512);
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
