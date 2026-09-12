import { ipcMain, shell } from "electron";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

export function registerShellIpc(): void {
  ipcMain.handle("shell:open-external", async (_event, url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: te("electron.shell.invalidExternalUrl") };
      }
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
