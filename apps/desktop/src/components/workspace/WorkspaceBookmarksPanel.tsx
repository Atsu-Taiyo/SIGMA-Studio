"use client";

import { Bookmark, FileText, Folder, Loader2 } from "lucide-react";

import { DocumentTitleText } from "@/features/rendering/adapters/react";
import { useT } from "@/lib/i18n/react";

import type { WorkspaceBookmarkEntry } from "./workspace-panels-model";
import { WorkspaceBookmarkButton } from "./WorkspaceBookmarkButton";
import { WorkspaceSharedBadge } from "./WorkspaceSharedBadge";

/**
 * What the user has bookmarked, across all workspaces. Choosing a material opens it and choosing a folder goes
 * to that folder; the filled button removes the bookmark.
 */
export function WorkspaceBookmarksPanel({ entries, loading, failed, onOpen, onRemove }: {
  entries: readonly WorkspaceBookmarkEntry[];
  /** The list of materials and folders the bookmarks are resolved against is still being read. */
  loading: boolean;
  failed: boolean;
  onOpen: (entry: WorkspaceBookmarkEntry) => void;
  onRemove: (entry: WorkspaceBookmarkEntry) => void;
}) {
  const t = useT("workspace");

  return (
    <>
      <header className="workspace-panel-header">
        <h2><Bookmark size={18} aria-hidden="true" />{t("bookmarks.title")}</h2>
      </header>

      {entries.length > 0 ? (
        <ul className="workspace-bookmark-list">
          {entries.map((entry) => (
            <li className="workspace-bookmark-row" key={entry.key}>
              <button
                type="button"
                className="workspace-bookmark-open"
                aria-label={t("action.openItem", { replace: { name: entry.name } })}
                onClick={() => onOpen(entry)}
              >
                <span className="workspace-bookmark-icon">
                  {entry.kind === "folder" ? <Folder size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
                  <span className="visually-hidden">{t(entry.kind === "folder" ? "bookmarks.folder" : "bookmarks.material")}</span>
                </span>
                <span className="workspace-bookmark-text">
                  <span className="workspace-bookmark-name">
                    {entry.kind === "file" ? <DocumentTitleText title={entry.name} /> : entry.name}
                    {entry.shared && <WorkspaceSharedBadge />}
                  </span>
                  {entry.location && <small>{entry.location}</small>}
                </span>
              </button>
              <WorkspaceBookmarkButton name={entry.name} bookmarked onToggle={() => onRemove(entry)} />
            </li>
          ))}
        </ul>
      ) : loading ? (
        <p className="workspace-panel-status" role="status"><Loader2 className="workspace-spin" size={15} aria-hidden="true" />{t("status.loading")}</p>
      ) : failed ? (
        <p className="workspace-panel-status" role="alert">{t("error.loadFailed")}</p>
      ) : (
        <div className="workspace-empty-state" data-empty-variant="bookmarks">
          <Bookmark size={26} aria-hidden="true" />
          <p>{t("bookmarks.emptyTitle")}</p>
          <small>{t("bookmarks.emptyHint")}</small>
        </div>
      )}
    </>
  );
}
