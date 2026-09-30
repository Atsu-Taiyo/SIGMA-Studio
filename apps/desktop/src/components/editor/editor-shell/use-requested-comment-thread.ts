"use client";

import { useEffect, useRef, useState } from "react";

import type { SigmaCommentThread } from "@/features/document";

import { clearRequestedCommentThread, getRequestedCommentThread } from "./workspace-request";

/** A thread that never shows up (deleted, or the shared material never synced) must not stay armed forever. */
const GIVE_UP_MS = 20_000;

/**
 * Selects the thread named by the URL (`commentThreadId`) once its material is the active one and the thread
 * has loaded. It fires once; a request that can't be met within `GIVE_UP_MS` is dropped, and the parameter is
 * removed either way so a reload does not replay it.
 */
export function useRequestedCommentThread({ ready, activeFileId, comments, select }: {
  ready: boolean;
  activeFileId: string;
  comments: readonly SigmaCommentThread[] | undefined;
  select: (threadId: string) => void;
}): void {
  // Read once at mount: `fileId` is removed from the URL as soon as the material opens.
  const [request] = useState(getRequestedCommentThread);
  const consumed = useRef(false);

  useEffect(() => {
    if (!request) return;
    const timer = window.setTimeout(() => {
      consumed.current = true;
      clearRequestedCommentThread();
    }, GIVE_UP_MS);
    return () => window.clearTimeout(timer);
  }, [request]);

  useEffect(() => {
    if (!request || consumed.current || !ready || activeFileId !== request.fileId) return;
    if (!comments?.some((thread) => thread.id === request.threadId)) return;
    consumed.current = true;
    clearRequestedCommentThread();
    select(request.threadId);
  }, [request, ready, activeFileId, comments, select]);
}
