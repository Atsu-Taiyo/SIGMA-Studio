"use client";

import { Building2, FilePlus, FolderPlus, LayoutTemplate, Pencil, Trash2 } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { WorkspaceFileSummary } from "@/lib/workspace-repository";
import type { WorkspaceSummary } from "@/lib/runtime/types";

import { resolveFileDisplayName } from "./workspace-format";
import { useT } from "@/lib/i18n/react";

export type WorkspaceContextMenuState = {
  x: number;
  y: number;
  folderId: string | null;
};

export type WorkspaceFileActionMenuState = {
  x: number;
  y: number;
  fileId: string;
};

export type WorkspaceNavContextMenuState = {
  x: number;
  y: number;
  workspaceId: string;
};

interface WorkspaceCreateContextMenuProps {
  menu: WorkspaceContextMenuState;
  onCreateFolder: (folderId: string | null) => void;
  onCreateDocument: (folderId: string | null) => void;
  onCreateWorkspace: () => void;
  onRenameFolder: (folderId: string) => void;
  onDeleteFolder: (folderId: string) => void;
}

export function WorkspaceCreateContextMenu({
  menu,
  onCreateFolder,
  onCreateDocument,
  onCreateWorkspace,
  onRenameFolder,
  onDeleteFolder,
}: WorkspaceCreateContextMenuProps) {
  const t = useT("workspace");

  const folderId = menu.folderId;
  return (
    <div
      className="workspace-context-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(event: ReactMouseEvent) => event.stopPropagation()}
    >
      {folderId !== null && (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => onRenameFolder(folderId)}
          >
            <Pencil size={15} />
            <span>{t("action.rename")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => onDeleteFolder(folderId)}
          >
            <Trash2 size={15} />
            <span>{t("action.deleteShort")}</span>
          </button>
        </>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={() => onCreateFolder(menu.folderId)}
      >
        <FolderPlus size={15} />
        <span>{t("newFolder")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => onCreateDocument(menu.folderId)}
      >
        <FilePlus size={15} />
        <span>{t("create.newMaterialTitle")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onCreateWorkspace}
      >
        <Building2 size={15} />
        <span>{t("newWorkspace")}</span>
      </button>
    </div>
  );
}

interface WorkspaceFileActionMenuProps {
  menu: WorkspaceFileActionMenuState;
  file: WorkspaceFileSummary;
  busy: boolean;
  saving: boolean;
  onRename: () => void;
  onAddToTemplate: () => void;
  onDelete: () => void;
}

export function WorkspaceFileActionMenu({
  menu,
  file,
  busy,
  saving,
  onRename,
  onAddToTemplate,
  onDelete,
}: WorkspaceFileActionMenuProps) {
  const t = useT("workspace");

  return (
    <div
      className="workspace-context-menu workspace-file-action-menu"
      role="menu"
      aria-label={t("action.itemMenu", { replace: { name: resolveFileDisplayName(file, t) } })}
      style={{ left: menu.x, top: menu.y }}
      onClick={(event: ReactMouseEvent) => event.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        disabled={busy || saving}
        onClick={onRename}
      >
        <Pencil size={15} />
        <span>{t("action.rename")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy || saving}
        onClick={onAddToTemplate}
      >
        <LayoutTemplate size={15} />
        <span>{t("action.addToTemplates")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="danger"
        disabled={busy || saving}
        onClick={onDelete}
      >
        <Trash2 size={15} />
        <span>{t("action.deleteShort")}</span>
      </button>
    </div>
  );
}

interface WorkspaceNavContextMenuProps {
  menu: WorkspaceNavContextMenuState;
  workspace: WorkspaceSummary;
  targetIsActive: boolean;
  saving: boolean;
  deleteDisabled: boolean;
  deleteDisabledReason: string | null;
  onRename: () => void;
  onCreateFolder: () => void;
  onCreateDocument: () => void;
  onDelete: () => void;
}

export function WorkspaceNavContextMenu({
  menu,
  workspace,
  targetIsActive,
  saving,
  deleteDisabled,
  deleteDisabledReason,
  onRename,
  onCreateFolder,
  onCreateDocument,
  onDelete,
}: WorkspaceNavContextMenuProps) {
  const t = useT("workspace");

  return (
    <div
      className="workspace-context-menu"
      role="menu"
      aria-label={t("action.itemMenu", { replace: { name: workspace.name } })}
      style={{ left: menu.x, top: menu.y }}
      onClick={(event: ReactMouseEvent) => event.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        disabled={saving}
        onClick={onRename}
      >
        <Pencil size={15} />
        <span>{t("action.rename")}</span>
      </button>
      {targetIsActive && (
        <>
          <button type="button" role="menuitem" onClick={onCreateFolder}>
            <FolderPlus size={15} />
            <span>{t("newFolder")}</span>
          </button>
          <button type="button" role="menuitem" onClick={onCreateDocument}>
            <FilePlus size={15} />
            <span>{t("create.newMaterialTitle")}</span>
          </button>
        </>
      )}
      <button
        type="button"
        role="menuitem"
        className="danger"
        disabled={deleteDisabled || saving}
        title={deleteDisabledReason ?? undefined}
        onClick={onDelete}
      >
        <Trash2 size={15} />
        <span>{t("action.deleteWorkspace")}</span>
      </button>
    </div>
  );
}
