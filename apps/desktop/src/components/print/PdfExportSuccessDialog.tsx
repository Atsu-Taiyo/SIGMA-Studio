"use client";

import { CheckCircle2, X } from "lucide-react";
import { useEffect } from "react";

import { useT } from "@/lib/i18n/react";

export function PdfExportSuccessDialog({ filePath, onClose }: { filePath: string; onClose: () => void }) {
  const t = useT("print");
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="pdf-export-success-backdrop" data-modal-backdrop="" role="presentation" onPointerDown={onClose}>
      <section
        className="pdf-export-success-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-export-success-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <div className="pdf-export-success-heading">
            <CheckCircle2 size={20} aria-hidden="true" />
            <h2 id="pdf-export-success-title">{t("export.savedTitle")}</h2>
          </div>
          <button type="button" className="icon-button" title={t("toolbar.close")} aria-label={t("toolbar.close")} autoFocus onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="pdf-export-success-content">
          <p>{t("export.savedBody")}</p>
          <code title={filePath}>{filePath}</code>
        </div>
      </section>
    </div>
  );
}
