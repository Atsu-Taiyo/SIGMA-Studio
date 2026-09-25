import { ipcMain } from "electron";
import type { SigmaDocument } from "@/features/document";

import {
  readSharedPreviewImage,
  removeSharedPreviewImage,
  writeSharedPreviewImage,
  readWorkspacePreviewPng,
  writeWorkspacePreviewPng,
} from "../workspace-preview-cache";

export interface RegisterWorkspacePreviewIpcDeps {
  userDataPath: string;
  sharedContext?: (fileId: string) => Promise<{ scope: string; token: string; opened: boolean } | null>;
  loadSharedDocument?: (fileId: string) => Promise<SigmaDocument | null>;
}

export function registerWorkspacePreviewIpc(deps: RegisterWorkspacePreviewIpcDeps): void {
  const { userDataPath } = deps;
  ipcMain.handle("workspace-preview:shared-document", async (event, fileId: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || typeof fileId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(fileId)) return null;
    const context = await deps.sharedContext?.(fileId);
    try {
      const document = await deps.loadSharedDocument?.(fileId) ?? null;
      if (!document && context) await removeSharedPreviewImage(userDataPath, context.scope);
      return document;
    } catch (error) {
      if (context && error instanceof Error && /AUTH|FORBIDDEN|PERMISSION|TARGET_UNAVAILABLE|ACCOUNT_CHANGED|HTTP_40[134]/.test(error.message))
        await removeSharedPreviewImage(userDataPath, context.scope);
      throw error;
    }
  });

  ipcMain.handle("workspace-preview:shared-get", async (event, fileId: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || typeof fileId !== "string") return null;
    const context = await deps.sharedContext?.(fileId);
    if (!context) return null;
    const cached = await readSharedPreviewImage(userDataPath, context.scope);
    if ((await deps.sharedContext?.(fileId))?.token !== context.token) return null;
    return { token: context.token, opened: context.opened,
      dataUrl: cached?.token === context.token ? cached.dataUrl : null, updatedAt: cached?.token === context.token ? cached.updatedAt : 0 };
  });
  ipcMain.handle("workspace-preview:shared-put", async (event, payload: { fileId?: unknown; token?: unknown; dataUrl?: unknown } | null) => {
    if (event.senderFrame !== event.sender.mainFrame || !payload || typeof payload.fileId !== "string" || typeof payload.dataUrl !== "string") return { ok: false };
    const context = await deps.sharedContext?.(payload.fileId);
    if (!context || context.token !== payload.token) return { ok: false };
    const ok = await writeSharedPreviewImage(userDataPath, context.scope, { token: context.token, dataUrl: payload.dataUrl, updatedAt: Date.now() });
    return { ok: ok && (await deps.sharedContext?.(payload.fileId))?.token === context.token };
  });

  ipcMain.handle("workspace-preview:get", async (_event, payload: unknown) => {
    const parsed = parsePreviewKey(payload);
    if (!parsed) {
      return null;
    }
    return readWorkspacePreviewPng(userDataPath, parsed.fileId, parsed.revision);
  });

  ipcMain.handle("workspace-preview:put", async (_event, payload: unknown) => {
    const parsed = parsePreviewPut(payload);
    if (!parsed) {
      return { ok: false };
    }
    const ok = await writeWorkspacePreviewPng(
      userDataPath,
      parsed.fileId,
      parsed.revision,
      parsed.dataUrl,
    );
    return { ok };
  });
}

function parsePreviewKey(payload: unknown): { fileId: string; revision: number } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as { fileId?: unknown; revision?: unknown };
  const fileId = typeof record.fileId === "string" ? record.fileId.trim() : "";
  const revision = Number(record.revision);
  if (!fileId || !Number.isInteger(revision) || revision <= 0) {
    return null;
  }
  return { fileId, revision };
}

function parsePreviewPut(
  payload: unknown,
): { fileId: string; revision: number; dataUrl: string } | null {
  const key = parsePreviewKey(payload);
  if (!key || !payload || typeof payload !== "object") {
    return null;
  }
  const dataUrl = (payload as { dataUrl?: unknown }).dataUrl;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
    return null;
  }
  return { ...key, dataUrl };
}
