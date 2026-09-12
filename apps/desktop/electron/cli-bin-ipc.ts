import { dialog, ipcMain, shell, type BrowserWindow, type OpenDialogOptions } from "electron";

import { assertUsableCliBinPath } from "./cli-spawn";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

// claude:* and gemini:* IPC handlers (get-status / set-bin / select-bin /
// open-install-page) were near-identical copies of each other in main.ts —
// both wrap a "local CLI client" with getStatus/setBin-equivalent/
// getConfiguredBin, persist the chosen path to DesktopSettings, and open a
// native file picker + install page (Finding 9). codex:* has extra login/
// logout handlers and its own status broadcast wiring via an EventEmitter, so
// it is left as-is rather than forced into this shape.

export interface CliBinClient<TStatus> {
  getStatus(): Promise<TStatus>;
  setBin(bin: string | null): void;
  getConfiguredBin(): string | null;
}

export interface RegisterCliBinIpcOptions<TStatus> {
  /** IPC channel prefix, e.g. "claude" -> "claude:get-status". */
  prefix: string;
  client: CliBinClient<TStatus>;
  /** Persist the chosen bin path (or "" to clear) to desktop settings. */
  persistBin: (bin: string) => Promise<void>;
  /** Native file-picker copy and default path. */
  dialogTitle: string;
  filterName: string;
  getSuggestedBinPath: () => string;
  installPageUrl: string;
  installPageErrorFallback: string;
  getMainWindow: () => BrowserWindow | null;
  /** Called after set-bin/select-bin update the client, e.g. to notify renderers. */
  broadcastStatusChange?: () => void;
  /** Post-process the raw client status before returning it over IPC (e.g. gemini adds `account: null`). */
  mapStatus?: (status: TStatus) => unknown;
}

export function registerCliBinIpc<TStatus>(options: RegisterCliBinIpcOptions<TStatus>): void {
  const { prefix, client } = options;
  const mapStatus = options.mapStatus ?? ((status: TStatus) => status);

  ipcMain.handle(`${prefix}:get-status`, async () => {
    return mapStatus(await client.getStatus());
  });

  ipcMain.handle(`${prefix}:set-bin`, async (_event, rawPath: unknown) => {
    // レンダラ由来の文字列がそのまま spawn のコマンド名になる。ここを素通しにすると、
    // レンダラでの任意 JS 実行 (教材由来の XSS) がホスト OS の任意コマンド実行へ橋渡しされる。
    // 設定解除は `null` で来る (`DesktopSettingsModal` の `draft.trim() || null`)。空文字も同義。
    if (rawPath === null || rawPath === undefined || (typeof rawPath === "string" && !rawPath.trim())) {
      await options.persistBin("");
      client.setBin(null);
      const cleared = mapStatus(await client.getStatus());
      options.broadcastStatusChange?.();
      return cleared;
    }
    if (typeof rawPath !== "string") {
      throw new Error(te("electron.cli.invalidPath"));
    }

    const validation = assertUsableCliBinPath(rawPath.trim(), process.platform);
    if (!validation.ok) {
      // 保存もクライアント更新もせず、理由を例外で返す。通常の status 形状で返すと、
      // レンダラは成功として扱って「保存しました」と表示し、入力欄を巻き戻してしまう。
      throw new Error(validation.reason);
    }

    await options.persistBin(validation.path);
    client.setBin(validation.path);
    const status = mapStatus(await client.getStatus());
    options.broadcastStatusChange?.();
    return status;
  });

  ipcMain.handle(`${prefix}:select-bin`, async () => {
    const dialogOptions: OpenDialogOptions = {
      title: options.dialogTitle,
      properties: ["openFile"],
      defaultPath: client.getConfiguredBin() ?? options.getSuggestedBinPath(),
      ...(process.platform === "win32"
        ? {
            filters: [
              { name: options.filterName, extensions: ["exe", "cmd", "bat"] },
              { name: "All Files", extensions: ["*"] },
            ],
          }
        : {}),
    };
    const mainWindow = options.getMainWindow();
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    const selectedPath = result.canceled ? null : result.filePaths[0];
    if (!selectedPath) {
      return { canceled: true };
    }
    // ピッカーの返り値は常に絶対パスだが、実行できるファイルかどうかは保証されない。
    const validation = assertUsableCliBinPath(selectedPath, process.platform);
    if (!validation.ok) {
      // `{ canceled: false }` を status 無しで返すとレンダラが `result.status.available` で
      // 落ちる (描画中の例外 = 白画面)。例外にすればレンダラ既存の catch がそのまま効く。
      throw new Error(validation.reason);
    }
    await options.persistBin(validation.path);
    client.setBin(validation.path);
    const status = mapStatus(await client.getStatus());
    options.broadcastStatusChange?.();
    return {
      canceled: false,
      status,
    };
  });

  ipcMain.handle(`${prefix}:open-install-page`, async () => {
    try {
      await shell.openExternal(options.installPageUrl);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : options.installPageErrorFallback,
      };
    }
  });
}
