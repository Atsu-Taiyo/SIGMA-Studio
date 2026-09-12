import type { WorkspaceFileSummary, WorkspaceFolderSummary, WorkspaceOverview } from "@/lib/workspace-repository";
import type { WorkspaceSortDirection, WorkspaceSortKey } from "@/lib/workspace-view-preferences";

import { resolveFileDisplayName, resolveFolderDisplayName } from "./workspace-format";
import type { Translate } from "@/lib/i18n/translator";

export type WorkspaceRow =
  | {
      kind: "folder";
      key: `folder:${string}`;
      id: string;
      name: string;
      updatedAt: string;
      folder: WorkspaceFolderSummary;
    }
  | {
      kind: "file";
      key: `file:${string}`;
      id: string;
      name: string;
      updatedAt: string;
      file: WorkspaceFileSummary;
    };

// Japanese collation with numeric mode so "教材2" sorts before "教材10"
// (plain string comparison would put "10" before "2"). This must drive both
// sorting and any future display normalization, so it lives at module scope
// rather than being recreated per call.
const COLLATOR = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

export interface BuildWorkspaceRowsInput {
  folders: WorkspaceFolderSummary[];
  files: WorkspaceFileSummary[];
  sortKey: WorkspaceSortKey;
  sortDirection: WorkspaceSortDirection;
  /**
   * 題名の無い教材の表示名を作るためだけに使う。**並べ替え規則そのものは
   * UI 言語に連動させない** (下の `Intl.Collator("ja")` を参照) — 並ぶのは
   * 教材名 = 内容であって、UI の言語で本棚の順序が変わるのは不可解なので。
   */
  t: Translate<"workspace">;
}

/**
 * Builds the combined, sorted row list for a workspace listing. Folders
 * always sort ahead of files (Drive's behavior) regardless of sort key or
 * direction; the requested sort only orders items within each group.
 */
export function buildWorkspaceRows(input: BuildWorkspaceRowsInput): WorkspaceRow[] {
  const { folders, files, sortKey, sortDirection, t } = input;

  const folderRows: WorkspaceRow[] = folders.map((folder) => ({
    kind: "folder",
    key: `folder:${folder.id}`,
    id: folder.id,
    name: resolveFolderDisplayName(folder),
    updatedAt: folder.updatedAt,
    folder,
  }));
  const fileRows: WorkspaceRow[] = files.map((file) => ({
    kind: "file",
    key: `file:${file.fileId}`,
    id: file.fileId,
    name: resolveFileDisplayName(file, t),
    updatedAt: file.updatedAt,
    file,
  }));

  return [
    ...sortRows(folderRows, sortKey, sortDirection),
    ...sortRows(fileRows, sortKey, sortDirection),
  ];
}

function sortRows(
  rows: WorkspaceRow[],
  sortKey: WorkspaceSortKey,
  sortDirection: WorkspaceSortDirection,
): WorkspaceRow[] {
  const comparator = sortKey === "name"
    ? (a: WorkspaceRow, b: WorkspaceRow) => compareByName(a, b, sortDirection)
    : (a: WorkspaceRow, b: WorkspaceRow) => compareByUpdatedAt(a, b, sortDirection);
  return [...rows].sort(comparator);
}

function compareByName(a: WorkspaceRow, b: WorkspaceRow, direction: WorkspaceSortDirection): number {
  const cmp = COLLATOR.compare(a.name, b.name);
  return direction === "asc" ? cmp : -cmp;
}

function compareByUpdatedAt(a: WorkspaceRow, b: WorkspaceRow, direction: WorkspaceSortDirection): number {
  const aTime = Date.parse(a.updatedAt);
  const bTime = Date.parse(b.updatedAt);
  const aValid = !Number.isNaN(aTime);
  const bValid = !Number.isNaN(bTime);

  if (aValid && bValid) {
    if (aTime !== bTime) {
      return direction === "asc" ? aTime - bTime : bTime - aTime;
    }
    // Ties break on name ascending regardless of direction, so the order is
    // stable across refreshes instead of depending on array insertion order.
    return COLLATOR.compare(a.name, b.name);
  }
  if (aValid !== bValid) {
    // An unparsable updatedAt sorts last regardless of direction: it's a
    // data-quality problem, not "oldest".
    return aValid ? -1 : 1;
  }
  return COLLATOR.compare(a.name, b.name);
}

