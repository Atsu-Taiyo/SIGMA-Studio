"use client";
import type { RefObject } from "react";
import { useLayoutEffect,useMemo,useState } from "react";
import type { CommentThreadsPanelProps } from "../CommentThreadsPanel";
import { measureCommentAnchorTop,measureCommentThreadTop } from "./comment-geometry";
import { sameNullableNumber,sameNumberMap } from "./layout-equality";

interface Inputs {
  commentPanel: Omit<CommentThreadsPanelProps, "document" | "candidateTop" | "panelHeight" | "pendingTop" | "threadPositions"> | undefined;
  totalHeight: number;
  zoom: number;
  showComments: boolean;
  canvasRef: RefObject<HTMLDivElement | null>;
}

export function usePageCanvasCommentGeometry({ commentPanel, totalHeight, zoom, showComments, canvasRef }: Inputs) {

  const [commentThreadPositions, setCommentThreadPositions] = useState<Record<string, number>>({});

  const [pendingCommentTop, setPendingCommentTop] = useState<number | null>(null);

  const [candidateCommentTop, setCandidateCommentTop] = useState<number | null>(null);

  const commentLayoutKey = useMemo(() => JSON.stringify({
    candidateAnchor: commentPanel?.candidateAnchor ?? null,
    pendingAnchor: commentPanel?.pendingAnchor ?? null,
    threads: commentPanel?.threads.map((thread) => [thread.id, thread.anchor, thread.resolved]) ?? [],
    totalHeight,
    zoom,
  }), [commentPanel?.candidateAnchor, commentPanel?.pendingAnchor, commentPanel?.threads, totalHeight, zoom]);

  useLayoutEffect(() => {
    if (!showComments || !commentPanel) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    let frame = 0;
    const updatePositions = () => {
      frame = 0;
      const nextPositions: Record<string, number> = {};
      for (const thread of commentPanel.threads) {
        const top = measureCommentThreadTop(canvas, thread, zoom);
        if (top !== null) {
          nextPositions[thread.id] = top;
        }
      }

      setCommentThreadPositions((current) => sameNumberMap(current, nextPositions) ? current : nextPositions);
      const nextPendingTop = commentPanel.pendingAnchor ? measureCommentAnchorTop(canvas, commentPanel.pendingAnchor, zoom) : null;
      const nextCandidateTop = commentPanel.candidateAnchor ? measureCommentAnchorTop(canvas, commentPanel.candidateAnchor, zoom) : null;
      setPendingCommentTop((current) => sameNullableNumber(current, nextPendingTop) ? current : nextPendingTop);
      setCandidateCommentTop((current) => sameNullableNumber(current, nextCandidateTop) ? current : nextCandidateTop);
    };

    const scheduleUpdate = () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(updatePositions);
    };

    scheduleUpdate();
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(canvas);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
    };
  }, [canvasRef, commentLayoutKey, commentPanel, showComments, zoom]);
  return { candidateCommentTop, pendingCommentTop, commentThreadPositions };
}
