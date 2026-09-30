import type { UserCommentThread } from "@/features/document";
import type { Translate } from "@/lib/i18n/translator";
import type { WorkspaceSummary } from "@/lib/runtime/types";
import { workspaceBookmarkKey, type WorkspaceBookmark, type WorkspaceBookmarkKey } from "@/lib/workspace-bookmarks";
import type { WorkspaceFileSummary, WorkspaceFolderSummary } from "@/lib/workspace-repository";

import { resolveFileDisplayName, resolveFolderDisplayName } from "./workspace-format";
import { buildFolderPath } from "./workspace-list-model";

/** サイドバーが切り替える本体の面。教材・フォルダの一覧以外は、全ワークスペースを横断して見せる。 */
export type WorkspacePanel = "files" | "comments" | "bookmarks";

export interface WorkspacePanelContext {
  workspaces: readonly WorkspaceSummary[];
  folders: readonly WorkspaceFolderSummary[];
  files: readonly WorkspaceFileSummary[];
  /** 共有アイテムのように、保存名とは別の表示名を持つワークスペースの名前解決。 */
  workspaceLabel: (workspace: WorkspaceSummary) => string;
}

/** 「ワークスペース / フォルダ / サブフォルダ」の形の場所表示 (検索結果の場所表示と同じ形)。 */
export function resolveItemLocation(
  context: Pick<WorkspacePanelContext, "workspaces" | "folders" | "workspaceLabel">,
  workspaceId: string,
  parentFolderId: string | null,
): string {
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId);
  const path = buildFolderPath(context.folders.filter((folder) => folder.workspaceId === workspaceId), parentFolderId);
  return [workspace ? context.workspaceLabel(workspace) : undefined, ...path.map(resolveFolderDisplayName)]
    .filter(Boolean)
    .join(" / ");
}

export interface WorkspaceBookmarkEntry {
  key: WorkspaceBookmarkKey;
  kind: "file" | "folder";
  id: string;
  name: string;
  location: string;
  workspaceId: string;
  /** フォルダなら親、教材なら入っているフォルダ。 */
  parentFolderId: string | null;
  shared: boolean;
  addedAt: string;
}

/**
 * ブックマークを、いま見えている教材・フォルダへ引き当てる。引き当てられない項目 (削除済み・
 * アクセス権を失った共有・サインアウト中の共有など) は出さないだけで消さない — 一時的に見えない
 * だけの共有アイテムのブックマークを、その場の読み込み結果で失わないため。新しい順に返す。
 */
export function buildBookmarkEntries(
  bookmarks: readonly WorkspaceBookmark[],
  context: WorkspacePanelContext,
  t: Translate<"workspace">,
): WorkspaceBookmarkEntry[] {
  const files = new Map(context.files.map((file) => [file.fileId, file]));
  const folders = new Map(context.folders.map((folder) => [folder.id, folder]));
  const entries: WorkspaceBookmarkEntry[] = [];
  for (const bookmark of bookmarks) {
    if (bookmark.kind === "file") {
      const file = files.get(bookmark.id);
      if (!file) continue;
      entries.push({
        key: workspaceBookmarkKey("file", file.fileId),
        kind: "file",
        id: file.fileId,
        name: resolveFileDisplayName(file, t),
        location: resolveItemLocation(context, file.workspaceId, file.folderId),
        workspaceId: file.workspaceId,
        parentFolderId: file.folderId,
        shared: Boolean(file.sharing),
        addedAt: bookmark.addedAt,
      });
    } else {
      const folder = folders.get(bookmark.id);
      if (!folder) continue;
      entries.push({
        key: workspaceBookmarkKey("folder", folder.id),
        kind: "folder",
        id: folder.id,
        name: resolveFolderDisplayName(folder),
        location: resolveItemLocation(context, folder.workspaceId, folder.parentFolderId),
        workspaceId: folder.workspaceId,
        parentFolderId: folder.parentFolderId,
        shared: Boolean(folder.sharing),
        addedAt: bookmark.addedAt,
      });
    }
  }
  return entries.sort((a, b) => timestamp(b.addedAt) - timestamp(a.addedAt));
}

export interface WorkspaceCommentEntry {
  key: string;
  fileId: string;
  threadId: string;
  title: string;
  location: string;
  shared: boolean;
  resolved: boolean;
  /** 自分宛てのメンションを含む。 */
  mentioned: boolean;
  /** 自分が書いたメッセージを含む。 */
  authored: boolean;
  authorName?: string;
  /** 見せているメッセージを自分が書いた。 */
  ownMessage: boolean;
  excerpt: string;
  quote: string;
  messageCount: number;
  activityAt: string;
}

/**
 * 教材ごとの走査結果を、動きのあった新しい順の一覧へ並べる。走査結果を持っていても、いま
 * 一覧に無い教材 (削除・共有解除) のものは出さない。
 */
export function buildCommentEntries(
  threadsByFile: ReadonlyMap<string, readonly UserCommentThread[]>,
  context: WorkspacePanelContext,
  t: Translate<"workspace">,
): WorkspaceCommentEntry[] {
  const entries: WorkspaceCommentEntry[] = [];
  for (const file of context.files) {
    const threads = threadsByFile.get(file.fileId);
    if (!threads?.length) continue;
    const title = resolveFileDisplayName(file, t);
    const location = resolveItemLocation(context, file.workspaceId, file.folderId);
    for (const thread of threads) {
      entries.push({
        key: `${file.fileId}:${thread.threadId}`,
        fileId: file.fileId,
        threadId: thread.threadId,
        title,
        location,
        shared: Boolean(file.sharing),
        resolved: thread.resolved,
        mentioned: thread.mentioned,
        authored: thread.authored,
        ...(thread.authorName ? { authorName: thread.authorName } : {}),
        ownMessage: thread.ownMessage,
        excerpt: thread.excerpt,
        quote: thread.quote,
        messageCount: thread.messageCount,
        activityAt: thread.activityAt,
      });
    }
  }
  return entries.sort((a, b) => timestamp(b.activityAt) - timestamp(a.activityAt) || a.key.localeCompare(b.key));
}

export type WorkspaceCommentFilter = "all" | "mentioned" | "authored";

export function filterCommentEntries(
  entries: readonly WorkspaceCommentEntry[],
  filter: { relation: WorkspaceCommentFilter; includeResolved: boolean },
): WorkspaceCommentEntry[] {
  return entries.filter((entry) => (
    (filter.includeResolved || !entry.resolved)
    && (filter.relation === "all" || (filter.relation === "mentioned" ? entry.mentioned : entry.authored))
  ));
}

/** サイドバーのバッジ。ホワイトボードの `@件数` と同じく、自分宛ての未解決スレッドだけ数える。 */
export function countUnresolvedMentions(entries: readonly WorkspaceCommentEntry[]): number {
  return entries.reduce((count, entry) => count + (entry.mentioned && !entry.resolved ? 1 : 0), 0);
}

/** 読めない日時は最も古い扱いにして、並びの末尾へ寄せる。 */
function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
