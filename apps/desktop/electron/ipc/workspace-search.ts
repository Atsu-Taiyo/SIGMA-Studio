import type { WebContents } from "electron";

import { ipcMain } from "../trusted-ipc";
import type { WorkspaceBodySearchSession } from "@/lib/workspace-body-search";
import type { WorkspaceBodySearchService } from "../workspace-body-search";

const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_QUERY_LENGTH = 200;

/**
 * 本文検索の口。画面ごと (webContents ごと) にセッションを 1 つだけ持ち、画面が新しい ID で
 * 来たら (再読み込み・別ページ) 前のセッションを閉じる。結果は `workspace-search:update` で送り返す。
 */
export function registerWorkspaceSearchIpc(service: WorkspaceBodySearchService): void {
  const sessions = new Map<WebContents, { id: string; session: WorkspaceBodySearchSession }>();
  const watched = new WeakSet<WebContents>();
  const release = (sender: WebContents) => {
    const current = sessions.get(sender);
    if (!current) return;
    sessions.delete(sender);
    service.release(current.session);
  };

  ipcMain.handle("workspace-search:query", async (event, sessionId: unknown, queryId: unknown, query: unknown) => {
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return;
    if (typeof queryId !== "number" || !Number.isSafeInteger(queryId)) return;
    if (typeof query !== "string") return;
    const sender = event.sender;
    let current = sessions.get(sender);
    if (current?.id !== sessionId) {
      release(sender);
      if (!watched.has(sender)) {
        watched.add(sender);
        sender.once("destroyed", () => release(sender));
      }
      const session = service.open((update) => {
        if (!sender.isDestroyed()) sender.send("workspace-search:update", { sessionId, ...update });
      });
      current = { id: sessionId, session };
      sessions.set(sender, current);
    }
    await current.session.setQuery(queryId, query.slice(0, MAX_QUERY_LENGTH));
  });

  ipcMain.handle("workspace-search:close", (event, sessionId: unknown) => {
    if (sessions.get(event.sender)?.id === sessionId) release(event.sender);
  });
}
