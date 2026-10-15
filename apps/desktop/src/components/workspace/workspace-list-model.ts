import type { WorkspaceFileSummary, WorkspaceFolderSummary, WorkspaceOverview } from "@/lib/workspace-repository";
import type { WorkspaceBodySearchExcerpt } from "@/lib/workspace-body-search-contract";
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
      /** 題名ではなく本文で検索に一致した教材の、一致した箇所。 */
      excerpt?: WorkspaceBodySearchExcerpt;
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
  /**
   * 検索中だけ渡す。題名ではなく本文で一致した教材 (fileId → 一致した箇所)。題名で一致した教材の
   * 後ろにまとめて並べる — 本文の一致は後から届くので、先に出ている題名の一致の間へ割り込ませない。
   */
  bodyMatches?: ReadonlyMap<string, WorkspaceBodySearchExcerpt>;
  /**
   * 先頭からこの数だけを返す。全部を並べ替えずに上位だけを選ぶので、数万件の検索結果でも
   * 速い (並びは全部を並べ替えて切り取ったときと同じ)。
   */
  limit?: number;
}

/**
 * Builds the combined, sorted row list for a workspace listing. Folders
 * always sort ahead of files (Drive's behavior) regardless of sort key or
 * direction; the requested sort only orders items within each group.
 */
export function buildWorkspaceRows(input: BuildWorkspaceRowsInput): WorkspaceRow[] {
  const { folders, files, sortKey, sortDirection, t, bodyMatches, limit = Number.POSITIVE_INFINITY } = input;

  const folderRows: WorkspaceRow[] = folders.map((folder) => ({
    kind: "folder",
    key: `folder:${folder.id}`,
    id: folder.id,
    name: resolveFolderDisplayName(folder),
    updatedAt: folder.updatedAt,
    folder,
  }));
  const fileRows: WorkspaceRow[] = files.map((file) => {
    const excerpt = bodyMatches?.get(file.fileId);
    return {
      kind: "file",
      key: `file:${file.fileId}`,
      id: file.fileId,
      name: resolveFileDisplayName(file, t),
      updatedAt: file.updatedAt,
      file,
      ...(excerpt ? { excerpt } : {}),
    };
  });

  const rows: WorkspaceRow[] = [];
  for (const group of [
    folderRows,
    fileRows.filter((row) => !(row.kind === "file" && row.excerpt)),
    fileRows.filter((row) => row.kind === "file" && row.excerpt),
  ]) {
    if (rows.length >= limit) break;
    rows.push(...sortRows(group, sortKey, sortDirection, limit - rows.length));
  }
  return rows;
}

function sortRows(
  rows: WorkspaceRow[],
  sortKey: WorkspaceSortKey,
  sortDirection: WorkspaceSortDirection,
  limit: number,
): WorkspaceRow[] {
  let compare: (a: WorkspaceRow, b: WorkspaceRow) => number;
  if (sortKey === "name") {
    compare = (a, b) => compareByName(a, b, sortDirection);
  } else {
    // 日時の解釈は 1 行 1 回。比較のたびに解釈すると、数万件の検索結果で並べ替えが数倍遅くなる。
    const times = new Map(rows.map((row) => [row, Date.parse(row.updatedAt)]));
    compare = (a, b) => compareByUpdatedAt(a, b, sortDirection, times);
  }
  return rows.length <= limit ? [...rows].sort(compare) : selectSorted(rows, compare, limit);
}

/**
 * 並べ替えたときの先頭 `limit` 件を、全部を並べ替えずに選ぶ。並びが同じ行は元の順を保つ (安定な
 * 並べ替えと同じ結果)。上位に入らない行は、今の最下位と 1 回比べるだけで捨てる。
 */
function selectSorted(rows: WorkspaceRow[], compare: (a: WorkspaceRow, b: WorkspaceRow) => number, limit: number): WorkspaceRow[] {
  const top: WorkspaceRow[] = [];
  for (const row of rows) {
    if (top.length === limit && compare(row, top[limit - 1]) >= 0) continue;
    let low = 0;
    let high = top.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (compare(row, top[middle]) < 0) high = middle;
      else low = middle + 1;
    }
    top.splice(low, 0, row);
    if (top.length > limit) top.pop();
  }
  return top;
}

function compareByName(a: WorkspaceRow, b: WorkspaceRow, direction: WorkspaceSortDirection): number {
  const cmp = COLLATOR.compare(a.name, b.name);
  return direction === "asc" ? cmp : -cmp;
}

function compareByUpdatedAt(
  a: WorkspaceRow,
  b: WorkspaceRow,
  direction: WorkspaceSortDirection,
  times: ReadonlyMap<WorkspaceRow, number>,
): number {
  const aTime = times.get(a) ?? Number.NaN;
  const bTime = times.get(b) ?? Number.NaN;
  const aValid = Number.isFinite(aTime) && aTime !== 0;
  const bValid = Number.isFinite(bTime) && bTime !== 0;

  if (aValid && bValid) {
    if (aTime !== bTime) {
      return direction === "asc" ? aTime - bTime : bTime - aTime;
    }
    // Ties break on name ascending regardless of direction, so the order is
    // stable across refreshes instead of depending on array insertion order.
    return COLLATOR.compare(a.name, b.name);
  }
  if (aValid !== bValid) {
    // An unavailable or unparsable updatedAt sorts last regardless of direction: it's a
    // data-quality problem, not "oldest".
    return aValid ? -1 : 1;
  }
  return COLLATOR.compare(a.name, b.name);
}

/**
 * 検索結果の「場所」(ワークスペース名 / 親フォルダの道筋) を返す関数を作る。フォルダを ID で引けるように
 * し、組んだ道筋を覚えておくので、数千のフォルダがあっても検索結果の 1 行ごとに全フォルダをたどらない。
 * 別のワークスペースのフォルダはたどらず、親が輪になっていても止まる (`buildFolderPath` と同じ)。
 */
export function createSearchLocationResolver(
  folders: WorkspaceFolderSummary[],
  workspaces: WorkspaceOverview["workspaces"],
): (row: WorkspaceRow) => string {
  const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const paths = new Map<string, string[]>();
  const pathOf = (workspaceId: string, folderId: string | null): string[] => {
    if (!folderId) return [];
    const key = `${workspaceId}\u0000${folderId}`;
    const cached = paths.get(key);
    if (cached) return cached;
    const names: string[] = [];
    const seen = new Set<string>();
    for (let current = foldersById.get(folderId); current && current.workspaceId === workspaceId && !seen.has(current.id); current = current.parentFolderId && current.parentFolderId !== current.id ? foldersById.get(current.parentFolderId) : undefined) {
      seen.add(current.id);
      names.unshift(current.name);
    }
    paths.set(key, names);
    return names;
  };
  return (row) => {
    const item = row.kind === "file" ? row.file : row.folder;
    const parentId = row.kind === "file" ? row.file.folderId : row.folder.parentFolderId;
    return [workspaceNames.get(item.workspaceId), ...pathOf(item.workspaceId, parentId)].filter(Boolean).join(" / ");
  };
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
