"use client";

import { Loader2, Trash2, X } from "lucide-react";
import { useEffect } from "react";
import { useT } from "@/lib/i18n/react";

export type WorkspaceDeleteDialogState = {
  workspaceId: string;
  workspaceName: string;
  fileCount: number;
  folderCount: number;
};

interface WorkspaceDeleteDialogProps {
  dialog: WorkspaceDeleteDialogState;
  saving: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function WorkspaceDeleteDialog({
  dialog,
  saving,
  onConfirm,
  onClose,
}: WorkspaceDeleteDialogProps) {
  const t = useT("workspace");

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
        aria-labelledby="workspace-delete-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="workspace-create-header">
          <div>
            <h2 id="workspace-delete-title">{t("action.deleteWorkspace")}</h2>
            <p>{dialog.workspaceName}</p>
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
          <p className="workspace-delete-warning">
            {t("confirm.deleteWorkspaceBody", { replace: { files: dialog.fileCount, folders: dialog.folderCount } })}
          </p>
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
              {t("action.delete")}
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}
