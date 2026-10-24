import { ipcMain } from "../trusted-ipc";
import { shell } from "electron";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

export function registerShellIpc({ confirm, openSharedLink }: { confirm(url: string): Promise<boolean>; openSharedLink?: (url: string) => boolean }): void {
  ipcMain.handle("shell:open-external", async (_event, url: string) => {
    try {
      if (typeof url !== "string") return { ok: false };
      if (openSharedLink?.(url)) return { ok: true };
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: te("electron.shell.invalidExternalUrl") };
      }
      if (!await confirm(url)) return { ok: false };
      await shell.openExternal(url);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : te("electron.shell.openExternalFailed"),
      };
    }
  });
}
