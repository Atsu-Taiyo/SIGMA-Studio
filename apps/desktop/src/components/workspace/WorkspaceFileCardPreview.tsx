"use client";

import { FileText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { PrintPreviewThumbnail } from "@/components/print/PrintPreview";
import { rasterizePrintPageTopHalf } from "@/components/print/rasterize-print-thumbnail";
import { loadWorkspacePreviewDocument } from "@/lib/workspace-repository";
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
};

export function WorkspaceFileCardPreview({
  fileId,
  revision,
}: {
  fileId: string;
  revision: number;
  updatedAt?: string;
}) {
  const previewKey = `${fileId}:${revision}`;
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

  const handleRasterReady = useCallback(async (surface: HTMLElement) => {
    try {
      const dataUrl = await rasterizePrintPageTopHalf(surface);
      await persistWorkspacePreviewImage(fileId, revision, dataUrl);
      setPreview((current) => (
        current.key === previewKey
          ? { key: previewKey, status: "ready", imageUrl: dataUrl, document: null }
          : current
      ));
    } catch {
      setPreview((current) => (
        current.key === previewKey
          ? { key: previewKey, status: "error", imageUrl: null, document: null }
          : current
      ));
    }
  }, [fileId, previewKey, revision]);

  useEffect(() => {
    const element = rootRef.current;
    let cancelled = false;

    const loadPreview = async () => {
      setPreview({ key: previewKey, status: "loading", imageUrl: null, document: null });
      const cached = await lookupWorkspacePreviewImage(fileId, revision);
      if (cancelled) {
        return;
      }
      if (cached) {
        setPreview({ key: previewKey, status: "ready", imageUrl: cached, document: null });
        return;
      }
      const document = await loadWorkspacePreviewDocument(fileId);
      if (cancelled) {
        return;
      }
      setPreview({
        key: previewKey,
        status: document ? "loading" : "error",
        imageUrl: null,
        document,
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
  }, [fileId, previewKey, revision]);

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
        <WorkspacePreviewRasterHost
          document={currentPreview.document}
          onReady={handleRasterReady}
        />
      ) : null}
    </div>
  );
}

function WorkspacePreviewRasterHost({
  document: previewDocument,
  onReady,
}: {
  document: SigmaDocument;
  onReady: (root: HTMLElement) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    let cancelled = false;
    const wait = async () => {
      await globalThis.document.fonts?.ready;
      for (let attempt = 0; attempt < 45; attempt += 1) {
        if (cancelled) {
          return;
        }
        if (host.querySelector(".print-a4-page")) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
          if (!cancelled) {
            onReadyRef.current(host);
          }
          return;
        }
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      }
    };
    void wait();
    return () => {
      cancelled = true;
    };
  }, [previewDocument]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className="workspace-file-preview-raster-host"
    >
      <PrintPreviewThumbnail document={previewDocument} />
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
