"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Check, MessageSquarePlus, MoreHorizontal, Pencil, Reply, RotateCcw, Search, Smile, Trash2 } from "lucide-react";

import { CommentAuthorAvatar } from "@/components/editor/CommentAuthorAvatar";
import { CommentRichTextEditor } from "@/components/editor/CommentRichTextEditor";
import { renderInlineContent } from "@/features/rendering/adapters/react";
import {
  COMMENT_REACTION_USAGE_STORAGE_KEY,
  getFrequentCommentReactionEmojis,
  getQuickCommentReactionEmojis,
  parseCommentReactionUsage,
  recordCommentReactionUsage,
  searchCommentReactionEmojis,
  type CommentReactionUsage,
} from "@/components/editor/comment-reactions";
import {
  getCommentAnchorLabel,
  getCommentAnchorQuote,
  isInlineBodyEmpty,
} from "@/lib/comments";
import type { AppLocale } from "@/lib/i18n";
import { useAppLocale, useT } from "@/lib/i18n/react";
import type { SigmaCommentAgent, SigmaCommentAnchor, SigmaCommentMessage, SigmaCommentReaction, SigmaCommentThread, SigmaDocument, InlineNode } from "@/features/document";

const COMMENT_CARD_GAP_PX = 12;
const COMMENT_EMPTY_STATE_HEIGHT_PX = 150;
const COMMENT_THREAD_CARD_HEIGHT_PX = 152;
const COMMENT_COMPOSE_CARD_HEIGHT_PX = 188;

interface CommentReactionTarget {
  messageId: string;
  threadId: string;
}

export interface CommentPanelAuthor {
  avatarUrl?: string | null;
  name: string;
  /** AI が書いたときだけ入る。アバターを提供元のロゴに差し替える根拠。 */
  agent?: SigmaCommentAgent | null;
}

export interface CommentThreadsPanelProps {
  activeThreadId: string | null;
  author: CommentPanelAuthor;
  candidateAnchor: SigmaCommentAnchor | null;
  document: SigmaDocument;
  pendingAnchor: SigmaCommentAnchor | null;
  pendingDraft: InlineNode[];
  replyDrafts: Record<string, InlineNode[]>;
  showResolved: boolean;
  candidateTop?: number | null;
  panelHeight?: number;
  pendingTop?: number | null;
  threadPositions?: Record<string, number>;
  threads: SigmaCommentThread[];
  onAddThread: () => void;
  onCancelPending: () => void;
  onDeleteMessage: (threadId: string, messageId: string) => void;
  onDeleteThread: (threadId: string) => void;
  onEditMessage: (threadId: string, messageId: string, body: InlineNode[]) => void;
  onEditThread: (threadId: string, body: InlineNode[]) => void;
  onPendingDraftChange: (value: InlineNode[]) => void;
  onReply: (threadId: string) => void;
  onReplyDraftChange: (threadId: string, value: InlineNode[]) => void;
  onResolveThread: (threadId: string) => void;
  onReopenThread: (threadId: string) => void;
  onSelectThread: (threadId: string) => void;
  onShowResolvedChange: (showResolved: boolean) => void;
  onStartThread: (anchor: SigmaCommentAnchor | null) => void;
  onThreadHoverChange?: (threadId: string | null) => void;
  onToggleReaction: (threadId: string, messageId: string, emoji: string) => void;
}

