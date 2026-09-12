"use client";

import { Loader2, Trash2, X } from "lucide-react";
import { useEffect } from "react";
import { useT } from "@/lib/i18n/react";

interface WorkspaceConfirmDialogProps {
  title: string;
  itemLabel: string;
  warning: string;
  confirmLabel?: string;
  saving: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function WorkspaceConfirmDialog({
  title,
  itemLabel,
  warning,
  confirmLabel: confirmLabelProp,
  saving,
  onConfirm,
  onClose,
}: WorkspaceConfirmDialogProps) {
  const t = useT("workspace");
  // 既定値を引数に書くと、本体で宣言した `t` より前に評価されて TDZ で落ちる。
  const confirmLabel = confirmLabelProp ?? t("action.delete");

  useEffect(() => {
    const closeDialogOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", closeDialogOnEscape);
    return () => window.removeEventListener("keydown", closeDialogOnEscape);
  }, [onClose]);

  return (
    <div
      className="workspace-create-backdrop"
      data-modal-backdrop=""
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="workspace-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-confirm-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="workspace-create-header">
          <div>
            <h2 id="workspace-confirm-title">{title}</h2>
            <p>{itemLabel}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            title={t("action.close")}
            aria-label={t("action.close")}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>
        <div className="workspace-create-form">
          <p className="workspace-delete-warning">{warning}</p>
          <footer>
            <button type="button" className="button secondary" onClick={onClose}>
              {t("action.cancel")}
            </button>
            <button
              type="button"
              className="button danger"
              disabled={saving}
              onClick={onConfirm}
            >
              {saving
                ? <Loader2 className="workspace-spin" size={15} />
                : <Trash2 size={15} />}
              {confirmLabel}
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}
