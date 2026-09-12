"use client";

import { Building2, ChevronRight, FileText, Folder, Plus } from "lucide-react";
import type { CSSProperties, Dispatch, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, SetStateAction } from "react";

import { DocumentTitleText } from "@/features/rendering/adapters/react";
import type { WorkspaceSummary } from "@/lib/runtime/types";
import type { WorkspaceFileSummary, WorkspaceFolderSummary } from "@/lib/workspace-repository";

import type { WorkspaceDropTarget } from "./workspace-drag";
import { resolveFileDisplayName } from "./workspace-format";
import { WorkspaceInlineRenameInput } from "./WorkspaceInlineRenameInput";
import type { WorkspaceInlineRenameTarget } from "./use-inline-rename";
import { useT } from "@/lib/i18n/react";

interface WorkspaceSidebarProps {
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
  isRenameEditing: (key: string) => boolean;
  onStartRename: (target: WorkspaceInlineRenameTarget, currentName: string) => void;
  onCommitRename: (nextName: string) => void;
  onCancelRename: () => void;
}

export function WorkspaceSidebar({
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
  isRenameEditing,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: WorkspaceSidebarProps) {
  const t = useT("workspace");

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
        </div>
        {expanded && (
          <div className="workspace-tree-children">
            {childFolders.map((child) => renderSidebarFolder(child, depth + 1))}
            {childFiles.map((file) => (
              <button
                type="button"
                className="workspace-tree-file"
                style={{ "--workspace-tree-depth": depth + 1 } as CSSProperties}
                key={file.fileId}
                aria-label={resolveFileDisplayName(file, t)}
                onClick={() => onOpenFile(file.fileId)}
              >
                <FileText size={14} />
                <span><DocumentTitleText title={resolveFileDisplayName(file, t)} /></span>
              </button>
            ))}
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
                <button
                  type="button"
                  className={`workspace-nav-item ${active ? "active" : ""} ${dropTarget === target ? "drop-active" : ""}`}
                  onClick={() => {
                    if (!active) {
                      setWorkspaceTreeExpanded(false);
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
                  <span className="workspace-nav-name">{workspace.name}</span>
                </button>
              )}
              {active && workspaceTreeExpanded && (
                <div className="workspace-tree" aria-label={t("nav.workspaceTree", { replace: { name: workspace.name } })}>
                  {rootFolders.map((folder) => renderSidebarFolder(folder))}
                  {rootFiles.map((file) => (
                    <button
                      type="button"
                      className="workspace-tree-file"
                      style={{ "--workspace-tree-depth": 0 } as CSSProperties}
                      key={file.fileId}
                      aria-label={resolveFileDisplayName(file, t)}
                      onClick={() => onOpenFile(file.fileId)}
                    >
                      <FileText size={14} />
                      <span><DocumentTitleText title={resolveFileDisplayName(file, t)} /></span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
