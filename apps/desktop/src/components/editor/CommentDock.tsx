"use client";

import { MessageSquare, MessageSquarePlus, X } from "lucide-react";
import { useEffect, useRef } from "react";

import {
  CommentThreadsPanel,
  type CommentThreadsPanelProps,
} from "@/components/editor/CommentThreadsPanel";
import type { SigmaDocument } from "@/features/document";
import { useT } from "@/lib/i18n/react";

type CommentDockPanelProps = Omit<
  CommentThreadsPanelProps,
  "candidateTop" | "document" | "panelHeight" | "pendingTop" | "threadPositions"
>;

export interface CommentDockProps {
  document: SigmaDocument;
  open: boolean;
  panel: CommentDockPanelProps;
  onOpenChange: (open: boolean) => void;
}

/**
 * キャンバス右上に常駐するコメントの入口。ページやホワイトボードの
 * 座標系とは分離し、ユーザーが明示的に開いたときだけパネルを表示する。
 */
export function CommentDock({ document, open, panel, onOpenChange }: CommentDockProps) {
  const t = useT("editor");
  const rootRef = useRef<HTMLDivElement>(null);
  const unresolvedCount = (document.comments ?? []).filter((thread) => !thread.resolved).length;
  const toggleLabel = unresolvedCount > 0
    ? t("comment.toggleWithCount", { comments: unresolvedCount })
    : t("comment.toggle");

  useEffect(() => {
    if (!open) {
      return;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && !rootRef.current?.contains(target)) {
        onOpenChange(false);
      }
    };

    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("mousedown", closeOnOutsideClick);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("mousedown", closeOnOutsideClick);
    };
  }, [onOpenChange, open]);

  return (
    <div
      className="comment-dock-root"
      ref={rootRef}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onTouchEnd={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={`comment-dock-toggle${open ? " is-panel-open" : ""}`}
        aria-expanded={open}
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={() => onOpenChange(!open)}
      >
        <MessageSquare size={16} aria-hidden="true" />
        {unresolvedCount > 0 && (
          <span className="comment-dock-badge" aria-hidden="true">
            {unresolvedCount}
          </span>
        )}
      </button>

      {open && (
        <div className="comment-dock-motion is-expanded">
          <section className="comment-dock" aria-label={t("comment.dockPanel")}>
            <header className="comment-dock-header">
              <span className="comment-dock-heading">
                <span className="comment-dock-title">{t("comment.toggle")}</span>
                {unresolvedCount > 0 && <span className="comment-dock-count">{unresolvedCount}</span>}
              </span>
              <button
                type="button"
                className="comment-dock-add"
                onClick={() => panel.onStartThread(panel.candidateAnchor)}
              >
                <MessageSquarePlus size={14} aria-hidden="true" />
                <span>{t("comment.addComment")}</span>
              </button>
              <button
                type="button"
                className="comment-dock-close"
                aria-label={t("comment.closeDock")}
                title={t("comment.close")}
                onClick={() => onOpenChange(false)}
              >
                <X size={15} />
              </button>
            </header>
            {!panel.candidateAnchor && !panel.pendingAnchor && (
              <p className="comment-dock-target-hint" role="status">
                {t("comment.selectTargetHint")}
              </p>
            )}
            <CommentThreadsPanel {...panel} document={document} />
          </section>
        </div>
      )}
    </div>
  );
}
