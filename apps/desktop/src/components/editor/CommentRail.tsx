"use client";

import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { CommentAuthorAvatar } from "@/components/editor/CommentAuthorAvatar";
import { CommentThreadsPanel, type CommentThreadsPanelProps } from "@/components/editor/CommentThreadsPanel";
import { getCommentThreadParticipants } from "@/components/editor/comment-participants";
import { useCommentRailLayout } from "@/components/editor/comment-rail/use-comment-rail-layout";
import { IconButton } from "@/components/ui/Button";
import type { SigmaDocument } from "@/features/document";
import { useT } from "@/lib/i18n/react";
import styles from "./CommentRail.module.css";

/** 追従で、先頭のカードを一覧の上端から離す距離 (一覧の余白 + 影のぶん)。 */
const FOLLOW_TOP_OFFSET_PX = 8;
/** アイコンの並びに出すコメントの数。これを超えたぶんは「+N」にまとめる。 */
const COMPACT_THREAD_LIMIT = 6;

type CommentRailPanelProps = Omit<
  CommentThreadsPanelProps,
  "candidateTop" | "document" | "panelHeight" | "pendingTop" | "showParticipants" | "threadPositions"
>;

export interface CommentRailProps {
  document: SigmaDocument;
  panel: CommentRailPanelProps;
  /** コメントを見せるか。閉じていても、サイドバーの内容のカードを置く場所は残す。 */
  open: boolean;
  whiteboard: boolean;
  /** サイドバーの内容のカードを差し込む場所。 */
  onPeekHostChange(element: HTMLElement | null): void;
  /** いま小さなアイコンだけで描いているか (カードを差し込む側も、同じ大きさに合わせる)。 */
  onCompactChange(compact: boolean): void;
}

/**
 * キャンバスの右上に浮かぶカードの縦の並び。サイドバーの内容のカードの下に、コメントを
 * 浮かぶカードとして積む。本文の右横の欄と違い対象と同じ高さには並ばないので、本文の並びに揃え、
 * 本文をスクロールしたら見えている対象のカードへ追従する。対象の本文側は、既存のハイライトで示す。
 * 2人以上が発言したスレッドは、見出しに発言者を重ねて見せる。
 *
 * 用紙の右に置く余白が足りないとき (窓が狭い・サイドバーを開いた・拡大した) は、本文の邪魔に
 * ならないよう小さなアイコンだけにする。コメントのアイコンを押すと、その場でカードに広がる。
 */