export function CommentThreadsPanel({
  activeThreadId,
  author,
  candidateAnchor,
  document,
  pendingAnchor,
  pendingDraft,
  replyDrafts,
  showResolved,
  panelHeight,
  pendingTop = null,
  threadPositions,
  threads,
  onAddThread,
  onCancelPending,
  onDeleteMessage,
  onDeleteThread,
  onEditMessage,
  onEditThread,
  onPendingDraftChange,
  onReply,
  onReplyDraftChange,
  onResolveThread,
  onReopenThread,
  onSelectThread,
  onShowResolvedChange,
  onStartThread,
  onThreadHoverChange,
  onToggleReaction,
}: CommentThreadsPanelProps) {
  const t = useT("editor");
  const locale = useAppLocale();
  const mathFractionSizing = document.metadata.mathFractionSizing;
  const allThreads = document.comments ?? [];
  const unresolvedCount = allThreads.filter((thread) => !thread.resolved).length;
  const resolvedCount = allThreads.length - unresolvedCount;
  const panelBodyRef = useRef<HTMLDivElement | null>(null);
  const [measuredCardHeights, setMeasuredCardHeights] = useState<Record<string, number>>({});
  const [editingMessageKey, setEditingMessageKey] = useState<string | null>(null);
  const [editDrafts, setEditDrafts] = useState<Record<string, InlineNode[]>>({});
  const [openMenuMessageKey, setOpenMenuMessageKey] = useState<string | null>(null);
  const [reactionPickerTarget, setReactionPickerTarget] = useState<CommentReactionTarget | null>(null);
  const [reactionSearchQuery, setReactionSearchQuery] = useState("");
  const [reactionUsage, setReactionUsage] = useState<CommentReactionUsage>(loadStoredCommentReactionUsage);
  const [recentReactionKey, setRecentReactionKey] = useState<string | null>(null);
  const [expandedReplyThreadIds, setExpandedReplyThreadIds] = useState<Set<string>>(() => new Set());
  const quickReactionEmojis = useMemo(() => getQuickCommentReactionEmojis(reactionUsage), [reactionUsage]);
  const frequentReactionEmojis = useMemo(() => getFrequentCommentReactionEmojis(reactionUsage), [reactionUsage]);
  const recentReactionEmojis = reactionUsage.recent;
  const cardMeasurementKey = useMemo(() => JSON.stringify({
    editingMessageKey,
    expandedReplyThreadIds: Array.from(expandedReplyThreadIds).sort(),
    pending: Boolean(pendingAnchor),
    replyDrafts: Object.entries(replyDrafts).map(([threadId, draft]) => [threadId, draft.length]),
    threads: threads.map((thread) => [
      thread.id,
      thread.resolved,
      thread.messages.length,
      thread.messages.map((message) => message.body.length).join(","),
      thread.messages.map((message) => message.reactions?.length ?? 0).join(","),
      thread.reactions?.length ?? 0,
    ]),
  }), [editingMessageKey, expandedReplyThreadIds, pendingAnchor, replyDrafts, threads]);

  useLayoutEffect(() => {
    if (!recentReactionKey) {
      return;
    }
    const timeoutId = window.setTimeout(() => setRecentReactionKey(null), 700);
    return () => window.clearTimeout(timeoutId);
  }, [recentReactionKey]);

  useLayoutEffect(() => {
    const panelBody = panelBodyRef.current;
    if (!panelBody) {
      return;
    }

    let frameId = 0;
    const measureCardHeights = () => {
      frameId = 0;
      const nextHeights: Record<string, number> = {};
      panelBody.querySelectorAll<HTMLElement>("[data-comment-card-key]").forEach((element) => {
        const key = element.dataset.commentCardKey;
        if (!key) {
          return;
        }
        nextHeights[key] = Math.ceil(element.getBoundingClientRect().height);
      });
      setMeasuredCardHeights((currentHeights) => (
        areNumberRecordsEqual(currentHeights, nextHeights) ? currentHeights : nextHeights
      ));
    };
    const requestMeasure = () => {
      if (frameId === 0) {
        frameId = window.requestAnimationFrame(measureCardHeights);
      }
    };

    requestMeasure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(requestMeasure) : null;
    panelBody.querySelectorAll<HTMLElement>("[data-comment-card-key]").forEach((element) => {
      observer?.observe(element);
    });
    window.addEventListener("resize", requestMeasure);
    return () => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
      observer?.disconnect();
      window.removeEventListener("resize", requestMeasure);
    };
  }, [cardMeasurementKey]);

  const recordReaction = (emoji: string) => {
    setReactionUsage((currentUsage) => {
      const nextUsage = recordCommentReactionUsage(currentUsage, emoji);
      try {
        window.localStorage.setItem(COMMENT_REACTION_USAGE_STORAGE_KEY, JSON.stringify(nextUsage));
      } catch {
        // Reactions should still work even if browser storage is unavailable.
      }
      return nextUsage;
    });
  };

  const toggleReaction = (threadId: string, messageId: string, emoji: string) => {
    onToggleReaction(threadId, messageId, emoji);
    recordReaction(emoji);
    setRecentReactionKey(getReactionAnimationKey(threadId, messageId, emoji));
    setReactionPickerTarget(null);
    setReactionSearchQuery("");
  };

  const positionedItems = getPositionedCommentItems({
    measuredCardHeights,
    pendingAnchor,
    pendingTop,
    threadPositions,
    threads,
  });

  return (
    <aside
      className="comment-thread-panel"
      aria-label={t("comment.panelAria", { comments: unresolvedCount })}
      style={{ minHeight: panelHeight ? `${Math.max(240, panelHeight)}px` : undefined }}
    >
      <div className="comment-thread-panel-body" ref={panelBodyRef}>
        {pendingAnchor && (
          <section className="comment-compose-card pending" data-comment-card-key="pending" style={positionedItems.pendingStyle}>
            <CommentAuthorLine author={author} />
            <CommentQuote anchor={pendingAnchor} />
            <CommentRichTextEditor
              value={pendingDraft}
              mathFractionSizing={mathFractionSizing}
              placeholder={t("comment.agentPlaceholder")}
              onChange={onPendingDraftChange}
            />
            <ComposerActions
              disabled={isInlineBodyEmpty(pendingDraft)}
              primaryLabel={t("comment.add")}
              onCancel={onCancelPending}
              onSubmit={onAddThread}
            />
          </section>
        )}

        {threads.length === 0 && !pendingAnchor && (
          <div className="comment-empty-state" data-comment-card-key="empty" style={positionedItems.emptyStyle}>
            <MessageSquarePlus size={20} aria-hidden="true" />
            <strong>{t("comment.none")}</strong>
            <span>{t("comment.emptyHint")}</span>
            <button type="button" onClick={() => onStartThread(candidateAnchor)}>
              {t("comment.addComment")}
            </button>
          </div>
        )}

        {positionedItems.threads.map(({ style, thread }) => {
          const active = thread.id === activeThreadId;
          const replyDraft = replyDrafts[thread.id] ?? [];
          const repliesExpanded = expandedReplyThreadIds.has(thread.id);
          const replyCount = getReplyCount(thread);
          const firstMessage = thread.messages[0];
          const cardAuthor = getMessageAuthor(firstMessage, author);
          return (
            <section
              key={thread.id}
              className={`comment-thread-card ${active ? "active" : ""} ${thread.resolved ? "resolved" : ""}`}
              data-comment-card-key={thread.id}
              style={style}
              onMouseEnter={() => onThreadHoverChange?.(thread.id)}
              onMouseLeave={() => onThreadHoverChange?.(null)}
              onFocus={() => onThreadHoverChange?.(thread.id)}
              onBlur={(event) => {
                const nextFocus = event.relatedTarget;
                if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) {
                  onThreadHoverChange?.(null);
                }
              }}
              onClick={() => {
                setOpenMenuMessageKey(null);
                setReactionPickerTarget(null);
                onSelectThread(thread.id);
              }}
            >
              <div className="comment-thread-card-header">
                <CommentAuthorLine author={cardAuthor} timestamp={firstMessage?.createdAt} />
                <button
                  type="button"
                  className={`comment-thread-resolve-button${thread.resolved ? " is-resolved" : ""}`}
                  title={thread.resolved ? t("comment.reopen") : t("comment.resolve")}
                  aria-label={thread.resolved ? t("comment.reopen") : t("comment.resolve")}
                  aria-pressed={Boolean(thread.resolved)}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (thread.resolved) {
                      onReopenThread(thread.id);
                    } else {
                      onResolveThread(thread.id);
                    }
                  }}
                >
                  {thread.resolved ? <RotateCcw size={14} /> : <Check size={15} />}
                </button>
              </div>
              <div className="comment-anchor-label">
                <span>{getCommentAnchorLabel(thread.anchor, document, t)}</span>
                {thread.resolved && <em>{t("comment.resolved")}</em>}
              </div>
              <CommentQuote anchor={thread.anchor} />
              <div className="comment-message-list">
                {(repliesExpanded ? thread.messages : thread.messages.slice(0, 1)).map((message, index) => {
                  const messageAuthor = getMessageAuthor(message, author);
                  const messageKey = getMessageTargetKey(thread.id, message.id);
                  const editDraft = editDrafts[messageKey] ?? message.body;
                  const editing = editingMessageKey === messageKey;
                  const startEditing = () => {
                    setOpenMenuMessageKey(null);
                    setReactionPickerTarget(null);
                    setEditingMessageKey(messageKey);
                    setEditDrafts((current) => ({
                      ...current,
                      [messageKey]: cloneInlineBody(message.body),
                    }));
                  };
                  const cancelEditing = () => {
                    setEditingMessageKey(null);
                    setEditDrafts((current) => {
                      const next = { ...current };
                      delete next[messageKey];
                      return next;
                    });
                  };
                  const submitEditing = () => {
                    if (isInlineBodyEmpty(editDraft)) {
                      return;
                    }
                    if (index === 0) {
                      onEditThread(thread.id, editDraft);
                    } else {
                      onEditMessage(thread.id, message.id, editDraft);
                    }
                    cancelEditing();
                  };
                  if (editing) {
                    return (
                      <div className={`comment-message-edit ${index > 0 ? "reply" : ""}`} key={message.id} onClick={(event) => event.stopPropagation()}>
                        {index > 0 && <CommentAuthorLine author={messageAuthor} />}
                        <CommentRichTextEditor
                          value={editDraft}
                          mathFractionSizing={mathFractionSizing}
                          placeholder={t("comment.editPlaceholder")}
                          onChange={(value) => setEditDrafts((current) => ({ ...current, [messageKey]: value }))}
                        />
                        <ComposerActions
                          disabled={isInlineBodyEmpty(editDraft)}
                          primaryLabel={t("comment.save")}
                          onCancel={cancelEditing}
                          onSubmit={submitEditing}
                        />
                      </div>
                    );
                  }
                  return (
                    <div className={`comment-message ${index === 0 ? "root" : "reply"}`} key={message.id}>
                      {index > 0 && <CommentAuthorLine author={messageAuthor} />}
                      <CommentMessageToolbar
                        frequentEmojis={frequentReactionEmojis}
                        menuOpen={openMenuMessageKey === messageKey}
                        pickerOpen={isReactionPickerOpen(reactionPickerTarget, thread.id, message.id)}
                        quickEmojis={quickReactionEmojis}
                        recentEmojis={recentReactionEmojis}
                        reactionSearchQuery={reactionSearchQuery}
                        showMenu
                        onDelete={() => {
                          if (index === 0) {
                            onDeleteThread(thread.id);
                          } else {
                            onDeleteMessage(thread.id, message.id);
                          }
                        }}
                        onEdit={startEditing}
                        onMenuToggle={() => {
                          setReactionPickerTarget(null);
                          setOpenMenuMessageKey((current) => current === messageKey ? null : messageKey);
                        }}
                        onPickerToggle={() => {
                          setOpenMenuMessageKey(null);
                          setReactionSearchQuery("");
                          setReactionPickerTarget((current) => isReactionPickerOpen(current, thread.id, message.id)
                            ? null
                            : { messageId: message.id, threadId: thread.id });
                        }}
                        onReactionSearchChange={setReactionSearchQuery}
                        onToggleReaction={(emoji) => toggleReaction(thread.id, message.id, emoji)}
                      />
                      <CommentMessageBody body={message.body} mathFractionSizing={mathFractionSizing} />
                      <CommentReactionBar
                        currentAuthorName={author.name}
                        recentReactionKey={recentReactionKey}
                        reactions={getMessageReactions(thread, message.id, index)}
                        targetKey={getReactionTargetKey(thread.id, message.id)}
                        onToggleReaction={(emoji) => toggleReaction(thread.id, message.id, emoji)}
                      />
                    </div>
                  );
                })}
              </div>
              {!repliesExpanded && (replyCount > 0 || !thread.resolved) && (
                <button
                  type="button"
                  className="comment-reply-summary"
                  aria-expanded={repliesExpanded}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectThread(thread.id);
                    setExpandedReplyThreadIds((current) => toggleSetValue(current, thread.id));
                  }}
                >
                  {replyCount > 0
                    ? (
                      <span className="comment-reply-avatars" aria-hidden="true">
                        {getReplyAuthors(thread, author).map((replyAuthor, replyIndex) => (
                          <CommentAuthorAvatar
                            key={`${replyAuthor.name}:${replyIndex}`}
                            agent={replyAuthor.agent}
                            avatarUrl={replyAuthor.avatarUrl}
                            name={replyAuthor.name}
                          />
                        ))}
                      </span>
                    )
                    : <Reply size={13} />}
                  <span>{replyCount > 0 ? t("comment.replyCount", { replies: replyCount }) : t("comment.reply")}</span>
                  {replyCount > 0 && <em>{getLatestReplyLabel(thread, locale)}</em>}
                </button>
              )}
              {!thread.resolved && repliesExpanded && (
                <div className="comment-reply-composer" onClick={(event) => event.stopPropagation()}>
                  <CommentAuthorLine author={author} />
                  <CommentRichTextEditor
                    value={replyDraft}
                    mathFractionSizing={mathFractionSizing}
                    placeholder={t("comment.replyPlaceholder")}
                    onChange={(value) => onReplyDraftChange(thread.id, value)}
                  />
                  <ComposerActions
                    disabled={isInlineBodyEmpty(replyDraft)}
                    primaryLabel={t("comment.replySubmit")}
                    secondaryLabel={t("comment.close")}
                    onCancel={() => {
                      onSelectThread(thread.id);
                      setExpandedReplyThreadIds((current) => toggleSetValue(current, thread.id));
                    }}
                    onSubmit={() => {
                      setExpandedReplyThreadIds((current) => addSetValue(current, thread.id));
                      onReply(thread.id);
                    }}
                  />
                </div>
              )}
              {repliesExpanded && thread.resolved && replyCount > 0 && (
                <button
                  type="button"
                  className="comment-reply-summary open"
                  aria-expanded={repliesExpanded}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectThread(thread.id);
                    setExpandedReplyThreadIds((current) => toggleSetValue(current, thread.id));
                  }}
                >
                  <Reply size={13} />
                  <span>{t("comment.close")}</span>
                  {replyCount > 0 && <em>{t("comment.replyCount", { replies: replyCount })}</em>}
                </button>
              )}
            </section>
          );
        })}
      </div>

      {resolvedCount > 0 && (
        <div className="comment-thread-panel-footer">
          <div className="comment-filter-switch" role="group" aria-label={t("comment.filterAria")}>
            <button
              type="button"
              className={showResolved ? "" : "is-active"}
              aria-pressed={!showResolved}
              onClick={() => onShowResolvedChange(false)}
            >
              <span>{t("comment.filterOpen")}</span>
              <em>{unresolvedCount}</em>
            </button>
            <button
              type="button"
              className={showResolved ? "is-active" : ""}
              aria-pressed={showResolved}
              onClick={() => onShowResolvedChange(true)}
            >
              <span>{t("comment.filterAll")}</span>
              <em>{allThreads.length}</em>
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

function CommentMessageToolbar({
  frequentEmojis,
  menuOpen,
  pickerOpen,
  quickEmojis,
  reactionSearchQuery,
  recentEmojis,
  showMenu,
  onDelete,
  onEdit,
  onMenuToggle,
  onPickerToggle,
  onReactionSearchChange,
  onToggleReaction,
}: {
  frequentEmojis: string[];
  menuOpen: boolean;
  pickerOpen: boolean;
  quickEmojis: string[];
  reactionSearchQuery: string;
  recentEmojis: string[];
  showMenu: boolean;
  onDelete: () => void;
  onEdit: () => void;
  onMenuToggle: () => void;
  onPickerToggle: () => void;
  onReactionSearchChange: (query: string) => void;
  onToggleReaction: (emoji: string) => void;
}) {
  const t = useT("editor");
  return (
    <div
      className="comment-message-hover-toolbar"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {quickEmojis.map((emoji) => (
        <button
          type="button"
          key={emoji}
          className="comment-toolbar-emoji-button"
          aria-label={t("comment.reactWith", { name: emoji })}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggleReaction(emoji);
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (event.detail === 0) {
              onToggleReaction(emoji);
            }
          }}
        >
          {emoji}
        </button>
      ))}
      <div className="comment-reaction-picker-root">
        <button
          type="button"
          className="comment-toolbar-icon-button"
          aria-label={t("comment.pickReaction")}
          aria-expanded={pickerOpen}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onPickerToggle();
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (event.detail === 0) {
              onPickerToggle();
            }
          }}
        >
          <Smile size={15} />
        </button>
        {pickerOpen && (
          <CommentReactionPicker
            frequentEmojis={frequentEmojis}
            query={reactionSearchQuery}
            recentEmojis={recentEmojis}
            onQueryChange={onReactionSearchChange}
            onToggleReaction={onToggleReaction}
          />
        )}
      </div>
      {showMenu && (
        <div className={`comment-thread-menu-root ${menuOpen ? "open" : ""}`}>
          <button
            type="button"
            className="comment-toolbar-icon-button comment-thread-menu-button"
            title={t("comment.menu")}
            aria-label={t("comment.menu")}
            aria-expanded={menuOpen}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onMenuToggle();
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (event.detail === 0) {
                onMenuToggle();
              }
            }}
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen && (
            <div className="comment-thread-menu" role="menu">
              <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); onEdit(); }}>
                <Pencil size={13} />
                <span>{t("comment.edit")}</span>
              </button>
              <button type="button" role="menuitem" className="danger" onClick={(event) => { event.stopPropagation(); onDelete(); }}>
                <Trash2 size={13} />
                <span>{t("comment.delete")}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CommentReactionPicker({
  frequentEmojis,
  query,
  recentEmojis,
  onQueryChange,
  onToggleReaction,
}: {
  frequentEmojis: string[];
  query: string;
  recentEmojis: string[];
  onQueryChange: (query: string) => void;
  onToggleReaction: (emoji: string) => void;
}) {
  const t = useT("editor");
  const locale = useAppLocale();
  // 検索語彙は表示中の言語で切り替わる (`editor.reaction.keywords.*`)。
  const searchResults = searchCommentReactionEmojis(query, { locale });
  const trimmedQuery = query.trim();
  const showSavedSections = trimmedQuery.length === 0;

  return (
    <div className="comment-reaction-picker" role="dialog" aria-label={t("comment.reactions")}>
      <label className="comment-reaction-picker-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder={t("comment.searchEmoji")}
          aria-label={t("comment.searchEmoji")}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        />
      </label>
      {showSavedSections && recentEmojis.length > 0 && (
        <CommentReactionPickerSection
          title={t("comment.recent")}
          emojis={recentEmojis.slice(0, 8)}
          onToggleReaction={onToggleReaction}
        />
      )}
      {showSavedSections && frequentEmojis.length > 0 && (
        <CommentReactionPickerSection
          title={t("comment.frequent")}
          emojis={frequentEmojis}
          onToggleReaction={onToggleReaction}
        />
      )}
      <section className="comment-reaction-picker-section">
        <div className="comment-reaction-picker-heading">
          <span>{trimmedQuery ? t("comment.searchResults") : t("comment.allEmoji")}</span>
          <small>{t("comment.matchCount", { matches: searchResults.length })}</small>
        </div>
        {searchResults.length > 0 ? (
          <div className="comment-reaction-picker-grid">
            {searchResults.map((item) => (
              <CommentReactionPickerButton
                key={item.emoji}
                emoji={item.emoji}
                label={item.label}
                onToggleReaction={onToggleReaction}
              />
            ))}
          </div>
        ) : (
          <p className="comment-reaction-picker-empty">{t("comment.noEmoji")}</p>
        )}
      </section>
    </div>
  );
}

