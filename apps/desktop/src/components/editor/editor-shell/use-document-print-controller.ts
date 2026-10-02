"use client";

import { suggestedPdfFileName } from "@/components/editor/editor-shell/formatting-icons";
import { type PagedRenderStateSnapshot } from "@/components/print/paged-render/PagedRenderSurface";
import { type SigmaDocument } from "@/features/document";
import { getAppRouteHref } from "@/lib/app-navigation";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { resolveDocumentTitle } from "@/lib/document-title";
import { useState } from "react";
import { tEditor } from "./editor-translations";
import type { SaveState } from "./types";

import { useEditorOwnerLifetime } from "./use-editor-owner-lifetime";

interface PrintPorts {
  isDesktopApp: boolean;
  isEmbedded: boolean;
  getDocument: () => SigmaDocument;
  getActiveFileId: () => string;
  flushOverlayChanges: () => void;
  saveCurrentDocumentRecord: () => Promise<{ ok: boolean; error?: string }>;
  setSaveState: (state: SaveState) => void;
  setStatusMessage: (message: string) => void;
}
export function useDocumentPrintController({ isDesktopApp, isEmbedded, getDocument, getActiveFileId, flushOverlayChanges, saveCurrentDocumentRecord, setSaveState, setStatusMessage }: PrintPorts) {
  const captureLifetime = useEditorOwnerLifetime();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pdfExporting, setPdfExporting] = useState(false);
  const [exportedPdfPath, setExportedPdfPath] = useState<string | null>(null);
  const [printPreviewRenderState, setPrintPreviewRenderState] = useState<PagedRenderStateSnapshot>({
    state: "pending",
    surfaceId: "",
    revision: 0,
    pageCount: 0,
    pageWidthMm: 0,
    pageHeightMm: 0,
  });
  const openPrintPreview = () => {
    flushOverlayChanges();
    setPreviewOpen(true);
  };

  const printEmbeddedPreview = async () => {
    const isCurrent = captureLifetime();
    if (!isCurrent()) return;
    try {
      setSaveState("saving");
      setStatusMessage(tEditor("status.preparingPrint"));
      const saveResult = await saveCurrentDocumentRecord();
      if (!isCurrent()) return;
      if (!saveResult.ok) {
        setSaveState("error");
        setStatusMessage(saveResult.error ?? tEditor("status.saveFailed"));
        return;
      }
      setSaveState("saved");
      setStatusMessage(tEditor("status.browserPrintOpened"));
      window.print();
    } catch (error) {
      if (!isCurrent()) return;
      setSaveState("error");
      setStatusMessage(error instanceof Error ? error.message : tEditor("status.printOpenFailed"));
    }
  };

  const exportPdf = async () => {
    const alive = captureLifetime();
    const fileId = getActiveFileId();
    const isCurrent = () => alive() && getActiveFileId() === fileId;
    if (!isCurrent()) return;
    setPdfExporting(true);
    if (isEmbedded) {
      await printEmbeddedPreview();
      if (alive()) setPdfExporting(false);
      return;
    }

    const bridge = getDesktopBridge();
    if (!isDesktopApp || !bridge?.file.exportPdf) {
      openPrintPreview();
      setStatusMessage(tEditor("status.pdfDesktopOnly"));
      setPdfExporting(false);
      return;
    }

    try {
      if (printPreviewRenderState.state !== "ready") {
        setStatusMessage(tEditor("status.pdfPreviewNotReady"));
        return;
      }
      setSaveState("saving");
      setStatusMessage(tEditor("status.pdfExporting"));
      const saveResult = await saveCurrentDocumentRecord();
      if (!isCurrent()) return;
      if (!saveResult.ok) {
        setSaveState("error");
        setStatusMessage(saveResult.error ?? tEditor("status.saveFailed"));
        return;
      }

      const result = await bridge.file.exportPdf({
        suggestedName: suggestedPdfFileName(resolveDocumentTitle(getDocument())),
        surfaceId: printPreviewRenderState.surfaceId,
        revision: printPreviewRenderState.revision,
        pageCount: printPreviewRenderState.pageCount,
        pageWidthMm: printPreviewRenderState.pageWidthMm,
        pageHeightMm: printPreviewRenderState.pageHeightMm,
      });
      if (!isCurrent()) return;
      if (result) {
        setSaveState("saved");
        setStatusMessage(tEditor("status.pdfExported", { path: result.filePath }));
        setExportedPdfPath(result.filePath);
      } else {
        setSaveState("saved");
        setStatusMessage(tEditor("status.pdfExportCancelled"));
      }
    } catch (error) {
      if (!isCurrent()) return;
      setSaveState("error");
      setStatusMessage(error instanceof Error ? error.message : tEditor("status.pdfExportFailed"));
    } finally {
      if (alive()) setPdfExporting(false);
    }
  };

  const openPrintWindow = async () => {
    const isCurrent = captureLifetime();
    const fileId = getActiveFileId();
    if (!isCurrent()) return;
    flushOverlayChanges();
    if (isEmbedded) {
      await printEmbeddedPreview();
      return;
    }

    if (isDesktopApp) {
      setPreviewOpen(true);
      setStatusMessage(tEditor("status.pdfPreviewOpened"));
      return;
    }
    await saveCurrentDocumentRecord();
    if (!isCurrent() || getActiveFileId() !== fileId) return;
    window.open(
      getAppRouteHref("/print", { fileId: getActiveFileId(), profile: "teacher" }),
      "_blank",
      "noopener,noreferrer",
    );
  };

  return { previewOpen, setPreviewOpen, pdfExporting, exportedPdfPath, setExportedPdfPath, printPreviewRenderState, setPrintPreviewRenderState, openPrintPreview, exportPdf, openPrintWindow };
}
