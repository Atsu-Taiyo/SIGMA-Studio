import { app, BrowserWindow, dialog, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import fs from "node:fs/promises";

import { createCurrentLocaleTranslator } from "@/lib/i18n";
import type { ExtensionMenuGroup } from "@/lib/extension-contracts";

import { IMPORT_MAX_INPUT_BYTES, type PluginHost } from "../plugins/host";
import { PluginError } from "../plugins/manifest";
import { isTrustedMainSender, ipcMain } from "../trusted-ipc";

const te = createCurrentLocaleTranslator("error");

const HOUR_MS = 60 * 60 * 1000;
const ACCESS_REFRESH_MS = 60_000;
const IDENTITY_POLL_MS = 1_000;

export interface RegisterPluginIpcDeps {
  host: PluginHost;
  getMainWindow: () => BrowserWindow | null;
}

/**
 * 公式プラグインと拡張機能メニューの橋。権限・署名・実行はホストが持ち、ここは受け渡しだけ。
 * 状態の変化は、信頼できるメインウィンドウにだけ流す。
 */
export function registerPluginIpc({ host, getMainWindow }: RegisterPluginIpcDeps): void {
  const { manager } = host;

  const sendToTrustedWindows = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      const sender = window.webContents;
      if (!sender.isDestroyed() && isTrustedMainSender({ sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent)) {
        sender.send(channel, payload);
      }
    }
  };

  let lastMenu = JSON.stringify(manager.menuGroups());
  manager.on("change", (status) => {
    sendToTrustedWindows("official-plugins:change", status);
    const groups = manager.menuGroups();
    const serialized = JSON.stringify(groups);
    if (serialized !== lastMenu) {
      lastMenu = serialized;
      sendToTrustedWindows("extensions:menu-change", groups);
    }
  });

  for (const [channel, action] of [
    ["status", async () => {
      await manager.refreshAccess().catch(() => {});
      return manager.status();
    }],
    ["check", () => manager.check()],
    ["install", (id: string) => manager.install(id)],
    ["enabled", (id: string, enabled: boolean) => manager.setEnabled(id, enabled)],
    ["auto-update", (enabled: boolean) => manager.setAutoUpdate(enabled)],
  ] as const) {
    ipcMain.handle(`official-plugins:${channel}`, async (_event, ...args) => {
      try {
        await host.ready;
        return await (action as (...values: unknown[]) => Promise<unknown>)(...args);
      } catch {
        return { ...manager.status(), error: "unavailable" };
      }
    });
  }

  ipcMain.handle("extensions:menu", async () => {
    await host.ready;
    await manager.refreshAccess().catch(() => {});
    return manager.menuGroups() satisfies ExtensionMenuGroup[];
  });

  ipcMain.handle("extensions:run", (_event, extensionId: unknown, itemId: unknown) =>
    host.runItem(extensionId, itemId, async (extensions) => {
      const options: OpenDialogOptions = {
        title: te("electron.plugins.importTitle"),
        properties: ["openFile"],
        filters: [{ name: te("electron.plugins.importFiles"), extensions: extensions.map((extension) => extension.slice(1)) }],
      };
      const window = getMainWindow();
      const result = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
      if (result.canceled || result.filePaths.length === 0) return null;
      const filePath = result.filePaths[0];
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size > IMPORT_MAX_INPUT_BYTES) throw new PluginError("import-failed");
      return { filePath, bytes: await fs.readFile(filePath) };
    }));

  // 権限は定期的に確かめ直す。本人が変わったときは、前の本人の権限と所属を即座に捨てる。
  void host.ready.then(() => manager.refreshAutomatically());
  const timers = [
    setInterval(() => { void manager.refreshAutomatically(); }, HOUR_MS),
    setInterval(() => { void manager.refreshAccess().catch(() => {}); }, ACCESS_REFRESH_MS),
  ];
  let actor = manager.currentActor();
  timers.push(setInterval(() => {
    const next = manager.currentActor();
    if (next !== actor) {
      actor = next;
      manager.resetIdentity();
      void manager.refreshAccess().catch(() => {});
    }
  }, IDENTITY_POLL_MS));
  for (const timer of timers) timer.unref();
  app.once("before-quit", () => { for (const timer of timers) clearInterval(timer); });
}