function CommentReactionPickerSection({
  emojis,
  title,
  onToggleReaction,
}: {
  emojis: string[];
  title: string;
  onToggleReaction: (emoji: string) => void;
}) {
  return (
    <section className="comment-reaction-picker-section">
      <div className="comment-reaction-picker-heading">
        <span>{title}</span>
      </div>
      <div className="comment-reaction-picker-grid compact">
        {emojis.map((emoji) => (
          <CommentReactionPickerButton
            key={emoji}
            emoji={emoji}
            label={emoji}
            onToggleReaction={onToggleReaction}
          />
        ))}
      </div>
    </section>
  );
}

function CommentReactionPickerButton({
  emoji,
  label,
  onToggleReaction,
}: {
  emoji: string;
  label: string;
  onToggleReaction: (emoji: string) => void;
}) {
  const t = useT("editor");
  return (
    <button
      type="button"
      title={label}
      aria-label={t("comment.reactWith", { name: label })}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggleReaction(emoji);
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (event.detail === 0) {
          onToggleReaction(emoji);
        }
      }}
    >
      {emoji}
    </button>
  );
}

/**
 * 差出人の 1 行。**名前と時刻は同じ行に置く** (Figma と同じ)。縦積みにすると
 * 1 スレッドあたりの高さが増え、右のガターに並ぶカード数が目に見えて減る。
 */
