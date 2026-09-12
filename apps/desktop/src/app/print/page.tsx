"use client";

import { AlertTriangle, ArrowLeft, Check, Loader2, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
  PagedRenderSurface,
  type PagedRenderStateSnapshot,
} from "@/components/print/paged-render/PagedRenderSurface";
import { PrintPaperShimmer } from "@/components/print/PrintPaperShimmer";
import { PrintPreviewToolbar } from "@/components/print/PrintPreviewToolbar";
import { PdfExportSuccessDialog } from "@/components/print/PdfExportSuccessDialog";
import { Button, IconButton } from "@/components/ui/Button";
import { navigateToAppRoute } from "@/lib/app-navigation";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import { loadDocumentByFileId, loadSavedDocument } from "@/lib/storage";
import type { SigmaDocument, OutputProfileName } from "@/features/document";
import { MathEnvironmentProvider } from "@/features/rendering/adapters/react";

type ExportNotice = {
  kind: "cancelled" | "error" | "progress" | "success";
  message: string;
  retryable?: boolean;
};

type PdfExportAvailability =
  | { available: true }
  | { available: false; reason: string };

const DEFAULT_PRINT_TRANSLATE = createCurrentLocaleTranslator("print");

export default function PrintPage() {
  const t = useT("print");
  const [document, setDocument] = useState<SigmaDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [exportNotice, setExportNotice] = useState<ExportNotice | null>(null);
  const [exportedPdfPath, setExportedPdfPath] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportAvailability, setExportAvailability] = useState<PdfExportAvailability>({
    available: false,
    reason: DEFAULT_PRINT_TRANSLATE("load.checkingAvailability"),
  });
  const [profile, setProfile] = useState<OutputProfileName>("teacher");
  const [renderState, setRenderState] = useState<PagedRenderStateSnapshot>({
    state: "pending",
    surfaceId: "",
    revision: 0,
    pageCount: 0,
    pageWidthMm: 0,
    pageHeightMm: 0,
  });

  useEffect(() => {
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      const load = async () => {
        const params = new URLSearchParams(window.location.search);
        const requestedFileId = params.get("fileId");
        const renderId = params.get("renderId");
        setProfile(toOutputProfileName(params.get("profile")));

        if (renderId) {
          const bridge = getDesktopBridge();
          const renderDocument = (await bridge?.aiRender?.getRenderDocument(renderId)) ?? null;
          if (cancelled) {
            return;
          }
          if (renderDocument) {
            setDocument(renderDocument);
            setLoadError(null);
            setLoadState("ready");
          } else {
            setDocument(null);
            setLoadError(DEFAULT_PRINT_TRANSLATE("load.aiDocumentFailed"));
            setLoadState("error");
          }
          return;
        }

        const saved = requestedFileId ? await loadDocumentByFileId(requestedFileId) : loadSavedDocument();
        if (cancelled) {
          return;
        }

        if (saved) {
          setDocument(saved);
          setLoadError(null);
          setLoadState("ready");
        } else {
          setDocument(null);
          setLoadError(requestedFileId
            ? DEFAULT_PRINT_TRANSLATE("load.requestedDocumentFailed")
            : DEFAULT_PRINT_TRANSLATE("load.documentRequired"));
          setLoadState("error");
        }
      };

      load().catch((error) => {
        if (cancelled) {
          return;
        }
        setDocument(null);
        setLoadError(error instanceof Error ? error.message : DEFAULT_PRINT_TRANSLATE("load.failed"));
        setLoadState("error");
      });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const requestedFileId = new URLSearchParams(window.location.search).get("fileId");
      setExportAvailability(resolvePdfExportAvailability({
        fileId: requestedFileId,
        hasDesktopExportBridge: Boolean(getDesktopBridge()?.file.exportPdf),
      }));
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!exportNotice || isExporting || !isTransientExportNotice(exportNotice)) {
      return;
    }
    const timeoutId = window.setTimeout(() => setExportNotice(null), 4_000);
    return () => window.clearTimeout(timeoutId);
  }, [exportNotice, isExporting]);

  const exportPdf = async () => {
    const requestedFileId = new URLSearchParams(window.location.search).get("fileId");
    const bridge = getDesktopBridge();
    const desktopExportPdf = bridge?.file.exportPdf;
    if (renderState.state !== "ready") {
      setExportNotice({
        kind: "error",
        message: DEFAULT_PRINT_TRANSLATE("export.previewNotReady"),
        retryable: false,
      });
      return;
    }
    const availability = resolvePdfExportAvailability({
      fileId: requestedFileId,
      hasDesktopExportBridge: Boolean(desktopExportPdf),
    });
    if (!availability.available) {
      setExportAvailability(availability);
      setExportNotice({ kind: "error", message: availability.reason, retryable: false });
      return;
    }
    if (!requestedFileId || !desktopExportPdf) {
      return;
    }

    try {
      setIsExporting(true);
      setExportNotice({ kind: "progress", message: DEFAULT_PRINT_TRANSLATE("export.exporting") });
      const result = await desktopExportPdf({
        suggestedName: suggestedPdfFileName(document?.metadata.title ?? ""),
        surfaceId: renderState.surfaceId,
        revision: renderState.revision,
        pageCount: renderState.pageCount,
        pageWidthMm: renderState.pageWidthMm,
        pageHeightMm: renderState.pageHeightMm,
      });
      setExportNotice(result
        ? { kind: "success", message: DEFAULT_PRINT_TRANSLATE("export.exported", { path: result.filePath }) }
        : { kind: "cancelled", message: DEFAULT_PRINT_TRANSLATE("export.cancelled") });
      setExportedPdfPath(result?.filePath ?? null);
    } catch (error) {
      setExportNotice({
        kind: "error",
        message: error instanceof Error ? error.message : DEFAULT_PRINT_TRANSLATE("export.failed"),
        retryable: true,
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <MathEnvironmentProvider
      mathFractionSizing={document?.metadata.mathFractionSizing}
      preamble={document?.metadata.texPreamble}
    >
    <main className="print-page">
      <PrintPreviewToolbar
        documentUnavailable={loadState === "error"}
        renderState={renderState.state}
        pageCount={renderState.pageCount}
        isExporting={isExporting}
        exportUnavailableReason={exportAvailability.available ? undefined : exportAvailability.reason}
        onExport={() => void exportPdf()}
      />
      {loadState === "ready" && document ? (
        <PagedRenderSurface
          document={document}
          profile={profile}
          onRenderStateChange={setRenderState}
        />
      ) : loadState === "error" ? (
        <section className="print-load-error" data-print-load-state="error" role="alert">
          <AlertTriangle size={24} aria-hidden="true" />
          <h2>{t("load.failedTitle")}</h2>
          <p>{loadError ?? t("load.failed")}</p>
          <button type="button" className="button secondary" onClick={() => navigateToAppRoute("/")}>
            <ArrowLeft size={16} aria-hidden="true" />
            {t("load.backToEditor")}
          </button>
        </section>
      ) : (
        <section className="print-load-pending" role="status" aria-label={t("load.pending")} aria-busy="true">
          <PrintPaperShimmer widthMm={210} heightMm={297} />
        </section>
      )}
      <div
        className={`print-status-toast${exportNotice ? ` is-${exportNotice.kind}` : " is-empty"}`}
        role={exportNotice?.kind === "error" ? "alert" : "status"}
      >
        {exportNotice?.kind === "progress" && (
          <Loader2 className="save-state-spinner" size={16} aria-hidden="true" />
        )}
        {exportNotice?.kind === "success" && <Check size={16} aria-hidden="true" />}
        {exportNotice?.kind === "error" && <AlertTriangle size={16} aria-hidden="true" />}
        <span className="print-status-toast-message">{exportNotice?.message}</span>
        {shouldShowExportRetry(exportNotice) && (
          <Button
            className="print-status-toast-retry"
            disabled={isExporting || renderState.state !== "ready"}
            size="sm"
            title={renderState.state !== "ready" ? t("export.retryAfterReady") : undefined}
            tone="secondary"
            onClick={() => void exportPdf()}
          >
            <RotateCcw size={14} aria-hidden="true" />
            {t("export.retry")}
          </Button>
        )}
        {exportNotice?.kind === "error" && (
          <>
            <IconButton
              className="print-status-toast-close"
              label={t("export.closeError")}
              tooltip={{ label: t("export.closeError") }}
              size="sm"
              tone="ghost"
              onClick={() => setExportNotice(null)}
            >
              <X size={14} aria-hidden="true" />
            </IconButton>
          </>
        )}
      </div>
      {exportedPdfPath && <PdfExportSuccessDialog filePath={exportedPdfPath} onClose={() => setExportedPdfPath(null)} />}
    </main>
    </MathEnvironmentProvider>
  );
}

export function isTransientExportNotice(notice: ExportNotice): boolean {
  return notice.kind === "success" || notice.kind === "cancelled";
}

export function shouldShowExportRetry(notice: ExportNotice | null): boolean {
  return notice?.kind === "error" && notice.retryable === true;
}

export function resolvePdfExportAvailability({
  fileId,
  hasDesktopExportBridge,
}: {
  fileId: string | null;
  hasDesktopExportBridge: boolean;
}, t: Translate<"print"> = DEFAULT_PRINT_TRANSLATE): PdfExportAvailability {
  if (!fileId) {
    return { available: false, reason: t("load.documentRequiredShort") };
  }
  if (!hasDesktopExportBridge) {
    return { available: false, reason: t("toolbar.desktopOnly") };
  }
  return { available: true };
}

export function toOutputProfileName(value: string | null): OutputProfileName {
  return value === "student" || value === "answerBook" ? value : "teacher";
}

function suggestedPdfFileName(title: string): string {
  const stem = title
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim() || "lesson";
  return `${stem}.pdf`;
}
