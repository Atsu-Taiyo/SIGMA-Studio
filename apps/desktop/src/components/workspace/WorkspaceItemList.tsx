"use client";

import { ChevronDown, ChevronUp, Folder, FileText, Loader2, MoreHorizontal } from "lucide-react";
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { DocumentTitleText } from "@/features/rendering/adapters/react";
import type { WorkspaceFileSummary, WorkspaceFolderSummary } from "@/lib/workspace-repository";
import type { WorkspaceSortDirection, WorkspaceSortKey } from "@/lib/workspace-view-preferences";

import type { WorkspaceDragItem, WorkspaceDropTarget } from "./workspace-drag";
import { buildWorkspaceRows, resolveRowLocation, type WorkspaceRow } from "./workspace-list-model";
import { formatDateTime, resolveFileDisplayName } from "./workspace-format";
import { isInteractiveTargetWithin } from "./workspace-interaction";
import { WorkspaceEmptyState, type WorkspaceEmptyVariant } from "./WorkspaceEmptyState";
import { WorkspaceInlineRenameInput } from "./WorkspaceInlineRenameInput";
import { useAppLocale, useT } from "@/lib/i18n/react";

type DragDropProps = {
  onDragOver: (event: ReactDragEvent) => void;
  onDragLeave: (event: ReactDragEvent) => void;
  onDrop: (event: ReactDragEvent) => void;
};

