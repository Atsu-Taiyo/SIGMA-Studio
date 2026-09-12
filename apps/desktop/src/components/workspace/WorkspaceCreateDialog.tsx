"use client";

import { Building2, FilePlus, FolderPlus, Loader2, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { FormEvent } from "react";

import type { WorkspaceFolderSummary } from "@/lib/workspace-repository";
import { useT } from "@/lib/i18n/react";

export type WorkspaceCreateKind = "folder" | "document" | "workspace";

export type WorkspaceCreateDialogState = {
  kind: WorkspaceCreateKind;
  folderId: string | null;
  name: string;
};

interface WorkspaceCreateDialogProps {
  dialog: WorkspaceCreateDialogState;
  folders: WorkspaceFolderSummary[];
  saving: boolean;
  onNameChange: (name: string) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
}

export function WorkspaceCreateDialog({
  dialog,
  folders,
  saving,
  onNameChange,
  onSubmit,
  onClose,
}: WorkspaceCreateDialogProps) {
  const t = useT("workspace");

  const nameInputRef = useRef<HTMLInputElement>(null);

  // ダイアログはマウント時にのみ全選択する。下書き文字列 (dialog.name) はまだ親が
  // 保持しているため、この effect の依存に含めてはいけない
  // (含めると1文字ごとに全選択が走り直して次の入力を丸ごと置換してしまう)。
  useEffect(() => {
    nameInputRef.current?.select();
  }, []);

  useEffect(() => {
    const closeDialogOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", closeDialogOnEscape);
    return () => window.removeEventListener("keydown", closeDialogOnEscape);
  }, [onClose]);

  const createTargetLabel = dialog.kind === "workspace"
    ? t("create.onThisPc")
    : dialog.folderId
      ? folders.find((folder) => folder.id === dialog.folderId)?.name ?? t("create.selectedFolder")
      : t("create.workspaceRoot");

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
        aria-labelledby="workspace-create-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="workspace-create-header">
          <div>
            <h2 id="workspace-create-title">
              {dialog.kind === "folder"
                ? t("newFolder")
                : dialog.kind === "workspace"
                  ? t("newWorkspace")
                  : t("create.newMaterialTitle")}
            </h2>
            <p>{createTargetLabel}</p>
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
        <form className="workspace-create-form" onSubmit={onSubmit}>
          <label>
            <span>
              {dialog.kind === "folder"
                ? t("label.folderName")
                : dialog.kind === "workspace"
                  ? t("nav.workspaceName")
                  : t("label.materialName")}
            </span>
            <input
              ref={nameInputRef}
              autoFocus
              aria-label={dialog.kind === "folder"
                ? t("label.folderName")
                : dialog.kind === "workspace"
                  ? t("nav.workspaceName")
                  : t("label.materialName")}
              value={dialog.name}
              onChange={(event) => onNameChange(event.target.value)}
            />
          </label>
          <footer>
            <button type="button" className="button secondary" onClick={onClose}>
              {t("action.cancel")}
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={saving}
            >
              {saving
                ? <Loader2 className="workspace-spin" size={15} />
                : dialog.kind === "folder"
                  ? <FolderPlus size={15} />
                  : dialog.kind === "workspace"
                    ? <Building2 size={15} />
                    : <FilePlus size={15} />}
              {t("action.create")}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
