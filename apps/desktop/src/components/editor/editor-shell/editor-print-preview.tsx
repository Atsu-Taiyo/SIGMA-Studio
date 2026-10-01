"use client";

import { PrintPreviewToolbar,resolveDrawerExportUnavailableReason,shouldOfferExternalPrintWindow } from "@/components/print/PrintPreviewToolbar";
import { PagedRenderSurface } from "@/components/print/paged-render/PagedRenderSurface";
import { type SigmaDocument } from "@/features/document";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { type Translate } from "@/lib/i18n";
import type { ComponentProps } from "react";

interface EditorPrintPreviewProps {
  previewOpen: boolean;
  document: SigmaDocument;
  renderState: { state: ComponentProps<typeof PrintPreviewToolbar>["renderState"]; pageCount: number };
  pdfExporting: boolean;
  isDesktopApp: boolean;
  isEmbedded: boolean;
  onRenderStateChange: ComponentProps<typeof PagedRenderSurface>["onRenderStateChange"];
  onExport: () => void;
  onOpenExternal: () => void;
  onClose: () => void;
  tE: Translate<"editor">;
}
export function EditorPrintPreview({ previewOpen, document, renderState, pdfExporting, isDesktopApp, isEmbedded, onRenderStateChange, onExport, onOpenExternal, onClose, tE }: EditorPrintPreviewProps) {
  return <>
      {previewOpen && (
        <div className="preview-drawer" role="dialog" aria-modal="true" aria-label={tE("aria.pdfPreview")}>
          <PrintPreviewToolbar
            renderState={renderState.state}
            pageCount={renderState.pageCount}
            isExporting={pdfExporting}
            exportUnavailableReason={resolveDrawerExportUnavailableReason({
              isDesktopApp,
              isEmbedded,
              hasDesktopExportBridge: Boolean(getDesktopBridge()?.file.exportPdf),
            })}
            onOpenExternal={shouldOfferExternalPrintWindow({ isDesktopApp, isEmbedded })
              ? onOpenExternal
              : undefined}
            onExport={onExport}
            onClose={onClose}
          />
          <div className="preview-scroll">
            <PagedRenderSurface
              document={document}
              profile="teacher"
              onRenderStateChange={onRenderStateChange}
            />
          </div>
        </div>
      )}

  </>;
}
