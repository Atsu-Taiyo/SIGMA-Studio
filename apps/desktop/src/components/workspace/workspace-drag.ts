import type { WorkspaceSummary } from "@/lib/runtime/types";
import type { WorkspaceFileSummary, WorkspaceFolderSummary } from "@/lib/workspace-repository";

export type WorkspaceDragItem =
  | { type: "file"; fileId: string }
  | { type: "folder"; folderId: string };

export type WorkspaceDropTarget = "root" | `folder:${string}` | `workspace:${string}` | null;

export function isWorkspaceDragItem(value: unknown): value is WorkspaceDragItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<WorkspaceDragItem>;
  return (
    (item.type === "file" && typeof item.fileId === "string") ||
    (item.type === "folder" && typeof item.folderId === "string")
  );
}

/**
 * Builds the "file:<id>" / "folder:<id>" selection-key vocabulary from a
 * WorkspaceDragItem -- the same vocabulary WorkspaceRow.key and
 * selectedKeys use, so a dragged item can be checked against the current
 * multi-selection.
 */
export function workspaceItemKey(item: WorkspaceDragItem): string {
  return item.type === "file" ? `file:${item.fileId}` : `folder:${item.folderId}`;
}

/**
 * Inverse of workspaceItemKey: parses a "file:<id>" / "folder:<id>" key back
 * into a WorkspaceDragItem, for reconstituting the full multi-selection into
 * draggable/deletable items. Returns null for a malformed key rather than
 * throwing, so a stale or corrupted key is silently skipped by callers.
 */
export function parseWorkspaceItemKey(key: string): WorkspaceDragItem | null {
  if (key.startsWith("file:")) {
    return { type: "file", fileId: key.slice("file:".length) };
  }
  if (key.startsWith("folder:")) {
    return { type: "folder", folderId: key.slice("folder:".length) };
  }
  return null;
}

export function isFolderDescendant(
  folders: WorkspaceFolderSummary[],
  folderId: string,
  possibleAncestorId: string,
): boolean {
  let current = folders.find((folder) => folder.id === folderId) ?? null;
  const seen = new Set<string>();
  while (current?.parentFolderId) {
    if (current.parentFolderId === possibleAncestorId) {
      return true;
    }
    if (seen.has(current.parentFolderId)) {
      return false;
    }
    seen.add(current.parentFolderId);
    current = folders.find((folder) => folder.id === current?.parentFolderId) ?? null;
  }
  return false;
}

export interface CanDropItemInput {
  item: WorkspaceDragItem | null;
  target: WorkspaceDropTarget;
  folders: WorkspaceFolderSummary[];
  files: WorkspaceFileSummary[];
  workspaces: WorkspaceSummary[];
  hasActiveWorkspace: boolean;
}

export function canDropItem(input: CanDropItemInput): boolean {
  const { item, target, folders, files, workspaces, hasActiveWorkspace } = input;
  if (!item || !target || !hasActiveWorkspace) {
    return false;
  }
  if (target === "root") {
    if (item.type === "file") {
      const file = files.find((candidate) => candidate.fileId === item.fileId);
      return Boolean(file?.folderId);
    }
    const folder = folders.find((candidate) => candidate.id === item.folderId);
    return Boolean(folder?.parentFolderId);
  }
  if (target.startsWith("folder:")) {
    const targetFolderId = target.slice("folder:".length);
    const targetFolder = folders.find((folder) => folder.id === targetFolderId);
    if (!targetFolder) {
      return false;
    }
    if (item.type === "file") {
      const file = files.find((candidate) => candidate.fileId === item.fileId);
      return Boolean(file && file.folderId !== targetFolderId);
    }
    const folder = folders.find((candidate) => candidate.id === item.folderId);
    return Boolean(
      folder &&
      folder.id !== targetFolderId &&
      folder.parentFolderId !== targetFolderId &&
      !isFolderDescendant(folders, targetFolderId, folder.id),
    );
  }
  if (target.startsWith("workspace:")) {
    if (item.type !== "file") {
      return false;
    }
    const targetWorkspaceId = target.slice("workspace:".length);
    const targetWorkspace = workspaces.find((workspace) => workspace.id === targetWorkspaceId);
    const file = files.find((candidate) => candidate.fileId === item.fileId);
    return Boolean(targetWorkspace && file && file.workspaceId !== targetWorkspaceId);
  }
  return false;
}