function CommentAuthorLine({ author, timestamp }: { author: CommentPanelAuthor; timestamp?: string }) {
  const locale = useAppLocale();
  return (
    <div className="comment-author-line">
      <CommentAuthorAvatar agent={author.agent} avatarUrl={author.avatarUrl} name={author.name} />
      <div className="comment-author-meta">
        <strong>{author.name}</strong>
        {author.agent?.model && <em className="comment-author-model">{author.agent.model}</em>}
        {timestamp && <span>{formatCommentTimestamp(timestamp, locale)}</span>}
      </div>
    </div>
  );
}

function CommentQuote({ anchor }: { anchor: SigmaCommentAnchor }) {
  const quote = getCommentAnchorQuote(anchor);
  if (!quote) {
    return null;
  }

  return <blockquote className="comment-anchor-quote">{quote}</blockquote>;
}

export function CommentMessageBody({
  body,
  mathFractionSizing,
}: {
  body: InlineNode[];
  mathFractionSizing?: SigmaDocument["metadata"]["mathFractionSizing"] | null;
}) {
  const t = useT("editor");
  if (isInlineBodyEmpty(body)) {
    return <p>{t("comment.emptyBody")}</p>;
  }

  return <p className="rich-inline-content">{renderInlineContent(body, { mathFractionSizing })}</p>;
}

