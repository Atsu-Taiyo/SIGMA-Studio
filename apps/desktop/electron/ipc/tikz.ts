import { ipcMain } from "../trusted-ipc";
import { renderTikz } from "../tikz-renderer";

export function registerTikzIpc(): void {
  ipcMain.handle("tikz:render", (_event, input: unknown) => renderTikz(input));
}
