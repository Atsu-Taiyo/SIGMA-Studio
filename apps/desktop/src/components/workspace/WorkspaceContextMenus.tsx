"use client";

import { Building2, FilePlus, FolderPlus, LayoutTemplate, Pencil, Share2, Trash2 } from "lucide-react";
import { WorkspaceMenuSurface } from "./WorkspaceMenuSurface";

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
  onShare?: () => void;
  canRename?: boolean;
  canDelete?: boolean;
  canCreate?: boolean;
  onRenameFolder: (folderId: string) => void;
  onDeleteFolder: (folderId: string) => void;
}

export function WorkspaceCreateContextMenu({
  menu,
  onCreateFolder,
  onCreateDocument,
  onCreateWorkspace,
  onShare,
  canRename = true,
  canDelete = true,
  canCreate = true,
  onRenameFolder,
  onDeleteFolder,
}: WorkspaceCreateContextMenuProps) {
  const t = useT("workspace");
  const tc = useT("chrome");

  const folderId = menu.folderId;
  return (
    <WorkspaceMenuSurface
      className="workspace-context-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
    >
      {onShare && <button type="button" role="menuitem" onClick={onShare}><Share2 size={15} /><span>{tc("collaboration.shareAction")}</span></button>}
      {folderId !== null && (
        <>
          <button
            type="button"
            role="menuitem"
            disabled={!canRename}
            onClick={() => onRenameFolder(folderId)}
          >
            <Pencil size={15} />
            <span>{t("action.rename")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={!canDelete}
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
        disabled={!canCreate}
        onClick={() => onCreateFolder(menu.folderId)}
      >
        <FolderPlus size={15} />
        <span>{t("newFolder")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!canCreate}
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
    </WorkspaceMenuSurface>
  );
}

interface WorkspaceFileActionMenuProps {
  menu: WorkspaceFileActionMenuState;
  file: WorkspaceFileSummary;
  busy: boolean;
  saving: boolean;
  onShare?: () => void;
  canRename?: boolean;
  canDelete?: boolean;
  canCreate?: boolean;
  onRename: () => void;
  onAddToTemplate: () => void;
  onDelete: () => void;
}

export function WorkspaceFileActionMenu({
  menu,
  file,
  busy,
  saving,
  onShare,
  canRename = true,
  canDelete = true,
  onRename,
  onAddToTemplate,
  onDelete,
}: WorkspaceFileActionMenuProps) {
  const t = useT("workspace");
  const tc = useT("chrome");

  return (
    <WorkspaceMenuSurface
      className="workspace-context-menu workspace-file-action-menu"
      role="menu"
      aria-label={t("action.itemMenu", { replace: { name: resolveFileDisplayName(file, t) } })}
      style={{ left: menu.x, top: menu.y }}
    >
      {onShare && <button type="button" role="menuitem" onClick={onShare}><Share2 size={15} /><span>{tc("collaboration.shareAction")}</span></button>}
      <button
        type="button"
        role="menuitem"
        disabled={busy || saving || !canRename}
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
        disabled={busy || saving || !canDelete}
        onClick={onDelete}
      >
        <Trash2 size={15} />
        <span>{t("action.deleteShort")}</span>
      </button>
    </WorkspaceMenuSurface>
  );
}

interface WorkspaceNavContextMenuProps {
  menu: WorkspaceNavContextMenuState;
  workspace: WorkspaceSummary;
  targetIsActive: boolean;
  saving: boolean;
  deleteDisabled: boolean;
  deleteDisabledReason: string | null;
  onShare?: () => void;
  canRename?: boolean;
  canDelete?: boolean;
  canCreate?: boolean;
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
  onShare,
  canRename = true,
  canDelete = true,
  canCreate = true,
  onRename,
  onCreateFolder,
  onCreateDocument,
  onDelete,
}: WorkspaceNavContextMenuProps) {
  const t = useT("workspace");
  const tc = useT("chrome");

  return (
    <WorkspaceMenuSurface
      className="workspace-context-menu"
      role="menu"
      aria-label={t("action.itemMenu", { replace: { name: workspace.name } })}
      style={{ left: menu.x, top: menu.y }}
    >
      {onShare && <button type="button" role="menuitem" onClick={onShare}><Share2 size={15} /><span>{tc("collaboration.shareAction")}</span></button>}
      <button
        type="button"
        role="menuitem"
        disabled={saving || !canRename}
        onClick={onRename}
      >
        <Pencil size={15} />
        <span>{t("action.rename")}</span>
      </button>
      {targetIsActive && (
        <>
          <button type="button" role="menuitem" disabled={!canCreate} onClick={onCreateFolder}>
            <FolderPlus size={15} />
            <span>{t("newFolder")}</span>
          </button>
          <button type="button" role="menuitem" disabled={!canCreate} onClick={onCreateDocument}>
            <FilePlus size={15} />
            <span>{t("create.newMaterialTitle")}</span>
          </button>
        </>
      )}
      <button
        type="button"
        role="menuitem"
        className="danger"
        disabled={deleteDisabled || saving || !canDelete}
        title={deleteDisabledReason ?? undefined}
        onClick={onDelete}
      >
        <Trash2 size={15} />
        <span>{t("action.deleteWorkspace")}</span>
      </button>
    </WorkspaceMenuSurface>
  );
}
