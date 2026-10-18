"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { CommentAuthorAvatar } from "@/components/editor/CommentAuthorAvatar";
import { PendingCommentComposer, type CommentPanelAuthor } from "@/components/editor/CommentThreadsPanel";
import type { InlineNode, SigmaCommentAnchor, SigmaDocument } from "@/features/document";
import { isInlineBodyEmpty } from "@/lib/comments";
import { useT } from "@/lib/i18n/react";

import type { LoadCommentMentionCandidates } from "./comment-mentions";
import styles from "./FloatingCommentComposer.module.css";

/** 押したチップのすぐ下に開く (チップの高さ + 間隔、画面の px)。AI の入力欄と同じ置き方。 */
const BELOW_CHIP_OFFSET_PX = 46;
const VIEWPORT_MARGIN_PX = 12;

export interface FloatingCommentComposerProps {
  /** 押したチップの位置 (画面座標)。 */
  placement: { left: number; top: number };
  author: CommentPanelAuthor;
  anchor: SigmaCommentAnchor;
  draft: InlineNode[];
  document: SigmaDocument;
  loadMentionCandidates?: LoadCommentMentionCandidates;
  onDraftChange: (value: InlineNode[]) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** 書きかけのまま、コメントの欄のカードへ移す (外側を押した・Esc)。 */
  onDock: () => void;
}

/**
 * 選んだところの右下のチップから始めたコメントの入力欄。押した場所の下に浮かべ、書き終えた
 * スレッドはコメントの欄に並ぶ。外側を押したら、書きかけを捨てずに欄のカードへ移す。
 */
export function FloatingCommentComposer({
  placement,
  author,
  anchor,
  draft,
  document,
  loadMentionCandidates,
  onDraftChange,
  onSubmit,
  onCancel,
  onDock,
}: FloatingCommentComposerProps) {
  const t = useT("editor");
  const rootRef = useRef<HTMLElement>(null);
  const [position, setPosition] = useState({ left: placement.left, top: placement.top + BELOW_CHIP_OFFSET_PX });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const place = () => {
      const width = root.offsetWidth;
      const height = root.offsetHeight;
      const below = placement.top + BELOW_CHIP_OFFSET_PX;
      // 下に収まらなければ、押したチップの上に開く。
      const top = below + height <= window.innerHeight - VIEWPORT_MARGIN_PX
        ? below
        : Math.max(VIEWPORT_MARGIN_PX, placement.top - VIEWPORT_MARGIN_PX - height);
      const left = Math.max(VIEWPORT_MARGIN_PX, Math.min(placement.left, window.innerWidth - width - VIEWPORT_MARGIN_PX));
      setPosition((current) => (current.left === left && current.top === top ? current : { left, top }));
    };
    place();
    window.addEventListener("resize", place);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(root);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [placement.left, placement.top]);

  const draftEmptyRef = useRef(isInlineBodyEmpty(draft));
  useEffect(() => {
    draftEmptyRef.current = isInlineBodyEmpty(draft);
  }, [draft]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      // メンションの候補や数式の入力など、入力欄から開いたものの中は外側に数えない。
      if (!target || rootRef.current?.contains(target)
        || target.closest("[data-comment-popover], [role='menu'], [role='listbox'], [role='dialog'], .ML__keyboard, .ML__popover")) {
        return;
      }
      onDock();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !rootRef.current?.contains(event.target as Node | null)) {
        return;
      }
      event.preventDefault();
      if (draftEmptyRef.current) {
        onCancel();
      } else {
        onDock();
      }
    };
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onCancel, onDock]);

  if (typeof window === "undefined") {
    return null;
  }
  return createPortal(
    <section
      ref={rootRef}
      className={styles.root}
      data-floating-comment-composer="true"
      aria-label={t("comment.addComment")}
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
    >
      {/* 書いている人のピン (Figma・Claude のコメントと同じ形)。とがった角が選んだところを指す。 */}
      <span className={styles.pin} aria-hidden="true">
        <CommentAuthorAvatar name={author.name} avatarUrl={author.avatarUrl} />
      </span>
      <div className={`comment-compose-card pending ${styles.card}`}>
        <PendingCommentComposer
          anchor={anchor}
          draft={draft}
          mathFractionSizing={document.metadata.mathFractionSizing}
          loadMentionCandidates={loadMentionCandidates}
          floating
          autoFocus
          onDraftChange={onDraftChange}
          onCancel={onCancel}
          onSubmit={onSubmit}
        />
      </div>
    </section>,
    window.document.body,
  );
}
