import { app, ipcMain, dialog, shell, type BrowserWindow, type OpenDialogOptions } from "electron";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

import type { AppUpdateController } from "../app-updater";
import {
  normalizeEditorFontFamily,
  readDesktopEditorPreferences,
  readDesktopSettingsSync,
  writeDesktopSettings,
  type DesktopCustomFont,
} from "../desktop-settings";
import { restorePreviousInputSource, switchToAsciiInputSource } from "../input-source";

const te = createCurrentLocaleTranslator("error");

const FONT_FILE_EXTENSIONS = new Set([".ttf", ".otf", ".woff", ".woff2", ".ttc"]);

interface DesktopCustomFontForRenderer extends DesktopCustomFont {
  url: string;
}

export interface RegisterAppIpcDeps {
  getMainWindow: () => BrowserWindow | null;
  releaseUrl: string;
  dataDir: string;
  appUpdateController: AppUpdateController;
  quitAndInstall?: () => ReturnType<AppUpdateController["quitAndInstall"]>;
}

export function registerAppIpc(deps: RegisterAppIpcDeps): void {
  const { getMainWindow, releaseUrl, dataDir, appUpdateController, quitAndInstall } = deps;

  function customFontsDir(): string {
    return path.join(dataDir, "fonts");
  }

  function customFontUrl(fileName: string): string {
    return pathToFileURL(path.join(customFontsDir(), fileName)).toString();
  }

  function readDesktopCustomFontsForRenderer(): DesktopCustomFontForRenderer[] {
    return (readDesktopSettingsSync(dataDir).customFonts ?? []).map((font) => ({
      ...font,
      url: customFontUrl(font.fileName),
    }));
  }

  function isSupportedFontPath(filePath: string): boolean {
    return FONT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }

  function createCustomFontId(): string {
    return `font_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }

  function sanitizeFontDisplayName(filePath: string): string {
    const baseName = path.basename(filePath, path.extname(filePath)).replace(/[_-]+/gu, " ").trim();
    return baseName || te("electron.app.addedFont");
  }

  async function uniqueCustomFontFileName(id: string, sourcePath: string): Promise<string> {
    const ext = path.extname(sourcePath).toLowerCase();
    const safeBase = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "font";
    let candidate = `${id}-${safeBase}${ext}`;
    let counter = 2;
    while (existsSync(path.join(customFontsDir(), candidate))) {
      candidate = `${id}-${safeBase}-${counter}${ext}`;
      counter += 1;
    }
    return candidate;
  }

  async function importCustomFont(sourcePath: string): Promise<DesktopCustomFont> {
    if (!isSupportedFontPath(sourcePath)) {
      throw new Error(te("electron.app.unsupportedFont"));
    }
    await fs.mkdir(customFontsDir(), { recursive: true });
    const id = createCustomFontId();
    const fileName = await uniqueCustomFontFileName(id, sourcePath);
    await fs.copyFile(sourcePath, path.join(customFontsDir(), fileName));
    const font: DesktopCustomFont = {
      id,
      displayName: sanitizeFontDisplayName(sourcePath),
      fileName,
      cssFamily: `"Sigma Custom Font ${id}"`,
      importedAt: new Date().toISOString(),
    };
    const settings = readDesktopSettingsSync(dataDir);
    await writeDesktopSettings(dataDir, {
      customFonts: [...(settings.customFonts ?? []), font],
    });
    return font;
  }

  async function deleteCustomFont(fontId: unknown): Promise<boolean> {
    if (typeof fontId !== "string" || !fontId.trim()) {
      return false;
    }
    const settings = readDesktopSettingsSync(dataDir);
    const fonts = settings.customFonts ?? [];
    const target = fonts.find((font) => font.id === fontId);
    if (!target) {
      return false;
    }
    await writeDesktopSettings(dataDir, {
      customFonts: fonts.filter((font) => font.id !== fontId),
    });
    try {
      await fs.unlink(path.join(customFontsDir(), target.fileName));
    } catch {
      // 設定からの削除を優先する。ファイルが既に無い場合も成功扱い。
    }
    return true;
  }

  function getEditorFontFamilyPreferencePatch(payload: unknown): string | undefined {
    if (typeof payload !== "object" || payload === null || !("fontFamily" in payload)) {
      return undefined;
    }
    return normalizeEditorFontFamily((payload as { fontFamily?: unknown }).fontFamily) ?? "";
  }

  ipcMain.handle("app:get-info", () => ({
    version: app.getVersion(),
    releaseUrl,
  }));

  ipcMain.handle("app:open-latest-release-page", async () => {
    try {
      await shell.openExternal(releaseUrl);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : te("electron.app.latestReleasePageFailed"),
      };
    }
  });

  ipcMain.handle("app:get-editor-preferences", () => {
    return readDesktopEditorPreferences(dataDir);
  });

  ipcMain.handle("app:save-editor-preferences", async (_event, payload: unknown) => {
    const fontFamily = getEditorFontFamilyPreferencePatch(payload);
    if (fontFamily !== undefined) {
      await writeDesktopSettings(dataDir, { editorFontFamily: fontFamily });
    }
    return {
      ok: true,
      preferences: readDesktopEditorPreferences(dataDir),
    };
  });

  ipcMain.handle("fonts:list", () => ({
    ok: true,
    fonts: readDesktopCustomFontsForRenderer(),
  }));

  ipcMain.handle("fonts:import", async () => {
    const options: OpenDialogOptions = {
      title: te("electron.app.addFont"),
      properties: ["openFile"],
      filters: [
        { name: "Font files", extensions: ["ttf", "otf", "woff", "woff2", "ttc"] },
      ],
    };
    const mainWindow = getMainWindow();
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const selectedPath = result.filePaths[0];
    if (result.canceled || !selectedPath) {
      return { ok: true, canceled: true, fonts: readDesktopCustomFontsForRenderer() };
    }
    try {
      await importCustomFont(selectedPath);
      return { ok: true, canceled: false, fonts: readDesktopCustomFontsForRenderer() };
    } catch (error) {
      return {
        ok: false,
        canceled: false,
        error: error instanceof Error ? error.message : te("electron.app.addFontFailed"),
        fonts: readDesktopCustomFontsForRenderer(),
      };
    }
  });

  ipcMain.handle("fonts:delete", async (_event, fontId: unknown) => {
    const deleted = await deleteCustomFont(fontId);
    return {
      ok: deleted,
      error: deleted ? undefined : te("electron.app.fontNotFound"),
      fonts: readDesktopCustomFontsForRenderer(),
    };
  });

  ipcMain.handle("app-updater:get-status", () => appUpdateController.getStatus());

  ipcMain.handle("app-updater:check", async () => appUpdateController.checkForUpdates());

  ipcMain.handle("app-updater:download", async () => appUpdateController.downloadUpdate());

  ipcMain.handle("app-updater:quit-and-install", () => (
    quitAndInstall?.() ?? appUpdateController.quitAndInstall()
  ));

  ipcMain.handle("input-source:switch-to-ascii", async () => {
    return switchToAsciiInputSource();
  });

  ipcMain.handle("input-source:restore", async (_event, restoreToken: unknown) => {
    return restorePreviousInputSource(typeof restoreToken === "string" ? restoreToken : "");
  });

  ipcMain.handle("app:print", async () => {
    getMainWindow()?.webContents.send("menu:action", "print-document");
  });
}
