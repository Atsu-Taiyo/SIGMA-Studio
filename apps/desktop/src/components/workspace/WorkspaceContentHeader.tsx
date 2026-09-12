"use client";

import { ChevronRight, Pencil, Trash2 } from "lucide-react";
import { Fragment } from "react";
import type { DragEvent as ReactDragEvent } from "react";

import type { WorkspaceFolderSummary } from "@/lib/workspace-repository";
import type { WorkspaceViewMode } from "@/lib/workspace-view-preferences";

import type { WorkspaceDropTarget } from "./workspace-drag";
import { resolveFolderDisplayName } from "./workspace-format";
import { WorkspaceViewToggle } from "./WorkspaceViewToggle";
import { useT } from "@/lib/i18n/react";

interface WorkspaceContentHeaderProps {
  workspaceName: string;
  folderPath: WorkspaceFolderSummary[];
  selectedFolder: WorkspaceFolderSummary | null;
  searchActive: boolean;
  dropTarget: WorkspaceDropTarget;
  dropProps: (target: WorkspaceDropTarget) => {
    onDragOver: (event: ReactDragEvent) => void;
    onDragLeave: (event: ReactDragEvent) => void;
    onDrop: (event: ReactDragEvent) => void;
  };
  onNavigateRoot: () => void;
  onNavigateFolder: (folderId: string) => void;
  viewMode: WorkspaceViewMode;
  onViewModeChange: (mode: WorkspaceViewMode) => void;
  onEditFolder: () => void;
  onDeleteFolder: () => void;
}

export function WorkspaceContentHeader({
  workspaceName,
  folderPath,
  selectedFolder,
  searchActive,
  dropTarget,
  dropProps,
  onNavigateRoot,
  onNavigateFolder,
  viewMode,
  onViewModeChange,
  onEditFolder,
  onDeleteFolder,
}: WorkspaceContentHeaderProps) {
  const t = useT("workspace");

  const atRoot = !searchActive && folderPath.length === 0;
  const showFolderActions = !searchActive && Boolean(selectedFolder);

  return (
    <div className="workspace-content-header">
      <nav className="workspace-breadcrumb" aria-label={t("nav.currentLocation")}>
        {atRoot ? (
          <span className="workspace-breadcrumb-item" data-current="true">{workspaceName}</span>
        ) : (
          <button
            type="button"
            className={`workspace-breadcrumb-item workspace-breadcrumb-crumb ${dropTarget === "root" ? "drop-active" : ""}`}
            onClick={onNavigateRoot}
            {...dropProps("root")}
          >
            {workspaceName}
          </button>
        )}
        {searchActive ? (
          <Fragment>
            <ChevronRight size={15} aria-hidden="true" />
            <span className="workspace-breadcrumb-item" data-current="true">{t("search.results")}</span>
          </Fragment>
        ) : (
          folderPath.map((folder, index) => {
            const isLast = index === folderPath.length - 1;
            const target = `folder:${folder.id}` as const;
            return (
              <Fragment key={folder.id}>
                <ChevronRight size={15} aria-hidden="true" />
                {isLast ? (
                  <span className="workspace-breadcrumb-item" data-current="true">
                    {resolveFolderDisplayName(folder)}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={`workspace-breadcrumb-item workspace-breadcrumb-crumb ${dropTarget === target ? "drop-active" : ""}`}
                    onClick={() => onNavigateFolder(folder.id)}
                    {...dropProps(target)}
                  >
                    {resolveFolderDisplayName(folder)}
                  </button>
                )}
              </Fragment>
            );
          })
        )}
      </nav>
      <div className="workspace-content-header-actions">
        <WorkspaceViewToggle value={viewMode} onChange={onViewModeChange} />
        {showFolderActions && selectedFolder && (
          <>
            <button
              type="button"
              className="icon-button"
              title={t("action.moveFolder")}
              aria-label={t("action.moveFolder")}
              onClick={onEditFolder}
            >
              <Pencil size={15} />
            </button>
            <button
              type="button"
              className="icon-button danger"
              title={t("action.deleteFolder")}
              aria-label={t("action.deleteFolder")}
              onClick={onDeleteFolder}
            >
              <Trash2 size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
