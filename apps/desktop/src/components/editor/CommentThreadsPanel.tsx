"use client";

import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Check, MessageSquarePlus, MoreHorizontal, Pencil, Reply, RotateCcw, Search, Smile, Trash2 } from "lucide-react";

import { CommentAuthorAvatar } from "@/components/editor/CommentAuthorAvatar";
import { CommentComposer } from "@/components/editor/CommentComposer";
import { CommentParticipantStack } from "@/components/editor/CommentParticipantStack";
import { getCommentThreadParticipants, resolveCommentAuthor, type CommentAuthorContext } from "@/components/editor/comment-participants";
import { useCommentPeopleDirectory, type LoadCommentPeople } from "@/components/editor/comment-people";
import { formatCommentAbsoluteTime, formatCommentRelativeTime, useCommentClock } from "@/components/editor/comment-time";
import { InlineContent } from "@/features/rendering/adapters/react";
import {
  COMMENT_REACTION_USAGE_STORAGE_KEY,
  getFrequentCommentReactionEmojis,
  getQuickCommentReactionEmojis,
  parseCommentReactionUsage,
  recordCommentReactionUsage,
  searchCommentReactionEmojis,
  type CommentReactionUsage,
} from "@/components/editor/comment-reactions";
import { getCommentQuoteContent } from "@/lib/comment-quote-content";
import {
  getCommentAnchorQuote,
  isCommentAnchorOrphan,
  isInlineBodyEmpty,
} from "@/lib/comments";
import { useAppLocale, useT } from "@/lib/i18n/react";
import type { SigmaCommentAgent, SigmaCommentAnchor, SigmaCommentMessage, SigmaCommentReaction, SigmaCommentThread, SigmaDocument, InlineNode } from "@/features/document";

import { splitCommentAiMentions } from "@/lib/comment-agent-mentions";