function ComposerActions({
  disabled,
  primaryLabel,
  secondaryLabel,
  onCancel,
  onSubmit,
}: {
  disabled: boolean;
  primaryLabel: string;
  /** 省略時は「キャンセル」。既定値を引数に書くと翻訳前の文言が焼き付く。 */
  secondaryLabel?: string;
  onCancel?: () => void;
  onSubmit: () => void;
}) {
  const t = useT("editor");
  const cancelLabel = secondaryLabel ?? t("comment.cancel");
  return (
    <div className="comment-composer-actions">
      {onCancel && (
        <button type="button" className="button secondary" onClick={onCancel}>
          {cancelLabel}
        </button>
      )}
      <button type="button" className="button primary" disabled={disabled} onClick={onSubmit}>
        {primaryLabel}
      </button>
    </div>
  );
}

function CommentReactionBar({
  currentAuthorName,
  recentReactionKey,
  reactions,
  targetKey,
  onToggleReaction,
}: {
  currentAuthorName: string;
  recentReactionKey: string | null;
  reactions: SigmaCommentReaction[];
  targetKey: string;
  onToggleReaction: (emoji: string) => void;
}) {
  const t = useT("editor");
  const groups = getReactionGroups(reactions, currentAuthorName);
  const empty = groups.length === 0;
  return (
    <div className={`comment-reaction-bar ${empty ? "empty" : ""}`} onClick={(event) => event.stopPropagation()}>
      {groups.map((group) => (
        <button
          type="button"
          key={group.emoji}
          className={[
            "comment-reaction-chip",
            group.active ? "active" : "",
            recentReactionKey === `${targetKey}:${group.emoji}` ? "just-added" : "",
          ].filter(Boolean).join(" ")}
          aria-pressed={group.active}
          aria-label={t("comment.reactionCountAria", { name: group.emoji, reactions: group.count })}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggleReaction(group.emoji);
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (event.detail === 0) {
              onToggleReaction(group.emoji);
            }
          }}
        >
          <span>{group.emoji}</span>
          <strong>{group.count}</strong>
        </button>
      ))}
    </div>
  );
}

