import { ipcMain } from "../trusted-ipc";
import type { LocalAuthoringStyleStore } from "../authoring-style-store";

function scope(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 256) throw new Error("Invalid workspace ID");
  return value;
}

export function registerAuthoringStyleIpc(store: LocalAuthoringStyleStore): void {
  ipcMain.handle("authoring-style:read", (_event, workspaceId: unknown) => store.getProfile(scope(workspaceId)));
  ipcMain.handle("authoring-style:save", (_event, input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Invalid style note");
    const value = input as Record<string, unknown>;
    if (typeof value.content !== "string" || typeof value.expectedRevision !== "string") throw new Error("Invalid style note");
    return store.saveProfile({ workspaceId: scope(value.workspaceId), content: value.content, expectedRevision: value.expectedRevision });
  });
  ipcMain.handle("authoring-style:set-enabled", (_event, workspaceId: unknown, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Invalid enabled flag");
    return store.setEnabled(scope(workspaceId), enabled);
  });
  ipcMain.handle("authoring-style:reset", (_event, workspaceId: unknown) => store.reset(scope(workspaceId)));
}
