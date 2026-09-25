import { ipcMain } from "electron";
import type { SigmaDocument } from "@/features/document";

import {
  readWorkspacePreviewPng,
  writeWorkspacePreviewPng,
} from "../workspace-preview-cache";

export interface RegisterWorkspacePreviewIpcDeps {
  userDataPath: string;
  loadSharedDocument?: (fileId: string) => Promise<SigmaDocument | null>;
}

export function registerWorkspacePreviewIpc(deps: RegisterWorkspacePreviewIpcDeps): void {
  const { userDataPath } = deps;
  ipcMain.handle("workspace-preview:shared-document", async (event, fileId: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || typeof fileId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(fileId)) return null;
    return deps.loadSharedDocument?.(fileId) ?? null;
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