function getPositionedCommentItems({
  measuredCardHeights,
  pendingAnchor,
  pendingTop,
  threadPositions,
  threads,
}: {
  measuredCardHeights?: Record<string, number>;
  pendingAnchor: SigmaCommentAnchor | null;
  pendingTop: number | null;
  threadPositions?: Record<string, number>;
  threads: SigmaCommentThread[];
}): {
  emptyStyle?: CSSProperties;
  pendingStyle?: CSSProperties;
  threads: Array<{ style?: CSSProperties; thread: SigmaCommentThread }>;
} {
  const hasPositioning = Boolean(threadPositions);
  if (!hasPositioning) {
    return {
      emptyStyle: undefined,
      pendingStyle: undefined,
      threads: threads.map((thread) => ({ thread })),
    };
  }

  const items: Array<{
    fallbackHeight: number;
    height: number;
    key: string;
    top: number;
    thread?: SigmaCommentThread;
    type: "empty" | "pending" | "thread";
  }> = [];

  if (pendingAnchor) {
    items.push({
      fallbackHeight: COMMENT_COMPOSE_CARD_HEIGHT_PX,
      height: measuredCardHeights?.pending ?? COMMENT_COMPOSE_CARD_HEIGHT_PX,
      key: "pending",
      top: pendingTop ?? 0,
      type: "pending",
    });
  }

  if (threads.length === 0 && !pendingAnchor) {
    items.push({
      fallbackHeight: COMMENT_EMPTY_STATE_HEIGHT_PX,
      height: measuredCardHeights?.empty ?? COMMENT_EMPTY_STATE_HEIGHT_PX,
      key: "empty",
      top: 0,
      type: "empty",
    });
  }

  for (const thread of threads) {
    items.push({
      fallbackHeight: COMMENT_THREAD_CARD_HEIGHT_PX,
      height: measuredCardHeights?.[thread.id] ?? COMMENT_THREAD_CARD_HEIGHT_PX,
      key: thread.id,
      thread,
      top: threadPositions?.[thread.id] ?? Number.POSITIVE_INFINITY,
      type: "thread",
    });
  }

  items.sort((a, b) => a.top - b.top || a.key.localeCompare(b.key));
  const styles = new Map<string, CSSProperties>();
  let nextTop = 0;
  for (const item of items) {
    const requestedTop = Number.isFinite(item.top) ? item.top : nextTop;
    const top = Math.max(0, Math.max(requestedTop, nextTop));
    styles.set(item.key, { top: `${Math.round(top)}px` });
    nextTop = top + Math.max(item.height, item.fallbackHeight) + COMMENT_CARD_GAP_PX;
  }

  return {
    emptyStyle: styles.get("empty"),
    pendingStyle: styles.get("pending"),
    threads: threads
      .slice()
      .sort((a, b) => (threadPositions?.[a.id] ?? Number.MAX_SAFE_INTEGER) - (threadPositions?.[b.id] ?? Number.MAX_SAFE_INTEGER))
      .map((thread) => ({ style: styles.get(thread.id), thread })),
  };
}

