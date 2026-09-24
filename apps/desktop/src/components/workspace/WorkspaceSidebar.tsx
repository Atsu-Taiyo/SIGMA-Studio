"use client";

import { Building2, ChevronRight, FileText, Folder, Plus, Share2 } from "lucide-react";
import type { CSSProperties, Dispatch, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, SetStateAction } from "react";

import { SHARED_ITEMS_WORKSPACE_ID } from "@/lib/runtime/shared-catalog";
import { WorkspaceItemMenuButton } from "./WorkspaceItemMenuButton";
import { DocumentTitleText } from "@/features/rendering/adapters/react";
import type { WorkspaceSummary } from "@/lib/runtime/types";
import type { WorkspaceFileSummary, WorkspaceFolderSummary } from "@/lib/workspace-repository";

import type { WorkspaceDropTarget } from "./workspace-drag";
import { resolveFileDisplayName } from "./workspace-format";
import { WorkspaceInlineRenameInput } from "./WorkspaceInlineRenameInput";
import type { WorkspaceInlineRenameTarget } from "./use-inline-rename";
import { useT } from "@/lib/i18n/react";

interface WorkspaceSidebarProps {
  menuKey?: string | null;
  visibleWorkspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  workspaceTreeExpanded: boolean;
  setWorkspaceTreeExpanded: Dispatch<SetStateAction<boolean>>;
  expandedFolderIds: Set<string>;
  setExpandedFolderIds: Dispatch<SetStateAction<Set<string>>>;
  folders: WorkspaceFolderSummary[];
  files: WorkspaceFileSummary[];
  rootFolders: WorkspaceFolderSummary[];
  rootFiles: WorkspaceFileSummary[];
  effectiveFolderFilter: string;
  setFolderFilter: Dispatch<SetStateAction<string>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  dropTarget: WorkspaceDropTarget;
  dropProps: (target: WorkspaceDropTarget) => {
    onDragOver: (event: ReactDragEvent) => void;
    onDragLeave: (event: ReactDragEvent) => void;
    onDrop: (event: ReactDragEvent) => void;
  };
  onNewButtonClick: (event: ReactMouseEvent) => void;
  onSwitchWorkspace: (workspaceId: string) => void;
  onWorkspaceContextMenu: (event: ReactMouseEvent, workspaceId: string) => void;
  onOpenFile: (fileId: string) => void;
  onFolderContextMenu: (event: ReactMouseEvent, folderId: string) => void;
  onFileContextMenu: (event: ReactMouseEvent, file: WorkspaceFileSummary) => void;
  isRenameEditing: (key: string) => boolean;
  onStartRename: (target: WorkspaceInlineRenameTarget, currentName: string) => void;
  onCommitRename: (nextName: string) => void;
  onCancelRename: () => void;
}