export interface ResolveRowLocationContext {
  folders: WorkspaceFolderSummary[];
  workspaceName: string;
}

/**
 * Resolves the "場所" (location) column for a row: the display name of its
 * containing folder, or the workspace name at root. Never throws — a
 * dangling folderId/parentFolderId (referencing a folder that no longer
 * exists) falls back to the workspace name.
 */
export function resolveRowLocation(row: WorkspaceRow, ctx: ResolveRowLocationContext): string {
  const containingFolderId = row.kind === "file" ? row.file.folderId : row.folder.parentFolderId;
  if (!containingFolderId) {
    return ctx.workspaceName;
  }
  const containingFolder = ctx.folders.find((folder) => folder.id === containingFolderId);
  return containingFolder ? resolveFolderDisplayName(containingFolder) : ctx.workspaceName;
}

/**
 * Walks parentFolderId upward from folderId to the root, returning the
 * ancestor chain root-first (including folderId's own folder last). Guards
 * against cycles the same way isFolderDescendant does: a Set of visited ids
 * stops the walk instead of looping forever, so both a self-parented folder
 * and an A -> B -> A cycle terminate.
 */
export function buildFolderPath(
  folders: WorkspaceFolderSummary[],
  folderId: string | null,
): WorkspaceFolderSummary[] {
  if (!folderId) {
    return [];
  }

  const path: WorkspaceFolderSummary[] = [];
  const seen = new Set<string>();
  let current = folders.find((folder) => folder.id === folderId) ?? null;

  while (current) {
    if (seen.has(current.id)) {
      break;
    }
    seen.add(current.id);
    path.push(current);

    if (!current.parentFolderId || current.parentFolderId === current.id) {
      break;
    }
    current = folders.find((folder) => folder.id === current?.parentFolderId) ?? null;
  }

  return path.reverse();
}

/**
 * Overlays optimistic in-flight rename names on top of an overview, keyed by
 * the same "file:<id>" / "folder:<id>" / "workspace:<id>" vocabulary as
 * WorkspaceDropTarget. This is what keeps an inline rename visible when a
 * background overview refresh (the storage watcher's debounced silent
 * reload) lands mid-flight, before the rename's own repository call has
 * resolved -- without it, the incoming overview would revert the display to
 * the pre-rename name for a frame (or longer, if the rename is slow).
 *
 * Returns the same overview reference when the pending map is empty or none
 * of its entries match anything in the overview, so callers that skip a
 * setState when the reference is unchanged don't re-render for nothing.
 */
export function applyPendingRenames(
  overview: WorkspaceOverview,
  pending: Map<string, string>,
): WorkspaceOverview {
  if (pending.size === 0) {
    return overview;
  }

  let changed = false;

  const files = overview.files.map((file) => {
    const pendingName = pending.get(`file:${file.fileId}`);
    if (pendingName === undefined || pendingName === file.title) {
      return file;
    }
    changed = true;
    return { ...file, title: pendingName };
  });

  const folders = overview.folders.map((folder) => {
    const pendingName = pending.get(`folder:${folder.id}`);
    if (pendingName === undefined || pendingName === folder.name) {
      return folder;
    }
    changed = true;
    return { ...folder, name: pendingName };
  });

  const workspaces = overview.workspaces.map((workspace) => {
    const pendingName = pending.get(`workspace:${workspace.id}`);
    if (pendingName === undefined || pendingName === workspace.name) {
      return workspace;
    }
    changed = true;
    return { ...workspace, name: pendingName };
  });

  if (!changed) {
    return overview;
  }

  return { ...overview, files, folders, workspaces };
}
