import fs from "node:fs/promises";
import path from "node:path";

import { ipcMain } from "../trusted-ipc";
import type { SigmaDocument } from "@/features/document";

export interface RegisterWorkspacePreviewIpcDeps {
  loadSharedDocument?: (fileId: string, options?: { assets?: boolean }) => Promise<SigmaDocument | null>;
}

/**
 * 共有教材を編集用のセッションを開かずに読み取り専用で読む (ワークスペース画面のコメント一覧の走査)。
 * 教材一覧のサムネイル画像は廃止したので、画像の保存・読み出しの口はもう持たない。
 */
export function registerWorkspacePreviewIpc(deps: RegisterWorkspacePreviewIpcDeps): void {
  ipcMain.handle("workspace-preview:shared-document", async (event, fileId: unknown, options?: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || typeof fileId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(fileId)) return null;
    // Only `{ assets: false }` is honoured; anything else is a plain read with images.
    const textOnly = typeof options === "object" && options !== null && (options as { assets?: unknown }).assets === false;
    return await (textOnly ? deps.loadSharedDocument?.(fileId, { assets: false }) : deps.loadSharedDocument?.(fileId)) ?? null;
  });
}

/** 教材一覧のサムネイル画像を端末に保存していた置き場。サムネイルの廃止で使わなくなった。 */
export const RETIRED_WORKSPACE_PREVIEW_DIRECTORIES = ["workspace-previews", "shared-workspace-previews"] as const;

/** 以前の版が残したサムネイル画像を消す。起動を待たせないよう、呼び出し側は待たずに投げる。 */
export async function removeRetiredWorkspacePreviewCaches(userDataPath: string): Promise<void> {
  await Promise.all(RETIRED_WORKSPACE_PREVIEW_DIRECTORIES.map((name) =>
    fs.rm(path.join(userDataPath, name), { recursive: true, force: true }).catch((error) => {
      console.warn(`[workspace-preview] Could not remove the retired thumbnail cache (${name}).`, error);
    })));
}