import type { CommentMentionCandidate, LoadCommentMentionCandidates } from "./comment-mentions";

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
  loadMentionCandidates?: LoadCommentMentionCandidates;
  /** 書いた人・宛先の今の名前とアイコンを、共有アカウントの ID から引く (共有している相手だけ)。 */
  loadCommentPeople?: LoadCommentPeople;
  /** 入力欄に「Claude に送信」を出すか。AI が動かない画面 (埋め込みなど) では出さない。 */
  aiAgentsAvailable?: boolean;
  currentUserId?: string;
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
  /** 見出しに、そのスレッドで発言した人の重ねアバターを出す (2人以上のとき)。 */
  showParticipants?: boolean;
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
  loadMentionCandidates,
  loadCommentPeople,
  aiAgentsAvailable = false,
  currentUserId,
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
  showParticipants = false,
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
  const mentionDirectory = useCommentPeopleDirectory({ threads, currentUserId, author, loadPeople: loadCommentPeople, loadMembers: loadMentionCandidates });
  const authorContext = useMemo<CommentAuthorContext>(
    () => ({ currentAuthor: author, currentUserId, people: mentionDirectory }),
    [author, currentUserId, mentionDirectory],
  );
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

  const collapseReplies = (threadId: string) => {
    onSelectThread(threadId);
    setExpandedReplyThreadIds((current) => {
      const next = new Set(current);
      next.delete(threadId);
      return next;
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
            <PendingCommentComposer
              anchor={pendingAnchor}
              document={document}
              draft={pendingDraft}
              mathFractionSizing={mathFractionSizing}
              loadMentionCandidates={loadMentionCandidates}
              aiAgentsAvailable={aiAgentsAvailable}
              onDraftChange={onPendingDraftChange}
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
          const cardAuthor = getMessageAuthor(firstMessage, authorContext);
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
                {showParticipants && <ThreadParticipants thread={thread} context={authorContext} />}
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
              <CommentThreadStatus anchor={thread.anchor} document={document} resolved={Boolean(thread.resolved)} />
              <CommentQuote anchor={thread.anchor} document={document} />
              <div className="comment-message-list">
                {(repliesExpanded ? thread.messages : thread.messages.slice(0, 1)).map((message, index) => {
                  const messageAuthor = getMessageAuthor(message, authorContext);
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
                        {index > 0 && <CommentAuthorLine author={messageAuthor} timestamp={message.createdAt} />}
                        <CommentComposer
                          loadMentionCandidates={loadMentionCandidates}
                          value={editDraft}
                          mathFractionSizing={mathFractionSizing}
                          placeholder={t("comment.editPlaceholder")}
                          submitLabel={t("comment.save")}
                          submitIcon="save"
                          cancelLabel={t("comment.cancel")}
                          autoFocus
                          onChange={(value) => setEditDrafts((current) => ({ ...current, [messageKey]: value }))}
                          onCancel={cancelEditing}
                          onEscape={cancelEditing}
                          onSubmit={submitEditing}
                        />
                      </div>
                    );
                  }
                  return (
                    <div className={`comment-message ${index === 0 ? "root" : "reply"}`} key={message.id}>
                      {index > 0 && <CommentAuthorLine author={messageAuthor} timestamp={message.createdAt} />}
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
                      <CommentMessageBody currentUserId={currentUserId} body={message.body} mentionDirectory={mentionDirectory} mathFractionSizing={mathFractionSizing} />
                      <CommentReactionBar
                        currentAuthorName={author.name}
                        currentUserId={currentUserId}
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
                        {getReplyAuthors(thread, authorContext).map((replyAuthor, replyIndex) => (
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
                  {replyCount > 0 && <LatestReplyTime thread={thread} />}
                </button>
              )}
              {!thread.resolved && repliesExpanded && (
                <div className="comment-reply-composer" onClick={(event) => event.stopPropagation()}>
                  <CommentComposer
                    loadMentionCandidates={loadMentionCandidates}
                    value={replyDraft}
                    mathFractionSizing={mathFractionSizing}
                    placeholder={t("comment.replyPlaceholder")}
                    submitLabel={t("comment.replySubmit")}
                    cancelLabel={t("comment.close")}
                    showAgentToggle={aiAgentsAvailable}
                    // 「返信する」を押して開いたら、そのまま打ち始められるようにする。
                    autoFocus
                    onChange={(value) => onReplyDraftChange(thread.id, value)}
                    onCancel={() => collapseReplies(thread.id)}
                    onEscape={() => collapseReplies(thread.id)}
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

/**
 * 書きかけのコメントの中身 (引用・入力欄)。コメントの欄のカードと、選んだところの右下に浮かべる
 * 入力欄 (`FloatingCommentComposer`) が同じものを使う。浮かべた入力欄は選択のすぐ下に開き、
 * 何に付けるかは選択のハイライトで見えているので、引用を繰り返さない。
 */
export function PendingCommentComposer({
  anchor,
  document,
  draft,
  mathFractionSizing,
  loadMentionCandidates,
  aiAgentsAvailable = false,
  autoFocus,
  floating = false,
  onDraftChange,
  onCancel,
  onSubmit,
}: {
  anchor: SigmaCommentAnchor;
  /** 引用を本文の書式・数式で出すために引く文書。 */
  document?: SigmaDocument;
  draft: InlineNode[];
  mathFractionSizing?: SigmaDocument["metadata"]["mathFractionSizing"];
  loadMentionCandidates?: LoadCommentMentionCandidates;
  aiAgentsAvailable?: boolean;
  autoFocus?: boolean;
  /** 浮かべた入力欄。取り消しは Esc と外側のクリックで行うので、ボタンを置かない。 */
  floating?: boolean;
  onDraftChange: (value: InlineNode[]) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const t = useT("editor");
  return (
    <>
      {!floating && <CommentQuote anchor={anchor} document={document} />}
      <CommentComposer
        loadMentionCandidates={loadMentionCandidates}
        value={draft}
        mathFractionSizing={mathFractionSizing}
        placeholder={t("comment.addComment")}
        submitLabel={t("comment.add")}
        showAgentToggle={aiAgentsAvailable}
        cancelLabel={floating ? undefined : t("comment.cancel")}
        autoFocus={autoFocus}
        onChange={onDraftChange}
        onCancel={floating ? undefined : onCancel}
        onEscape={floating ? undefined : () => {
          if (isInlineBodyEmpty(draft)) onCancel();
        }}
        onSubmit={onSubmit}
      />
    </>
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
/** 2人以上が発言したスレッドだけ、発言者の重ねアバターを出す (1人なら見出しの名前で足りる)。 */
function ThreadParticipants({ thread, context }: { thread: SigmaCommentThread; context: CommentAuthorContext }) {
  const participants = useMemo(() => getCommentThreadParticipants(thread, context), [thread, context]);
  return participants.length >= 2 ? <CommentParticipantStack participants={participants} /> : null;
}

function CommentAuthorLine({ author, timestamp }: { author: CommentPanelAuthor; timestamp?: string }) {
  return (
    <div className="comment-author-line">
      <CommentAuthorAvatar agent={author.agent} avatarUrl={author.avatarUrl} name={author.name} />
      <div className="comment-author-meta">
        <strong>{author.name}</strong>
        {author.agent?.model && <em className="comment-author-model">{author.agent.model}</em>}
        {timestamp && <CommentTime value={timestamp} />}
      </div>
    </div>
  );
}

/** 「今」「5分前」。正確な日時はツールチップに出す。 */
function CommentTime({ value }: { value: string }) {
  const t = useT("editor");
  const locale = useAppLocale();
  const now = useCommentClock();
  return (
    <time className="comment-time" dateTime={value} title={formatCommentAbsoluteTime(value, locale)}>
      {formatCommentRelativeTime(value, now, locale, t("comment.justNow"))}
    </time>
  );
}

function LatestReplyTime({ thread }: { thread: SigmaCommentThread }) {
  const latestReply = thread.messages[thread.messages.length - 1];
  if (!latestReply || thread.messages.length <= 1) {
    return null;
  }
  return <em><CommentTime value={latestReply.createdAt} /></em>;
}

/**
 * 「ブロック」「図形」のような付け先の種別は出さない (本文のハイライトを見れば分かる)。出すのは本文を
 * 見ても分からない状態だけ — 付け先が消えた (対象なし) と、解決済み。
 */
function CommentThreadStatus({ anchor, document, resolved }: { anchor: SigmaCommentAnchor; document: SigmaDocument; resolved: boolean }) {
  const t = useT("editor");
  const orphan = isCommentAnchorOrphan(document, anchor);
  if (!orphan && !resolved) {
    return null;
  }
  return (
    <div className="comment-thread-status">
      {orphan && <span>{t("comment.anchor.orphan")}</span>}
      {resolved && <em>{t("comment.resolved")}</em>}
    </div>
  );
}

/**
 * 引用元。本文から引けるものは本文と同じ書式・数式で (`InlineContent`)、引けないもの (消えた所など) は
 * 保存してある引用の文字列で出す。
 */
function CommentQuote({ anchor, document }: { anchor: SigmaCommentAnchor; document?: SigmaDocument }) {
  // 図形・領域の引用は「選択した図形」のような名前だけ (保存と AI への指示には残す)。図を見れば分かるので出さない。
  const hidden = anchor.type === "overlayShape" || anchor.type === "canvasRegion";
  const content = useMemo(
    () => (hidden || !document ? null : getCommentQuoteContent(document, anchor)),
    [anchor, document, hidden],
  );
  if (hidden) {
    return null;
  }
  if (content) {
    return (
      <blockquote className="comment-anchor-quote">
        <InlineContent nodes={content} keyPrefix="comment-quote" mathFractionSizing={document?.metadata.mathFractionSizing} />
      </blockquote>
    );
  }
  const quote = getCommentAnchorQuote(anchor);
  if (!quote) {
    return null;
  }

  return <blockquote className="comment-anchor-quote">{quote}</blockquote>;
}

/** アイコンと名前を 1 つにまとめた宛先のチップ。詳細 (名前・メール) はツールチップに出す。 */
function CommentMentionChip({ className, title, avatar, label, userId }: {
  className: string;
  title?: string;
  avatar: ReactNode;
  label: ReactNode;
  userId?: string;
}) {
  return (
    <span className={className} data-comment-mention={userId} title={title}>
      {avatar}
      <span className="comment-mention-label">{label}</span>
    </span>
  );
}

/**
 * コメントの本文。本文の静的な描画 (`InlineContent` — 編集面と同じ書式・数式の組み方) に渡し、宛先 (人・AI)
 * だけをチップにする。チップ以外の連続した部分は 1 つの `InlineContent` にまとめる — ノードごとに分けて
 * 組むと、書式の続きや数式と文字の並びが本文と変わる。
 */
export function CommentMessageBody({
  currentUserId,
  body,
  mentionDirectory,
  mathFractionSizing,
}: {
  body: InlineNode[];
  currentUserId?: string;
  mentionDirectory?: ReadonlyMap<string, CommentMentionCandidate>;
  mathFractionSizing?: SigmaDocument["metadata"]["mathFractionSizing"] | null;
}) {
  const t = useT("editor");
  const segments = useMemo(() => splitCommentBodySegments(body), [body]);
  if (isInlineBodyEmpty(body)) {
    return <p>{t("comment.emptyBody")}</p>;
  }

  return <p className="comment-message-body">{segments.map((segment, index) => {
    if (segment.kind === "inline") {
      return <InlineContent key={index} nodes={segment.nodes} keyPrefix={`comment-${index}`} mathFractionSizing={mathFractionSizing} />;
    }
    if (segment.kind === "person") {
      const { node } = segment;
      const isSelf = node.mentionUserId === currentUserId;
      const member = mentionDirectory?.get(node.mentionUserId);
      const name = member?.name ?? node.text.replace(/^[@＠]/u, "");
      const detail = member?.email && member.email !== name ? `${name} <${member.email}>` : name;
      return (
        <CommentMentionChip
          key={index}
          className={`comment-mention is-chip${isSelf ? " is-self" : ""}`}
          userId={node.mentionUserId}
          title={isSelf ? `${detail} · ${t("comment.mentionsYou")}` : detail}
          avatar={<CommentAuthorAvatar name={name} avatarUrl={member?.avatarUrl} />}
          label={`@${name}`}
        />
      );
    }
    return (
      <CommentMentionChip
        key={index}
        className="comment-mention is-chip is-agent"
        title={t("comment.mentionAgentTitle", { name: segment.agent.name })}
        avatar={<CommentAuthorAvatar name={segment.agent.name} agent={{ vendor: segment.agent.vendor }} />}
        label={segment.text}
      />
    );
  })}</p>;
}

type CommentBodySegment =
  | { kind: "inline"; nodes: InlineNode[] }
  | { kind: "person"; node: InlineNode & { type: "text"; mentionUserId: string } }
  | { kind: "agent"; text: string; agent: { name: string; vendor: SigmaCommentAgent["vendor"] } };

/** 本文を、そのまま組む部分と宛先のチップに分ける。AI への宛先 (@claude など) は本文の文字列のまま保存されている。 */
function splitCommentBodySegments(body: readonly InlineNode[]): CommentBodySegment[] {
  const segments: CommentBodySegment[] = [];
  const pushInline = (node: InlineNode) => {
    const last = segments.at(-1);
    if (last?.kind === "inline") last.nodes.push(node);
    else segments.push({ kind: "inline", nodes: [node] });
  };
  for (const node of body) {
    if (node.type !== "text") {
      pushInline(node);
      continue;
    }
    if (node.mentionUserId) {
      segments.push({ kind: "person", node: node as InlineNode & { type: "text"; mentionUserId: string } });
      continue;
    }
    for (const part of splitCommentAiMentions(node.text)) {
      if (part.agent) segments.push({ kind: "agent", text: part.text, agent: part.agent });
      else pushInline({ ...node, text: part.text });
    }
  }
  return segments;
}

function CommentReactionBar({
  currentAuthorName,
  currentUserId,
  recentReactionKey,
  reactions,
  targetKey,
  onToggleReaction,
}: {
  currentAuthorName: string;
  currentUserId?: string;
  recentReactionKey: string | null;
  reactions: SigmaCommentReaction[];
  targetKey: string;
  onToggleReaction: (emoji: string) => void;
}) {
  const t = useT("editor");
  const groups = getReactionGroups(reactions, { authorName: currentAuthorName, userId: currentUserId });
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

function getMessageAuthor(message: SigmaCommentMessage | undefined, context: CommentAuthorContext): CommentPanelAuthor {
  if (!message) {
    return { name: context.currentAuthor.name, avatarUrl: context.currentAuthor.avatarUrl ?? null, agent: null };
  }
  const { name, avatarUrl, agent } = resolveCommentAuthor(message, context);
  return { name, avatarUrl: avatarUrl ?? null, agent: agent ?? null };
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

/** 自分が付けたかは、共有アカウントの ID を持つリアクションは ID で (名前は変わりうる)、古いものは名前で見る。 */
function getReactionGroups(
  reactions: SigmaCommentReaction[],
  current: { authorName: string; userId?: string },
): Array<{ active: boolean; count: number; emoji: string }> {
  const groups = new Map<string, { active: boolean; count: number; emoji: string }>();
  for (const reaction of reactions) {
    const group = groups.get(reaction.emoji) ?? {
      active: false,
      count: 0,
      emoji: reaction.emoji,
    };
    group.count += 1;
    if (reaction.authorId && current.userId ? reaction.authorId === current.userId : (reaction.authorName || "") === current.authorName) {
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
function getReplyAuthors(thread: SigmaCommentThread, context: CommentAuthorContext): CommentPanelAuthor[] {
  const seen = new Set<string>();
  const authors: CommentPanelAuthor[] = [];
  for (const message of thread.messages.slice(1)) {
    const { key, name, avatarUrl, agent } = resolveCommentAuthor(message, context);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    authors.push({ name, avatarUrl: avatarUrl ?? null, agent: agent ?? null });
    if (authors.length === 3) {
      break;
    }
  }
  return authors;
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
