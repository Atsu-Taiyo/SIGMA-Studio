"use client";

import { FileText } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { PagedThumbnailRenderer } from "@/components/print/paged-render/PagedThumbnailRenderer";
import { loadWorkspacePreviewDocument, loadSharedWorkspacePreviewDocument } from "@/lib/workspace-repository";
import {
  lookupWorkspacePreviewImage,
  persistWorkspacePreviewImage,
} from "@/lib/workspace-preview-image";
import type { SigmaDocument } from "@/features/document";

export type WorkspaceFilePreviewStatus = "idle" | "loading" | "ready" | "error";
export type WorkspaceFilePreviewState = {
  key: string;
  status: WorkspaceFilePreviewStatus;
  imageUrl: string | null;
  document: SigmaDocument | null;
  cacheToken?: string;
};

export function WorkspaceFileCardPreview({
  fileId,
  revision,
  allowDocumentLoad = true,
}: {
  fileId: string;
  revision: number;
  updatedAt?: string;
  /** Shared cards use read-only snapshots; listing must not open an editing session. */
  allowDocumentLoad?: boolean;
}) {
  const forceRefresh = useRef(false);
  const [generation, setGeneration] = useState(0);
  const previewKey = `${fileId}:${revision}:${generation}`;
  useEffect(() => {
    if (allowDocumentLoad) return;
    let timer = 0;
    const refresh = () => {
      forceRefresh.current = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setGeneration(value => value + 1), 300);
    };
    const poll = window.setInterval(() => setGeneration(value => value + 1), 30_000);
    const unsubscribe = window.desktopAPI?.collaboration?.onEvent(event => {
      if (event.fileId === fileId && ["update", "reset", "asset-ready", "status"].includes(event.type)) refresh();
    });
    const unsubscribeCatalog = window.desktopAPI?.sharedCatalog?.onChange(() => {
      // Clear the visible image immediately on account or permission changes.
      setGeneration(value => value + 1);
    });
    return () => { window.clearInterval(poll); window.clearTimeout(timer); unsubscribe?.(); unsubscribeCatalog?.(); };
  }, [allowDocumentLoad, fileId]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<WorkspaceFilePreviewState>(() => ({
    key: previewKey,
    status: "idle",
    imageUrl: null,
    document: null,
  }));
  const currentPreview = preview.key === previewKey
    ? preview
    : { key: previewKey, status: "idle" as const, imageUrl: null, document: null };

  const activePreviewKey = useRef(previewKey);
  useLayoutEffect(() => { activePreviewKey.current = previewKey; return () => { activePreviewKey.current = ""; }; }, [previewKey]);

  const handleRendered = useCallback((dataUrl: string) => {
    if (activePreviewKey.current !== previewKey) return;
    if (allowDocumentLoad) void persistWorkspacePreviewImage(fileId, revision, dataUrl);
    else if (currentPreview.cacheToken) void window.desktopAPI?.workspacePreview?.putShared?.(fileId, currentPreview.cacheToken, dataUrl).catch(() => {});
    setPreview((current) => (
      current.key === previewKey
        ? { key: previewKey, status: "ready", imageUrl: dataUrl, document: null }
        : current
    ));
  }, [allowDocumentLoad, currentPreview.cacheToken, fileId, previewKey, revision]);

  const handleRenderFailed = useCallback(() => {
    setPreview((current) => (
      current.key === previewKey
        ? { key: previewKey, status: "error", imageUrl: null, document: null }
        : current
    ));
  }, [previewKey]);

  useEffect(() => {
    const element = rootRef.current;
    let cancelled = false;

    const loadPreview = async () => {
      setPreview({ key: previewKey, status: "loading", imageUrl: null, document: null });
      const shared = !allowDocumentLoad
        ? await window.desktopAPI?.workspacePreview?.getShared?.(fileId).catch(() => null)
        : null;
      let cached = allowDocumentLoad ? await lookupWorkspacePreviewImage(fileId, revision) : shared?.dataUrl;
      const force = forceRefresh.current;
      forceRefresh.current = false;
      if (cancelled) {
        return;
      }
      if (cached) {
        setPreview({ key: previewKey, status: "ready", imageUrl: cached, document: null, cacheToken: shared?.token });
        if (allowDocumentLoad || (!force && shared && Date.now() - shared.updatedAt < (shared.opened ? 60_000 : 300_000))) return;
      }
      let document: SigmaDocument | null = null;
      try {
        document = allowDocumentLoad
          ? await loadWorkspacePreviewDocument(fileId)
          : await loadSharedWorkspacePreviewDocument(fileId);
        if (!document) cached = null;
      } catch (error) {
        if (!(error instanceof Error) || !/NETWORK_UNAVAILABLE|fetch failed|Failed to fetch|HTTP_5\d\d|TimeoutError/.test(`${error.name}: ${error.message}`)) cached = null;
      }
      if (cancelled) {
        return;
      }
      setPreview({
        key: previewKey,
        status: cached ? "ready" : document ? "loading" : "error",
        imageUrl: cached ?? null,
        document,
        cacheToken: shared?.token,
      });
    };

    if (!element || typeof IntersectionObserver === "undefined") {
      void loadPreview();
      return () => {
        cancelled = true;
      };
    }

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
        return;
      }
      observer.disconnect();
      void loadPreview();
    }, { rootMargin: "220px" });

    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [allowDocumentLoad, fileId, previewKey, revision]);

  return (
    <div
      ref={rootRef}
      className="workspace-file-card-preview-stage"
      data-preview-state={currentPreview.status}
      data-testid="workspace-file-preview"
    >
      {currentPreview.status === "ready" && currentPreview.imageUrl ? (
        <div className="workspace-file-card-thumbnail">
          {/* キャッシュした data URL。Next/Image は data URL を最適化できない。 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt=""
            className="workspace-file-card-preview-image"
            data-testid="workspace-file-preview-image"
            draggable={false}
            src={currentPreview.imageUrl}
          />
        </div>
      ) : (
        <WorkspaceFileCardPreviewFallback loading={currentPreview.status === "loading"} />
      )}
      {currentPreview.document ? (
        // Same surface as the print preview; the card only shows its top half.
        <PagedThumbnailRenderer
          key={previewKey}
          document={currentPreview.document}
          onRendered={handleRendered}
          onFailed={handleRenderFailed}
        />
      ) : null}
    </div>
  );
}

function WorkspaceFileCardPreviewFallback({ loading }: { loading: boolean }) {
  return (
    <div className={`workspace-file-card-preview-fallback ${loading ? "loading" : ""}`}>
      {loading ? (
        <>
          <span className="workspace-file-preview-shimmer page" />
          <span className="workspace-file-preview-shimmer line" />
          <span className="workspace-file-preview-shimmer short-line" />
        </>
      ) : (
        <FileText size={26} />
      )}
    </div>
  );
}
