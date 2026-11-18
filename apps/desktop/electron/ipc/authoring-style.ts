import { ipcMain } from "../trusted-ipc";
import type { LocalAuthoringStyleStore } from "../authoring-style-store";

function scope(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 256) throw new Error("Invalid workspace ID");
  return value;
}

function workspace(value: unknown): string {
  const id = scope(value);
  if (id === null) throw new Error("Invalid workspace ID");
  return id;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Invalid input");
  return value as Record<string, unknown>;
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
  ipcMain.handle("authoring-style:set-ai-summary", (_event, workspaceId: unknown, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Invalid enabled flag");
    return store.setAiSummary(scope(workspaceId), enabled);
  });
  ipcMain.handle("authoring-style:set-auto-apply", (_event, workspaceId: unknown, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Invalid enabled flag");
    return store.setAutoApply(scope(workspaceId), enabled);
  });
  ipcMain.handle("authoring-style:revert-auto-change", (_event, input: unknown) => {
    const value = record(input);
    if (typeof value.id !== "string" || value.id.length > 200) throw new Error("Invalid style change");
    return store.revertAutoChange({ workspaceId: workspace(value.workspaceId), id: value.id });
  });
  ipcMain.handle("authoring-style:reset", (_event, workspaceId: unknown) => store.reset(scope(workspaceId)));
  ipcMain.handle("authoring-style:save-learned", (_event, input: unknown) => {
    const value = record(input);
    if (typeof value.content !== "string" || typeof value.expectedRevision !== "string") throw new Error("Invalid style memo");
    return store.saveLearned({ workspaceId: workspace(value.workspaceId), content: value.content, expectedRevision: value.expectedRevision });
  });
  ipcMain.handle("authoring-style:review", (_event, workspaceId: unknown) => store.reviewNow(workspace(workspaceId)));
  ipcMain.handle("authoring-style:resolve-pending", (_event, input: unknown) => {
    const value = record(input);
    if (typeof value.id !== "string" || value.id.length > 200 || typeof value.approve !== "boolean") throw new Error("Invalid staged change");
    return store.resolvePending({ workspaceId: workspace(value.workspaceId), id: value.id, approve: value.approve });
  });
  ipcMain.handle("authoring-style:resolve-member-entries", (_event, input: unknown) => {
    const value = record(input);
    if (!Array.isArray(value.ids) || value.ids.length > 2000 || value.ids.some(id => typeof id !== "string" || id.length > 40) || typeof value.approve !== "boolean") throw new Error("Invalid member entries");
    return store.resolveMemberEntries({ workspaceId: workspace(value.workspaceId), ids: value.ids as string[], approve: value.approve });
  });
  ipcMain.handle("authoring-style:remove-item", (_event, input: unknown) => {
    const value = record(input);
    if (typeof value.id !== "string" || value.id.length > 200) throw new Error("Invalid style item");
    return store.removeItem({ workspaceId: workspace(value.workspaceId), id: value.id });
  });
  ipcMain.handle("authoring-style:set-sync", (_event, workspaceId: unknown, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Invalid enabled flag");
    return store.setSync(scope(workspaceId), enabled);
  });
  ipcMain.handle("authoring-style:sync-now", (_event, workspaceId: unknown) => store.syncNow(scope(workspaceId)));
  ipcMain.handle("authoring-style:relink-sync", (_event, workspaceId: unknown) => store.relinkSync(scope(workspaceId)));
  ipcMain.handle("authoring-style:delete-synced", (_event, workspaceId: unknown) => store.deleteSynced(scope(workspaceId)));
  ipcMain.handle("authoring-style:undo", (_event, workspaceId: unknown) => store.undo(workspace(workspaceId)));
}