function getMessageAuthor(message: SigmaCommentMessage | undefined, currentAuthor: CommentPanelAuthor): CommentPanelAuthor {
  const name = message?.authorName || currentAuthor.name;
  // AI の差出人は現在のユーザーではないので、ユーザー画像を貸さない。
  return {
    avatarUrl: !message?.agent && name === currentAuthor.name ? currentAuthor.avatarUrl : null,
    agent: message?.agent ?? null,
    name,
  };
}

function getMessageReactions(thread: SigmaCommentThread, messageId: string, messageIndex: number): SigmaCommentReaction[] {
  const message = thread.messages.find((candidate) => candidate.id === messageId);
  if (!message) {
    return [];
  }
  return messageIndex === 0
    ? [...(thread.reactions ?? []), ...(message.reactions ?? [])]
    : message.reactions ?? [];
}

function cloneInlineBody(body: InlineNode[]): InlineNode[] {
  return body.map((node) => ({ ...node }));
}

function loadStoredCommentReactionUsage(): CommentReactionUsage {
  if (typeof window === "undefined") {
    return { counts: {}, recent: [] };
  }

  try {
    return parseCommentReactionUsage(window.localStorage.getItem(COMMENT_REACTION_USAGE_STORAGE_KEY));
  } catch {
    return { counts: {}, recent: [] };
  }
}

