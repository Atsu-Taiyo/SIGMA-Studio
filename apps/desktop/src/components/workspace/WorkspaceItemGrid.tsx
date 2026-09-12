"use client";

import { Folder, Loader2, MoreHorizontal } from "lucide-react";
import type { CSSProperties, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { DocumentTitleText } from "@/features/rendering/adapters/react";
import type { WorkspaceFileSummary, WorkspaceFolderSummary } from "@/lib/workspace-repository";
import type { WorkspaceSortDirection, WorkspaceSortKey } from "@/lib/workspace-view-preferences";

import type { WorkspaceDragItem, WorkspaceDropTarget } from "./workspace-drag";
import { buildWorkspaceRows, type WorkspaceRow } from "./workspace-list-model";
import { resolveFileDisplayName, formatDateTime } from "./workspace-format";
import { isInteractiveTargetWithin } from "./workspace-interaction";
import { WorkspaceEmptyState, type WorkspaceEmptyVariant } from "./WorkspaceEmptyState";
import { WorkspaceFileCardPreview } from "./WorkspaceFileCardPreview";
import { WorkspaceInlineRenameInput } from "./WorkspaceInlineRenameInput";
import { useAppLocale, useT } from "@/lib/i18n/react";

type DragDropProps = {
  onDragOver: (event: ReactDragEvent) => void;
  onDragLeave: (event: ReactDragEvent) => void;
  onDrop: (event: ReactDragEvent) => void;
};

interface WorkspaceItemGridProps {
  folders: WorkspaceFolderSummary[];
  files: WorkspaceFileSummary[];
  sortKey: WorkspaceSortKey;
  sortDirection: WorkspaceSortDirection;
  emptyVariant: WorkspaceEmptyVariant;
  dragItem: WorkspaceDragItem | null;
  dropTarget: WorkspaceDropTarget;
  dragProps: (item: WorkspaceDragItem) => { onDragStart: (event: ReactDragEvent) => void; onDragEnd: () => void };
  dropProps: (target: WorkspaceDropTarget) => DragDropProps;
  selectedKeys: ReadonlySet<string>;
  focusedKey: string | null;
  onItemClick: (event: ReactMouseEvent, key: string, rows: WorkspaceRow[]) => void;
  onItemKeyDown: (event: ReactKeyboardEvent, key: string) => void;
  onOpenFolder: (folderId: string) => void;
  onFolderContextMenu: (event: ReactMouseEvent, folderId: string) => void;
  onOpenFile: (fileId: string) => void;
  savingFileId: string | null;
  saving: boolean;
  fileActionMenuFileId: string | null;
  onOpenFileActionMenu: (event: ReactMouseEvent, file: WorkspaceFileSummary) => void;
  onCreateDocument: () => void;
  onClearSearch: () => void;
  isRenameEditing: (key: string) => boolean;
  onCommitRename: (nextName: string) => void;
  onCancelRename: () => void;
}

export function WorkspaceItemGrid({
  folders,
  files,
  sortKey,
  sortDirection,
  emptyVariant,
  dragItem,
  dropTarget,
  dragProps,
  dropProps,
  selectedKeys,
  focusedKey,
  onItemClick,
  onItemKeyDown,
  onOpenFolder,
  onFolderContextMenu,
  onOpenFile,
  savingFileId,
  saving,
  fileActionMenuFileId,
  onOpenFileActionMenu,
  onCreateDocument,
  onClearSearch,
  isRenameEditing,
  onCommitRename,
  onCancelRename,
}: WorkspaceItemGridProps) {
  const t = useT("workspace");
  const locale = useAppLocale();

  const rows = buildWorkspaceRows({ folders, files, sortKey, sortDirection, t });
  const sortedFolders = rows.filter((row) => row.kind === "folder").map((row) => row.folder);
  const sortedFiles = rows.filter((row) => row.kind === "file").map((row) => row.file);
  // Roving tabIndex: only focusedKey gets 0. Falls back to the first row so
  // the grid stays Tab-reachable before any item has ever been focused.
  const effectiveFocusedKey = focusedKey ?? rows[0]?.key ?? null;

  return (
    <>
      {sortedFolders.length > 0 && (
        <section className="workspace-group" aria-label={t("label.folders")}>
          <h3 className="workspace-group-title">{t("label.folders")}</h3>
          <div className="workspace-item-grid" style={{ "--workspace-item-min": "200px" } as CSSProperties}>
            {sortedFolders.map((folder) => {
              const target = `folder:${folder.id}` as const;
              const dragging = dragItem?.type === "folder" && dragItem.folderId === folder.id;
              const key = `folder:${folder.id}`;
              const editing = isRenameEditing(key);
              const selected = selectedKeys.has(key);
              return (
                <div
                  className={`workspace-folder-card ${dropTarget === target ? "drop-active" : ""} ${dragging ? "dragging" : ""} ${editing ? "editing" : ""} ${selected ? "selected" : ""}`}
                  role={editing ? undefined : "button"}
                  tabIndex={editing ? -1 : effectiveFocusedKey === key ? 0 : -1}
                  key={folder.id}
                  data-item-key={key}
                  aria-label={editing ? undefined : t("action.openItem", { replace: { name: folder.name } })}
                  draggable={!editing}
                  {...dragProps({ type: "folder", folderId: folder.id })}
                  {...dropProps(target)}
                  onClick={editing ? undefined : (event) => {
                    if (isInteractiveTargetWithin(event.target, event.currentTarget)) {
                      return;
                    }
                    onItemClick(event, key, rows);
                  }}
                  onDoubleClick={editing ? undefined : (event) => {
                    if (isInteractiveTargetWithin(event.target, event.currentTarget)) {
                      return;
                    }
                    onOpenFolder(folder.id);
                  }}
                  onContextMenu={editing ? undefined : (event) => onFolderContextMenu(event, folder.id)}
                  onKeyDown={editing ? undefined : (event) => onItemKeyDown(event, key)}
                >
                  <Folder size={16} />
                  {editing ? (
                    <WorkspaceInlineRenameInput
                      key={key}
                      original={folder.name}
                      ariaLabel={t("label.folderName")}
                      className="workspace-folder-card-name workspace-inline-rename-input"
                      onCommit={onCommitRename}
                      onCancel={onCancelRename}
                    />
                  ) : (
                    <span className="workspace-folder-card-name">{folder.name}</span>
                  )}
                  <small>{folder.fileCount}</small>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="workspace-group" aria-label={t("label.materials")}>
        <h3 className="workspace-group-title">{t("label.materials")}</h3>
        {sortedFiles.length === 0 ? (
          <WorkspaceEmptyState
            variant={emptyVariant}
            canCreate
            onCreateDocument={onCreateDocument}
            onClearSearch={onClearSearch}
          />
        ) : (
          <div className="workspace-item-grid" style={{ "--workspace-item-min": "232px" } as CSSProperties}>
            {sortedFiles.map((file) => {
              const dragging = dragItem?.type === "file" && dragItem.fileId === file.fileId;
              const busy = savingFileId === file.fileId;
              const displayName = resolveFileDisplayName(file, t);
              const key = `file:${file.fileId}`;
              const editing = isRenameEditing(key);
              const selected = selectedKeys.has(key);
              return (
                <div
                  className={`workspace-file-card ${dragging ? "dragging" : ""} ${editing ? "editing" : ""} ${selected ? "selected" : ""}`}
                  role={editing ? undefined : "button"}
                  tabIndex={editing ? -1 : effectiveFocusedKey === key ? 0 : -1}
                  key={file.fileId}
                  data-item-key={key}
                  aria-label={editing ? undefined : t("action.openItem", { replace: { name: displayName } })}
                  draggable={!editing}
                  {...dragProps({ type: "file", fileId: file.fileId })}
                  onClick={editing ? undefined : (event) => {
                    if (isInteractiveTargetWithin(event.target, event.currentTarget)) {
                      return;
                    }
                    onItemClick(event, key, rows);
                  }}
                  onDoubleClick={editing ? undefined : (event) => {
                    if (isInteractiveTargetWithin(event.target, event.currentTarget)) {
                      return;
                    }
                    onOpenFile(file.fileId);
                  }}
                  onKeyDown={editing ? undefined : (event) => onItemKeyDown(event, key)}
                >
                  <div className="workspace-file-card-preview" aria-hidden="true">
                    <WorkspaceFileCardPreview
                      fileId={file.fileId}
                      revision={file.revision}
                      updatedAt={file.updatedAt}
                    />
                  </div>
                  <div className="workspace-file-card-body">
                    {editing ? (
                      <WorkspaceInlineRenameInput
                        key={key}
                        original={displayName}
                        ariaLabel={t("label.materialName")}
                        className="workspace-inline-rename-input"
                        onCommit={onCommitRename}
                        onCancel={onCancelRename}
                      />
                    ) : (
                      <strong><DocumentTitleText title={displayName} /></strong>
                    )}
                    <small>{formatDateTime(file.updatedAt, locale)}</small>
                  </div>
                  {!editing && (
                  <div className="workspace-file-card-actions">
                    <button
                      type="button"
                      className="icon-button"
                      title={t("action.materialMenu")}
                      aria-label={t("action.itemMenu", { replace: { name: displayName } })}
                      aria-haspopup="menu"
                      aria-expanded={fileActionMenuFileId === file.fileId}
                      disabled={busy || saving}
                      onClick={(event) => onOpenFileActionMenu(event, file)}
                    >
                      {busy && saving
                        ? <Loader2 className="workspace-spin" size={15} />
                        : <MoreHorizontal size={15} />}
                    </button>
                  </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
