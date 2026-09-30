"use client";

import { AtSign, Check, ChevronRight, Loader2, MessageSquare } from "lucide-react";
import { useState } from "react";

import { DocumentTitleText } from "@/features/rendering/adapters/react";
import { useAppLocale, useT } from "@/lib/i18n/react";

import { formatDateTime } from "./workspace-format";
import { filterCommentEntries, type WorkspaceCommentEntry, type WorkspaceCommentFilter } from "./workspace-panels-model";
import { WorkspaceSharedBadge } from "./WorkspaceSharedBadge";

const FILTERS: readonly { value: WorkspaceCommentFilter; label: "comments.filterAll" | "comments.filterMentioned" | "comments.filterAuthored" }[] = [
  { value: "all", label: "comments.filterAll" },
  { value: "mentioned", label: "comments.filterMentioned" },
  { value: "authored", label: "comments.filterAuthored" },
];

/**
 * Every comment thread that involves the signed-in user across all workspaces: threads that mention them and
 * threads they wrote in. Choosing one opens that material at that thread.
 */
export function WorkspaceCommentsPanel({ entries, signedIn, scanning, onOpen }: {
  entries: readonly WorkspaceCommentEntry[];
  signedIn: boolean;
  /** The first pass over the materials has not finished yet. */
  scanning: boolean;
  onOpen: (entry: WorkspaceCommentEntry) => void;
}) {
  const t = useT("workspace");
  const locale = useAppLocale();
  const [relation, setRelation] = useState<WorkspaceCommentFilter>("all");
  const [includeResolved, setIncludeResolved] = useState(false);
  const visible = filterCommentEntries(entries, { relation, includeResolved });

  return (
    <>
      <header className="workspace-panel-header">
        <h2><MessageSquare size={18} aria-hidden="true" />{t("comments.title")}</h2>
        {signedIn && (
          <div className="workspace-panel-tools">
            <div className="workspace-segmented" role="group" aria-label={t("comments.filterLabel")}>
              {FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  aria-pressed={relation === filter.value}
                  onClick={() => setRelation(filter.value)}
                >{t(filter.label)}</button>
              ))}
            </div>
            <label className="workspace-panel-toggle">
              <input type="checkbox" checked={includeResolved} onChange={(event) => setIncludeResolved(event.target.checked)} />
              <span>{t("comments.showResolved")}</span>
            </label>
          </div>
        )}
      </header>

      {!signedIn ? (
        <div className="workspace-empty-state" data-empty-variant="comments-signed-out">
          <MessageSquare size={26} aria-hidden="true" />
          <p>{t("comments.signedOutTitle")}</p>
          <small>{t("comments.signedOutHint")}</small>
        </div>
      ) : visible.length === 0 ? (
        scanning && entries.length === 0 ? (
          <p className="workspace-panel-status" role="status"><Loader2 className="workspace-spin" size={15} aria-hidden="true" />{t("comments.loading")}</p>
        ) : (
          <div className="workspace-empty-state" data-empty-variant="comments">
            <MessageSquare size={26} aria-hidden="true" />
            <p>{entries.length === 0 ? t("comments.emptyTitle") : t("comments.emptyFilteredTitle")}</p>
            {entries.length === 0 && <small>{t("comments.emptyHint")}</small>}
          </div>
        )
      ) : (
        <ul className="workspace-comment-list">
          {visible.map((entry) => (
            <li key={entry.key}>
              <button
                type="button"
                className={`workspace-comment-item${entry.resolved ? " is-resolved" : ""}`}
                data-comment-thread-id={entry.threadId}
                aria-label={t("comments.open", { replace: { title: entry.title || entry.location } })}
                onClick={() => onOpen(entry)}
              >
                <span className="workspace-comment-item-main">
                  <span className="workspace-comment-item-head">
                    <strong className="workspace-comment-item-title"><DocumentTitleText title={entry.title} /></strong>
                    {entry.shared && <WorkspaceSharedBadge />}
                    {entry.mentioned && <span className="workspace-comment-tag is-mention"><AtSign size={11} aria-hidden="true" />{t("comments.tagMentioned")}</span>}
                    {entry.authored && <span className="workspace-comment-tag">{t("comments.tagAuthored")}</span>}
                    {entry.resolved && <span className="workspace-comment-tag"><Check size={11} aria-hidden="true" />{t("comments.resolved")}</span>}
                    <time className="workspace-comment-item-time" dateTime={entry.activityAt}>{formatDateTime(entry.activityAt, locale)}</time>
                  </span>
                  {entry.location && <span className="workspace-comment-item-location">{entry.location}</span>}
                  {entry.excerpt && (
                    <span className="workspace-comment-item-message">
                      <span className="workspace-comment-item-author">{entry.ownMessage ? t("comments.you") : entry.authorName ?? t("comments.unknownAuthor")}</span>
                      {entry.excerpt}
                    </span>
                  )}
                  {entry.quote && <span className="workspace-comment-item-quote">{entry.quote}</span>}
                  {entry.messageCount > 1 && <span className="workspace-comment-item-count">{t("comments.messageCount", { count: entry.messageCount })}</span>}
                </span>
                <ChevronRight className="workspace-comment-item-go" size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