interface WorkspaceItemListProps {
  folders: WorkspaceFolderSummary[];
  files: WorkspaceFileSummary[];
  allFolders: WorkspaceFolderSummary[];
  workspaceName: string;
  sortKey: WorkspaceSortKey;
  sortDirection: WorkspaceSortDirection;
  onRequestSort: (sortKey: WorkspaceSortKey, sortDirection: WorkspaceSortDirection) => void;
  searchActive: boolean;
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

function nextSort(
  requestedKey: WorkspaceSortKey,
  currentKey: WorkspaceSortKey,
  currentDirection: WorkspaceSortDirection,
): { sortKey: WorkspaceSortKey; sortDirection: WorkspaceSortDirection } {
  if (requestedKey === currentKey) {
    return { sortKey: requestedKey, sortDirection: currentDirection === "asc" ? "desc" : "asc" };
  }
  // Switching to a different column resets to that column's natural default.
  return { sortKey: requestedKey, sortDirection: requestedKey === "name" ? "asc" : "desc" };
}

function ariaSortFor(column: WorkspaceSortKey, sortKey: WorkspaceSortKey, sortDirection: WorkspaceSortDirection): "ascending" | "descending" | "none" {
  if (column !== sortKey) {
    return "none";
  }
  return sortDirection === "asc" ? "ascending" : "descending";
}

export function WorkspaceItemList({
  folders,
  files,
  allFolders,
  workspaceName,
  sortKey,
  sortDirection,
  onRequestSort,
  searchActive,
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
}: WorkspaceItemListProps) {
  const t = useT("workspace");
  const locale = useAppLocale();

  const rows = buildWorkspaceRows({ folders, files, sortKey, sortDirection, t });
  // Roving tabIndex: only focusedKey gets 0. Falls back to the first row so
  // the table stays Tab-reachable before any item has ever been focused.
  const effectiveFocusedKey = focusedKey ?? rows[0]?.key ?? null;

  const handleSortClick = (column: WorkspaceSortKey) => {
    const next = nextSort(column, sortKey, sortDirection);
    onRequestSort(next.sortKey, next.sortDirection);
  };

  const openRow = (row: WorkspaceRow) => {
    if (row.kind === "folder") {
      onOpenFolder(row.id);
    } else {
      onOpenFile(row.id);
    }
  };

  return (
    <section className="workspace-group" aria-label={searchActive ? t("search.results") : t("label.materialsAndFolders")}>
      <div className="workspace-list">
        <table className="workspace-list-table">
          <thead className="workspace-list-head">
            <tr>
              <th scope="col" aria-sort={ariaSortFor("name", sortKey, sortDirection)}>
                <button type="button" className="workspace-list-sort-button" onClick={() => handleSortClick("name")}>
                  <span>{t("label.name")}</span>
                  {sortKey === "name" && (
                    sortDirection === "asc"
                      ? <ChevronUp className="workspace-list-sort-icon" size={13} aria-hidden="true" />
                      : <ChevronDown className="workspace-list-sort-icon" size={13} aria-hidden="true" />
                  )}
                </button>
              </th>
              <th scope="col" aria-sort={ariaSortFor("updatedAt", sortKey, sortDirection)}>
                <button type="button" className="workspace-list-sort-button" onClick={() => handleSortClick("updatedAt")}>
                  <span>{t("label.updatedAt")}</span>
                  {sortKey === "updatedAt" && (
                    sortDirection === "asc"
                      ? <ChevronUp className="workspace-list-sort-icon" size={13} aria-hidden="true" />
                      : <ChevronDown className="workspace-list-sort-icon" size={13} aria-hidden="true" />
                  )}
                </button>
              </th>
              <th scope="col" className="workspace-list-cell-location">{t("label.location")}</th>
              <th scope="col"><span className="visually-hidden">{t("label.operations")}</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <WorkspaceEmptyState
                    variant={emptyVariant}
                    canCreate
                    onCreateDocument={onCreateDocument}
                    onClearSearch={onClearSearch}
                  />
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const target = row.kind === "folder" ? `folder:${row.id}` as const : null;
                const dragItemForRow: WorkspaceDragItem = row.kind === "folder"
                  ? { type: "folder", folderId: row.id }
                  : { type: "file", fileId: row.id };
                const dragging = row.kind === "folder"
                  ? dragItem?.type === "folder" && dragItem.folderId === row.id
                  : dragItem?.type === "file" && dragItem.fileId === row.id;
                const busy = row.kind === "file" && savingFileId === row.file.fileId;
                const editing = isRenameEditing(row.key);
                const selected = selectedKeys.has(row.key);

                return (
                  <tr
                    key={row.key}
                    data-item-key={row.key}
                    tabIndex={editing ? -1 : effectiveFocusedKey === row.key ? 0 : -1}
                    aria-selected={selected}
                    className={`workspace-list-row ${target && dropTarget === target ? "drop-active" : ""} ${dragging ? "dragging" : ""} ${editing ? "editing" : ""}`}
                    draggable={!editing}
                    {...dragProps(dragItemForRow)}
                    {...(target ? dropProps(target) : undefined)}
                    onClick={editing ? undefined : (event) => {
                      if (isInteractiveTargetWithin(event.target, event.currentTarget)) {
                        return;
                      }
                      onItemClick(event, row.key, rows);
                    }}
                    onDoubleClick={editing ? undefined : (event) => {
                      if (isInteractiveTargetWithin(event.target, event.currentTarget)) {
                        return;
                      }
                      openRow(row);
                    }}
                    onKeyDown={editing ? undefined : (event) => onItemKeyDown(event, row.key)}
                    onContextMenu={editing ? undefined : (event) => row.kind === "folder" && onFolderContextMenu(event, row.id)}
                  >
                    <td className="workspace-list-cell-name">
                      {/* td 自身を flex にすると table-cell でなくなり行の高さ計算から外れる。
                          必ず内側の span でレイアウトすること。 */}
                      <span className="workspace-list-name-inner">
                        <span className="workspace-list-icon">
                          {row.kind === "folder" ? <Folder size={16} /> : <FileText size={16} />}
                        </span>
                        {editing ? (
                          <WorkspaceInlineRenameInput
                            key={row.key}
                            original={row.name}
                            ariaLabel={row.kind === "folder" ? t("label.folderName") : t("label.materialName")}
                            className="workspace-list-name-text workspace-inline-rename-input"
                            onCommit={onCommitRename}
                            onCancel={onCancelRename}
                          />
                        ) : (
                          <span className="workspace-list-name-text" title={row.name}>
                            {/* 数式として読むのは教材名だけ。フォルダ名は素の文字列のまま。 */}
                            {row.kind === "file" ? <DocumentTitleText title={row.name} /> : row.name}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="workspace-list-cell-updated">{formatDateTime(row.updatedAt, locale)}</td>
                    <td className="workspace-list-cell-location">
                      {resolveRowLocation(row, { folders: allFolders, workspaceName })}
                    </td>
                    <td className="workspace-list-cell-actions">
                      {!editing && row.kind === "file" && (
                        <>
                          <button
                            type="button"
                            className="icon-button"
                            title={t("action.materialMenu")}
                            aria-label={t("action.itemMenu", { replace: { name: resolveFileDisplayName(row.file, t) } })}
                            aria-haspopup="menu"
                            aria-expanded={fileActionMenuFileId === row.file.fileId}
                            disabled={busy || saving}
                            onClick={(event) => onOpenFileActionMenu(event, row.file)}
                          >
                            {busy && saving
                              ? <Loader2 className="workspace-spin" size={15} />
                              : <MoreHorizontal size={15} />}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
