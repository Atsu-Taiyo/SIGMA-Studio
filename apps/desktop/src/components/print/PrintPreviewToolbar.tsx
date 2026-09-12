"use client";

import { Download, ExternalLink, Loader2, X } from "lucide-react";

import { Button, IconButton } from "@/components/ui/Button";
import { Inline, Stack } from "@/components/ui/layout";
import { Shimmer } from "@/components/ui/Shimmer";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";

import type { PagedRenderState } from "./paged-render/PagedRenderSurface";

const DEFAULT_PRINT_TRANSLATE = createCurrentLocaleTranslator("print");

interface PrintPreviewToolbarProps {
  documentUnavailable?: boolean;
  exportUnavailableReason?: string;
  isExporting: boolean;
  onClose?: () => void;
  onExport: () => void;
  onOpenExternal?: () => void;
  pageCount: number;
  renderState: PagedRenderState;
}

export function shouldOfferExternalPrintWindow({
  isDesktopApp,
  isEmbedded,
}: {
  isDesktopApp: boolean;
  isEmbedded: boolean;
}): boolean {
  return !isEmbedded && !isDesktopApp;
}

export function resolveDrawerExportUnavailableReason({
  hasDesktopExportBridge,
  isDesktopApp,
  isEmbedded,
}: {
  hasDesktopExportBridge: boolean;
  isDesktopApp: boolean;
  isEmbedded: boolean;
}, t: Translate<"print"> = DEFAULT_PRINT_TRANSLATE): string | undefined {
  if (isEmbedded || (isDesktopApp && hasDesktopExportBridge)) {
    return undefined;
  }

  return t("toolbar.desktopOnly");
}

/** Shared, state-aware toolbar for the drawer and standalone PDF previews. */
export function PrintPreviewToolbar({
  documentUnavailable = false,
  exportUnavailableReason,
  isExporting,
  onClose,
  onExport,
  onOpenExternal,
  pageCount,
  renderState,
}: PrintPreviewToolbarProps) {
  const t = useT("print");
  const exportDisabled = isExporting || renderState !== "ready" || Boolean(exportUnavailableReason);

  return (
    <header className="print-preview-toolbar">
      <Stack className="print-preview-toolbar-heading" gap="xs">
        <h1>{t("toolbar.title")}</h1>
        {!documentUnavailable && (
          <span className="print-preview-toolbar-meta" aria-live="polite">
            {renderState === "ready" ? t("toolbar.pageCount", { count: pageCount }) : renderState === "stalled" ? (
              t("toolbar.stalled")
            ) : (
              <Shimmer variant="text" className="print-preview-toolbar-meta-shimmer" />
            )}
          </span>
        )}
      </Stack>

      <Inline className="print-preview-toolbar-actions" gap="sm" justify="end" wrap>
        {onOpenExternal && (
          <IconButton
            label={t("toolbar.openExternal")}
            tooltip={{ label: t("toolbar.openExternal") }}
            tone="ghost"
            onClick={onOpenExternal}
          >
            <ExternalLink size={16} aria-hidden="true" />
          </IconButton>
        )}

        <Button
          tone="primary"
          disabled={exportDisabled}
          title={exportUnavailableReason
            ?? (renderState !== "ready" ? t("toolbar.saveAfterReady") : undefined)}
          onClick={onExport}
        >
          {isExporting ? (
            <Loader2 className="save-state-spinner" size={16} aria-hidden="true" />
          ) : (
            <Download size={16} aria-hidden="true" />
          )}
          {isExporting ? t("toolbar.saving") : t("toolbar.save")}
        </Button>

        {onClose && (
          <IconButton label={t("toolbar.close")} tone="ghost" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        )}
      </Inline>
    </header>
  );
}