export function WorkspaceSidebar({
  menuKey,
  visibleWorkspaces,
  activeWorkspaceId,
  workspaceTreeExpanded,
  setWorkspaceTreeExpanded,
  expandedFolderIds,
  setExpandedFolderIds,
  folders,
  files,
  rootFolders,
  rootFiles,
  effectiveFolderFilter,
  setFolderFilter,
  setSearchQuery,
  dropTarget,
  dropProps,
  onNewButtonClick,
  onSwitchWorkspace,
  onWorkspaceContextMenu,
  onOpenFile,
  onFolderContextMenu,
  onFileContextMenu,
  isRenameEditing,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: WorkspaceSidebarProps) {
  const t = useT("workspace");
  const tc = useT("chrome");

  const toggleSidebarFolder = (folderId: string) => {
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const renderFile = (file: WorkspaceFileSummary, depth: number) => (
    <div className="workspace-tree-file-row" key={file.fileId} style={{ "--workspace-tree-depth": depth } as CSSProperties}>
      <button type="button" className="workspace-tree-file"
        aria-label={resolveFileDisplayName(file, t)}
        onContextMenu={(event) => onFileContextMenu(event, file)}
        onClick={() => onOpenFile(file.fileId)}>
        <FileText size={14} />
        <span><DocumentTitleText title={resolveFileDisplayName(file, t)} /></span>
      </button>
      <WorkspaceItemMenuButton expanded={menuKey === `file:${file.fileId}`} name={resolveFileDisplayName(file, t)} onClick={(event) => onFileContextMenu(event, file)} />
    </div>
  );

  const renderSidebarFolder = (folder: WorkspaceFolderSummary, depth = 0) => {
    const childFolders = folders.filter((candidate) => candidate.parentFolderId === folder.id);
    const childFiles = files.filter((file) => file.folderId === folder.id);
    const expanded = expandedFolderIds.has(folder.id);
    const hasChildren = childFolders.length > 0 || childFiles.length > 0;

    return (
      <div className="workspace-tree-branch" key={folder.id}>
        <div className="workspace-tree-row" style={{ "--workspace-tree-depth": depth } as CSSProperties}>
          <button
            type="button"
            className="workspace-tree-toggle"
            aria-label={t("nav.toggleFolder", { replace: { name: folder.name, action: expanded ? t("nav.collapse") : t("nav.expand") } })}
            aria-expanded={expanded}
            disabled={!hasChildren}
            onClick={() => toggleSidebarFolder(folder.id)}
          >
            <ChevronRight size={14} />
          </button>
          <button
            type="button"
            className={`workspace-tree-item ${effectiveFolderFilter === folder.id ? "active" : ""}`}
            onContextMenu={(event) => onFolderContextMenu(event, folder.id)}
            onClick={() => {
              setFolderFilter(folder.id);
              setSearchQuery("");
              if (hasChildren) {
                setExpandedFolderIds((current) => new Set(current).add(folder.id));
              }
            }}
          >
            <Folder size={15} />
            <span>{folder.name}</span>
          </button>
          <WorkspaceItemMenuButton expanded={menuKey === `folder:${folder.id}`} name={folder.name} onClick={(event) => onFolderContextMenu(event, folder.id)} />
        </div>
        {expanded && (
          <div className="workspace-tree-children">
            {childFolders.map((child) => renderSidebarFolder(child, depth + 1))}
            {childFiles.map((file) => renderFile(file, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="workspace-sidebar" aria-label={t("nav.workspace")}>
      <button
        type="button"
        className="workspace-new-button"
        onClick={onNewButtonClick}
      >
        <Plus size={18} />
        <span>{t("action.new")}</span>
      </button>
      <nav className="workspace-nav" aria-label={t("nav.workspaceList")}>
        <span className="workspace-nav-label">{t("nav.workspace")}</span>
        {visibleWorkspaces.map((workspace) => {
          const target = `workspace:${workspace.id}` as const;
          const active = workspace.id === activeWorkspaceId;
          const renameKey = `workspace:${workspace.id}`;
          const editing = isRenameEditing(renameKey);
          return (
            <div className="workspace-nav-entry" key={workspace.id}>
              {editing ? (
                <div
                  className={`workspace-nav-item editing ${dropTarget === target ? "drop-active" : ""}`}
                  {...dropProps(target)}
                >
                  <ChevronRight className="workspace-nav-chevron" size={14} />
                  <Building2 size={16} />
                  <WorkspaceInlineRenameInput
                    key={renameKey}
                    original={workspace.name}
                    ariaLabel={t("nav.workspaceName")}
                    className="workspace-nav-name workspace-inline-rename-input"
                    onCommit={onCommitRename}
                    onCancel={onCancelRename}
                  />
                </div>
              ) : (
                <div className="workspace-nav-row">
                <button
                  type="button"
                  className={`workspace-nav-item ${active ? "active" : ""} ${dropTarget === target ? "drop-active" : ""}`}
                  onClick={() => {
                    if (!active) {
                      setWorkspaceTreeExpanded(workspace.sharing?.placement === "incoming");
                      setExpandedFolderIds(new Set());
                      onSwitchWorkspace(workspace.id);
                      return;
                    }
                    setWorkspaceTreeExpanded((expanded) => !expanded);
                  }}
                  onContextMenu={(event) => onWorkspaceContextMenu(event, workspace.id)}
                  onKeyDown={(event) => {
                    if (event.key === "F2") {
                      event.preventDefault();
                      onStartRename({ type: "workspace", id: workspace.id }, workspace.name);
                    }
                  }}
                  aria-expanded={active ? workspaceTreeExpanded : undefined}
                  {...dropProps(target)}
                >
                  <ChevronRight className="workspace-nav-chevron" size={14} />
                  <Building2 size={16} />
                  <span className="workspace-nav-name">{workspace.id === SHARED_ITEMS_WORKSPACE_ID ? tc("collaboration.sharedItems") : workspace.name}</span>
                  {workspace.sharing && <Share2 size={14} aria-label={tc("collaboration.sharedBadge")} />}
                </button>
                {workspace.id !== SHARED_ITEMS_WORKSPACE_ID && <WorkspaceItemMenuButton expanded={menuKey === `workspace:${workspace.id}`} name={workspace.name} onClick={(event) => onWorkspaceContextMenu(event, workspace.id)} />}
                </div>
              )}
              {active && workspaceTreeExpanded && (
                <div className="workspace-tree" aria-label={t("nav.workspaceTree", { replace: { name: workspace.name } })}>
                  {rootFolders.map((folder) => renderSidebarFolder(folder))}
                  {rootFiles.map((file) => renderFile(file, 0))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