function getMessageTargetKey(threadId: string, messageId: string): string {
  return `${threadId}:${messageId}`;
}

function getReactionTargetKey(threadId: string, messageId: string): string {
  return getMessageTargetKey(threadId, messageId);
}

function getReactionAnimationKey(threadId: string, messageId: string, emoji: string): string {
  return `${getReactionTargetKey(threadId, messageId)}:${emoji}`;
}

function isReactionPickerOpen(target: CommentReactionTarget | null, threadId: string, messageId: string): boolean {
  return target?.threadId === threadId && target.messageId === messageId;
}

function getReactionGroups(
  reactions: SigmaCommentReaction[],
  currentAuthorName: string,
): Array<{ active: boolean; count: number; emoji: string }> {
  const groups = new Map<string, { active: boolean; count: number; emoji: string }>();
  for (const reaction of reactions) {
    const group = groups.get(reaction.emoji) ?? {
      active: false,
      count: 0,
      emoji: reaction.emoji,
    };
    group.count += 1;
    if ((reaction.authorName || "") === currentAuthorName) {
      group.active = true;
    }
    groups.set(reaction.emoji, group);
  }
  return Array.from(groups.values());
}

function getReplyCount(thread: SigmaCommentThread): number {
  return Math.max(0, thread.messages.length - 1);
}

/** 折りたたんだ返信行に重ねる差出人アイコン。同じ差出人は 1 つにまとめ、先頭 3 人まで。 */
function getReplyAuthors(thread: SigmaCommentThread, currentAuthor: CommentPanelAuthor): CommentPanelAuthor[] {
  const seen = new Set<string>();
  const authors: CommentPanelAuthor[] = [];
  for (const message of thread.messages.slice(1)) {
    const author = getMessageAuthor(message, currentAuthor);
    const key = `${author.name}:${author.agent?.vendor ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    authors.push(author);
    if (authors.length === 3) {
      break;
    }
  }
  return authors;
}

function getLatestReplyLabel(thread: SigmaCommentThread, locale: AppLocale): string {
  const latestReply = thread.messages[thread.messages.length - 1];
  if (!latestReply || thread.messages.length <= 1) {
    return "";
  }
  return formatCommentTimestamp(latestReply.createdAt, locale);
}

function addSetValue(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  next.add(value);
  return next;
}

function toggleSetValue(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

function areNumberRecordsEqual(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) => left[key] === right[key]);
}

/**
 * 時刻の表記は**表示中の UI 言語**に従う (`"ja-JP"` 決め打ちだと英語 UI でも
 * 24 時制の日本語表記のままになる)。
 */
function formatCommentTimestamp(value: string, locale: AppLocale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}
