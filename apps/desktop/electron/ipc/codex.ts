import { app, ipcMain, dialog, shell, BrowserWindow, type OpenDialogOptions } from "electron";
import path from "node:path";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

import type { ClaudeStreamClient } from "../claude-stream-client";
import { registerCliBinIpc } from "../cli-bin-ipc";
import { assertUsableCliBinPath } from "../cli-spawn";
import type { CodexAppServerClient } from "../codex-app-server-client";
import { writeDesktopSettings } from "../desktop-settings";
import type { GeminiHeadlessClient } from "../gemini-headless-client";

const te = createCurrentLocaleTranslator("error");

const CODEX_INSTALL_PAGE_URL = "https://developers.openai.com/codex/cli";
const CLAUDE_INSTALL_PAGE_URL = "https://docs.anthropic.com/en/docs/claude-code";
const GEMINI_INSTALL_PAGE_URL = "https://antigravity.google/product/antigravity-cli";

function getSuggestedCodexBinPath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) {
      return path.join(appData, "npm", "codex.cmd");
    }
    return path.join(app.getPath("home"), "AppData", "Roaming", "npm", "codex.cmd");
  }

  return path.join(app.getPath("home"), "Library", "pnpm", "bin", "codex");
}

function getSuggestedClaudeBinPath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) {
      return path.join(appData, "npm", "claude.cmd");
    }
    return path.join(app.getPath("home"), "AppData", "Roaming", "npm", "claude.cmd");
  }

  return path.join(app.getPath("home"), ".local", "bin", "claude");
}

function getSuggestedGeminiBinPath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) {
      return path.join(appData, "npm", "agy.cmd");
    }
    return path.join(app.getPath("home"), "AppData", "Roaming", "npm", "agy.cmd");
  }

  return path.join(app.getPath("home"), ".local", "bin", "agy");
}

function broadcastGeminiStatusChange(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("gemini:status-changed");
  }
}

export interface RegisterCodexIpcDeps {
  dataDir: string;
  codexAppServerClient: CodexAppServerClient;
  claudeStreamClient: ClaudeStreamClient;
  geminiHeadlessClient: GeminiHeadlessClient;
  getMainWindow: () => BrowserWindow | null;
  openExternalUrl: (url: string) => void;
}

export function registerCodexIpc(deps: RegisterCodexIpcDeps): void {
  const { dataDir, codexAppServerClient, claudeStreamClient, geminiHeadlessClient, getMainWindow, openExternalUrl } = deps;

  ipcMain.handle("codex:get-status", async () => {
    return codexAppServerClient.getStatus();
  });

  ipcMain.handle("codex:list-models", async () => {
    return codexAppServerClient.listModels();
  });

  ipcMain.handle("codex:set-bin", async (_event, rawPath: unknown) => {
    // `codex:*` は共通の `registerCliBinIpc` を使っていないので、同じ検証をここにも置く。
    // 片方だけ塞ぐと codex 経路にだけ XSS→RCE の橋渡しが残る。
    // 設定解除は `null` で来る (`DesktopSettingsModal` の `draft.trim() || null`)。空文字も同義。
    if (rawPath === null || rawPath === undefined || (typeof rawPath === "string" && !rawPath.trim())) {
      await writeDesktopSettings(dataDir, { codexBin: "" });
      codexAppServerClient.setCodexBin(null);
      return codexAppServerClient.getStatus();
    }
    if (typeof rawPath !== "string") {
      throw new Error(te("electron.cli.invalidPath"));
    }
    const validation = assertUsableCliBinPath(rawPath.trim(), process.platform);
    if (!validation.ok) {
      throw new Error(validation.reason);
    }
    await writeDesktopSettings(dataDir, { codexBin: validation.path });
    codexAppServerClient.setCodexBin(validation.path);
    return codexAppServerClient.getStatus();
  });

  ipcMain.handle("codex:select-bin", async () => {
    const options: OpenDialogOptions = {
      title: te("electron.cli.selectCodex"),
      properties: ["openFile"],
      defaultPath: codexAppServerClient.getConfiguredCodexBin() ?? getSuggestedCodexBinPath(),
      ...(process.platform === "win32"
        ? {
            filters: [
              { name: "Codex CLI", extensions: ["exe", "cmd", "bat"] },
              { name: "All Files", extensions: ["*"] },
            ],
          }
        : {}),
    };
    const mainWindow = getMainWindow();
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const selectedPath = result.canceled ? null : result.filePaths[0];
    if (!selectedPath) {
      return { canceled: true };
    }
    const validation = assertUsableCliBinPath(selectedPath, process.platform);
    if (!validation.ok) {
      throw new Error(validation.reason);
    }
    await writeDesktopSettings(dataDir, { codexBin: validation.path });
    codexAppServerClient.setCodexBin(validation.path);
    return {
      canceled: false,
      status: await codexAppServerClient.getStatus(),
    };
  });

  ipcMain.handle("codex:login", async () => {
    const result = await codexAppServerClient.login();
    if (result.ok && result.authUrl) {
      openExternalUrl(result.authUrl);
    }
    return result;
  });

  ipcMain.handle("codex:open-install-page", async () => {
    try {
      await shell.openExternal(CODEX_INSTALL_PAGE_URL);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : te("electron.cli.codexInstallPageFailed"),
      };
    }
  });

  ipcMain.handle("codex:logout", async () => {
    return codexAppServerClient.logout();
  });

  // claude:* / gemini:* (get-status, set-bin, select-bin, open-install-page)
  // share one shape; codex:* additionally has login/logout and its own
  // EventEmitter-based status broadcast, so it is left as its own handlers
  // above (Finding 9).
  registerCliBinIpc({
    prefix: "claude",
    client: {
      getStatus: () => claudeStreamClient.getStatus(),
      setBin: (bin) => claudeStreamClient.setClaudeBin(bin),
      getConfiguredBin: () => claudeStreamClient.getConfiguredClaudeBin(),
    },
    persistBin: (claudeBin) => writeDesktopSettings(dataDir, { claudeBin }),
    dialogTitle: te("electron.cli.selectClaude"),
    filterName: "Claude CLI",
    getSuggestedBinPath: getSuggestedClaudeBinPath,
    installPageUrl: CLAUDE_INSTALL_PAGE_URL,
    installPageErrorFallback: te("electron.cli.claudeInstallPageFailed"),
    getMainWindow,
  });

  ipcMain.handle("claude:list-models", async () => {
    return claudeStreamClient.listModels();
  });

  registerCliBinIpc({
    prefix: "gemini",
    client: {
      getStatus: () => geminiHeadlessClient.getStatus(),
      setBin: (bin) => geminiHeadlessClient.setGeminiBin(bin),
      getConfiguredBin: () => geminiHeadlessClient.getConfiguredGeminiBin(),
    },
    persistBin: (geminiBin) => writeDesktopSettings(dataDir, { antigravityBin: geminiBin }),
    dialogTitle: te("electron.cli.selectAntigravity"),
    filterName: "Antigravity CLI",
    getSuggestedBinPath: getSuggestedGeminiBinPath,
    installPageUrl: GEMINI_INSTALL_PAGE_URL,
    installPageErrorFallback: te("electron.cli.antigravityInstallPageFailed"),
    getMainWindow,
    broadcastStatusChange: broadcastGeminiStatusChange,
    mapStatus: (status) => ({ ...status, account: null }),
  });

  ipcMain.handle("gemini:list-models", async () => {
    return geminiHeadlessClient.listModels();
  });
}