export function CommentRail({ document, panel, open, whiteboard, onPeekHostChange, onCompactChange }: CommentRailProps) {
  const t = useT("editor");
  const railRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const hasComments = open && (panel.threads.length > 0 || Boolean(panel.pendingAnchor));

  // 本文のキャンバスは、画面に1つだけ。描き直しのたびに探さず、文書が替わったときに引き直す。
  useLayoutEffect(() => {
    canvasRef.current = railRef.current?.closest(".app-shell")?.querySelector<HTMLElement>(".editor-canvas") ?? null;
  }, [document.docId, hasComments]);

  const threadIds = useMemo(() => panel.threads.map((thread) => thread.id), [panel.threads]);
  const layout = useCommentRailLayout({ threadIds, canvasRef, listRef, whiteboard });

  // 小さなアイコンのままにするか。書きかけのコメントは、見えていないと書けないので広げる。
  const showCards = !layout.compact || expanded || Boolean(panel.pendingAnchor);
  const compactActive = layout.compact && !showCards;
  useEffect(() => onCompactChange(compactActive), [compactActive, onCompactChange]);

  // 広がったカードは、外側を押す・Esc で、アイコンへ戻す。カードの中のメニュー (リアクションなど) は外側に数えない。
  const expandedCompact = layout.compact && expanded;
  useEffect(() => {
    if (!expandedCompact) return;
    const collapse = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-comment-rail], [role='menu'], [role='dialog']")) return;
      setExpanded(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("mousedown", collapse);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", collapse);
      window.removeEventListener("keydown", onKey);
    };
  }, [expandedCompact]);

  // 上から下へ、本文の並びに合わせる。まだ測れていないスレッド (場所を持たないものを含む) は先頭に置く。
  const orderedThreads = useMemo(() => {
    if (layout.documentOrder.length === 0) return panel.threads;
    const rank = new Map(layout.documentOrder.map((id, index) => [id, index]));
    return panel.threads
      .map((thread, index) => ({ thread, index, rank: rank.get(thread.id) ?? -1 }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.thread);
  }, [layout.documentOrder, panel.threads]);

  // 本文をスクロールしたら、いま見えている対象のカードが一覧の先頭に来るよう追従する。
  // カードの上にポインタがある間、返信などを入力している間、スレッドを選んでいる間は動かさない。
  const lastFollowedRef = useRef<string | null>(null);
  const { activeThreadId } = panel;
  const firstVisibleId = useMemo(
    () => orderedThreads.find((thread) => layout.placements[thread.id] === "visible")?.id ?? null,
    [layout.placements, orderedThreads],
  );
  useEffect(() => {
    const list = listRef.current;
    if (!list || !firstVisibleId || firstVisibleId === lastFollowedRef.current || activeThreadId) return;
    // 開いた直後は、先頭の (場所を持たない) カードも見えるように動かさない。本文が動いて対象が替わってから追う。
    if (lastFollowedRef.current === null) {
      lastFollowedRef.current = firstVisibleId;
      return;
    }
    if (list.matches(":hover") || list.contains(list.ownerDocument.activeElement)) return;
    const card = list.querySelector<HTMLElement>(`[data-comment-card-key="${CSS.escape(firstVisibleId)}"]`);
    if (!card) return;
    lastFollowedRef.current = firstVisibleId;
    // 場所を持たないカード (文書全体へのコメント) は先頭に並ぶので、最初の対象まで戻ったときは一番上まで戻す。
    const firstAnchoredId = orderedThreads.find((thread) => layout.placements[thread.id] !== "none")?.id;
    const top = firstVisibleId === firstAnchoredId
      ? 0
      : card.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - FOLLOW_TOP_OFFSET_PX;
    list.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [activeThreadId, firstVisibleId, layout.placements, orderedThreads]);

  // 選んだスレッドのカードが、一覧の窓の外にあれば寄せる (広げた直後にも効く)。
  useEffect(() => {
    if (!activeThreadId || !showCards) return;
    listRef.current?.querySelector<HTMLElement>(`[data-comment-card-key="${CSS.escape(activeThreadId)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeThreadId, showCards]);

  const compactThreads = orderedThreads.slice(0, COMPACT_THREAD_LIMIT);
  const hiddenThreadCount = orderedThreads.length - compactThreads.length;
  const openThread = (threadId: string | null) => {
    setExpanded(true);
    if (threadId) panel.onSelectThread(threadId);
  };

  return (
    <div
      className={styles.rail}
      ref={railRef}
      data-compact={compactActive ? "true" : undefined}
      data-whiteboard={whiteboard ? "true" : undefined}
      data-comment-rail="true"
    >
      <div className={styles.peekSlot} ref={onPeekHostChange} />
      {hasComments && compactActive && (
        <div className={styles.compactList}>
          {compactThreads.map((thread) => {
            const [first] = getCommentThreadParticipants(thread, panel.author);
            return (
              <button
                key={thread.id}
                type="button"
                className={styles.threadButton}
                data-resolved={thread.resolved ? "true" : undefined}
                aria-label={t("comment.railOpenThread", { name: first.name })}
                title={`${first.name}: ${thread.messages[0]?.body.map((node) => ("text" in node ? node.text : "")).join("") ?? ""}`}
                onClick={() => openThread(thread.id)}
              >
                <CommentAuthorAvatar name={first.name} avatarUrl={first.avatarUrl} agent={first.agent} />
              </button>
            );
          })}
          {hiddenThreadCount > 0 && (
            <button
              type="button"
              className={`${styles.threadButton} ${styles.moreButton}`}
              aria-label={t("comment.railMore", { count: hiddenThreadCount })}
              onClick={() => openThread(null)}
            >
              +{hiddenThreadCount}
            </button>
          )}
        </div>
      )}
      {hasComments && showCards && (
        <div
          className={styles.list}
          ref={listRef}
          role="region"
          aria-label={t("comment.railAria")}
          data-more-above={layout.listMore.above ? "true" : undefined}
          data-more-below={layout.listMore.below ? "true" : undefined}
        >
          {expandedCompact && (
            <div className={styles.collapse}>
              <IconButton label={t("comment.railCollapse")} tone="ghost" size="sm" onClick={() => setExpanded(false)}>
                <X size={14} aria-hidden="true" />
              </IconButton>
            </div>
          )}
          <CommentThreadsPanel {...panel} threads={orderedThreads} document={document} showParticipants />
        </div>
      )}
    </div>
  );
}
